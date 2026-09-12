import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";
import { requestBaseUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/** Revenue, orders, deposits, users, squads, withdrawals + 14-day trend. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const db = getDb();

    const [metrics, config] = await Promise.all([
      db.call<any>("fn_admin_metrics", {}),
      db.call<any>("fn_public_config", {}),
    ]);

    return NextResponse.json({
      ok: true,
      ...metrics,
      config: config ?? {},
      sms_webhook_url: (await requestBaseUrl()) + "/api/webhook/sms-deposit",
      replica_check: db.kind,
    });
  } catch (error) {
    return jsonError(error, "admin/metrics");
  }
}
