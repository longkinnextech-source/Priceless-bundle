import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Raw SMS webhook audit trail — every payload, parsed or not. */
export async function GET(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const url = new URL(request.url);
    const result = await getDb().call<any>("fn_admin_webhook_events", {
      p_source: url.searchParams.get("source") ?? null,
      p_limit: Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200),
    });
    return NextResponse.json({ ok: true, events: result?.events ?? [] });
  } catch (error) {
    return jsonError(error, "admin/webhook-events");
  }
}
