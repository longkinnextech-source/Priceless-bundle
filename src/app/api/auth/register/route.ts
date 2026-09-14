import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, readJson, str } from "@/lib/api";
import { hashPin, sessionCookieOptions, signSession, validatePin, SESSION_COOKIE } from "@/lib/auth";
import { unwrap } from "@/lib/rpc";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    assertRateLimit(request, "register", 10, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const phone = str(body.phone, "Phone number");
    const fullName = str(body.full_name ?? body.fullName, "Full name");
    const pin = validatePin(body.pin);
    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    const inviteCode =
      typeof body.invite_code === "string" && body.invite_code.trim()
        ? body.invite_code.trim()
        : typeof body.inviteCode === "string" && body.inviteCode.trim()
          ? body.inviteCode.trim()
          : null;
    const wantedTier = body.tier === "sub_agent" ? "sub_agent" : "customer";

    const result = unwrap(
      await getDb().call<any>("fn_register_user", {
        p_phone: phone,
        p_full_name: fullName,
        p_pin_hash: hashPin(pin),
        p_email: email,
        p_squad_invite_code: inviteCode,
        p_accept_tier: wantedTier,
      })
    );

    const user = result.user;
    const token = await signSession({
      uid: user.id,
      phone: user.phone,
      tier: user.tier,
      admin: Boolean(user.is_admin),
    });

    const response = NextResponse.json({
      ok: true,
      created: result.created,
      activated: result.activated,
      user,
      message: result.activated
        ? "Welcome back — your agent account is now active."
        : "Account created. Welcome to Priceless Bundle.",
    });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    return jsonError(error, "auth/register");
  }
}
