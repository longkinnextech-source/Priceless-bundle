import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The price list, resolved server-side for the caller's own tier.
 * Prices always come from fn_list_plans() — a client never sends one.
 */
export async function GET() {
  try {
    if (!isConfigured()) {
      return NextResponse.json({ ok: true, plans: [], configured: false });
    }
    const session = await getSession();
    const result = await getDb().call<any>("fn_list_plans", { p_user_id: session?.uid ?? null });
    return NextResponse.json({
      ok: true,
      configured: true,
      tier: session?.tier ?? "customer",
      plans: result?.plans ?? [],
    });
  } catch (error) {
    return jsonError(error, "plans");
  }
}
