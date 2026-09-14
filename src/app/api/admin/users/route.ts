import { NextResponse } from "next/server";
import { ApiError, jsonError, num, readJson, str } from "@/lib/api";
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
    const result = await getDb().call<any>("fn_admin_users", {
      p_search: url.searchParams.get("q") ?? null,
      p_limit: Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500),
      p_offset: Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0),
    });
    return NextResponse.json({ ok: true, users: result?.users ?? [], count: result?.count ?? 0 });
  } catch (error) {
    return jsonError(error, "admin/users");
  }
}

/** Change a tier, adjust a wallet, or suspend an account. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireAdmin();
    const body = await readJson<Record<string, unknown>>(request);
    const actor = `operator:${session.phone}`;
    const db = getDb();
    const action = str(body.action, "Action");

    if (action === "set_tier") {
      const userId = str(body.user_id, "User");
      const tier = str(body.tier, "Tier");
      if (!["customer", "sub_agent", "super_agent"].includes(tier)) throw ApiError.badRequest("Unknown tier.");
      const result = unwrap(
        await db.call<any>("fn_admin_set_user_tier", { p_user_id: userId, p_tier: tier, p_actor: actor })
      );
      return NextResponse.json({ ok: true, ...result, message: `Tier changed to ${tier.replace("_", " ")}.` });
    }

    if (action === "adjust_wallet") {
      const result = unwrap(
        await db.call<any>("fn_admin_credit_wallet", {
          p_user_id: str(body.user_id, "User"),
          p_amount: num(body.amount, "amount"),
          p_reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : "Operator adjustment",
          p_actor: actor,
        })
      );
      return NextResponse.json({ ok: true, ...result, message: "Wallet adjusted." });
    }

    if (action === "set_status") {
      const status = body.status === "suspended" ? "suspended" : "active";
      const result = unwrap(
        await db.call<any>("fn_admin_set_user_status", {
          p_user_id: str(body.user_id, "User"),
          p_status: status,
          p_actor: actor,
        })
      );
      return NextResponse.json({ ok: true, ...result, message: `Account ${status}.` });
    }

    throw ApiError.badRequest("Unknown admin action.");
  } catch (error) {
    return jsonError(error, "admin/users");
  }
}
