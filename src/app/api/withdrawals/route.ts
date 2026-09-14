import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, num, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb, jsonb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const result = await getDb().call<any>("fn_list_withdrawals", { p_user_id: session.uid, p_limit: 50 });
    const quoteBase = await getDb().call<any>("fn_withdrawal_quote", {
      p_user_id: session.uid,
      p_amount: 100,
      p_mode: "instant",
    });
    return NextResponse.json({
      ok: true,
      withdrawals: result?.withdrawals ?? [],
      terms: quoteBase ?? null,
    });
  } catch (error) {
    return jsonError(error, "withdrawals");
  }
}

export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "withdrawal", 15, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const amount = num(body.amount ?? body.amount_ghs, "amount");
    const mode = body.mode === "free_friday_batch" ? "free_friday_batch" : "instant";
    const method = typeof body.payout_method === "string" ? body.payout_method : "momo";
    const details = typeof body.payout_details === "object" && body.payout_details !== null ? body.payout_details : {};

    const result = unwrap(
      await getDb().call<any>("fn_withdrawal_request", {
        p_user_id: session.uid,
        p_amount: amount,
        p_mode: mode,
        p_payout_method: method,
        p_payout_details: jsonb(details),
      })
    );
    const me = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
    return NextResponse.json({ ok: true, ...result, wallet: me?.user?.wallet ?? result.wallet });
  } catch (error) {
    return jsonError(error, "withdrawals/create");
  }
}
