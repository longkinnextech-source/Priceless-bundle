/**
 * Shared UI primitives. Server-safe (no hooks) so both server and client
 * components can use them.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/* --------------------------------- layout -------------------------------- */

export function Card({
  children,
  className = "",
  variant = "default",
  id,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  variant?: "default" | "fire" | "plain";
  id?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  const styles =
    variant === "fire" ? "card-fire" : variant === "plain" ? "border border-white/5 bg-charcoal-900/60" : "card-surface";
  return (
    <Tag id={id} className={cn("rounded-2xl p-5 shadow-lg shadow-black/30", styles, className)}>
      {children}
    </Tag>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-wrap items-end justify-between gap-3", className)}>
      <div>
        {eyebrow ? (
          <p className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-fire-400">{eyebrow}</p>
        ) : null}
        <h2 className="text-xl font-bold sm:text-2xl">{title}</h2>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ash-400">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/* --------------------------------- button -------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "gold" | "subtle";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "fire-gradient text-white shadow-[0_8px_28px_-10px_rgba(237,77,5,0.75)] hover:brightness-110 active:brightness-95",
  gold: "bg-ember-500 text-charcoal-950 hover:bg-ember-400 font-semibold",
  secondary: "bg-charcoal-800 text-ash-100 border border-fire-700/40 hover:border-fire-500/70 hover:bg-charcoal-700",
  ghost: "bg-transparent text-ash-300 hover:bg-white/5 hover:text-white",
  subtle: "bg-white/5 text-ash-200 hover:bg-white/10",
  danger: "bg-crimson-600 text-white hover:bg-crimson-500",
};

const BUTTON_SIZES = {
  sm: "h-9 px-3.5 text-[0.82rem]",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-[0.95rem]",
};

export function buttonClass(variant: ButtonVariant = "primary", size: keyof typeof BUTTON_SIZES = "md", className = "") {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal-950",
    "disabled:cursor-not-allowed disabled:opacity-50",
    BUTTON_STYLES[variant],
    BUTTON_SIZES[size],
    className
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  href,
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
  className?: string;
  href?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  if (href) {
    const external = href.startsWith("http");
    if (external) {
      return (
        <a href={href} className={buttonClass(variant, size, className)} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={buttonClass(variant, size, className)}>
        {children}
      </Link>
    );
  }
  return (
    <button className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

/* --------------------------------- badges -------------------------------- */

type Tone = "fire" | "gold" | "success" | "danger" | "muted" | "info" | "warning";

const TONES: Record<Tone, string> = {
  fire: "bg-fire-500/15 text-fire-300 border-fire-500/35",
  gold: "bg-ember-500/15 text-ember-300 border-ember-500/35",
  success: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
  danger: "bg-crimson-600/15 text-red-300 border-crimson-600/40",
  info: "bg-sky-500/12 text-sky-300 border-sky-500/30",
  warning: "bg-ember-500/15 text-ember-300 border-ember-500/40",
  muted: "bg-white/5 text-ash-400 border-white/10",
};

export function Badge({
  children,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/** Real telecom brand colours — used ONLY for network badges. */
export function NetworkBadge({ network, className = "" }: { network: string; className?: string }) {
  const brands: Record<string, { bg: string; fg: string; label: string }> = {
    MTN: { bg: "#FFCC00", fg: "#101010", label: "MTN" },
    Telecel: { bg: "#E60000", fg: "#FFFFFF", label: "Telecel" },
    AirtelTigo: { bg: "#0072CE", fg: "#FFFFFF", label: "AirtelTigo" },
  };
  const brand = brands[network] ?? { bg: "#3f3f46", fg: "#FFFFFF", label: network };
  return (
    <span
      className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[0.7rem] font-bold tracking-wide", className)}
      style={{ backgroundColor: brand.bg, color: brand.fg }}
    >
      {brand.label}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: Tone; label: string }> = {
    pending: { tone: "muted", label: "Pending" },
    processing: { tone: "info", label: "Processing" },
    delivered: { tone: "success", label: "Delivered" },
    failed: { tone: "danger", label: "Failed" },
    refunded: { tone: "gold", label: "Refunded" },
    credited: { tone: "success", label: "Credited" },
    matched: { tone: "info", label: "Matched" },
    unmatched_review: { tone: "danger", label: "Needs review" },
    rejected: { tone: "muted", label: "Rejected" },
    paid: { tone: "success", label: "Paid" },
    batched: { tone: "gold", label: "Free Friday" },
  };
  const entry = map[status] ?? { tone: "muted" as Tone, label: status };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

/* --------------------------------- inputs -------------------------------- */

export const inputClass =
  "w-full rounded-xl border border-white/10 bg-charcoal-900/80 px-3.5 py-2.5 text-sm text-white placeholder:text-ash-500 " +
  "transition focus:border-fire-500/70 focus:outline-none focus:ring-2 focus:ring-fire-500/25 disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[0.8rem] font-semibold text-ash-300">{label}</span>
        {hint ? <span className="text-[0.72rem] text-ash-500">{hint}</span> : null}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-[0.75rem] font-medium text-red-300">{error}</span> : null}
    </label>
  );
}

/* ---------------------------------- data --------------------------------- */

export function Stat({
  label,
  value,
  sub,
  tone = "default",
  className = "",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "fire" | "gold";
  className?: string;
}) {
  const valueTone =
    tone === "fire" ? "fire-text" : tone === "gold" ? "text-ember-300" : "text-white";
  return (
    <div className={cn("rounded-2xl card-surface p-4", className)}>
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-ash-500">{label}</p>
      <p className={cn("mt-1.5 text-xl font-extrabold sm:text-2xl", valueTone)}>{value}</p>
      {sub ? <p className="mt-1 text-[0.75rem] text-ash-400">{sub}</p> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = "fire",
  className = "",
}: {
  value: number;
  max?: number;
  tone?: "fire" | "gold" | "success";
  className?: string;
}) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const fill =
    tone === "gold" ? "bg-ember-500" : tone === "success" ? "bg-emerald-500" : "fire-gradient";
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-white/8", className)}>
      <div className={cn("h-full rounded-full transition-all duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  className = "",
}: {
  tone?: "info" | "success" | "warning" | "error";
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-fire-700/40 bg-fire-900/20 text-fire-100",
    success: "border-emerald-600/40 bg-emerald-900/15 text-emerald-100",
    warning: "border-ember-600/40 bg-ember-600/10 text-ember-200",
    error: "border-crimson-600/50 bg-crimson-700/15 text-red-100",
  } as const;
  const icons = { info: "ℹ", success: "✓", warning: "!", error: "✕" } as const;
  return (
    <div className={cn("rounded-xl border px-4 py-3 text-sm", tones[tone], className)}>
      <div className="flex gap-2.5">
        <span className="mt-px font-bold opacity-80">{icons[tone]}</span>
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          <div className={title ? "mt-0.5 text-[0.85rem] opacity-90" : "text-[0.88rem]"}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon = "✦",
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-charcoal-900/40 px-6 py-10 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-fire-500/12 text-lg text-fire-400">
        {icon}
      </div>
      <p className="font-semibold text-white">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-ash-400">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={cn("skeleton rounded-lg", className)} />;
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white",
        className
      )}
      aria-hidden="true"
    />
  );
}

/** Table wrapper with horizontal scroll on small screens. */
export function TableWrap({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0", className)}>
      <div className="min-w-full align-middle">{children}</div>
    </div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-white/8 px-3 py-2.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-ash-500",
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={cn("border-b border-white/5 px-3 py-3 text-sm text-ash-200", className)}>{children}</td>;
}
