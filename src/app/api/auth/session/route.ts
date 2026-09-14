import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Current session + authoritative user record (used by client components). */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ ok: true, authenticated: false });

    if (session.admin && session.uid === "admin") {
      return NextResponse.json({
        ok: true,
        authenticated: true,
        admin: true,
        user: {
          id: "admin",
          phone: session.phone,
          full_name: "Operator",
          tier: "super_agent",
          is_admin: true,
          wallet: { balance_ghs: 0, commission_balance_ghs: 0 },
        },
      });
    }
    if (!isConfigured()) return NextResponse.json({ ok: true, authenticated: false });

    const me = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
    if (!me?.ok) return NextResponse.json({ ok: true, authenticated: false });
    return NextResponse.json({ ok: true, authenticated: true, user: me.user, unread: me.unread_notifications });
  } catch (error) {
    return jsonError(error, "auth/session");
  }
}
