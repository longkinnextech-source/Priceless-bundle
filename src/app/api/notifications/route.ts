import { NextResponse } from "next/server";
import { ApiError, jsonError, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const result = await getDb().call<any>("fn_notifications_list", { p_user_id: session.uid, p_limit: 30 });
    return NextResponse.json({
      ok: true,
      notifications: result?.notifications ?? [],
      unread: result?.unread ?? 0,
    });
  } catch (error) {
    return jsonError(error, "notifications");
  }
}

/** Mark one notification (or all) as read. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const body = await readJson<Record<string, unknown>>(request).catch(() => ({}) as Record<string, unknown>);
    const id = body?.id === undefined || body?.id === null || body?.id === "" ? null : Number(body.id);
    await getDb().call("fn_notifications_mark_read", {
      p_user_id: session.uid,
      p_id: Number.isFinite(id as number) ? id : null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "notifications/read");
  }
}
