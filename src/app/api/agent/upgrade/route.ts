import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Tier upgrade.
 *   { tier: "sub_agent" }   — free registration, standard discount pricing
 *   { tier: "super_agent" } — unlocks at GHS 500 of lifetime wallet deposits
 */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "upgrade", 10, 60_000);

    const body = await readJson<Record<string, unknown>>(request).catch(() => ({}) as Record<string, unknown>);
    const tier = body?.tier === "super_agent" ? "super_agent" : "sub_agent";

    const db = getDb();
    const fn = tier === "super_agent" ? "fn_upgrade_to_super_agent" : "fn_upgrade_to_sub_agent";
    const result = unwrap(await db.call<any>(fn, { p_user_id: session.uid }));
    const me = await db.call<any>("fn_get_me", { p_user_id: session.uid });

    return NextResponse.json({
      ok: true,
      tier: result.tier,
      already: Boolean(result.already),
      squad: result.squad ?? null,
      user: me?.user ?? result.user,
      message:
        tier === "super_agent"
          ? result.already
            ? "You are already a Super Agent."
            : "Super Agent unlocked — VIP wholesale pricing and free instant payouts are live."
          : result.already
            ? "You are already a Sub-Agent."
            : "You are now a Sub-Agent. Sub-Agent pricing is live.",
    });
  } catch (error) {
    return jsonError(error, "agent/upgrade");
  }
}
