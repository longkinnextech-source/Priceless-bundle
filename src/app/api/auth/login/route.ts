import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, readJson, str } from "@/lib/api";
import { SESSION_COOKIE, safeEqual, sessionCookieOptions, signSession, verifyPin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env, isConfigured, isProduction } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    assertRateLimit(request, "login", 12, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const phone = str(body.phone, "Phone number");
    const pin = str(body.pin, "PIN");

    // Operator access: the admin phone + ADMIN_PIN from the environment.
    if (isProduction() && env.adminPin === "246810") {
      console.warn("[security] ADMIN_PIN is still the default — set ADMIN_PHONE and ADMIN_PIN before launch.");
    }
    if (safeEqual(phone.replace(/[^0-9]/g, ""), env.adminPhone.replace(/[^0-9]/g, "")) && safeEqual(pin, env.adminPin)) {
      const token = await signSession({ uid: "admin", phone: env.adminPhone, tier: "super_agent", admin: true });
      const response = NextResponse.json({
        ok: true,
        admin: true,
        redirect: "/admin",
        message: "Signed in as operator.",
      });
      response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(12 * 60 * 60));
      return response;
    }

    const lookup = await getDb().call<any>("fn_auth_lookup", { p_phone: phone });

    if (!lookup?.ok) {
      if (lookup?.error === "NOT_ACTIVATED") {
        throw ApiError.conflict(
          lookup.message ?? "This agent account needs activating. Create your account with the same number to set a PIN.",
          { code: "NOT_ACTIVATED" }
        );
      }
      // Same message for unknown users and bad PINs — no account enumeration.
      throw ApiError.unauthorized("That phone number and PIN do not match.");
    }
    if (lookup.status !== "active") {
      throw ApiError.forbidden("This account is suspended. Please contact support.");
    }
    if (!verifyPin(pin, lookup.pin_hash)) {
      throw ApiError.unauthorized("That phone number and PIN do not match.");
    }

    await getDb().call("fn_touch_login", { p_user_id: lookup.user_id });
    const me = await getDb().call<any>("fn_get_me", { p_user_id: lookup.user_id });

    const token = await signSession({
      uid: lookup.user_id,
      phone: lookup.phone,
      tier: lookup.tier,
      admin: Boolean(me?.user?.is_admin),
    });

    const response = NextResponse.json({
      ok: true,
      admin: Boolean(me?.user?.is_admin),
      user: me?.user,
      redirect: me?.user?.is_admin ? "/admin" : "/buy",
      message: `Welcome back, ${lookup.full_name ?? lookup.phone}.`,
    });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    return jsonError(error, "auth/login");
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "METHOD_NOT_ALLOWED", message: "Use POST to sign in." },
    { status: 405 }
  );
}
