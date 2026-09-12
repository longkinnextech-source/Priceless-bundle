/**
 * Mobile-money SMS parsing.
 *
 * An Android SMS-forwarder app on the collection phone POSTs raw SMS text to
 * /api/webhook/sms-deposit. Mobile-money messages are written by humans at the
 * telcos and are NOT standardised, so this parser is deliberately defensive:
 *
 *   - it never throws, for any input, ever
 *   - every field is optional; anything it is unsure about comes back as null
 *   - it reports the strategy it used and a confidence score
 *   - the raw message is always logged by the caller BEFORE parsing
 *
 * Anything with low confidence is routed to manual review rather than credited.
 */

import { createHash } from "node:crypto";

export type SmsDirection = "credit" | "debit" | "unknown";

export type ParsedSms = {
  amount: number | null;
  senderPhone: string | null;
  reference: string | null;
  /**
   * Money in or money out. The collection phone also receives debit alerts
   * (withdrawals, airtime purchases, transfers out) — those must NEVER be
   * credited to a user's wallet, so a debit message is stripped of its amount
   * and routed to manual review.
   */
  direction: SmsDirection;
  provider: "MTN Mobile Money" | "Telecel Cash" | "AirtelTigo Money" | null;
  currency: "GHS";
  confidence: number;
  warnings: string[];
};

export type IncomingSms = {
  rawMessage: string;
  forwardedSender: string | null;
  receivedAt: string | null;
  providerHint: string | null;
  device: string | null;
};

/**
 * Direction detection. Credit wins whenever both vocabularies appear, because
 * a genuine deposit SMS often mentions a fee being charged alongside it
 * ("Payment received for GHS 50.00 … a charge of GHS 0.50 applies").
 */
const CREDIT_WORDS =
  /\b(?:credit(?:ed|s)?|received?|receipt|deposit(?:ed|s)?|cash[\s-]?in|top[\s-]?up|paid\s+in|payment\s+(?:received|from)|transfer(?:red)?\s+(?:to\s+you|into)|has\s+been\s+added)\b/i;
const DEBIT_WORDS =
  /\b(?:debit(?:ed|s)?|withdrawn|withdraw(?:al)?|cash[\s-]?out|you\s+(?:have\s+)?sent|sent\s+to|payment\s+to|paid\s+to|transfer(?:red)?\s+to\s+(?!you)|purchase(?:d)?|airtime|bought|charged?|reversal|refund(?:ed)?\s+to)\b/i;

export function detectDirection(text: string): SmsDirection {
  const haystack = (text ?? "").toLowerCase();
  if (!haystack.trim()) return "unknown";
  if (CREDIT_WORDS.test(haystack)) return "credit";
  if (DEBIT_WORDS.test(haystack)) return "debit";
  return "unknown";
}

/** Strip currency noise so a single regex can chase the numbers. */
function normalise(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[₵]/g, " GHS ")
    .replace(/\bGH[SC]\b/gi, " GHS ")
    .replace(/\bGHS\s*GHS\b/gi, "GHS")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** "1,250.50" -> 1250.5 ; "50" -> 50 ; junk -> null */
function toAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0 || value > 10_000_000) return null;
  return Math.round(value * 100) / 100;
}

const AMOUNT_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  // "Payment received for GHS 50.00 from ..."
  { re: /(?:payment|received|credited|deposit(?:ed)?|paid|transfer(?:red)?|cash\s?in|top\s?up)\b[^0-9]{0,40}GHS\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i, weight: 1.0, label: "keyword_before_amount" },
  // "GHS 50.00 has been received from ..."
  { re: /GHS\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:has been|was|is)?\s*(?:received|credited|deposited|paid|sent)/i, weight: 0.95, label: "amount_before_keyword" },
  // "amount of GHS 50"
  { re: /amount(?:\s+of)?\s*:?\s*GHS\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i, weight: 0.9, label: "amount_of" },
  // Any currency mention — weakest, and we disqualify balances below.
  { re: /GHS\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i, weight: 0.5, label: "first_currency_amount" },
];

function extractAmount(text: string, warnings: string[]): number | null {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const value = toAmount(match[1]);
    if (value === null) continue;

    // Reject a "new balance" figure picked up by the weakest pattern.
    if (pattern.label === "first_currency_amount") {
      const before = text.slice(Math.max(0, match.index - 25), match.index).toLowerCase();
      if (/(balance|bal\b|available|remaining)/.test(before)) {
        warnings.push("skipped_balance_amount");
        continue;
      }
    }
    return value;
  }
  return null;
}

const PHONE_RE = /(?:\+?233|0)?([2-5][0-9]{8})/g;

function extractSenderPhone(text: string, warnings: string[]): string | null {
  const candidates: string[] = [];

  // Prefer a number introduced by "from" / "sender".
  const labelled = /(?:from|sender|by|number)\s*:?\s*([+0-9][0-9\s\-()]{8,19})/gi;
  let match: RegExpExecArray | null;
  while ((match = labelled.exec(text)) !== null) {
    const digits = match[1]!.replace(/[^0-9]/g, "");
    const normalised = normalisePhone(digits);
    if (normalised) candidates.push(normalised);
  }

  if (candidates.length === 0) {
    PHONE_RE.lastIndex = 0;
    while ((match = PHONE_RE.exec(text)) !== null) {
      const normalised = normalisePhone(match[0]!);
      if (normalised) candidates.push(normalised);
    }
  }
  if (candidates.length === 0) {
    warnings.push("sender_not_found");
    return null;
  }
  if (candidates.length > 1 && new Set(candidates).size > 1) {
    warnings.push("multiple_phone_numbers");
  }
  return candidates[0]!;
}

/** +233XXXXXXXXX / 233XXXXXXXXX / 0XXXXXXXXX -> 0XXXXXXXXX */
export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = String(input).replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.startsWith("233") && digits.length >= 12) digits = `0${digits.slice(3)}`;
  if (/^[0-9]{9}$/.test(digits)) digits = `0${digits}`;
  if (!/^0[0-9]{9}$/.test(digits)) return null;
  return digits;
}

function extractReference(text: string): string | null {
  // Accepts PB-4X7Q, PB4X7Q, pb 4x7q
  const match = /\bPB[\s\-]?([A-Z0-9]{4})\b/i.exec(text);
  if (!match) return null;
  return `PB-${match[1]!.toUpperCase()}`;
}

function detectProvider(text: string, hint: string | null): ParsedSms["provider"] {
  const haystack = `${text} ${hint ?? ""}`.toLowerCase();
  if (/\bmtn\b|mobile money|\bmomo\b/.test(haystack)) return "MTN Mobile Money";
  if (/\btelecel\b|\bvodafone\b|\bvoda\b|\bvf\b/.test(haystack)) return "Telecel Cash";
  if (/\bairteltigo\b|\bairtel\b|\btigo\b|\bat\b/.test(haystack)) return "AirtelTigo Money";
  return null;
}

/** Parse one raw SMS. Never throws. */
export function parseDepositSms(rawMessage: string, providerHint: string | null = null): ParsedSms {
  const warnings: string[] = [];
  const result: ParsedSms = {
    amount: null,
    senderPhone: null,
    reference: null,
    direction: "unknown",
    provider: detectProvider(rawMessage ?? "", providerHint),
    currency: "GHS",
    confidence: 0,
    warnings,
  };

  try {
    if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
      warnings.push("empty_message");
      return result;
    }

    const text = normalise(rawMessage);
    result.direction = detectDirection(text);
    result.amount = extractAmount(text, warnings);
    result.senderPhone = extractSenderPhone(text, warnings);
    result.reference = extractReference(text);

    // A debit alert is money LEAVING the collection phone. Never credit it —
    // hand it to a human instead.
    if (result.direction === "debit") {
      if (result.amount !== null) warnings.push("debit_message_ignored");
      result.amount = null;
    } else if (result.direction === "unknown") {
      warnings.push("direction_unknown");
    }

    let confidence = 0;
    if (result.amount !== null) confidence += 0.5;
    if (result.senderPhone !== null) confidence += 0.25;
    if (result.reference !== null) confidence += 0.15;
    if (result.provider !== null) confidence += 0.1;
    if (warnings.includes("multiple_phone_numbers")) confidence -= 0.05;
    result.confidence = Math.max(0, Math.min(1, Math.round(confidence * 1000) / 1000));
  } catch (error) {
    // Absolutely never throw on the webhook path.
    warnings.push(`parse_error:${(error as Error)?.message ?? "unknown"}`);
    result.confidence = 0;
  }
  return result;
}

/** Stable idempotency key for a forwarded SMS. */
export function smsHash(rawMessage: string, forwardedSender?: string | null): string {
  return createHash("sha256")
    .update(`${forwardedSender ?? ""}::${rawMessage ?? ""}`)
    .digest("hex");
}

/**
 * Normalise the many shapes an SMS-forwarder app might use.
 * Accepts: raw text/plain body, JSON, or form-encoded payloads.
 */
export function extractIncoming(
  body: string,
  contentType: string | null
): IncomingSms {
  const type = (contentType ?? "").toLowerCase();
  const base: IncomingSms = {
    rawMessage: "",
    forwardedSender: null,
    receivedAt: null,
    providerHint: null,
    device: null,
  };

  try {
    if (type.includes("json") || looksLikeJson(body)) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const pick = (...keys: string[]): string | null => {
        for (const key of keys) {
          const value = parsed[key];
          if (typeof value === "string" && value.trim()) return value.trim();
          if (typeof value === "number") return String(value);
        }
        return null;
      };
      return {
        rawMessage: pick("message", "text", "body", "msg", "sms", "content") ?? "",
        forwardedSender: pick("sender", "from", "address", "originator", "source"),
        receivedAt: pick("timestamp", "date", "receivedAt", "time", "sentStamp"),
        providerHint: pick("provider", "network", "sim", "carrier"),
        device: pick("device", "deviceId", "app"),
      };
    }

    if (type.includes("form-urlencoded")) {
      const params = new URLSearchParams(body);
      const pick = (...keys: string[]): string | null => {
        for (const key of keys) {
          const value = params.get(key);
          if (value && value.trim()) return value.trim();
        }
        return null;
      };
      return {
        rawMessage: pick("message", "text", "body", "msg", "sms", "content") ?? "",
        forwardedSender: pick("sender", "from", "address", "originator"),
        receivedAt: pick("timestamp", "date", "receivedAt"),
        providerHint: pick("provider", "network", "sim"),
        device: pick("device", "deviceId"),
      };
    }

    // Plain text body: might be the SMS itself, or "key: value" lines.
    const lines = body.split(/\r?\n/);
    const labelled: Record<string, string> = {};
    for (const line of lines) {
      const match = /^\s*(message|text|body|msg|sms|sender|from|address|provider|network|device)\s*[:=]\s*(.+)$/i.exec(line);
      if (match) labelled[match[1]!.toLowerCase()] = match[2]!.trim();
    }
    const message =
      labelled.message ?? labelled.text ?? labelled.body ?? labelled.msg ?? labelled.sms ?? body.trim();

    return {
      ...base,
      rawMessage: message,
      forwardedSender: labelled.sender ?? labelled.from ?? labelled.address ?? null,
      providerHint: labelled.provider ?? labelled.network ?? null,
      device: labelled.device ?? null,
    };
  } catch {
    // Unparseable body: treat the whole thing as the message text.
    return { ...base, rawMessage: body ?? "" };
  }
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

export const SMS_EXAMPLES = [
  "Payment received for GHS 50.00 from KOFI MENSAH 0244123456. Reference: PB-4X7Q. Your new balance is GHS 120.50. Transaction ID 1234567890.",
  "You have received GHS20.00 from 0501234567. Ref PB4X7Q. Current balance GHS 45.00",
  "GHS 100.00 has been credited to your Telecel Cash account from 0551234567. Trans ID: TC240912.1234",
  "Cash In: GHS 5.00 from 0264123456 (AMA). New balance: GHS 5.00.",
];
