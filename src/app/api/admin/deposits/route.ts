import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Deposit log (optionally filtered to the unmatched review queue). */
export async function GET(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const db = getDb();

    if (status === "unmatched_review") {
      const result = await db.call<any>("fn_admin_unmatched_deposits", { p_limit: 100 });
      return NextResponse.json({ ok: true, deposits: result?.deposits ?? [], count: result?.count ?? 0, unmatched: true });
    }

    const result = await db.call<any>("fn_admin_deposits", {
      p_status: status ?? null,
      p_limit: Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500),
      p_offset: Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0),
    });
    return NextResponse.json({ ok: true, deposits: result?.deposits ?? [], count: result?.count ?? 0 });
  } catch (error) {
    return jsonError(error, "admin/deposits");
  }
}
