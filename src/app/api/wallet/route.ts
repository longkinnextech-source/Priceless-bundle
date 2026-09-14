import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Wallet summary: balance, commission pot, this month's activity, live top-up requests. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const summary = unwrap(await getDb().call<any>("fn_wallet_summary", { p_user_id: session.uid }));
    const commission = await getDb().call<any>("fn_commission_summary", { p_user_id: session.uid });

    return NextResponse.json({
      ok: true,
      ...summary,
      commission,
      collection: {
        momo: Number(summary.wallet.balance_ghs) >= 0 ? null : null,
      },
    });
  } catch (error) {
    return jsonError(error, "wallet");
  }
}
