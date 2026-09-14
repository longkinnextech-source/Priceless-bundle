import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Prove every wallet still equals the sum of its ledger entries. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const result = await getDb().call<any>("fn_admin_reconcile", {});
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error, "admin/reconcile");
  }
}
