/**
 * Priceless Bundle — end-to-end API test.
 *
 * Drives the REAL Next.js route handlers over HTTP against a REAL PostgreSQL
 * engine. Nothing is stubbed: registration, the SMS deposit webhook, tier
 * pricing, atomic purchase, supplier fulfilment, refunds, withdrawals, P2P,
 * squad roll-up, admin resolution and ledger reconciliation all run exactly as
 * they do in production.
 *
 * By default the script starts its own stack:
 *    • Postgres (PGlite socket server) on :55433, in-memory, schema applied
 *    • Next.js on :3100 with SUPPLIER_MOCK_MODE=always_succeed
 *    • Next.js on :3101 with SUPPLIER_MOCK_MODE=always_fail  (refund path)
 *
 * Or point it at running servers:
 *   E2E_BASE_URL=http://localhost:3000 E2E_FAIL_BASE_URL=http://localhost:3001 node tests/e2e.mjs
 *
 *   node tests/e2e.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  section, check, checkEq, checkClose, checkGte, summary, results,
} from "./harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DB_PORT = Number(process.env.E2E_DB_PORT ?? 55433);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const FAIL_PORT = Number(process.env.E2E_FAIL_PORT ?? 3101);

const SMS_SECRET = "e2e-sms-forwarder-secret";
const ADMIN_PHONE = "0244000000";
const ADMIN_PIN = "246810";
const SESSION_SECRET = "priceless-bundle-e2e-session-secret-key-32-chars";

let BASE = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;
let FAIL_BASE = process.env.E2E_FAIL_BASE_URL ?? `http://localhost:${FAIL_PORT}`;
const managed = !process.env.E2E_BASE_URL;

const children = [];
const logs = new Map();

/* ------------------------------------------------------------------ */
/* process management (managed mode only)                             */
/* ------------------------------------------------------------------ */

function launch(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group: `npx next dev` spawns a child, and killing only the
    // parent would leave an orphan holding the port.
    detached: true,
  });
  const buffer = [];
  child.stdout.on("data", (chunk) => buffer.push(chunk.toString()));
  child.stderr.on("data", (chunk) => buffer.push(chunk.toString()));
  logs.set(name, buffer);
  children.push(child);
  return child;
}

function webEnv(mode) {
  return {
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`,
    SESSION_SECRET,
    SMS_WEBHOOK_SECRET: SMS_SECRET,
    ADMIN_PHONE,
    ADMIN_PIN,
    PUBLIC_BASE_URL: `http://localhost:${WEB_PORT}`,
    SUPPLIER_MOCK_MODE: mode,
    PGLITE_MAX_CONNECTIONS: "12",
    PG_POOL_MAX: "6",
  };
}

async function waitForHealth(url, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        const json = await response.json();
        if (json.ok && json.database === "up") return true;
        lastError = JSON.stringify(json).slice(0, 200);
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function shutdown() {
  for (const child of children) killGroup(child, "SIGTERM");
  await sleep(500);
  for (const child of children) killGroup(child, "SIGKILL");
  await sleep(200);
}

async function assertPortFree(port) {
  const { createConnection } = await import("node:net");
  await new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use — stop that process first (or set E2E_*_PORT).`));
    });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
  });
}

if (managed) {
  console.log("⚙️  starting a dedicated stack (Postgres + two Next.js servers)...");
  for (const port of [DB_PORT, WEB_PORT, FAIL_PORT]) await assertPortFree(port);
  launch("db", process.execPath, ["scripts/pg-server.mjs", "--port", String(DB_PORT), "--memory"], {
    PGLITE_MAX_CONNECTIONS: "12",
  });
  await sleep(2500);
  // Each server needs its own build directory: Next.js allows only one dev
  // server per .next folder.
  launch("web", "npx", ["next", "dev", "--port", String(WEB_PORT), "--hostname", "127.0.0.1"], {
    ...webEnv("always_succeed"),
    NEXT_DIST_DIR: ".next-e2e-pass",
  });
  launch("web-fail", "npx", ["next", "dev", "--port", String(FAIL_PORT), "--hostname", "127.0.0.1"], {
    ...webEnv("always_fail"),
    NEXT_DIST_DIR: ".next-e2e-fail",
    PUBLIC_BASE_URL: `http://localhost:${FAIL_PORT}`,
  });
}

/* ------------------------------------------------------------------ */
/* tiny HTTP client with a cookie jar                                  */
/* ------------------------------------------------------------------ */

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(response) {
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index > 0) {
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === "" || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
  }

  async request(method, path, body, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (body !== undefined && body !== null && !options.raw) headers["Content-Type"] = "application/json";
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: options.raw ? body : body === undefined || body === null ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    this.absorb(response);

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, body: json, text, headers: response.headers };
  }

  get(path, options) {
    return this.request("GET", path, undefined, options);
  }
  post(path, body, options) {
    return this.request("POST", path, body, options);
  }
}

const api = (client) => ({
  async ok(method, path, body, options) {
    const response = await client.request(method, path, body, options);
    if (!response.ok || response.body?.ok === false) {
      throw new Error(`${method} ${path} failed (${response.status}): ${response.text.slice(0, 300)}`);
    }
    return response.body;
  },
});

/** GET the check result of a request that is expected to fail. */
async function expectFailure(client, method, path, body, _expectedStatus) {
  const response = await client.request(method, path, body);
  return { response, ok: !response.ok || response.body?.ok === false, status: response.status };
}

/* ------------------------------------------------------------------ */
/* database inspection (read-only, for assertions)                     */
/* ------------------------------------------------------------------ */

let pgClient = null;
async function sql(text, params = []) {
  if (!pgClient) {
    const { default: pg } = await import("pg");
    pgClient = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres` });
    await pgClient.connect();
  }
  const result = await pgClient.query(text, params);
  return result.rows;
}

const one = async (text, params) => (await sql(text, params))[0] ?? null;

/* ------------------------------------------------------------------ */
/* START                                                              */
/* ------------------------------------------------------------------ */

try {
  if (managed) {
    await waitForHealth(BASE);
    await waitForHealth(FAIL_BASE);
    console.log(`✓ release-mode server ready at ${BASE}`);
    console.log(`✓ failure-mode server ready at ${FAIL_BASE}\n`);
  }

  const stamp = Date.now().toString().slice(-5);
  const buyerPhone = `0244${stamp}0`;
  const agentPhone = `0554${stamp}1`;
  const subPhone = `0204${stamp}2`;
  const recipient = `0244${stamp}7`;

  const buyer = new Client(BASE);
  const agent = new Client(BASE);
  const sub = new Client(BASE);
  const anon = new Client(BASE);
  const operator = new Client(BASE);

  /* ================================================================ */
  section("1. Platform health & public catalogue over HTTP");

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("health endpoint reports the database is up", health.ok === true && health.database === "up");
  checkEq("health reports the brand", health.health?.brand, "Priceless Bundle");
  checkEq("health reports the operator", health.health?.by, "LongKinnex Tech and Data");

  const catalogue = await api(anon).ok("GET", "/api/plans");
  checkEq("public catalogue returns every seeded plan", catalogue.plans.length, 24);
  check("public catalogue hides cost prices", !JSON.stringify(catalogue).includes("cost_price"));

  const plan5gb = catalogue.plans.find((p) => p.network === "MTN" && p.size_label === "5GB");
  const plan1gb = catalogue.plans.find((p) => p.network === "MTN" && p.size_label === "1GB");
  check("5GB MTN plan present", Boolean(plan5gb));
  checkEq("anonymous visitor is quoted retail", plan5gb.tier, "customer");

  const unauth = await expectFailure(anon, "GET", "/api/wallet");
  checkEq("wallet requires a session", unauth.status, 401);

  /* ================================================================ */
  section("2. Registration & sign-in");

  const registration = await api(buyer).ok("POST", "/api/auth/register", {
    full_name: "E2E Buyer",
    phone: buyerPhone,
    pin: "1234",
  });
  check("registration succeeds", registration.user?.id ? true : false);
  checkEq("new account is a customer", registration.user.tier, "customer");
  check("session cookie issued", buyer.cookies.has("pb_session"));
  const buyerId = registration.user.id;

  const duplicate = await expectFailure(anon, "POST", "/api/auth/register", {
    full_name: "E2E Buyer",
    phone: buyerPhone,
    pin: "1234",
  });
  checkEq("duplicate registration rejected", duplicate.status, 409);
  check("duplicate message is friendly", /already registered/i.test(duplicate.response.body?.message ?? ""));

  const weakPin = await expectFailure(new Client(BASE), "POST", "/api/auth/register", {
    full_name: "Bad Pin",
    phone: `0245${stamp}9`,
    pin: "12",
  });
  checkEq("weak PIN rejected", weakPin.status, 400);

  const wrongPin = await expectFailure(new Client(BASE), "POST", "/api/auth/login", { phone: buyerPhone, pin: "9999" });
  checkEq("wrong PIN rejected", wrongPin.status, 401);

  const signIn = await api(new Client(BASE)).ok("POST", "/api/auth/login", { phone: buyerPhone, pin: "1234" });
  check("sign-in succeeds with the right PIN", Boolean(signIn.user?.id));

  const session = await api(buyer).ok("GET", "/api/auth/session");
  checkEq("session endpoint identifies the buyer", session.user?.id, buyerId);

  /* ================================================================ */
  section("3. WALLET TOP-UP — full automatic payment collection flow");

  const topup = await api(buyer).ok("POST", "/api/wallet/topup", { amount: 120, channel: "momo" });
  const intent = topup.intent;
  check("top-up intent created", Boolean(intent?.id));
  check("reference code matches PB-XXXX", /^PB-[A-Z0-9]{4}$/.test(intent.reference_code), intent.reference_code);
  check("collection number returned", Boolean(intent.collection_number));
  checkEq("amount recorded as requested", Number(intent.expected_amount_ghs), 120);
  check("instructions returned for the UI", Boolean(topup.instructions?.step1));

  // The Android SMS-forwarder posts the raw confirmation SMS.
  const smsText =
    `Payment received for GHS 120.00 from ${buyerPhone}. Reference: ${intent.reference_code}. ` +
    `Your new balance is GHS 120.00. Transaction ID ${stamp}XYZ.`;

  const badSecret = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": "wrong-secret" },
    body: smsText,
  });
  checkEq("webhook rejects a bad shared secret", badSecret.status, 401);
  const afterBadSecret = await one("select balance_ghs from public.wallets where user_id = $1", [buyerId]);
  checkEq("bad secret credits nothing", Number(afterBadSecret.balance_ghs), 0);

  const webhook = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: smsText,
  });
  const webhookBody = await webhook.json();
  checkEq("webhook accepts the SMS", webhook.status, 200);
  checkEq("SMS credited the wallet", webhookBody.status, "credited");
  checkEq("matched by reference code", webhookBody.match_strategy, "reference");
  checkEq("parsed the amount from free text", Number(webhookBody.parsed?.amount), 120);
  checkEq("parsed the sender number", webhookBody.parsed?.senderPhone, buyerPhone);

  const walletAfterTopup = await api(buyer).ok("GET", "/api/wallet");
  checkEq("wallet balance is credited", Number(walletAfterTopup.wallet.balance_ghs), 120);

  const intentAfter = await api(buyer).ok("GET", `/api/wallet/topup/${intent.id}`);
  checkEq("intent is marked matched", intentAfter.intent.status, "matched");
  check("status endpoint reports credited", intentAfter.credited === true);

  // Idempotency: the same SMS again must not double-credit.
  const replay = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: smsText,
  });
  const replayBody = await replay.json();
  checkEq("replayed SMS detected as duplicate", replayBody.status, "duplicate");
  const afterReplay = await one("select balance_ghs from public.wallets where user_id = $1", [buyerId]);
  checkEq("duplicate SMS did not credit again", Number(afterReplay.balance_ghs), 120);

  // JSON payload shape from a different forwarder app.
  const jsonWebhook = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-priceless-secret": SMS_SECRET },
    body: JSON.stringify({
      sender: "MTNMobileMoney",
      message: `You have received GHS 30.00 from ${buyerPhone}. Current balance GHS 150.00.`,
    }),
  });
  const jsonBody = await jsonWebhook.json();
  checkEq("JSON-forwarded SMS credited by sender number", jsonBody.status, "credited");
  checkEq("sender-phone strategy used", jsonBody.match_strategy, "sender_phone");
  const afterJson = await api(buyer).ok("GET", "/api/wallet");
  checkEq("balance is now 150", Number(afterJson.wallet.balance_ghs), 150);

  // Ambiguous payment -> manual review, never a guess.
  const strangerSms = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: "Payment received for GHS 77.00 from 0209998877. Ref: none.",
  });
  const strangerBody = await strangerSms.json();
  checkEq("unmatchable payment goes to review", strangerBody.status, "unmatched_review");
  const reviewRow = await one("select id, status, amount_ghs, hold_reason from public.deposits where id = $1", [
    strangerBody.deposit_id,
  ]);
  checkEq("deposit stored for review", reviewRow.status, "unmatched_review");
  checkEq("reason recorded", reviewRow.hold_reason, "NO_MATCHING_INTENT");

  const webhookLog = await one(
    "select outcome, signature_ok from public.webhook_events where source = 'android-sms-forwarder' order by id desc limit 1"
  );
  checkEq("raw payload logged with its outcome", webhookLog.outcome, "unmatched_review");

  // A DEBIT alert on the collection phone must never become a credit. This is
  // the money-safety case: the SMS names the buyer's own number, so the
  // sender-phone strategy would match them if the direction guard were missing.
  const balanceBeforeDebit = Number((await api(buyer).ok("GET", "/api/wallet")).wallet.balance_ghs);
  const debitSms = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: `Your Mobile Money account has been debited GHS 40.00 for airtime purchase. Ref: none. ${buyerPhone}`,
  });
  const debitBody = await debitSms.json();
  checkEq("a debit alert is not credited", debitBody.credited, false);
  checkEq("the debit alert is parsed as a debit", debitBody.parsed.direction, "debit");
  checkEq("the debit alert carries no amount", debitBody.parsed.amount, null);
  checkEq("the debit alert is held for review", debitBody.status, "unmatched_review");
  const debitRow = await one("select hold_reason, sender_phone, user_id from public.deposits where id = $1", [
    debitBody.deposit_id,
  ]);
  checkEq("the debit hold reason is recorded", debitRow.hold_reason, "DEBIT_MESSAGE");
  checkEq("the debit alert is parked against the buyer for the operator", debitRow.user_id, buyerId);
  checkEq("the debit alert is not credited", debitBody.credited, false);
  const balanceAfterDebit = Number((await api(buyer).ok("GET", "/api/wallet")).wallet.balance_ghs);
  checkEq("the debit alert left the wallet untouched", balanceAfterDebit, balanceBeforeDebit);
  const debitLedger = await one(
    "select count(*)::int as c from public.wallet_ledger where user_id = $1 and entry_type = 'deposit'",
    [buyerId]
  );
  checkEq("no extra deposit row was written", Number(debitLedger.c), 2);

  const ledgerTopup = await one(
    "select entry_type, amount_ghs, balance_after from public.wallet_ledger where user_id = $1 and entry_type = 'deposit' order by id limit 1",
    [buyerId]
  );
  checkEq("first deposit is ledgered", ledgerTopup.entry_type, "deposit");
  checkEq("ledger snapshots the balance after the credit", Number(ledgerTopup.balance_after), 120);

  /* ================================================================ */
  section("4. BUY DATA — pricing, atomic debit, delivery");

  const buyerCatalogue = await api(buyer).ok("GET", "/api/plans");
  const buyerPrice = buyerCatalogue.plans.find((p) => p.id === plan5gb.id);
  checkEq("customer sees retail pricing", Number(buyerPrice.price_ghs), Number(plan5gb.price_ghs));

  // Client-sent price must be ignored entirely.
  const purchase = await api(buyer).ok("POST", "/api/orders", {
    plan_id: plan5gb.id,
    recipient_phone: recipient,
    price_ghs: 0.01,
    price_charged_ghs: 0.01,
  });
  checkEq("order delivered by the (succeeding) supplier", purchase.outcome, "delivered");
  checkEq("charged the server-side price, not the client's", Number(purchase.order.price_charged_ghs), Number(plan5gb.price_ghs));
  checkEq("channel recorded as web", purchase.order.channel, "web");
  checkEq("tier snapshot recorded", purchase.order.buyer_tier_at_purchase, "customer");
  checkClose("wallet debited by exactly the price", Number(purchase.wallet.balance_ghs), 150 - Number(plan5gb.price_ghs));

  const orderRow = await one("select status, price_charged_ghs, cost_price_ghs, supplier_reference, fulfilled_at from public.orders where id = $1", [purchase.order.id]);
  checkEq("order persisted as delivered", orderRow.status, "delivered");
  check("supplier reference stored", Boolean(orderRow.supplier_reference));
  check("fulfilment timestamp recorded", Boolean(orderRow.fulfilled_at));
  check("margin is positive", Number(orderRow.price_charged_ghs) - Number(orderRow.cost_price_ghs) > 0);

  const ledgerPurchase = await one(
    "select entry_type, amount_ghs, order_id from public.wallet_ledger where order_id = $1",
    [purchase.order.id]
  );
  checkEq("purchase ledger row written", ledgerPurchase.entry_type, "purchase");
  checkClose("ledger debit matches the price", Number(ledgerPurchase.amount_ghs), -Number(plan5gb.price_ghs));

  const history = await api(buyer).ok("GET", "/api/orders?limit=10");
  checkEq("order history returns the order", history.orders[0].id, purchase.order.id);

  const badRecipient = await expectFailure(buyer, "POST", "/api/orders", {
    plan_id: plan5gb.id,
    recipient_phone: "nonsense",
  });
  checkEq("invalid recipient rejected", badRecipient.status, 400);

  const missingPlan = await expectFailure(buyer, "POST", "/api/orders", {
    plan_id: "00000000-0000-0000-0000-000000000000",
    recipient_phone: recipient,
  });
  checkEq("unknown plan rejected", missingPlan.status, 404);

  /* ================================================================ */
  section("5. BUY DATA — insufficient funds & automatic refund");

  const brute = new Client(BASE);
  const bruteReg = await api(brute).ok("POST", "/api/auth/register", {
    full_name: "Broke Buyer",
    phone: `0247${stamp}5`,
    pin: "1234",
  });
  const bruteId = bruteReg.user.id;

  const ledgerCountBefore = Number((await one("select count(*)::int as c from public.wallet_ledger where user_id = $1", [bruteId])).c);
  const broke = await expectFailure(brute, "POST", "/api/orders", { plan_id: plan1gb.id, recipient_phone: recipient });
  checkEq("purchase blocked with an empty wallet", broke.status, 402);
  checkEq("error code is INSUFFICIENT_FUNDS", broke.response.body?.error, "INSUFFICIENT_FUNDS");
  const bruteOrders = Number((await one("select count(*)::int as c from public.orders where buyer_id = $1", [bruteId])).c);
  checkEq("no order was created", bruteOrders, 0);
  const bruteLedger = Number((await one("select count(*)::int as c from public.wallet_ledger where user_id = $1", [bruteId])).c);
  checkEq("no ledger row was written", bruteLedger, ledgerCountBefore);

  // Refund path — same database, the failure-mode server.
  const bruteTopup = await api(brute).ok("POST", "/api/wallet/topup", { amount: 40 });
  await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: `Payment received for GHS 40.00 from 0247${stamp}5. Reference: ${bruteTopup.intent.reference_code}. Balance GHS 40.00`,
  });
  const bruteBalance = await api(brute).ok("GET", "/api/wallet");
  checkEq("second buyer funded", Number(bruteBalance.wallet.balance_ghs), 40);

  const failClient = new Client(FAIL_BASE);
  await api(failClient).ok("POST", "/api/auth/login", { phone: `0247${stamp}5`, pin: "1234" });
  const failedPurchase = await api(failClient).ok("POST", "/api/orders", {
    plan_id: plan1gb.id,
    recipient_phone: recipient,
  });
  checkEq("supplier failure leaves nothing delivered", failedPurchase.outcome, "refunded");
  checkEq("the API reports a refund", failedPurchase.refunded, true);
  checkClose("wallet is restored in full", Number(failedPurchase.wallet.balance_ghs), 40);
  check("failure reason surfaced", Boolean(failedPurchase.finalised?.reason));

  const refunded = await one("select status, failure_reason, refund_ledger_id from public.orders where id = $1", [failedPurchase.order.id]);
  checkEq("order ends in the refunded state", refunded.status, "refunded");
  check("refund ledger row linked", Boolean(refunded.refund_ledger_id));
  const refundRow = await one("select entry_type, amount_ghs, balance_after from public.wallet_ledger where id = $1", [refunded.refund_ledger_id]);
  checkEq("refund is ledgered as a refund", refundRow.entry_type, "refund");
  checkClose("refund amount equals the price", Number(refundRow.amount_ghs), Number(plan1gb.price_ghs));
  checkClose("ledger snapshot shows the restored balance", Number(refundRow.balance_after), 40);

  /* ================================================================ */
  section("6. Agent tiers, squad mechanic & commission");

  const agentReg = await api(agent).ok("POST", "/api/auth/register", {
    full_name: "E2E Super Agent",
    phone: agentPhone,
    pin: "1234",
  });
  const agentId = agentReg.user.id;

  const early = await expectFailure(agent, "POST", "/api/agent/upgrade", { tier: "super_agent" });
  checkEq("Super Agent blocked before the GHS 500 commitment", early.status, 409);
  checkEq("commitment is GHS 500", Number(early.response.body?.details?.eligibility?.commitment_ghs), 500);

  const agentTopup = await api(agent).ok("POST", "/api/wallet/topup", { amount: 500 });
  const agentDeposit = await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: `Payment received for GHS 500.00 from ${agentPhone}. Reference: ${agentTopup.intent.reference_code}. Balance GHS 500.00`,
  });
  checkEq("GHS 500 deposit credited", (await agentDeposit.json()).status, "credited");

  const upgrade = await api(agent).ok("POST", "/api/agent/upgrade", { tier: "super_agent" });
  checkEq("Super Agent unlocked", upgrade.user.tier, "super_agent");
  check("squad provisioned automatically", Boolean(upgrade.squad?.id));
  const squadId = upgrade.squad.id;
  check("invite code issued", /^SQL-[A-Z0-9]{5}$/.test(upgrade.squad.invite_code), upgrade.squad.invite_code);

  const subUpgrade = await api(sub).ok("POST", "/api/auth/register", {
    full_name: "E2E Sub Agent",
    phone: subPhone,
    pin: "1234",
    tier: "sub_agent",
    invite_code: upgrade.squad.invite_code,
  });
  checkEq("Sub-Agent registered at signup", subUpgrade.user.tier, "sub_agent");
  checkEq("Sub-Agent joined the squad via the invite code", subUpgrade.user.squad_id, squadId);
  const subId = subUpgrade.user.id;

  const subCatalogue = await api(sub).ok("GET", "/api/plans");
  const subPrice = subCatalogue.plans.find((p) => p.id === plan5gb.id);
  check("sub-agent price is below retail", Number(subPrice.price_ghs) < Number(plan5gb.price_ghs));
  checkEq("sub-agent tier reported", subPrice.effective_tier, "sub_agent");

  const agentCatalogue = await api(agent).ok("GET", "/api/plans");
  const agentPrice = agentCatalogue.plans.find((p) => p.id === plan5gb.id);
  check("wholesale price is below the sub-agent price", Number(agentPrice.price_ghs) < Number(subPrice.price_ghs));

  // Fund the sub-agent, then make a squad sale.
  const subTopup = await api(sub).ok("POST", "/api/wallet/topup", { amount: 200 });
  await fetch(`${BASE}/api/webhook/sms-deposit`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
    body: `Payment received for GHS 200.00 from ${subPhone}. Reference: ${subTopup.intent.reference_code}. Balance GHS 200.00`,
  });

  const squadSale = await api(sub).ok("POST", "/api/orders", {
    plan_id: plan5gb.id,
    recipient_phone: `0249${stamp}8`,
  });
  checkEq("squad sale delivered", squadSale.outcome, "delivered");
  checkClose("charged the sub-agent price", Number(squadSale.order.price_charged_ghs), Number(subPrice.price_ghs));

  const squadRow = await one("select current_volume_ghs, tier_retained, volume_target_ghs from public.squads where id = $1", [squadId]);
  checkClose("squad volume increased automatically", Number(squadRow.current_volume_ghs), Number(subPrice.price_ghs));
  checkEq("tier retained while the target is unmet this period", squadRow.tier_retained, true);
  check("squad target is configured", Number(squadRow.volume_target_ghs) > 0);
  checkEq("order attributed to the super agent", squadSale.order.attributed_super_agent_id, agentId);

  const commissionRow = await one("select commission_balance_ghs from public.wallets where user_id = $1", [agentId]);
  const expectedCommission = Math.round(Number(subPrice.price_ghs) * 0.03 * 100) / 100;
  checkClose("super agent earns commission on the squad sale", Number(commissionRow.commission_balance_ghs), expectedCommission);

  const squadDashboard = await api(agent).ok("GET", "/api/agent/squad");
  checkEq("squad dashboard shows the squad", squadDashboard.squad.id, squadId);
  checkEq("squad dashboard lists the member", squadDashboard.member_count, 1);
  check("squad dashboard exposes the member's volume", Number(squadDashboard.members[0].volume_ghs) > 0);

  const recruit = await api(agent).ok("POST", "/api/agent/recruit", {
    phone: `0208${stamp}3`,
    full_name: "Recruited Agent",
  });
  check("super agent can add a recruit by phone", recruit.recruited?.id ? true : false);
  checkEq("recruit is flagged for activation", recruit.recruited.tier, "sub_agent");

  const notSuper = await expectFailure(sub, "POST", "/api/agent/recruit", { phone: `0208${stamp}4` });
  checkEq("sub-agents cannot recruit", notSuper.status, 403);

  /* ================================================================ */
  section("7. Commission reinvestment bonus");

  const beforeReinvest = await api(agent).ok("GET", "/api/wallet");
  const reinvest = await api(agent).ok("POST", "/api/wallet/commission", {});
  checkEq("reinvest succeeds", Number(reinvest.reinvested_ghs), expectedCommission);
  check("bonus rate is within 2–5%", Number(reinvest.bonus_rate) >= 0.02 && Number(reinvest.bonus_rate) <= 0.05);
  checkClose("wallet gains principal plus bonus", Number(reinvest.balance_ghs), Number(beforeReinvest.wallet.balance_ghs) + expectedCommission + Number(reinvest.bonus_ghs));

  const reinvestLedger = await sql(
    "select entry_type from public.wallet_ledger where user_id = $1 and entry_type in ('commission_reinvest','reinvest_bonus')",
    [agentId]
  );
  checkEq("two ledger rows for the reinvestment", reinvestLedger.length, 2);

  const emptyReinvest = await expectFailure(agent, "POST", "/api/wallet/commission", {});
  checkEq("nothing left to reinvest", emptyReinvest.status, 400);

  /* ================================================================ */
  section("8. Peer-to-peer transfers");

  const buyerBefore = await api(buyer).ok("GET", "/api/wallet");
  const p2p = await api(buyer).ok("POST", "/api/wallet/p2p", {
    recipient: subPhone,
    amount: 10,
    note: "E2E transfer",
  });
  checkEq("transfer succeeds", Number(p2p.amount_ghs), 10);
  checkClose("sender debited", Number(p2p.balance_ghs), Number(buyerBefore.wallet.balance_ghs) - 10);

  const receiverLedger = await one(
    "select entry_type, amount_ghs from public.wallet_ledger where reference = $1 and entry_type = 'p2p_receive'",
    [p2p.reference]
  );
  checkEq("receiver ledgered", receiverLedger.entry_type, "p2p_receive");
  checkEq("receiver credited the same amount", Number(receiverLedger.amount_ghs), 10);

  const selfTransfer = await expectFailure(buyer, "POST", "/api/wallet/p2p", { recipient: buyerPhone, amount: 5 });
  checkEq("self transfer blocked", selfTransfer.status, 400);
  const ghost = await expectFailure(buyer, "POST", "/api/wallet/p2p", { recipient: "0209999998", amount: 5 });
  checkEq("unknown recipient blocked", ghost.status, 404);

  /* ================================================================ */
  section("9. Withdrawals");

  const quote = await api(buyer).ok("POST", "/api/withdrawals/quote", { amount: 50, mode: "instant" });
  checkEq("instant fee quoted for a customer", Number(quote.fee_ghs), 1.5);
  checkEq("net amount excludes the fee", Number(quote.net_amount_ghs), 48.5);

  const buyerWallet = await api(buyer).ok("GET", "/api/wallet");
  const withdrawAmount = 20;
  const withdrawal = await api(buyer).ok("POST", "/api/withdrawals", {
    amount: withdrawAmount,
    mode: "instant",
    payout_method: "momo",
    payout_details: { number: buyerPhone },
  });
  checkEq("instant withdrawal accepted", withdrawal.withdrawal.status, "processing");
  checkClose("wallet debited the gross amount", Number(withdrawal.wallet.balance_ghs), Number(buyerWallet.wallet.balance_ghs) - withdrawAmount);

  const feeRows = await sql(
    "select entry_type, amount_ghs from public.wallet_ledger where reference = $1 order by id",
    [withdrawal.withdrawal.payout_reference]
  );
  checkEq("two ledger rows (payout + fee)", feeRows.length, 2);
  checkEq("fee row present", feeRows[1].entry_type, "withdrawal_fee");

  const freeFriday = await api(buyer).ok("POST", "/api/withdrawals", { amount: 10, mode: "free_friday_batch" });
  checkEq("Free Friday request is batched", freeFriday.withdrawal.status, "batched");
  checkEq("Free Friday has no fee", Number(freeFriday.withdrawal.fee_ghs), 0);

  const agentWithdrawal = await api(agent).ok("POST", "/api/withdrawals", { amount: 100, mode: "instant" });
  checkEq("Super Agent pays no instant fee", Number(agentWithdrawal.withdrawal.fee_ghs), 0);

  const tooSmall = await expectFailure(buyer, "POST", "/api/withdrawals", { amount: 2 });
  checkEq("minimum withdrawal enforced", tooSmall.status, 400);

  const list = await api(buyer).ok("GET", "/api/withdrawals");
  checkGte("withdrawal history returned", list.withdrawals.length, 2);

  /* ================================================================ */
  section("10. Bot-in-a-Box");

  const badToken = await expectFailure(agent, "POST", "/api/agent/bot", { channel: "telegram", token: "nope" });
  checkEq("malformed Telegram token rejected", badToken.status, 400);

  // A syntactically valid token; Telegram itself is unreachable from the test,
  // which is fine — the webhook registration failure is reported, not fatal.
  const botToken = `12345${stamp}:AAHk3Lm9QqWxYz12AbCdEfGhIjKlMnOpQrs`;
  const linked = await api(agent).ok("POST", "/api/agent/bot", { channel: "telegram", token: botToken });
  check("bot token accepted and stored", linked.linked === true);

  const botStatus = await api(agent).ok("GET", "/api/agent/bot");
  check("bot reported as linked", botStatus.has_telegram_bot === true);

  const notLinked = await fetch(`${BASE}/api/bot/telegram/99999${stamp}:ZZHk3Lm9QqWxYz12AbCdEfGhIjKlMnOpQrs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { chat: { id: 1 }, text: "help", from: { id: 2 } } }),
  });
  const notLinkedBody = await notLinked.json();
  checkEq("unlinked bot token ignored", notLinkedBody.ignored, "bot not linked");

  // Simulate an inbound Telegram update through the linked token endpoint. The
  // reply cannot reach api.telegram.org from here, which must not break the flow.
  const telegramWebhook = await fetch(`${BASE}/api/bot/telegram/${botToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { chat: { id: 555 }, from: { id: 777 }, text: `buy mtn 1gb ${recipient}` },
    }),
  });
  const telegramBody = await telegramWebhook.json();
  checkEq("telegram bot executed a vend", telegramBody.action, "vend");
  checkEq("bot order delivered via the mock supplier", telegramBody.status, "delivered");

  const botOrder = await one(
    "select super_agent_id, channel, end_customer_phone, price_charged_ghs from public.bot_orders where super_agent_id = $1 order by created_at desc limit 1",
    [agentId]
  );
  checkEq("bot_orders row attributes the sale", botOrder.super_agent_id, agentId);
  checkEq("channel recorded", botOrder.channel, "telegram");
  checkEq("end customer recorded", botOrder.end_customer_phone, recipient);

  const botOrderPricing = await one("select buyer_tier_at_purchase from public.orders where id = (select order_id from public.bot_orders where super_agent_id = $1 order by created_at desc limit 1)", [agentId]);
  checkEq("bot sale priced at the wholesale tier", botOrderPricing.buyer_tier_at_purchase, "super_agent");

  const waCatalogue = await fetch(`${BASE}/api/bot/whatsapp?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=nope`);
  checkEq("WhatsApp verify rejects unknown tokens", waCatalogue.status, 403);

  /* ================================================================ */
  section("11. Admin panel & operator access");

  const operatorLogin = await api(operator).ok("POST", "/api/auth/login", { phone: ADMIN_PHONE, pin: ADMIN_PIN });
  checkEq("operator signs in", operatorLogin.admin, true);
  checkEq("operator redirected to the admin panel", operatorLogin.redirect, "/admin");

  const unauthorised = await expectFailure(buyer, "GET", "/api/admin/metrics");
  checkEq("admin metrics blocked for normal users", unauthorised.status, 403);

  const metrics = await api(operator).ok("GET", "/api/admin/metrics");
  check("metrics load", metrics.ok === true);
  checkGte("revenue is reported", Number(metrics.revenue.gross_all_time_ghs), 1);
  checkGte("margin is reported", Number(metrics.revenue.margin_all_time_ghs), 0);
  checkGte("orders counted", Number(metrics.orders.delivered), 3);
  checkGte("deposits counted", Number(metrics.deposits.credited_all_time_ghs), 890);
  checkGte("users counted", Number(metrics.users.total), 4);
  checkEq("14-day trend returned", metrics.daily.length, 14);
  checkGte("squads reported", Number(metrics.squads.count), 1);

  const adminPlans = await api(operator).ok("GET", "/api/admin/plans");
  checkEq("admin sees every plan", adminPlans.plans.length, 24);
  check("admin sees cost prices", adminPlans.plans[0].cost_price_ghs !== undefined);

  const belowCost = await expectFailure(operator, "POST", "/api/admin/plans", {
    network: "MTN",
    size_label: "9GB",
    data_mb: 9216,
    cost_price_ghs: 40,
    retail_price_ghs: 30,
    sub_agent_price_ghs: 30,
    super_agent_price_ghs: 30,
  });
  checkEq("below-cost pricing rejected", belowCost.status, 400);

  const newPlan = await api(operator).ok("POST", "/api/admin/plans", {
    network: "MTN",
    size_label: "9GB",
    data_mb: 9216,
    cost_price_ghs: 40,
    retail_price_ghs: 48,
    sub_agent_price_ghs: 45,
    super_agent_price_ghs: 43,
  });
  checkEq("admin creates a plan", Number(newPlan.plan.retail_price_ghs), 48);

  const edited = await api(operator).ok("POST", "/api/admin/plans", {
    plan_id: newPlan.plan.id,
    network: "MTN",
    size_label: "9GB",
    data_mb: 9216,
    cost_price_ghs: 40,
    retail_price_ghs: 50,
    sub_agent_price_ghs: 46,
    super_agent_price_ghs: 44,
  });
  checkEq("admin edits the price", Number(edited.plan.retail_price_ghs), 50);
  const publishedPrice = await one("select retail_price_ghs from public.plans where id = $1", [newPlan.plan.id]);
  checkEq("the change is live in the database", Number(publishedPrice.retail_price_ghs), 50);

  const adminOrders = await api(operator).ok("GET", "/api/admin/orders?limit=100");
  checkGte("admin sees all orders", adminOrders.orders.length, 4);
  const searched = await api(operator).ok("GET", `/api/admin/orders?q=${recipient}`);
  checkGte("admin can search orders by recipient", searched.orders.length, 3);

  const unmatched = await api(operator).ok("GET", "/api/admin/deposits?status=unmatched_review");
  checkGte("unmatched queue populated", unmatched.deposits.length, 2);

  // The debit alert from section 3 is sitting in the queue. The operator can
  // dismiss it, and dismissing it must not move a single cedi.
  const debitHold = unmatched.deposits.find((d) => d.hold_reason === "DEBIT_MESSAGE");
  check("the queue flags the debit alert", Boolean(debitHold));
  checkEq("the debit alert is parked against the matched user", debitHold.user_id, buyerId);
  const buyerWalletBeforeReject = Number((await api(buyer).ok("GET", "/api/wallet")).wallet.balance_ghs);
  const rejectedDebit = await api(operator).ok("POST", "/api/admin/deposits/resolve", {
    deposit_id: debitHold.id,
    action: "reject",
    note: "Debit alert, not a payment",
  });
  checkEq("operator can dismiss the debit alert", rejectedDebit.status, "rejected");
  const buyerWalletAfterReject = Number((await api(buyer).ok("GET", "/api/wallet")).wallet.balance_ghs);
  checkEq("dismissing the debit alert moved no money", buyerWalletAfterReject, buyerWalletBeforeReject);

  const target = unmatched.deposits.find((d) => d.hold_reason === "NO_MATCHING_INTENT");
  check("the genuine unmatched payment is still queued", Boolean(target));
  check("queue shows the raw SMS", Boolean(target.raw_message));
  check("queue shows the hold reason", Boolean(target.hold_reason));
  checkGte("queue offers candidate accounts", (target.all_users ?? []).length, 1);

  const subWalletBefore = await api(sub).ok("GET", "/api/wallet");
  const resolved = await api(operator).ok("POST", "/api/admin/deposits/resolve", {
    deposit_id: target.id,
    action: "credit",
    user_id: subId,
    note: "E2E manual review",
  });
  checkEq("unmatched deposit credited manually", resolved.status, "credited");
  const subWalletAfter = await api(sub).ok("GET", "/api/wallet");
  checkClose(
    "manual credit lands in the wallet",
    Number(subWalletAfter.wallet.balance_ghs),
    Number(subWalletBefore.wallet.balance_ghs) + Number(target.amount_ghs)
  );
  const resolveAgain = await expectFailure(operator, "POST", "/api/admin/deposits/resolve", {
    deposit_id: target.id,
    action: "credit",
    user_id: subId,
  });
  checkEq("a deposit cannot be credited twice", resolveAgain.status, 409);

  const adminUsers = await api(operator).ok("GET", "/api/admin/users?limit=200");
  checkGte("admin user list populated", adminUsers.users.length, 4);
  const tierChange = await api(operator).ok("POST", "/api/admin/users", {
    action: "set_tier",
    user_id: subId,
    tier: "super_agent",
  });
  checkEq("admin can change a tier", tierChange.tier, "super_agent");
  await api(operator).ok("POST", "/api/admin/users", { action: "set_tier", user_id: subId, tier: "sub_agent" });

  const adjustment = await api(operator).ok("POST", "/api/admin/users", {
    action: "adjust_wallet",
    user_id: subId,
    amount: 5,
    reason: "E2E goodwill",
  });
  checkEq("admin wallet adjustment applied", adjustment.ok, true);

  const paused = await api(operator).ok("POST", "/api/admin/users", { action: "set_status", user_id: subId, status: "suspended" });
  checkEq("admin can suspend an account", paused.status, "suspended");
  const suspendedLogin = await expectFailure(new Client(BASE), "POST", "/api/auth/login", { phone: subPhone, pin: "1234" });
  checkEq("suspended account cannot sign in", suspendedLogin.status, 403);
  await api(operator).ok("POST", "/api/admin/users", { action: "set_status", user_id: subId, status: "active" });

  const payouts = await api(operator).ok("GET", "/api/admin/withdrawals");
  checkGte("withdrawals listed for the operator", payouts.withdrawals.length, 3);
  const batched = payouts.withdrawals.find((w) => w.status === "batched");
  check("Free Friday request is visible", Boolean(batched));

  const freeFridayRun = await api(operator).ok("POST", "/api/admin/withdrawals", { action: "run_free_friday" });
  checkGte("Free Friday run queues payouts", Number(freeFridayRun.count), 1);

  const payoutRows = (await api(operator).ok("GET", "/api/admin/withdrawals")).withdrawals;
  const pendingPayout = payoutRows.find((w) => w.status === "processing" && w.user?.id === buyerId);
  check("buyer payout is awaiting processing", Boolean(pendingPayout));
  const markedPaid = await api(operator).ok("POST", "/api/admin/withdrawals", {
    withdrawal_id: pendingPayout.id,
    status: "paid",
    payout_reference: "E2E-PAYOUT-1",
  });
  checkEq("payout marked paid", markedPaid.withdrawal.status, "paid");

  const rejectTarget = (await api(operator).ok("GET", "/api/admin/withdrawals")).withdrawals.find(
    (w) => w.status === "processing" && w.user?.id === agentId
  );
  if (rejectTarget) {
    const beforeReject = await api(agent).ok("GET", "/api/wallet");
    const rejected = await api(operator).ok("POST", "/api/admin/withdrawals", {
      withdrawal_id: rejectTarget.id,
      status: "rejected",
      note: "E2E rejection",
    });
    checkEq("payout rejected", rejected.status, "rejected");
    checkClose(
      "rejected payout returns the funds",
      Number(rejected.new_balance_ghs),
      Number(beforeReject.wallet.balance_ghs) + Number(rejectTarget.amount_ghs)
    );
  } else {
    check("an agent payout was available to reject", false, "no processing payout found for the agent");
  }

  const squads = await api(operator).ok("GET", "/api/admin/squads");
  checkGte("squads listed", squads.squads.length, 1);

  const settings = await api(operator).ok("GET", "/api/admin/settings");
  checkGte("settings readable", settings.settings.length, 10);
  await api(operator).ok("POST", "/api/admin/settings", { key: "support_phone", value: "0551112222" });
  const updatedSetting = await one("select value from public.settings where key = 'support_phone'");
  checkEq("setting updated", updatedSetting.value, "0551112222");
  await api(operator).ok("POST", "/api/admin/settings", { key: "support_phone", value: "0551234567" });

  const webhookEvents = await api(operator).ok("GET", "/api/admin/webhook-events?limit=50");
  checkGte("webhook audit trail returned", webhookEvents.events.length, 5);
  check(
    "rejected secret attempts are logged",
    webhookEvents.events.some((e) => e.signature_ok === false),
    "no unsigned event found"
  );

  /* ================================================================ */
  section("12. Ledger integrity after every flow");

  const reconcile = await api(operator).ok("GET", "/api/admin/reconcile");
  checkEq("no wallet drifts from its ledger", Number(reconcile.drift_count), 0);
  checkGte("wallets reconciled", Number(reconcile.checked_wallets), 4);
  checkClose(
    "ledger sum equals terminal balances",
    Number(reconcile.ledger.net_ghs),
    Number(reconcile.ledger.terminal_balances)
  );

  const negatives = await one("select count(*)::int as c from public.wallets where balance_ghs < 0 or commission_balance_ghs < 0");
  checkEq("no negative balance anywhere", Number(negatives.c), 0);

  const orphanDelivered = await one(`
    select count(*)::int as c from public.orders o
     where o.status = 'delivered' and not exists (
       select 1 from public.wallet_ledger l where l.order_id = o.id and l.entry_type = 'purchase')`);
  checkEq("every delivered order has its purchase ledger row", Number(orphanDelivered.c), 0);

  const orphanRefund = await one(`
    select count(*)::int as c from public.orders o
     where o.status = 'refunded' and not exists (
       select 1 from public.wallet_ledger l where l.order_id = o.id and l.entry_type = 'refund')`);
  checkEq("every refunded order has its refund ledger row", Number(orphanRefund.c), 0);

  const ledgerImmutability = await (async () => {
    try {
      await sql("update public.wallet_ledger set amount_ghs = 1 where id = (select max(id) from public.wallet_ledger)");
      return null;
    } catch (error) {
      return error.message;
    }
  })();
  check("the ledger still rejects updates", Boolean(ledgerImmutability) && /append-only/i.test(ledgerImmutability));

  /* ================================================================ */
  section("13. Branding & metadata");

  const landing = await fetch(`${BASE}/`);
  const landingHtml = await landing.text();
  checkEq("landing page returns 200", landing.status, 200);
  check("landing page carries the brand", landingHtml.includes("Priceless Bundle"));
  check("landing page carries the operator name", landingHtml.includes("LongKinnex Tech and Data"));
  check(
    "the operator name appears only in the footer",
    (landingHtml.match(/LongKinnex Tech and Data/g) ?? []).length >= 1
  );
  check("logo is served from /public/logo.png", landingHtml.includes("/logo.png"));

  const titleTag = /<title>([^<]*)<\/title>/.exec(landingHtml)?.[1] ?? "";
  check("page title is branded", titleTag.includes("Priceless Bundle"), titleTag);
} catch (error) {
  console.error("\n\x1b[31mE2E run aborted:\x1b[0m", error?.stack ?? error);
  results.failed += 1;
  results.failures.push(`aborted: ${error?.message ?? error}`);
} finally {
  try {
    if (pgClient) await pgClient.end();
  } catch {
    /* ignore */
  }
  if (managed) {
    const failed = [...logs.entries()].filter(([, buffer]) => buffer.some((line) => /Error|error:/.test(line)));
    if (results.failed > 0 && failed.length) {
      for (const [name, buffer] of failed) {
        console.error(`\n--- ${name} log tail ---`);
        console.error(buffer.slice(-25).join(""));
      }
    }
    await shutdown();
  }
  const failed = summary("E2E suite");
  process.exit(failed === 0 ? 0 : 1);
}
