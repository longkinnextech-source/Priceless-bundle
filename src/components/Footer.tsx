import Link from "next/link";
import Logo from "@/components/Logo";

/**
 * Footer — the ONLY place the operating company name appears in the app.
 */
export default function Footer() {
  return (
    <footer className="mt-16 border-t border-white/8 bg-charcoal-950/60">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo size={34} />
            <p className="mt-3 max-w-xs text-[0.83rem] leading-relaxed text-ash-400">
              Instant mobile data for MTN, Telecel and AirtelTigo — at prices that pay you back.
            </p>
          </div>

          <div>
            <h3 className="mb-3 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ash-500">Product</h3>
            <ul className="space-y-2 text-[0.85rem] text-ash-300">
              <li><Link href="/buy" className="hover:text-fire-400">Buy Data</Link></li>
              <li><Link href="/wallet" className="hover:text-fire-400">Wallet &amp; Top-up</Link></li>
              <li><Link href="/withdraw" className="hover:text-fire-400">Withdrawals</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="mb-3 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ash-500">Agents</h3>
            <ul className="space-y-2 text-[0.85rem] text-ash-300">
              <li><Link href="/agent" className="hover:text-fire-400">Agent Tiers</Link></li>
              <li><Link href="/signup" className="hover:text-fire-400">Become an Agent</Link></li>
              <li><Link href="/agent#bot" className="hover:text-fire-400">Bot-in-a-Box</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="mb-3 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-ash-500">Support</h3>
            <ul className="space-y-2 text-[0.85rem] text-ash-300">
              <li><Link href="/wallet" className="hover:text-fire-400">Top-up Help</Link></li>
              <li><Link href="/login" className="hover:text-fire-400">Sign in</Link></li>
              <li><Link href="/signup" className="hover:text-fire-400">Create account</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-white/8 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.78rem] text-ash-500">© 2026 Priceless Bundle by LongKinnex Tech and Data</p>
          <p className="text-[0.72rem] text-ash-500">Prices in Ghana Cedis (GHS) · All times GMT</p>
        </div>
      </div>
    </footer>
  );
}
