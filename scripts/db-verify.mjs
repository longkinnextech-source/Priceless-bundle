#!/usr/bin/env node
/**
 * DATABASE VERIFICATION
 *
 * Confirms that a database is correctly installed and healthy:
 *   - schema + functions + seed are present (tables, functions, plans)
 *   - fn_health() answers
 *   - every wallet equals the sum of its ledger entries
 *   - no wallet is negative, no ledger row is orphaned
 *   - the price list is sane (retail >= sub_agent >= super_agent >= cost)
 *   - the settings that matter are configured
 *
 * Usage:
 *   node scripts/db-verify.mjs                          # local dev database
 *   DATABASE_URL=postgres://… node scripts/db-verify.mjs
 *   node scripts/db-verify.mjs --memory                 # throwaway in-memory DB
 *   node scripts/db-verify.mjs --apply                  # apply schema first
 *   node scripts/db-verify.mjs --reset                  # wipe, apply, then verify
 *
 * Exits non-zero if anything fails, so it can gate a deployment.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const useMemory = args.includes("--memory");
const shouldApply = args.includes("--apply") || args.includes("--reset");
const shouldReset = args.includes("--reset");

const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:55432/postgres";
const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_URL;

const colour = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const green = (t) => colour(32, t);
const red = (t) => colour(31, t);
const dim = (t) => colour(90, t);
const bold = (t) => colour(1, t);

let failures = 0;
function heading(text) {
  console.log(`\n${bold(text)}`);
}
function pass(label, detail) {
  console.log(`  ${green("✓")} ${label}${detail ? dim(`  ${detail}`) : ""}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  ${red("✗")} ${label}${detail ? `  ${detail}` : ""}`);
}
function check(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

/* ------------------------------------------------------------------ */
/* Optional: apply the schema first                                    */
/* ------------------------------------------------------------------ */
async function applySchema() {
  heading(shouldReset ? "0. Resetting the database" : "0. Applying the schema");
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts", "db-setup.mjs"), ...(useMemory ? ["--memory"] : []), ...(shouldReset ? ["--reset"] : [])],
      { cwd: root, stdio: ["ignore", "inherit", "inherit"] }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`db-setup exited with ${code}`))));
    child.on("error", reject);
  });
  pass("schema, functions and seed applied");
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */
async function connect() {
  if (useMemory) {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    const schema = await readFile(path.join(root, "supabase", "schema.sql"), "utf8");
    const functions = await readFile(path.join(root, "supabase", "functions.sql"), "utf8");
    const seed = await readFile(path.join(root, "supabase", "seed.sql"), "utf8");
    await pg.exec(schema);
    await pg.exec(functions);
    await pg.exec(seed);
    return {
      kind: "PGlite (in-memory)",
      query: async (text, params = []) => {
        const result = await pg.query(text, params);
        return result.rows;
      },
      close: async () => pg.close(),
    };
  }

  let nodePg;
  try {
    nodePg = (await import("pg")).default;
  } catch {
    throw new Error("The `pg` package is required to verify a TCP database. Run `npm install`.");
  }

  const client = new nodePg.Client({
    connectionString: DATABASE_URL,
    ssl: /supabase\.(co|com)/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  return {
    kind: "Postgres (TCP)",
    query: async (text, params = []) => (await client.query(text, params)).rows,
    close: async () => client.end(),
  };
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */
const REQUIRED_TABLES = [
  "users", "squads", "wallets", "wallet_ledger", "plans", "orders", "deposit_intents", "deposits",
  "webhook_events", "withdrawals", "commissions", "bot_orders", "notifications", "admin_actions", "settings",
];

const REQUIRED_SETTINGS = [
  "platform_name", "company_name", "collection_number_momo", "collection_number_telecel",
  "collection_number_airteltigo", "min_deposit_ghs", "min_withdrawal_ghs", "instant_withdrawal_fee_ghs",
  "super_agent_commitment_ghs", "squad_volume_target_ghs", "commission_rate_squad_sale",
];

async function main() {
  if (shouldApply) await applySchema();

  const db = await connect();
  const q = async (text, params = []) => db.query(text, params);
  const one = async (text, params = []) => (await q(text, params))[0];

  console.log(bold("\n🔥 Priceless Bundle — database verification"));
  console.log(dim(`   engine : ${db.kind}`));
  if (!useMemory) console.log(dim(`   target : ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`));

  /* 1. Structure ---------------------------------------------------- */
  heading("1. Schema");
  const version = await one("select version() as v");
  pass("connected", String(version.v).split(" ").slice(0, 2).join(" "));

  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const row = await one("select to_regclass($1) as t", [`public.${table}`]);
    if (!row?.t) missing.push(table);
  }
  check(missing.length === 0, `all ${REQUIRED_TABLES.length} tables present`, missing.length ? `missing: ${missing.join(", ")}` : undefined);

  const fnCount = await one("select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'");
  check(Number(fnCount.c) > 60, "stored functions installed", `${fnCount.c} functions`);

  const requiredFns = [
    "fn_health", "fn_register_user", "fn_create_deposit_intent", "fn_process_sms_deposit",
    "fn_purchase_data", "fn_fulfill_order", "fn_withdrawal_quote", "fn_withdrawal_request",
    "fn_upgrade_to_sub_agent", "fn_upgrade_to_super_agent", "fn_squad_recompute", "fn_squad_dashboard",
    "fn_wallet_apply", "fn_ledger_append", "fn_admin_reconcile", "fn_process_sms_deposit",
  ];
  const missingFns = [];
  for (const fn of requiredFns) {
    const row = await one(
      "select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
      [fn]
    );
    if (Number(row.c) === 0) missingFns.push(fn);
  }
  check(missingFns.length === 0, "core money functions present", missingFns.length ? `missing: ${missingFns.join(", ")}` : undefined);

  const rls = await one(`
    select count(*)::int as c from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  check(Number(rls.c) === 0, "row level security enabled on every table", Number(rls.c) ? `${rls.c} tables without RLS` : undefined);

  const appendOnly = await one(
    "select count(*)::int as c from pg_trigger where tgname = 'trg_ledger_immutable' and not tgisinternal"
  );
  check(Number(appendOnly.c) > 0, "wallet ledger is append-only");

  /* 2. Seed --------------------------------------------------------- */
  heading("2. Seed data");
  const plans = await one("select count(*)::int as c, count(*) filter (where active)::int as active from public.plans");
  check(Number(plans.active) >= 12, "price list is populated", `${plans.active} active of ${plans.c} bundles`);

  const networks = await q("select distinct network from public.plans where active order by network");
  const netNames = networks.map((r) => r.network);
  check(
    ["MTN", "Telecel", "AirtelTigo"].every((n) => netNames.includes(n)),
    "all three networks priced",
    netNames.join(", ")
  );

  const badPrices = await one(`
    select count(*)::int as c from public.plans
     where retail_price_ghs < sub_agent_price_ghs
        or sub_agent_price_ghs < super_agent_price_ghs
        or super_agent_price_ghs < cost_price_ghs`);
  check(Number(badPrices.c) === 0, "no bundle is priced below cost or out of tier order", Number(badPrices.c) ? `${badPrices.c} bad rows` : undefined);

  const settingsRows = await q("select key from public.settings");
  const settingKeys = new Set(settingsRows.map((r) => r.key));
  const missingSettings = REQUIRED_SETTINGS.filter((k) => !settingKeys.has(k));
  check(missingSettings.length === 0, "required settings configured", missingSettings.length ? `missing: ${missingSettings.join(", ")}` : `${settingKeys.size} keys`);

  const collectionNumbers = await q(
    "select key, value from public.settings where key like 'collection_number%%' order by key"
  );
  const placeholders = collectionNumbers.filter((r) => /^(0551234567|0501234567|0271234567)$/.test(String(r.value).replace(/"/g, "")));
  if (placeholders.length) {
    console.log(
      `  ${colour(33, "!")} collection numbers are still the shipped placeholders: ` +
        dim(placeholders.map((r) => `${r.key}=${String(r.value).replace(/"/g, "")}`).join("  "))
    );
    console.log(dim("    → change them in Admin → Integrity / the settings table before taking real payments."));
  } else {
    pass("collection numbers have been customised");
  }

  /* 3. Accounting --------------------------------------------------- */
  heading("3. Accounting integrity");

  const walletDrift = await one(`
    select count(*)::int as c from public.wallets w
     where w.balance_ghs <> coalesce((select sum(l.amount_ghs) from public.wallet_ledger l where l.user_id = w.user_id), 0)`);
  check(Number(walletDrift.c) === 0, "every wallet equals the sum of its ledger entries", Number(walletDrift.c) ? `${walletDrift.c} drifting wallets` : undefined);

  const negative = await one("select count(*)::int as c from public.wallets where balance_ghs < 0 or commission_balance_ghs < 0");
  check(Number(negative.c) === 0, "no negative balance anywhere");

  const orphans = await one("select count(*)::int as c from public.wallet_ledger l left join public.users u on u.id = l.user_id where u.id is null");
  check(Number(orphans.c) === 0, "no orphaned ledger rows");

  const snapshotGaps = await one("select count(*)::int as c from public.wallet_ledger where balance_after is null");
  check(Number(snapshotGaps.c) === 0, "every ledger row snapshots balance_after");

  const walletsWithoutUser = await one("select count(*)::int as c from public.wallets w left join public.users u on u.id = w.user_id where u.id is null");
  check(Number(walletsWithoutUser.c) === 0, "every wallet belongs to a user");

  const reconcile = await one("select public.fn_admin_reconcile() as r");
  const report = reconcile?.r ?? {};
  check(Number(report.drift_count ?? 1) === 0, "fn_admin_reconcile() reports zero drift");

  const stuckDeposits = await one(
    "select count(*)::int as c from public.deposits where status = 'unmatched_review'"
  );
  if (Number(stuckDeposits.c) > 0) {
    console.log(`  ${colour(33, "!")} ${stuckDeposits.c} deposit(s) are waiting for manual review in Admin → Deposits`);
  } else {
    pass("no deposits are waiting for review");
  }

  const failedOrders = await one("select count(*)::int as c from public.orders where status = 'failed'");
  if (Number(failedOrders.c) > 0) {
    console.log(`  ${colour(33, "!")} ${failedOrders.c} order(s) are in the failed state — they were refunded automatically`);
  } else {
    pass("no orders are stuck in the failed state");
  }

  /* 4. Function smoke test ------------------------------------------ */
  heading("4. Function smoke test");
  const health = await one("select public.fn_health() as h");
  const h = health?.h ?? {};
  check(h.ok === true, "fn_health() answers ok", h.ok ? `brand=${h.brand} plans=${h.plans} users=${h.users}` : JSON.stringify(h).slice(0, 160));
  check(typeof h.db_version === "string" && h.db_version.length > 0, "database version reported", h.db_version);

  const publicConfig = await one("select public.fn_public_config() as c");
  const config = publicConfig?.c ?? {};
  check(config.platform_name === "Priceless Bundle", "public config is branded", `platform_name=${config.platform_name}`);
  check(
    typeof config.collection_number_momo === "string" && config.collection_number_momo.length >= 10,
    "a collection number is exposed to the app",
    config.collection_number_momo
  );

  const plansProbe = await one("select public.fn_list_plans(null) as p");
  const probePlans = plansProbe?.p?.plans ?? [];
  check(probePlans.length > 0, "fn_list_plans() returns bundles", `${probePlans.length} rows`);
  check(
    probePlans.every((p) => p.cost_price_ghs === undefined),
    "the price list never leaks the cost price"
  );

  await db.close();

  console.log(
    failures === 0
      ? green("\n✓ Database verified — schema, seed and accounting all check out.\n")
      : red(`\n✗ Verification found ${failures} problem(s).\n`)
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red(`\n✗ Verification could not run: ${error?.message ?? error}\n`));
  if (/ECONNREFUSED/.test(String(error?.message))) {
    console.error(dim("  No database is listening. Start the local stack with `npm run dev:local`, or set DATABASE_URL.\n"));
  }
  process.exit(1);
});
