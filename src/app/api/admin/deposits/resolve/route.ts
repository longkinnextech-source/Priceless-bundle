import { NextResponse } from "next/server";
import { ApiError, jsonError, num, readJson, str } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Resolve an unmatched deposit: credit it to a chosen account, or reject it.
 * Either way the decision is audited and the wallet change is ledgered.
 */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireAdmin();
    const body = await readJson<Record<string, unknown>>(request);

    const depositId = str(body.deposit_id ?? body.depositId, "Deposit");
    const action = body.action === "reject" ? "reject" : "credit";
    const userId = typeof body.user_id === "string" && body.user_id ? body.user_id : null;
    const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
    const override =
      body.amount === undefined || body.amount === null || body.amount === "" ? null : num(body.amount, "amount");

    const result = unwrap(
      await getDb().call<any>("fn_admin_resolve_deposit", {
        p_deposit_id: depositId,
        p_user_id: userId,
        p_action: action,
        p_note: note,
        p_actor: `operator:${session.phone}`,
        p_amount_override: override,
      })
    );
    return NextResponse.json({
      ok: true,
      ...result,
      message: result.message ?? (action === "reject" ? "Deposit rejected." : "Deposit credited."),
    });
  } catch (error) {
    return jsonError(error, "admin/deposits/resolve");
  }
}
