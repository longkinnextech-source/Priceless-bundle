import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const response = NextResponse.json({ ok: true, message: "Signed out." });
    response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
    return response;
  } catch (error) {
    return jsonError(error, "auth/logout");
  }
}
