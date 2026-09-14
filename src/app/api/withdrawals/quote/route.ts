import { NextResponse } from "next/server";
import { ApiError, jsonError, num, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Quote a withdrawal before the user commits: fee, net amount, limits and
 * whether instant payouts are free for this tier. Server-side only — the client
 * never computes a fee.
 */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const body = await readJson<Record<string, unknown>>(request).catch(() => ({}) as Record<string, unknown>);
    const amount = num(body?.amount ?? 0, "amount");
    const mode = body?.mode === "free_friday_batch" ? "free_friday_batch" : "instant";

    const quote = await getDb().call<any>("fn_withdrawal_quote", {
      p_user_id: session.uid,
      p_amount: amount,
      p_mode: mode,
    });
    if (!quote?.ok) throw ApiError.notFound("Your account could not be loaded.");

    const config = (await getDb().call<any>("fn_public_config", {})) ?? {};
    return NextResponse.json({ ok: true, ...quote, config });
  } catch (error) {
    return jsonError(error, "withdrawals/quote");
  }
}

/** Default terms (no amount) — handy for rendering the form before typing. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const [quote, config] = await Promise.all([
      getDb().call<any>("fn_withdrawal_quote", { p_user_id: session.uid, p_amount: 0, p_mode: "instant" }),
      getDb().call<any>("fn_public_config", {}),
    ]);
    return NextResponse.json({ ok: true, ...(quote ?? {}), config: config ?? {} });
  } catch (error) {
    return jsonError(error, "withdrawals/quote");
  }
}
