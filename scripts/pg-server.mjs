#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT DATABASE SERVER
 *
 * Serves a real PostgreSQL engine (PGlite = Postgres compiled to WebAssembly)
 * over the wire protocol, so the Next.js app can talk to it with plain `pg`
 * exactly as it would talk to Supabase or any managed Postgres.
 *
 * Production never uses this file — there you point DATABASE_URL at Supabase
 * (or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and the app uses PostgREST).
 *
 *   node scripts/pg-server.mjs [--port 55432] [--memory]
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applySchema } from "./db-setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = Number(process.env.PGLITE_PORT ?? (portArg >= 0 ? args[portArg + 1] : 55432));
const memory = args.includes("--memory") || process.env.PGLITE_MEMORY === "true";

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

const dataDir = path.join(root, ".pgdata", "priceless");
if (!memory) await mkdir(dataDir, { recursive: true });
const db = memory ? new PGlite() : new PGlite(dataDir);
await db.waitReady;

// Apply the schema on boot. Every statement is idempotent, so this is safe to
// re-run on every start and keeps a fresh clone zero-config.
const connection = {
  kind: "pglite",
  async exec(sql) {
    await db.exec(sql);
  },
  async query(sql, params = []) {
    const result = await db.query(sql, params);
    return result.rows;
  },
};
await applySchema(connection, { log: (line) => console.log(`[db] ${line}`) });

// PGlite is a single-connection database. The socket server multiplexes
// multiple client sockets onto it, so allow a small pool (default is 1, which
// would close concurrent `pg` pool connections).
const maxConnections = Number(process.env.PGLITE_MAX_CONNECTIONS ?? 12);
const server = new PGLiteSocketServer({ db, port, host: "0.0.0.0", maxConnections });
await server.start();

const health = (await db.query("select public.fn_health() as h")).rows[0].h;
console.log(`
┌──────────────────────────────────────────────────────────────┐
│  Priceless Bundle — local PostgreSQL (PGlite)                │
├──────────────────────────────────────────────────────────────┤
│  postgres://postgres:postgres@127.0.0.1:${String(port).padEnd(5)}/postgres        │
│  plans: ${String(health.plans).padEnd(3)}  users: ${String(health.users).padEnd(3)}  pg: ${health.db_version.padEnd(6)}                       │
└──────────────────────────────────────────────────────────────┘
Set DATABASE_URL to the string above, then run: npm run dev
`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[db] ${signal} received — closing...`);
  try {
    await server.stop();
    await db.close();
  } catch (error) {
    console.error("[db] shutdown error", error);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
