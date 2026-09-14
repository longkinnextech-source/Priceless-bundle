/**
 * Authentication: PIN hashing, signed session cookies, session helpers.
 *
 * Sessions are stateless JWTs in an httpOnly cookie, signed with
 * SESSION_SECRET. They carry only the user id + tier + admin flag; every
 * request re-reads the authoritative record from the database.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { ApiError } from "@/lib/api";
import { env, isProduction } from "@/lib/env";
import { getDb } from "@/lib/db";

export const SESSION_COOKIE = "pb_session";
const SESSION_DAYS = 30;

export type Session = {
  uid: string;
  phone: string;
  tier: "customer" | "sub_agent" | "super_agent";
  admin: boolean;
};

/* ------------------------------- PIN hashing ------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** scrypt$N$r$p$salt$hash — self-describing so parameters can be raised later. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, "base64");
    const expected = Buffer.from(hashB64!, "base64");
    const actual = scryptSync(pin.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Constant-time string compare for the operator credentials. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "pb-compare").update(a).digest();
  const hb = createHmac("sha256", "pb-compare").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function validatePin(pin: unknown): string {
  const value = typeof pin === "string" ? pin.trim() : "";
  if (!/^[0-9]{4,6}$/.test(value)) {
    throw ApiError.badRequest("Your PIN must be 4 to 6 digits.");
  }
  return value;
}

/* --------------------------- session token codec -------------------------- */

function sessionKey(): Uint8Array {
  const secret = env.sessionSecret ?? (isProduction() ? undefined : "priceless-bundle-development-session-secret");
  if (!secret) {
    throw new Error("SESSION_SECRET must be set in production (32+ random characters).");
  }
  if (isProduction() && secret.length < 16) {
    throw new Error("SESSION_SECRET is too short — use at least 32 random characters in production.");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("priceless-bundle")
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(sessionKey());
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { issuer: "priceless-bundle" });
    if (!payload.uid || !payload.phone) return null;
    return {
      uid: String(payload.uid),
      phone: String(payload.phone),
      tier: (payload.tier as Session["tier"]) ?? "customer",
      admin: Boolean(payload.admin),
    };
  } catch {
    return null;
  }
}

/* ------------------------------ cookie helpers ---------------------------- */

export function sessionCookieOptions(maxAge = SESSION_DAYS * 24 * 60 * 60) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction(),
    path: "/",
    maxAge,
  };
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/** For server components: returns the session or null, never throws. */
export async function currentUser(): Promise<Session | null> {
  try {
    return await getSession();
  } catch {
    return null;
  }
}

/** For API routes: throws a 401-shaped error when signed out. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw ApiError.unauthorized();
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (!session.admin) throw ApiError.forbidden("Administrator access is required.");
  return session;
}

/** The signed-in user's full record (authoritative, straight from Postgres). */
export async function requireUserRecord() {
  const session = await requireSession();
  const result = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
  if (!result?.ok) throw ApiError.unauthorized("Your account could not be loaded. Please sign in again.");
  return { session, user: result.user as Record<string, any>, unread: result.unread_notifications as number };
}
