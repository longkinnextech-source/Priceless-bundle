import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, num, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Start a wallet top-up (flow 1, step 1).
 *
 * Returns a short reference code plus the MoMo/Telecel Cash collection number.
 * The user sends the money with the code in the narrative; the Android
 * SMS-forwarder then POSTs the confirmation to /api/webhook/sms-deposit.
 */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "topup-create", 20, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const amount = num(body.amount ?? body.amount_ghs, "amount");
    const channel = typeof body.channel === "string" ? body.channel : "momo";

    const db = getDb();
    const result = unwrap(
      await db.call<any>("fn_create_deposit_intent", {
        p_user_id: session.uid,
        p_amount: amount,
        p_channel: channel,
      })
    );

    const intent = result.intent;
    const config = (await db.call<any>("fn_public_config", {})) ?? {};

    return NextResponse.json({
      ok: true,
      intent,
      reused: Boolean(result.reused),
      instructions: {
        step1: `Send exactly GHS ${Number(intent.expected_amount_ghs).toFixed(2)} via Mobile Money to ${intent.collection_number}.`,
        step2: `Use ${intent.reference_code} as the reference / narrative.`,
        step3: "Your wallet is credited automatically within seconds of the SMS confirmation.",
      },
      expires_at: intent.expires_at,
      support_phone: config.support_phone ?? "0551234567",
      collection_number_default: config.collection_number_momo ?? "0551234567",
    });
  } catch (error) {
    return jsonError(error, "wallet/topup");
  }
}

/** Live (unexpired) top-up requests for the signed-in user. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const result = await getDb().call<any>("fn_active_deposit_intents", { p_user_id: session.uid });
    const config = (await getDb().call<any>("fn_public_config", {})) ?? {};
    return NextResponse.json({
      ok: true,
      intents: result?.intents ?? [],
      support_phone: config.support_phone ?? "0551234567",
    });
  } catch (error) {
    return jsonError(error, "wallet/topup/list");
  }
}
