import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, readJson, str } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Squad dashboard (volume vs target, members, retention). */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const result = await getDb().call<any>("fn_squad_dashboard", { p_user_id: session.uid });
    return NextResponse.json(unwrap(result));
  } catch (error) {
    return jsonError(error, "agent/squad");
  }
}

/** Join a squad with an invite code. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "squad-join", 10, 60_000);
    const body = await readJson<Record<string, unknown>>(request);
    const code = str(body.invite_code ?? body.code, "Squad code");

    const result = unwrap(
      await getDb().call<any>("fn_join_squad", { p_user_id: session.uid, p_invite_code: code })
    );
    return NextResponse.json({
      ok: true,
      squad: result.squad,
      already_member: Boolean(result.already_member),
      message: result.already_member ? "You are already in that squad." : `Joined ${result.squad?.name ?? "the squad"}.`,
    });
  } catch (error) {
    return jsonError(error, "agent/squad/join");
  }
}
