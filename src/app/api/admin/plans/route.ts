import { NextResponse } from "next/server";
import { ApiError, jsonError, num, readJson, str } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Full pricing table including cost prices (admin only). */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const result = await getDb().call<any>("fn_admin_plans", {});
    return NextResponse.json({ ok: true, plans: result?.plans ?? [] });
  } catch (error) {
    return jsonError(error, "admin/plans");
  }
}

/** Create or update a plan — writes straight to `plans`. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireAdmin();
    const body = await readJson<Record<string, unknown>>(request);

    const actor = `operator:${session.phone}`;
    const result = unwrap(
      await getDb().call<any>("fn_admin_upsert_plan", {
        p_plan_id: typeof body.plan_id === "string" && body.plan_id ? body.plan_id : null,
        p_network: str(body.network, "Network"),
        p_size_label: str(body.size_label ?? body.sizeLabel, "Bundle size"),
        p_data_mb: Math.round(num(body.data_mb ?? body.dataMb, "bundle size in MB")),
        p_cost_price_ghs: num(body.cost_price_ghs ?? body.costPrice, "cost price"),
        p_retail_price_ghs: num(body.retail_price_ghs ?? body.retailPrice, "retail price"),
        p_sub_agent_price_ghs: num(body.sub_agent_price_ghs ?? body.subAgentPrice, "Sub-Agent price"),
        p_super_agent_price_ghs: num(body.super_agent_price_ghs ?? body.superAgentPrice, "Super Agent price"),
        p_validity_days: Math.round(num(body.validity_days ?? 90, "validity")),
        p_active: body.active === undefined ? true : Boolean(body.active),
        p_sort_order: Math.round(num(body.sort_order ?? 100, "sort order")),
        p_actor: actor,
      })
    );
    return NextResponse.json({ ok: true, plan: result.plan, message: "Pricing saved." });
  } catch (error) {
    return jsonError(error, "admin/plans/upsert");
  }
}
