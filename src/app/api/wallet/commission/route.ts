import { NextResponse } from "next/server";
import { ApiError, jsonError, num, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Commission pot summary + reinvestment preview. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const summary = unwrap(await getDb().call<any>("fn_commission_summary", { p_user_id: session.uid }));
    const quote = await getDb().call<any>("fn_reinvest_rate", { p_amount: Number(summary.available_ghs ?? 0) });
    return NextResponse.json({
      ok: true,
      ...summary,
      quote_rate: Number(quote ?? summary.next_rate ?? 0.02),
    });
  } catch (error) {
    return jsonError(error, "wallet/commission");
  }
}

/** Move commission into the main wallet and collect the 2–5% bonus. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const body = await readJson<Record<string, unknown>>(request).catch(() => ({}) as Record<string, unknown>);
    const amount = body?.amount === undefined || body?.amount === null || body?.amount === "" ? null : num(body.amount, "amount");

    const result = unwrap(
      await getDb().call<any>("fn_commission_reinvest", {
        p_user_id: session.uid,
        p_amount: amount,
      })
    );
    const me = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
    return NextResponse.json({ ok: true, ...result, wallet: me?.user?.wallet ?? null });
  } catch (error) {
    return jsonError(error, "wallet/commission/reinvest");
  }
}
