import { NextResponse } from "next/server";
import { ApiError, jsonError, readJson, str } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const url = new URL(request.url);
    const result = await getDb().call<any>("fn_admin_withdrawals", {
      p_status: url.searchParams.get("status") ?? null,
      p_limit: 200,
      p_offset: 0,
    });
    return NextResponse.json({
      ok: true,
      withdrawals: result?.withdrawals ?? [],
      count: result?.count ?? 0,
      totals: result?.totals ?? null,
      free_friday_scheduled_for: null,
    });
  } catch (error) {
    return jsonError(error, "admin/withdrawals");
  }
}

/**
 * Mark a payout paid / processing, or reject it (which returns the funds).
 * `action: "run_free_friday"` queues the whole batched run.
 */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireAdmin();
    const body = await readJson<Record<string, unknown>>(request);
    const actor = `operator:${session.phone}`;
    const db = getDb();

    if (body.action === "run_free_friday") {
      const result = unwrap(await db.call<any>("fn_admin_process_free_friday", { p_actor: actor }));
      return NextResponse.json({ ok: true, ...result });
    }

    const id = str(body.withdrawal_id ?? body.id, "Withdrawal");
    const status = str(body.status, "Status");
    if (!["pending", "batched", "processing", "paid", "rejected"].includes(status)) {
      throw ApiError.badRequest("Unknown withdrawal status.");
    }

    const result = unwrap(
      await db.call<any>("fn_admin_mark_withdrawal", {
        p_withdrawal_id: id,
        p_status: status,
        p_payout_reference: typeof body.payout_reference === "string" ? body.payout_reference.slice(0, 120) : null,
        p_note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
        p_actor: actor,
      })
    );
    return NextResponse.json({ ok: true, ...result, message: `Payout marked ${status}.` });
  } catch (error) {
    return jsonError(error, "admin/withdrawals/mark");
  }
}
