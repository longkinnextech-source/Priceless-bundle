"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import Logo from "@/components/Logo";
import { apiPost } from "@/lib/client";
import { formatGhs, tierLabel } from "@/lib/format";
import { useToast } from "@/components/Toast";

export type NavUser = {
  id: string;
  name: string;
  phone: string;
  tier: string;
  balance: number;
  commission: number;
  admin: boolean;
  unread: number;
} | null;

const LINKS = [
  { href: "/buy", label: "Buy Data" },
  { href: "/wallet", label: "Wallet" },
  { href: "/agent", label: "Agent" },
  { href: "/withdraw", label: "Withdraw" },
];

export default function Nav({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await apiPost("/api/auth/logout");
      toast.success("Signed out", "See you soon.");
      router.push("/");
      router.refresh();
    } catch {
      toast.error("Could not sign out", "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-50 border-b border-white/8 glass">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        <Link href="/" className="shrink-0" aria-label="Priceless Bundle home">
          <Logo size={34} />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive(link.href)
                  ? "bg-fire-500/12 text-fire-300"
                  : "text-ash-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              {link.label}
            </Link>
          ))}
          {user?.admin ? (
            <Link
              href="/admin"
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive("/admin") ? "bg-ember-500/15 text-ember-300" : "text-ember-400 hover:bg-white/5"
              }`}
            >
              Admin
            </Link>
          ) : null}
        </nav>

        <div className="flex items-center gap-2">
          {user ? (
            <>
              {user.id === "admin" ? null : (
              <Link
                href="/wallet"
                className="hidden items-center gap-2 rounded-xl border border-fire-700/40 bg-charcoal-900/70 px-3 py-1.5 transition hover:border-fire-500/60 sm:flex"
              >
                <span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-ash-500">Wallet</span>
                <span className="text-sm font-bold text-white">{formatGhs(user.balance)}</span>
              </Link>
              )}
              <div className="hidden items-center gap-2 lg:flex">
                <div className="text-right leading-tight">
                  <p className="max-w-[9rem] truncate text-[0.8rem] font-semibold text-white">{user.name}</p>
                  <p className="text-[0.68rem] text-fire-400">{tierLabel(user.tier)}</p>
                </div>
              </div>
              <button
                onClick={signOut}
                disabled={busy}
                className="hidden rounded-lg px-3 py-2 text-[0.82rem] font-medium text-ash-400 transition hover:bg-white/5 hover:text-white disabled:opacity-50 md:block"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden rounded-lg px-3 py-2 text-sm font-medium text-ash-300 transition hover:bg-white/5 hover:text-white sm:block"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="fire-gradient rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_24px_-10px_rgba(237,77,5,0.8)] transition hover:brightness-110"
              >
                Create account
              </Link>
            </>
          )}

          <button
            onClick={() => setOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-ash-200 transition hover:bg-white/5 md:hidden"
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            <span className="relative block h-3.5 w-5">
              <span
                className={`absolute left-0 h-0.5 w-5 bg-current transition-all ${open ? "top-1.5 rotate-45" : "top-0"}`}
              />
              <span className={`absolute left-0 top-1.5 h-0.5 w-5 bg-current transition-all ${open ? "opacity-0" : ""}`} />
              <span
                className={`absolute left-0 h-0.5 w-5 bg-current transition-all ${open ? "top-1.5 -rotate-45" : "top-3"}`}
              />
            </span>
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-white/8 bg-charcoal-950/95 px-4 pb-4 pt-3 md:hidden">
          {user ? (
            <div className="mb-3 rounded-xl card-fire p-3">
              <p className="text-[0.7rem] uppercase tracking-[0.14em] text-ash-400">Wallet balance</p>
              <p className="text-xl font-extrabold fire-text">{formatGhs(user.balance)}</p>
              <p className="mt-0.5 text-[0.75rem] text-ash-400">
                {user.name} · {tierLabel(user.tier)}
              </p>
            </div>
          ) : null}
          <nav className="grid gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={`rounded-lg px-3 py-2.5 text-sm font-medium ${
                  isActive(link.href) ? "bg-fire-500/12 text-fire-300" : "text-ash-200 hover:bg-white/5"
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user?.admin ? (
              <Link
                href="/admin"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-ember-300 hover:bg-white/5"
              >
                Admin
              </Link>
            ) : null}
            {user ? (
              <button
                onClick={signOut}
                disabled={busy}
                className="rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ash-400 hover:bg-white/5"
              >
                Sign out
              </button>
            ) : (
              <>
                <Link href="/login" className="rounded-lg px-3 py-2.5 text-sm font-medium text-ash-200 hover:bg-white/5">
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="fire-gradient mt-1 rounded-lg px-3 py-2.5 text-center text-sm font-semibold text-white"
                >
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
