#!/usr/bin/env node
/**
 * One-command local development stack:
 *   1. starts the local PostgreSQL (PGlite) socket server and applies the schema
 *   2. starts Next.js on DEV_PORT with DATABASE_URL pointed at it
 *
 *   npm run dev:local
 *
 * Everything the app needs lives in .env.local; this script fills in the
 * development defaults so a fresh clone runs with zero setup.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PORT = Number(process.env.PGLITE_PORT ?? 55432);
const DEV_PORT = Number(process.env.PORT ?? 3000);

const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;

const children = [];
let stopping = false;

function start(name, command, args, env = {}, { waitForPort = null } = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const prefix = `[${name}]`;
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${prefix} exited (code ${code ?? signal})`);
      void shutdown(code ?? 1);
    }
  });

  return waitForPort ? { child, ready: waitForPortReady(waitForPort) } : { child, ready: Promise.resolve() };
}

function waitForPortReady(port, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for port ${port}`));
        } else {
          setTimeout(attempt, 400);
        }
      });
    };
    attempt();
  });
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 600);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

console.log("🔥 Priceless Bundle — starting local development stack\n");

const db = start("db", process.execPath, ["scripts/pg-server.mjs", "--port", String(DB_PORT)], {
  PGLITE_PORT: String(DB_PORT),
}, { waitForPort: DB_PORT });

await db.ready;
console.log(`\n✓ database ready on port ${DB_PORT}`);

start("web", "npx", ["next", "dev", "--port", String(DEV_PORT), "--hostname", "0.0.0.0"], {
  DATABASE_URL,
  SESSION_SECRET: process.env.SESSION_SECRET ?? "priceless-bundle-local-development-secret-key",
  SMS_WEBHOOK_SECRET: process.env.SMS_WEBHOOK_SECRET ?? "local-sms-forwarder-secret",
  ADMIN_PHONE: process.env.ADMIN_PHONE ?? "0244000000",
  ADMIN_PIN: process.env.ADMIN_PIN ?? "246810",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? `http://localhost:${DEV_PORT}`,
  SUPPLIER_MOCK_MODE: process.env.SUPPLIER_MOCK_MODE ?? "always_succeed",
});

console.log(`
┌──────────────────────────────────────────────────────────────┐
│  App        http://localhost:${String(DEV_PORT).padEnd(35)}│
│  Database   ${DATABASE_URL.padEnd(47)}│
│  Admin      sign in with 0244000000 / 246810                 │
└──────────────────────────────────────────────────────────────┘
`);
