import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Every order, with buyer, attribution and margin. */
export async function GET(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const url = new URL(request.url);
    const result = await getDb().call<any>("fn_admin_orders", {
      p_status: url.searchParams.get("status") ?? null,
      p_search: url.searchParams.get("q") ?? null,
      p_limit: Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500),
      p_offset: Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0),
    });
    return NextResponse.json({ ok: true, orders: result?.orders ?? [], count: result?.count ?? 0 });
  } catch (error) {
    return jsonError(error, "admin/orders");
  }
}
