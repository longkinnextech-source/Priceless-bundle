import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const result = await getDb().call<any>("fn_admin_squads", {});
    return NextResponse.json({ ok: true, squads: result?.squads ?? [] });
  } catch (error) {
    return jsonError(error, "admin/squads");
  }
}
