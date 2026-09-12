#!/usr/bin/env node
/**
 * DEPLOYMENT SMOKE TEST / LIVE WALKTHROUGH
 *
 * Walks the two money flows against a running deployment and prints what
 * actually happened, reading the real rows back out of Postgres:
 *
 *   1. wallet top-up  — request a reference code, POST the confirmation SMS to
 *                       the webhook (exactly as the Android forwarder does),
 *                       confirm the wallet and the ledger.
 *   2. buy data       — confirm the server ignores a tampered client price,
 *                       confirm the wallet debit and the order row.
 *
 * Usage:
 *   BASE_URL=https://priceless.example.com DATABASE_URL=postgres://... node scripts/smoke.mjs
 *   node scripts/smoke.mjs                     # localhost:3000 + local database
 */

import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SMS_SECRET = process.env.SMS_WEBHOOK_SECRET ?? "local-sms-forwarder-secret";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55432/postgres";

const colour = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const green = (t) => colour(32, t);
const red = (t) => colour(31, t);
const dim = (t) => colour(90, t);
const bold = (t) => colour(1, t);

let failures = 0;
function step(name, detail) {
  console.log(`\n${bold("▸ " + name)}`);
  if (detail) console.log(dim(`  ${detail}`));
}
function pass(message, detail) {
  console.log(`  ${green("✓")} ${message}${detail ? dim(`  ${detail}`) : ""}`);
}
function fail(message, detail) {
  failures += 1;
  console.log(`  ${red("✗")} ${message}${detail ? `  ${detail}` : ""}`);
}

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async request(method, path, body, raw = false) {
    const headers = {};
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body && !raw) headers["Content-Type"] = "application/json";
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    for (const cookie of cookies) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: response.status, ok: response.ok, body: json, text };
  }
}

let pg = null;
async function sql(text, params = []) {
  if (!pg) {
    const { default: nodePg } = await import("pg");
    pg = new nodePg.Client({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
    });
    await pg.connect();
  }
  return (await pg.query(text, params)).rows;
}

const stamp = Date.now().toString().slice(-5);
const phone = `0271${stamp}0`;
const recipient = `0271${stamp}7`;

console.log(bold("\n🔥 Priceless Bundle — live walkthrough"));
console.log(dim(`   app: ${BASE}`));
console.log(dim(`   db : ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`));

const client = new Client();

/* ------------------------------------------------------------------ */
step("0. Health", "GET /api/health");
const health = await client.request("GET", "/api/health");
if (health.body?.ok && health.body.database === "up") {
  pass("database reachable", `brand=${health.body.health.brand} plans=${health.body.health.plans}`);
} else {
  fail("health check failed", JSON.stringify(health.body).slice(0, 160));
  process.exit(1);
}

/* ------------------------------------------------------------------ */
step("1. Create an account", `phone ${phone}`);
const signup = await client.request("POST", "/api/auth/register", {
  full_name: "Walkthrough User",
  phone,
  pin: "4321",
});
if (signup.body?.ok) {
  pass("account created", `tier=${signup.body.user.tier} id=${signup.body.user.id.slice(0, 8)}…`);
} else {
  fail("registration failed", signup.text.slice(0, 160));
  process.exit(1);
}
const userId = signup.body.user.id;

/* ------------------------------------------------------------------ */
step("2. WALLET TOP-UP — request a reference code", "POST /api/wallet/topup");
const topup = await client.request("POST", "/api/wallet/topup", { amount: 80, channel: "momo" });
if (!topup.body?.ok) {
  fail("could not create a top-up request", topup.text.slice(0, 160));
  process.exit(1);
}
const intent = topup.body.intent;
pass("reference code issued", intent.reference_code);
pass("collection number", intent.collection_number);
pass("amount expected", `GHS ${Number(intent.expected_amount_ghs).toFixed(2)}`);
console.log(dim(`  → the user now dials MoMo and sends GHS ${Number(intent.expected_amount_ghs).toFixed(2)} to ${intent.collection_number}`));
console.log(dim(`  → with "${intent.reference_code}" as the reference`));

step("3. WALLET TOP-UP — the collection phone forwards the confirmation SMS", "POST /api/webhook/sms-deposit");
const smsText =
  `Payment received for GHS 80.00 from ${phone}. Reference: ${intent.reference_code}. ` +
  `Your new balance is GHS 80.00. Transaction ID ${stamp}AB.`;
console.log(dim(`  payload: "${smsText}"`));

const webhook = await fetch(`${BASE}/api/webhook/sms-deposit`, {
  method: "POST",
  headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
  body: smsText,
});
const webhookBody = await webhook.json();

if (webhookBody.status === "credited") {
  pass("SMS credited automatically", `strategy=${webhookBody.match_strategy} parsed=GHS ${webhookBody.parsed?.amount}`);
} else {
  fail("SMS was not credited", JSON.stringify(webhookBody).slice(0, 200));
}

const walletRow = (await sql("select balance_ghs, total_deposited_ghs from public.wallets where user_id = $1", [userId]))[0];
const depositRow = (
  await sql("select status, match_strategy, amount_ghs, sender_phone from public.deposits where id = $1", [webhookBody.deposit_id])
)[0];
const ledgerRow = (
  await sql(
    "select entry_type, amount_ghs, balance_after, reference from public.wallet_ledger where user_id = $1 order by id limit 1",
    [userId]
  )
)[0];

console.log(dim("  database rows:"));
console.log(dim(`    wallets        balance=${walletRow.balance_ghs} deposited=${walletRow.total_deposited_ghs}`));
console.log(dim(`    deposits       status=${depositRow.status} strategy=${depositRow.match_strategy} amount=${depositRow.amount_ghs}`));
console.log(dim(`    wallet_ledger  ${ledgerRow.entry_type} ${ledgerRow.amount_ghs} -> balance_after=${ledgerRow.balance_after}`));

if (Number(walletRow.balance_ghs) === 80) pass("wallet credited with GHS 80.00");
else fail("wallet balance is wrong", `got ${walletRow.balance_ghs}`);
if (Number(ledgerRow.balance_after) === 80) pass("ledger snapshots the resulting balance");
else fail("ledger snapshot is wrong", `got ${ledgerRow.balance_after}`);

step("3b. Replay the same SMS (idempotency check)");
const replay = await fetch(`${BASE}/api/webhook/sms-deposit`, {
  method: "POST",
  headers: { "Content-Type": "text/plain", "x-priceless-secret": SMS_SECRET },
  body: smsText,
});
const replayBody = await replay.json();
if (replayBody.status === "duplicate") pass("duplicate SMS ignored — no double credit");
else fail("duplicate SMS was not detected", JSON.stringify(replayBody).slice(0, 160));
const afterReplay = (await sql("select balance_ghs from public.wallets where user_id = $1", [userId]))[0];
if (Number(afterReplay.balance_ghs) === 80) pass("balance still GHS 80.00");
else fail("balance changed on replay", `got ${afterReplay.balance_ghs}`);

/* ------------------------------------------------------------------ */
step("4. BUY DATA — read the price list for this user", "GET /api/plans");
const plans = await client.request("GET", "/api/plans");
const plan = plans.body.plans.find((p) => p.network === "MTN" && p.size_label === "5GB");
pass("catalogue loaded", `${plans.body.plans.length} bundles, tier=${plans.body.tier}`);
pass("this user's price for MTN 5GB", `GHS ${Number(plan.price_ghs).toFixed(2)} (list GHS ${Number(plan.list_price_ghs).toFixed(2)})`);

step("5. BUY DATA — purchase with a tampered client price", "POST /api/orders { price_ghs: 0.01 }");
console.log(dim("  the request claims the bundle costs GHS 0.01 — the server must ignore it"));
const purchase = await client.request("POST", "/api/orders", {
  plan_id: plan.id,
  recipient_phone: recipient,
  price_ghs: 0.01,
  price_charged_ghs: 0.01,
});

if (!purchase.body?.ok) {
  fail("purchase failed", purchase.text.slice(0, 200));
} else {
  pass("order outcome", purchase.body.outcome);
  pass("price actually charged", `GHS ${Number(purchase.body.order.price_charged_ghs).toFixed(2)}`);
  if (Number(purchase.body.order.price_charged_ghs) === Number(plan.price_ghs)) {
    pass("client-sent price was ignored — server-side pricing held");
  } else {
    fail("server trusted the client price!", `charged ${purchase.body.order.price_charged_ghs}`);
  }
}

const orderRow = (
  await sql(
    "select status, network, size_label, recipient_phone, price_charged_ghs, cost_price_ghs, supplier_reference, buyer_tier_at_purchase from public.orders where buyer_id = $1 order by created_at desc limit 1",
    [userId]
  )
)[0];
const purchaseLedger = (
  await sql("select entry_type, amount_ghs, balance_after from public.wallet_ledger where user_id = $1 order by id desc limit 1", [userId])
)[0];
const finalWallet = (await sql("select balance_ghs, total_spent_ghs from public.wallets where user_id = $1", [userId]))[0];

console.log(dim("  database rows:"));
console.log(
  dim(
    `    orders         ${orderRow.network} ${orderRow.size_label} -> ${orderRow.recipient_phone} ` +
      `[${orderRow.status}] price=${orderRow.price_charged_ghs} cost=${orderRow.cost_price_ghs}`
  )
);
console.log(dim(`                   supplier_ref=${orderRow.supplier_reference} tier_at_purchase=${orderRow.buyer_tier_at_purchase}`));
console.log(dim(`    wallet_ledger  ${purchaseLedger.entry_type} ${purchaseLedger.amount_ghs} -> balance_after=${purchaseLedger.balance_after}`));
console.log(dim(`    wallets        balance=${finalWallet.balance_ghs} spent=${finalWallet.total_spent_ghs}`));

const expected = Math.round((80 - Number(plan.price_ghs)) * 100) / 100;
if (Number(finalWallet.balance_ghs) === expected) pass(`wallet debited correctly (GHS 80.00 → GHS ${expected.toFixed(2)})`);
else fail("wallet balance after purchase is wrong", `expected ${expected}, got ${finalWallet.balance_ghs}`);

step("6. BUY DATA — attempt the same purchase with an empty wallet");
const empty = new Client();
await empty.request("POST", "/api/auth/register", { full_name: "Skint User", phone: `0272${stamp}1`, pin: "4321" });
const blocked = await empty.request("POST", "/api/orders", { plan_id: plan.id, recipient_phone: recipient });
if (blocked.status === 402 && blocked.body?.error === "INSUFFICIENT_FUNDS") {
  pass("purchase blocked atomically", blocked.body.message.slice(0, 90));
} else {
  fail("insufficient-funds guard failed", `${blocked.status} ${blocked.text.slice(0, 120)}`);
}
const emptyOrders = (await sql("select count(*)::int as c from public.orders o join public.users u on u.id = o.buyer_id where u.phone = $1", [`0272${stamp}1`]))[0];
if (emptyOrders.c === 0) pass("no partial order was created");
else fail("an order was created despite insufficient funds");

/* ------------------------------------------------------------------ */
step("7. Ledger integrity");
const drift = await sql(`
  select count(*)::int as c from public.wallets w
   where w.balance_ghs <> coalesce((select sum(l.amount_ghs) from public.wallet_ledger l where l.user_id = w.user_id), 0)`);
if (drift[0].c === 0) pass("every wallet still equals the sum of its ledger entries");
else fail(`${drift[0].c} wallet(s) drift from the ledger`);

const adminDrift = await sql("select public.fn_admin_reconcile() as r");
if (Number(adminDrift[0].r.drift_count) === 0) pass("fn_admin_reconcile() reports zero drift");
else fail("fn_admin_reconcile() reports drift");

console.log(
  failures === 0
    ? green(`\n✓ Live walkthrough passed — top-up and buy-data both work end to end.\n`)
    : red(`\n✗ Live walkthrough: ${failures} check(s) failed.\n`)
);

try {
  if (pg) await pg.end();
} catch {
  /* ignore */
}
await sleep(50);
process.exit(failures === 0 ? 0 : 1);
