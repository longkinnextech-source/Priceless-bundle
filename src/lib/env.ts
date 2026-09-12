/**
 * Environment / configuration.
 *
 * Two supported database transports:
 *  1. Supabase  — SUPABASE_URL + SUPABASE_KEY (service role). Uses PostgREST RPC.
 *  2. Direct Postgres — DATABASE_URL. Used for local development and tests.
 *
 * The application is transport-agnostic: it only ever calls the Postgres
 * functions defined in supabase/functions.sql.
 */

export type DbTransport = "supabase" | "pg";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export const env = {
  supabaseUrl: clean(process.env.SUPABASE_URL),
  supabaseKey:
    clean(process.env.SUPABASE_SERVICE_ROLE_KEY) ??
    clean(process.env.SUPABASE_SERVICE_KEY) ??
    clean(process.env.SUPABASE_KEY),
  databaseUrl: clean(process.env.DATABASE_URL),
  smsWebhookSecret: clean(process.env.SMS_WEBHOOK_SECRET),
  sessionSecret: clean(process.env.SESSION_SECRET),
  adminPhone: clean(process.env.ADMIN_PHONE) ?? "0244000000",
  adminPin: clean(process.env.ADMIN_PIN) ?? "246810",
  allowDevLogin: (clean(process.env.ALLOW_DEV_LOGIN) ?? "false").toLowerCase() === "true",
  nodeEnv: clean(process.env.NODE_ENV) ?? "development",
} as const;

export function getTransport(): DbTransport {
  if (env.supabaseUrl && env.supabaseKey) return "supabase";
  if (env.databaseUrl) return "pg";
  throw new Error(
    "No database configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (production) " +
      "or DATABASE_URL (local development). See README.md."
  );
}

/** True when the app has a real database to talk to. */
export function isConfigured(): boolean {
  return Boolean((env.supabaseUrl && env.supabaseKey) || env.databaseUrl);
}

export function isProduction(): boolean {
  return env.nodeEnv === "production";
}

export function publicConfig() {
  return {
    transport: isConfigured() ? getTransport() : null,
    configured: isConfigured(),
    brand: "Priceless Bundle",
    company: "LongKinnex Tech and Data",
  };
}
