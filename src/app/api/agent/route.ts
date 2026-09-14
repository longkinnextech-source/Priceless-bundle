import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Everything the Agent dashboard needs in one round trip. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const db = getDb();

    const [me, eligibility, squad, commission, recruits, config] = await Promise.all([
      db.call<any>("fn_get_me", { p_user_id: session.uid }),
      db.call<any>("fn_upgrade_eligibility", { p_user_id: session.uid }),
      db.call<any>("fn_squad_dashboard", { p_user_id: session.uid }),
      db.call<any>("fn_commission_summary", { p_user_id: session.uid }),
      db.call<any>("fn_list_recruits", { p_super_agent_id: session.uid }),
      db.call<any>("fn_public_config", {}),
    ]);

    const myOrders = await db.call<any>("fn_list_orders", { p_user_id: session.uid, p_limit: 10 });

    return NextResponse.json({
      ok: true,
      user: me?.user ?? null,
      eligibility: eligibility ?? null,
      squad: squad ?? null,
      commission: commission ?? null,
      recruits: recruits ?? null,
      recent_orders: myOrders?.orders ?? [],
      config: config ?? {},
    });
  } catch (error) {
    return jsonError(error, "agent");
  }
}
