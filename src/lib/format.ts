/**
 * Formatting helpers — money, dates, tier labels, network brands.
 * Everything is rendered in Africa/Accra (GMT) so the business day matches
 * the operator's day.
 */

export const TIMEZONE = "Africa/Accra";

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** "GHS 1,250.50" */
export function formatGhs(value: unknown, options: { symbol?: boolean } = {}): string {
  const amount = toNumber(value, 0);
  const formatted = new Intl.NumberFormat("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return options.symbol === false ? formatted : `GHS ${formatted}`;
}

/** "1,250.50" — for inputs and dense tables. */
export function formatAmount(value: unknown): string {
  return formatGhs(value, { symbol: false });
}

/** "+GHS 50.00" / "-GHS 12.50" for ledger rows. */
export function formatSignedGhs(value: unknown): string {
  const amount = toNumber(value, 0);
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}GHS ${formatAmount(Math.abs(amount))}`;
}

export function formatDate(value: unknown, withTime = true): string {
  if (!value) return "—";
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : (value as Date);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

export function formatRelative(value: unknown): string {
  if (!value) return "—";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value, false);
}

export function formatData(mb: unknown): string {
  const value = toNumber(mb, 0);
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024}GB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}GB`;
  return `${value}MB`;
}

/* --------------------------------- tiers --------------------------------- */

export const TIER_LABELS: Record<string, string> = {
  customer: "Customer",
  sub_agent: "Sub-Agent",
  super_agent: "Super Agent",
};

export function tierLabel(tier: unknown): string {
  return TIER_LABELS[String(tier ?? "customer")] ?? "Customer";
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  delivered: "Delivered",
  failed: "Failed",
  refunded: "Refunded",
};

export const LEDGER_LABELS: Record<string, string> = {
  deposit: "Wallet top-up",
  purchase: "Data purchase",
  commission: "Commission earned",
  commission_reinvest: "Commission reinvested",
  reinvest_bonus: "Reinvestment bonus",
  p2p_send: "Sent to another user",
  p2p_receive: "Received from another user",
  withdrawal: "Withdrawal",
  withdrawal_fee: "Instant payout fee",
  refund: "Refund",
  admin_adjustment: "Adjustment",
  squad_bonus: "Squad bonus",
};

export function ledgerLabel(type: unknown): string {
  return LEDGER_LABELS[String(type ?? "")] ?? String(type ?? "Entry");
}

/* ------------------------------- networks -------------------------------- */

/**
 * Real telecom brand colours, used ONLY on network badges/avatars.
 * Everything else in the product uses the fire palette.
 */
export const NETWORK_BRAND: Record<string, { bg: string; fg: string; ring: string; short: string }> = {
  MTN: { bg: "#FFCC00", fg: "#111111", ring: "#FFCC00", short: "MTN" },
  Telecel: { bg: "#E60000", fg: "#FFFFFF", ring: "#E60000", short: "TC" },
  AirtelTigo: { bg: "#0072CE", fg: "#FFFFFF", ring: "#0072CE", short: "AT" },
};

export function networkBrand(network: unknown) {
  const key = String(network ?? "");
  return NETWORK_BRAND[key] ?? { bg: "#3f3f46", fg: "#FFFFFF", ring: "#3f3f46", short: key.slice(0, 2).toUpperCase() || "??" };
}

export const NETWORKS = ["MTN", "Telecel", "AirtelTigo"] as const;
export type Network = (typeof NETWORKS)[number];

/** Smart default: guess the recipient's network from their prefix. */
export function guessNetworkFromPhone(phone: string): Network | null {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  const local = digits.startsWith("233") ? `0${digits.slice(3)}` : digits;
  if (/^0(24|25|53|54|55|59)/.test(local)) return "MTN";
  if (/^0(20|50)/.test(local)) return "Telecel";
  if (/^0(26|27|56|57)/.test(local)) return "AirtelTigo";
  return null;
}
