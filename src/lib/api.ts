/**
 * API plumbing: typed JSON responses, an error type that survives the
 * server/client boundary, and lightweight in-memory rate limiting.
 */

import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INSUFFICIENT_FUNDS"
  | "SERVER_ERROR"
  | "DB_UNREACHABLE";

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INSUFFICIENT_FUNDS: 402,
  SERVER_ERROR: 500,
  DB_UNREACHABLE: 503,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError("BAD_REQUEST", message, details);
  }
  static unauthorized(message = "Please sign in to continue.") {
    return new ApiError("UNAUTHORIZED", message);
  }
  static forbidden(message = "You do not have access to this.") {
    return new ApiError("FORBIDDEN", message);
  }
  static notFound(message = "Not found.") {
    return new ApiError("NOT_FOUND", message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError("CONFLICT", message, details);
  }
  static server(message = "Something went wrong on our side. Please try again.") {
    return new ApiError("SERVER_ERROR", message);
  }
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...(data as object) }, { status: 200, ...init });
}

export function jsonError(error: unknown, context = "api") {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { ok: false, error: error.code, message: error.message, details: error.details ?? undefined },
      { status: error.status }
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${context}] unhandled error:`, error);
  const unreachable = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|DB_UNREACHABLE|NO_DATABASE_URL|No database configured/i.test(message);
  return NextResponse.json(
    {
      ok: false,
      error: unreachable ? "DB_UNREACHABLE" : "SERVER_ERROR",
      message: unreachable
        ? "The database is not reachable right now. Please try again shortly."
        : "Something went wrong on our side. Please try again.",
    },
    { status: unreachable ? 503 : 500 }
  );
}

/* --------------------------- rate limiting --------------------------- */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Simple fixed-window limiter. Good enough for a single-region deployment. */
export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function assertRateLimit(request: Request, bucket: string, limit: number, windowMs = 60_000) {
  const { allowed, retryAfter } = rateLimit(`${bucket}:${clientIp(request)}`, limit, windowMs);
  if (!allowed) {
    throw new ApiError("RATE_LIMITED", `Too many requests. Try again in ${retryAfter}s.`, { retryAfter });
  }
}

/** Parse + validate a JSON body without ever throwing a 500 on bad input. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) throw ApiError.badRequest("Expected a JSON body.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw ApiError.badRequest("That request body was not valid JSON.");
  }
}

export function num(value: unknown, field = "amount"): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[,\s]/g, "");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw ApiError.badRequest(`Enter a valid ${field}.`);
}

export function str(value: unknown, field = "value"): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw ApiError.badRequest(`${field} is required.`);
}
