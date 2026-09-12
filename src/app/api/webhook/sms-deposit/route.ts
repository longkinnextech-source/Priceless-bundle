import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/api";
import { getDb, jsonb } from "@/lib/db";
import { env, isConfigured } from "@/lib/env";
import { extractIncoming, parseDepositSms, smsHash } from "@/lib/sms";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * AUTOMATIC PAYMENT COLLECTION — SMS webhook.
 *
 * An Android SMS-forwarder app running on the collection phone POSTs every
 * incoming mobile-money SMS here. The raw payload is written to
 * `webhook_events` BEFORE any parsing happens, whatever the outcome.
 *
 * Security: a shared secret header (`x-priceless-secret` by default, configurable
 * via SMS_WEBHOOK_HEADER). Wrong secret -> 401, but the attempt is still logged.
 *
 * Matching is deliberately conservative: reference code first, then sender
 * phone, then amount + time window. Anything ambiguous goes to
 * `unmatched_review` for a human instead of guessing with someone's money.
 */

const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request) {
  const started = Date.now();
  let eventId: bigint | number | null = null;
  let rawBody = "";
  let contentType: string | null = null;
  let ip = "unknown";

  try {
    ip = clientIp(request);
    contentType = request.headers.get("content-type");

    // 1. Read the raw body first — before auth, before parsing.
    rawBody = (await request.text()).slice(0, MAX_BODY_BYTES);

    if (!isConfigured()) {
      console.error("[sms-deposit] database not configured — payload dropped");
      return NextResponse.json({ ok: false, error: "DB_UNCONFIGURED" }, { status: 503 });
    }

    const db = getDb();

    // 2. Verify the shared secret (constant-time).
    const headerName = process.env.SMS_WEBHOOK_HEADER ?? "x-priceless-secret";
    const provided =
      request.headers.get(headerName) ??
      request.headers.get("x-webhook-secret") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      "";
    const expected = env.smsWebhookSecret ?? "";
    const signatureOk = expected.length > 0 && safeCompare(provided, expected);

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      // Never persist credentials into the audit trail.
      headers[key] = /secret|authorization|token|apikey/i.test(key) ? "[redacted]" : value.slice(0, 500);
    });

    // 3. Log the raw payload, unconditionally.
    try {
      eventId = await db.call<number>("fn_log_webhook_event", {
        p_source: "android-sms-forwarder",
        p_raw_body: rawBody,
        p_payload: jsonb({}),
        p_headers: jsonb(headers),
        p_remote_ip: ip,
        p_signature_ok: signatureOk,
      });
    } catch (logError) {
      console.error("[sms-deposit] FAILED to log the raw payload", logError);
    }

    if (!expected) {
      console.error("[sms-deposit] SMS_WEBHOOK_SECRET is not set — refusing to credit anything");
      await finish(db, eventId, "rejected_no_secret", "SMS_WEBHOOK_SECRET not configured", started);
      return NextResponse.json({ ok: false, error: "WEBHOOK_NOT_CONFIGURED" }, { status: 503 });
    }

    if (!signatureOk) {
      console.warn(`[sms-deposit] rejected: bad shared secret from ${ip}`);
      await finish(db, eventId, "rejected_unauthorized", "Invalid or missing shared secret", started);
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }

    // 4. Rate limit (one forwarder sends everything, so keep it generous).
    const { allowed } = rateLimit(`sms-deposit:${ip}`, 600, 60_000);
    if (!allowed) {
      await finish(db, eventId, "rejected_rate_limited", null, started);
      return NextResponse.json({ ok: false, error: "RATE_LIMITED" }, { status: 429 });
    }

    // 5. Normalise the payload shape from whatever the forwarder app sends.
    const incoming = extractIncoming(rawBody, contentType);
    const parsed = parseDepositSms(incoming.rawMessage, incoming.providerHint);

    // Audit the parse even when it looks bad.
    try {
      await db.call("fn_finish_parse", {
        p_id: eventId,
        p_parsed: jsonb({ ...parsed, forwardedSender: incoming.forwardedSender, device: incoming.device }),
      });
    } catch {
      /* fn_finish_parse is optional telemetry */
    }

    console.log(
      `[sms-deposit] parse result=${JSON.stringify({
        amount: parsed.amount,
        sender: parsed.senderPhone,
        reference: parsed.reference,
        direction: parsed.direction,
        confidence: parsed.confidence,
        warnings: parsed.warnings,
      })}`
    );

    // 6. Hand off to Postgres: matching + crediting happen in ONE transaction.
    const result = await db.call<any>("fn_process_sms_deposit", {
      p_raw_message: incoming.rawMessage || rawBody,
      p_amount: parsed.amount,
      p_sender_phone: parsed.senderPhone ?? incoming.forwardedSender ?? null,
      p_reference_code: parsed.reference,
      p_provider: parsed.provider,
      p_sms_hash: smsHash(incoming.rawMessage || rawBody, incoming.forwardedSender),
      p_webhook_event_id: eventId,
      p_direction: parsed.direction,
    });

    await finish(db, eventId, result?.status ?? "unknown", null, started);

    console.log(
      `[sms-deposit] outcome=${result?.status} deposit=${result?.deposit_id ?? "-"} ` +
        `amount=${result?.amount_ghs ?? "-"} strategy=${result?.match_strategy ?? "-"}`
    );

    // Always 200 for accepted payloads so the forwarder does not retry-spam.
    return NextResponse.json({
      ok: true,
      status: result?.status,
      deposit_id: result?.deposit_id ?? null,
      amount_ghs: result?.amount_ghs ?? null,
      match_strategy: result?.match_strategy ?? null,
      credited: result?.status === "credited",
      parsed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[sms-deposit] unhandled error", error);
    try {
      if (isConfigured() && eventId === null && rawBody) {
        const db = getDb();
        eventId = await db.call<number>("fn_log_webhook_event", {
          p_source: "android-sms-forwarder",
          p_raw_body: rawBody,
          p_payload: jsonb({}),
          p_headers: jsonb({ "x-error-path": "true" }),
          p_remote_ip: ip,
          p_signature_ok: false,
        });
      }
      await finish(getDb(), eventId, "error", message, started);
    } catch {
      /* the logging path itself failed — nothing more we can do */
    }
    return NextResponse.json({ ok: false, error: "PROCESSING_ERROR", message }, { status: 200 });
  }
}

/** GET is useful for the forwarder app's connectivity test. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "sms-deposit",
    hint: "POST the raw SMS text here with the shared-secret header.",
    accepts: ["text/plain", "application/json", "application/x-www-form-urlencoded"],
    secret_configured: Boolean(env.smsWebhookSecret),
  });
}

async function finish(
  db: ReturnType<typeof getDb>,
  id: bigint | number | null,
  outcome: string,
  error: string | null,
  started: number
) {
  if (id === null) return;
  try {
    await db.call("fn_finish_webhook_event", {
      p_id: id,
      p_outcome: outcome,
      p_error: error,
      p_processing_ms: Date.now() - started,
    });
  } catch (finishError) {
    console.error("[sms-deposit] failed to finalise the webhook log", finishError);
  }
}

function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
