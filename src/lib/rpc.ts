/**
 * Maps Postgres business-rule error codes from the RPC layer onto HTTP.
 * Business failures come back as { ok: false, error: "CODE" } — never as
 * exceptions — so the API can answer with a sensible status and message.
 */

import { ApiError, type ApiErrorCode } from "@/lib/api";

const MAP: Record<string, { code: ApiErrorCode; message?: string }> = {
  INVALID_PHONE: { code: "BAD_REQUEST" },
  INVALID_NAME: { code: "BAD_REQUEST" },
  INVALID_PIN: { code: "BAD_REQUEST" },
  INVALID_AMOUNT: { code: "BAD_REQUEST" },
  INVALID_RECIPIENT: { code: "BAD_REQUEST" },
  INVALID_NETWORK: { code: "BAD_REQUEST" },
  INVALID_SIZE: { code: "BAD_REQUEST" },
  INVALID_PRICING: { code: "BAD_REQUEST" },
  INVALID_ACTION: { code: "BAD_REQUEST" },
  INVALID_ENDPOINT: { code: "BAD_REQUEST" },
  INVALID_TOKEN: { code: "BAD_REQUEST" },
  INVALID_INVITE: { code: "NOT_FOUND" },
  AMOUNT_BELOW_MIN: { code: "BAD_REQUEST" },
  AMOUNT_ABOVE_MAX: { code: "BAD_REQUEST" },
  AMOUNT_TOO_SMALL: { code: "BAD_REQUEST" },
  NEGATIVE_PRICE: { code: "BAD_REQUEST" },
  BELOW_COST: { code: "BAD_REQUEST" },
  TIER_ORDER: { code: "BAD_REQUEST" },
  DUPLICATE_PLAN: { code: "CONFLICT" },
  PHONE_TAKEN: { code: "CONFLICT" },
  TOKEN_IN_USE: { code: "CONFLICT" },
  PHONE_NUMBER_ID_IN_USE: { code: "CONFLICT" },
  ALREADY_RESOLVED: { code: "CONFLICT" },
  ALREADY_FINAL: { code: "CONFLICT" },
  NOT_PENDING: { code: "CONFLICT" },

  USER_NOT_FOUND: { code: "NOT_FOUND" },
  PLAN_NOT_FOUND: { code: "NOT_FOUND" },
  PLAN_UNAVAILABLE: { code: "NOT_FOUND" },
  ORDER_NOT_FOUND: { code: "NOT_FOUND" },
  DEPOSIT_NOT_FOUND: { code: "NOT_FOUND" },
  WITHDRAWAL_NOT_FOUND: { code: "NOT_FOUND" },
  SQUAD_NOT_FOUND: { code: "NOT_FOUND" },
  RECIPIENT_NOT_FOUND: { code: "NOT_FOUND" },

  NOT_SUPER_AGENT: { code: "FORBIDDEN" },
  ACCOUNT_SUSPENDED: { code: "FORBIDDEN" },
  SELF_RECRUIT: { code: "BAD_REQUEST" },

  INSUFFICIENT_FUNDS: { code: "INSUFFICIENT_FUNDS" },
  INSUFFICIENT_COMMISSION: { code: "INSUFFICIENT_FUNDS" },
  NOTHING_TO_REINVEST: { code: "BAD_REQUEST" },
  COMMITMENT_NOT_MET: { code: "CONFLICT" },
  ABOVE_INSTANT_LIMIT: { code: "BAD_REQUEST" },
  SELF_TRANSFER: { code: "BAD_REQUEST" },
  RECIPIENT_INACTIVE: { code: "FORBIDDEN" },
  OWN_SQUAD: { code: "CONFLICT" },
  NOT_ACTIVATED: { code: "FORBIDDEN" },
  BOT_NOT_LINKED: { code: "NOT_FOUND" },
  UNSUPPORTED_CHANNEL: { code: "BAD_REQUEST" },
  USER_REQUIRED: { code: "BAD_REQUEST" },
  CODE_GENERATION_FAILED: { code: "SERVER_ERROR" },
  SERVER_ERROR: { code: "SERVER_ERROR" },
};

/**
 * Unwrap an RPC result: returns the payload when ok, throws an ApiError with
 * the mapped status otherwise.
 */
export function unwrap<T extends { ok?: boolean; error?: string; message?: string }>(result: T | null | undefined): T {
  if (!result) throw ApiError.server("The database did not respond. Please try again.");
  if (result.ok) return result;

  const rpcError = String(result.error ?? "SERVER_ERROR");
  const mapped = MAP[rpcError] ?? { code: "BAD_REQUEST" as ApiErrorCode };
  const message =
    result.message ??
    mapped.message ??
    humanise(rpcError);

  return (() => {
    throw new ApiError(mapped.code, message, { error: rpcError, ...stripMeta(result) });
  })();
}

/** Drop the RPC envelope keys so only the payload reaches the caller. */
function stripMeta(result: Record<string, any>) {
  const rest = { ...(result as Record<string, any>) };
  delete rest.ok;
  delete rest.error;
  delete rest.message;
  return rest;
}

function humanise(code: string): string {
  const words = code.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1) + ".";
}

/** Like unwrap, but returns null instead of throwing (for optional reads). */
export function soft<T>(result: T | null | undefined): T | null {
  if (!result || !(result as any).ok) return null;
  return result;
}
