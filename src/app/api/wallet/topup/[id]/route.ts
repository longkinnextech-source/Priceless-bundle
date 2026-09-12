import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Poll one top-up request — used by the wallet page to confirm the credit. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const { id } = await params;

    const result = await getDb().call<any>("fn_get_deposit_intent", { p_intent_id: id, p_user_id: session.uid });
    if (!result?.intent) throw ApiError.notFound("That top-up request no longer exists.");

    const wallet = await getDb().call<any>("fn_wallet_summary", { p_user_id: session.uid });

    return NextResponse.json({
      ok: true,
      intent: result.intent,
      deposits: result.deposits ?? [],
      status: result.intent.status,
      credited: result.intent.status === "matched" || (result.deposits ?? []).some((d: any) => d.status === "credited"),
      wallet: wallet?.wallet ?? null,
    });
  } catch (error) {
    return jsonError(error, "wallet/topup/status");
  }
}
