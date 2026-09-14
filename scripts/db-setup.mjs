#!/usr/bin/env node
/**
 * Applies supabase/schema.sql -> functions.sql -> seed.sql to a database.
 *
 * Targets:
 *   - DATABASE_URL if set  (a real Postgres — Supabase, local, CI)
 *   - otherwise a local PGlite database at ./.pgdata/priceless (dev default)
 *
 * Usage:
 *   node scripts/db-setup.mjs            # apply missing pieces
 *   node scripts/db-setup.mjs --reset    # drop the local PGlite db first
 *   node scripts/db-setup.mjs --memory   # throwaway in-memory database
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const useMemory = args.has("--memory");
const doReset = args.has("--reset");

export async function readSql(name) {
  return readFile(path.join(root, "supabase", name), "utf8");
}

/** Connect to DATABASE_URL, or spin up PGlite for local development. */
export async function connect({ memory = false, reset = false, quiet = false } = {}) {
  const url = process.env.DATABASE_URL?.trim();
  const log = quiet ? () => {} : (...a) => console.log(...a);

  if (url && !memory) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: url,
      ssl: url.includes("supabase.co") || url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    log(`→ connected to Postgres via DATABASE_URL (${url.replace(/:[^:@/]+@/, ":***@").slice(0, 60)}...)`);
    return {
      kind: "pg",
      async exec(sql) {
        await client.query(sql);
      },
      async query(sql, params = []) {
        const res = await client.query(sql, params);
        return res.rows;
      },
      async close() {
        await client.end();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = path.join(root, ".pgdata", "priceless");
  if (reset && existsSync(dataDir)) {
    await rm(dataDir, { recursive: true, force: true });
    log("→ removed local database (--reset)");
  }
  if (!memory) await (await import("node:fs/promises")).mkdir(dataDir, { recursive: true });
  const db = new PGlite(memory ? undefined : dataDir);
  await db.waitReady;
  log(`→ using local PGlite database (${memory ? "in-memory" : dataDir})`);

  return {
    kind: "pglite",
    async exec(sql) {
      await db.exec(sql);
    },
    async query(sql, params = []) {
      const res = await db.query(sql, params);
      return res.rows;
    },
    async close() {
      await db.close();
    },
    raw: db,
  };
}

/** Apply the full schema. Safe to re-run: every statement is idempotent. */
export async function applySchema(conn, { log = console.log } = {}) {
  for (const file of ["schema.sql", "functions.sql", "seed.sql"]) {
    const sql = await readSql(file);
    const started = Date.now();
    try {
      await conn.exec(sql);
      log(`✓ applied supabase/${file} (${Date.now() - started}ms)`);
    } catch (error) {
      console.error(`✗ FAILED applying supabase/${file}`);
      console.error(error.message);
      if (error.position) {
        const pos = Number(error.position);
        const before = sql.slice(0, pos);
        const line = before.split("\n").length;
        console.error(`  at line ${line}:`);
        console.error(sql.split("\n").slice(Math.max(0, line - 4), line + 2).join("\n"));
      }
      throw error;
    }
  }
}

async function main() {
  const conn = await connect({ memory: useMemory, reset: doReset });
  try {
    await applySchema(conn);
    const rows = await conn.query("select public.fn_health() as h");
    const health = rows[0].h;
    console.log("\nHealth:", JSON.stringify(health, null, 2));
    const reconcile = (await conn.query("select public.fn_admin_reconcile() as r"))[0].r;
    console.log(`Wallets checked: ${reconcile.checked_wallets}, ledger drift: ${reconcile.drift_count}`);
  } finally {
    await conn.close();
  }
}

if (import.meta.url === pathToFileURLSafe(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function pathToFileURLSafe(p) {
  try {
    return new URL(`file://${path.resolve(p)}`).href;
  } catch {
    return "";
  }
}
