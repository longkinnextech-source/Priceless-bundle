/**
 * Database access layer.
 *
 * The whole application talks to Postgres through `db.call(fnName, args)`,
 * which invokes a SECURITY DEFINER function from supabase/functions.sql.
 * Balances, prices and order state are only ever changed inside those
 * functions, inside a single transaction.
 *
 * Two interchangeable transports:
 *   - `pg`       : direct Postgres connection (local dev, scripts, tests)
 *   - `supabase` : PostgREST RPC with the service-role key (production)
 */

import { getTransport, env, type DbTransport } from "@/lib/env";

export class DbError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(message: string, code = "DB_ERROR", detail?: unknown) {
    super(message);
    this.name = "DbError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Marker for values destined for a `jsonb` function argument.
 *
 * node-postgres serialises objects/arrays to JSON automatically, but a plain
 * *string* is sent raw — and `"0551112222"` is not valid JSON. Wrapping the
 * value in `jsonb()` forces proper JSON serialisation on every transport.
 */
const JSONB_MARKER = Symbol.for("priceless.jsonb");

export type JsonbWrapped<T> = { [JSONB_MARKER]: true; value: T };

export function jsonb<T>(value: T): JsonbWrapped<T> {
  return { [JSONB_MARKER]: true, value };
}

function isJsonb(value: unknown): value is JsonbWrapped<unknown> {
  return typeof value === "object" && value !== null && (value as any)[JSONB_MARKER] === true;
}

/** Serialise jsonb-marked values to JSON text, leaving everything else alone. */
function encodeParam(value: unknown): unknown {
  if (isJsonb(value)) return JSON.stringify(value.value ?? null);
  return value;
}

/** Unwrap jsonb markers for transports that serialise the whole request. */
function unwrapJsonb(value: unknown): unknown {
  if (isJsonb(value)) return value.value ?? null;
  if (Array.isArray(value)) return value.map(unwrapJsonb);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = unwrapJsonb(inner);
    return out;
  }
  return value;
}

export interface DbClient {
  readonly kind: DbTransport;
  /** Invoke a Postgres function returning jsonb. */
  call<T = any>(fn: string, args?: Record<string, unknown>): Promise<T>;
  /** Raw SQL. Only available on the direct-Postgres transport. */
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  healthy(): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* Direct Postgres transport                                          */
/* ------------------------------------------------------------------ */

type PgPool = import("pg").Pool;

let poolPromise: Promise<PgPool> | null = null;

function getPool(): Promise<PgPool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      if (!env.databaseUrl) throw new DbError("DATABASE_URL is not set", "NO_DATABASE_URL");
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: env.databaseUrl,
        max: Number(process.env.PG_POOL_MAX ?? 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 15_000,
        ssl: env.databaseUrl.includes("sslmode=require") || env.databaseUrl.includes("supabase.co")
          ? { rejectUnauthorized: false }
          : undefined,
      });
      pool.on("error", (err) => console.error("[db] idle client error", err));
      return pool;
    })();
  }
  return poolPromise;
}

/** Build `select public.fn("arg" => $1, "arg2" => $2)` — named-argument RPC. */
function buildCall(fn: string, args: Record<string, unknown>): { sql: string; params: unknown[] } {
  const keys = Object.keys(args ?? {});
  const params: unknown[] = [];
  const placeholders = keys.map((key, i) => {
    params.push(encodeParam((args as Record<string, unknown>)[key]));
    return `${quoteIdent(key)} => $${i + 1}`;
  });
  return {
    sql: `select public.${quoteIdent(fn)}(${placeholders.join(", ")}) as result`,
    params,
  };
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new DbError(`Illegal SQL identifier: ${name}`, "BAD_IDENTIFIER");
  }
  return `"${name}"`;
}

const pgClient: DbClient = {
  kind: "pg",
  async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const pool = await getPool();
    const { sql, params } = buildCall(fn, args);
    try {
      const { rows } = await pool.query(sql, params);
      return rows[0]?.result as T;
    } catch (err) {
      throw toDbError(err, fn);
    }
  },
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pool = await getPool();
    try {
      const { rows } = await pool.query(sql, params);
      return rows as T[];
    } catch (err) {
      throw toDbError(err, "query");
    }
  },
  async healthy() {
    try {
      const rows = await this.query<{ ok: number }>("select 1 as ok");
      return rows.length === 1;
    } catch {
      return false;
    }
  },
};

/* ------------------------------------------------------------------ */
/* Supabase (PostgREST RPC) transport                                 */
/* ------------------------------------------------------------------ */

async function supabaseRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const url = `${env.supabaseUrl}/rest/v1/rpc/${encodeURIComponent(fn)}`;
  const key = env.supabaseKey as string;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(unwrapJsonb(args ?? {})),
      cache: "no-store",
    });
  } catch (err) {
    throw new DbError(`Network error calling ${fn}: ${(err as Error).message}`, "DB_UNREACHABLE");
  }

  const text = await response.text();
  if (!response.ok) {
    let message = text;
    let code = "DB_ERROR";
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: string; details?: string; hint?: string };
      message = parsed.message ?? text;
      code = parsed.code ?? code;
      if (parsed.details) message += ` — ${parsed.details}`;
    } catch {
      /* keep the raw body */
    }
    throw new DbError(`rpc ${fn} failed: ${message}`, code, text);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

const supabaseClient: DbClient = {
  kind: "supabase",
  async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return supabaseRpc<T>(fn, args);
  },
  async query<T>(): Promise<T[]> {
    throw new DbError(
      "Raw SQL is not available on the Supabase transport. Add a Postgres function to supabase/functions.sql instead.",
      "RAW_SQL_UNSUPPORTED"
    );
  },
  async healthy() {
    try {
      const res = await supabaseRpc<{ ok: boolean }>("fn_health", {});
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  },
};

/* ------------------------------------------------------------------ */
/* Façade                                                             */
/* ------------------------------------------------------------------ */

let cached: DbClient | null = null;

export function getDb(): DbClient {
  if (!cached) {
    cached = getTransport() === "supabase" ? supabaseClient : pgClient;
  }
  return cached;
}

/** Convenience: call a function and get a typed jsonb payload. */
export async function call<T = any>(fn: string, args?: Record<string, unknown>): Promise<T> {
  return getDb().call<T>(fn, args);
}

function toDbError(err: unknown, context: string): DbError {
  if (err instanceof DbError) return err;
  const e = err as { message?: string; code?: string; detail?: string; constraint?: string };
  const message = e?.message ?? String(err);
  const detail = [e?.detail, e?.constraint].filter(Boolean).join(" | ");
  return new DbError(
    `db.${context}: ${message}${detail ? ` (${detail})` : ""}`,
    e?.code ?? "DB_ERROR",
    err
  );
}

/** Shape returned by business-rule functions. */
export type RpcResult<T = Record<string, unknown>> = {
  ok: boolean;
  error?: string;
  message?: string;
} & Partial<T>;
