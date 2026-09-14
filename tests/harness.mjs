/**
 * Shared test harness: a real Postgres (PGlite) with the full schema applied,
 * a named-argument RPC helper, and tiny assertion/reporting utilities.
 */

import { connect, applySchema } from "../scripts/db-setup.mjs";

export async function makeDb({ memory = true, reset = false } = {}) {
  const conn = await connect({ memory, reset, quiet: true });
  await applySchema(conn, { log: () => {} });
  return conn;
}

/** Call a Postgres function by name using named arguments. */
export async function rpc(conn, fn, args = {}) {
  const keys = Object.keys(args);
  const values = keys.map((k) => args[k]);
  const named = keys.map((k, i) => `"${k}" => $${i + 1}`).join(", ");
  const rows = await conn.query(`select public."${fn}"(${named}) as r`, values);
  return rows[0]?.r ?? null;
}

/** Call a Postgres function expected to raise — returns the error message. */
export async function rpcError(conn, sql, params = []) {
  try {
    await conn.query(sql, params);
    return null;
  } catch (error) {
    return error.message;
  }
}

export async function one(conn, sql, params = []) {
  const rows = await conn.query(sql, params);
  return rows[0] ?? null;
}

export async function all(conn, sql, params = []) {
  return conn.query(sql, params);
}

/* ------------------------------- assertions ------------------------------- */

export const results = { passed: 0, failed: 0, failures: [], current: "general" };

export function section(name) {
  results.current = name;
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

export function check(name, condition, detail = "") {
  if (condition) {
    results.passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    results.failed += 1;
    results.failures.push(`[${results.current}] ${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? `\n      ${detail}` : ""}`);
  }
  return Boolean(condition);
}

export function checkEq(name, actual, expected) {
  const ok = numericEqual(actual, expected);
  return check(name, ok, ok ? "" : `expected ${fmt(expected)}, got ${fmt(actual)}`);
}

export function checkClose(name, actual, expected, epsilon = 0.011) {
  const a = Number(actual);
  const e = Number(expected);
  const ok = Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= epsilon;
  return check(name, ok, ok ? "" : `expected ~${e}, got ${a}`);
}

export function checkGte(name, actual, expected) {
  const ok = Number(actual) >= Number(expected);
  return check(name, ok, ok ? "" : `expected >= ${expected}, got ${actual}`);
}

function numericEqual(a, b) {
  if (typeof a === "number" || typeof b === "number" || typeof a === "bigint" || typeof b === "bigint") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  }
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

function fmt(value) {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function summary(label = "Tests") {
  const { passed, failed, failures } = results;
  console.log(`\n${"─".repeat(64)}`);
  if (failed === 0) {
    console.log(`\x1b[32m✓ ${label}: ${passed} passed, 0 failed\x1b[0m`);
  } else {
    console.log(`\x1b[31m✗ ${label}: ${failed} failed, ${passed} passed\x1b[0m`);
    for (const failure of failures) console.log(`   • ${failure}`);
  }
  return failed;
}

/* ------------------------------ domain helpers --------------------------- */

export const HASHES = {
  // Deterministic fake pin hashes — real scrypt hashes are produced by the app.
  alice: "scrypt$16384$8$1$dGVzdHNhbHQxMjM0NTY3OA==$" + "a".repeat(86),
  bob: "scrypt$16384$8$1$dGVzdHNhbHQxMjM0NTY3OA==$" + "b".repeat(86),
  carol: "scrypt$16384$8$1$dGVzdHNhbHQxMjM0NTY3OA==$" + "c".repeat(86),
};

export async function registerUser(conn, phone, name, pinHash) {
  const res = await rpc(conn, "fn_register_user", {
    p_phone: phone,
    p_full_name: name,
    p_pin_hash: pinHash,
  });
  if (!res?.ok) throw new Error(`register failed for ${phone}: ${JSON.stringify(res)}`);
  return res.user;
}

export async function creditWallet(conn, userId, amount, _reason = "test top-up") {
  // Uses the real deposit path so the ledger stays honest.
  const intent = await rpc(conn, "fn_create_deposit_intent", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (!intent?.ok) throw new Error(`intent failed: ${JSON.stringify(intent)}`);
  const processed = await rpc(conn, "fn_process_sms_deposit", {
    p_raw_message: `Payment received for GHS ${amount.toFixed(2)}. Reference: ${intent.intent.reference_code}. Balance GHS 0.00`,
    p_amount: amount,
    p_sender_phone: "0244000000",
    p_reference_code: intent.intent.reference_code,
    p_provider: "MTN Mobile Money",
    p_sms_hash: `test-${userId}-${amount}-${Date.now()}-${Math.random()}`,
  });
  if (processed?.status !== "credited") {
    throw new Error(`deposit not credited: ${JSON.stringify(processed)}`);
  }
  return processed;
}

export async function getPlanId(conn, network, sizeLabel) {
  const row = await one(conn, "select id from public.plans where network = $1 and size_label = $2", [network, sizeLabel]);
  return row?.id;
}

export async function walletOf(conn, userId) {
  const row = await one(conn, "select balance_ghs, commission_balance_ghs from public.wallets where user_id = $1", [userId]);
  return { balance: Number(row?.balance_ghs ?? 0), commission: Number(row?.commission_balance_ghs ?? 0) };
}

export const n = (value) => Number(value ?? 0);
