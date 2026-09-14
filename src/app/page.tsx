import Link from "next/link";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";
import { formatGhs } from "@/lib/format";
import { Badge, Button, Card, NetworkBadge, SectionHeading, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

type PlanRow = {
  id: string;
  network: string;
  size_label: string;
  price_ghs: number;
  list_price_ghs: number;
  savings_ghs: number;
};

async function loadLandingData() {
  if (!isConfigured()) return { plans: [] as PlanRow[], stats: null as any, config: null as any };
  try {
    const db = getDb();
    const [plans, stats, config] = await Promise.all([
      db.call<any>("fn_list_plans", { p_user_id: null }),
      db.call<any>("fn_public_stats", {}),
      db.call<any>("fn_public_config", {}),
    ]);
    return { plans: (plans?.plans ?? []) as PlanRow[], stats, config };
  } catch (error) {
    console.error("[landing] failed to load data:", (error as Error).message);
    return { plans: [] as PlanRow[], stats: null, config: null };
  }
}

export default async function LandingPage() {
  const { plans, stats, config } = await loadLandingData();

  const byNetwork = ["MTN", "Telecel", "AirtelTigo"].map((network) => ({
    network,
    plans: plans.filter((p) => p.network === network).slice(0, 4),
  }));

  return (
    <div className="pb-8">
      {/* ---------------------------------- HERO --------------------------------- */}
      <section className="relative overflow-hidden rounded-3xl border border-fire-800/40 px-6 py-14 sm:px-10 sm:py-20">
        <div className="absolute inset-0 fire-gradient-soft opacity-70" aria-hidden="true" />
        <div
          className="absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
          style={{ background: "radial-gradient(circle, rgba(255,138,61,0.35), transparent 70%)" }}
          aria-hidden="true"
        />
        <div className="relative max-w-3xl">
          <Badge tone="fire" className="mb-4">
            Ghana · MTN · Telecel · AirtelTigo
          </Badge>
          <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            Instant data.
            <br />
            <span className="fire-text text-shadow-fire">Priceless</span> prices.
          </h1>
          <p className="mt-5 max-w-xl text-[0.98rem] leading-relaxed text-ash-300">
            Top up your wallet with Mobile Money and push data to any number in seconds.
            Walk-in customers buy at retail. Agents buy at wholesale — and earn on every
            bundle their squad sells.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button href="/buy" size="lg">
              Buy data now
            </Button>
            <Button href="/signup" variant="secondary" size="lg">
              Become an agent
            </Button>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-[0.8rem] text-ash-400">
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Instant delivery
            </span>
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-fire-400" />
              Automatic MoMo top-up
            </span>
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ember-400" />
              {plans.length} bundles live
            </span>
          </div>
        </div>
      </section>

      {/* --------------------------------- NETWORKS ------------------------------ */}
      <section className="mt-12">
        <SectionHeading
          eyebrow="Live price list"
          title="Every network, one wallet"
          description="Prices below are the walk-in customer rate. Sign in as an agent to unlock Sub-Agent and Super Agent pricing."
          action={
            <Button href="/buy" variant="secondary" size="sm">
              Open the buy page
            </Button>
          }
        />

        <div className="grid gap-5 lg:grid-cols-3">
          {byNetwork.map(({ network, plans: networkPlans }) => (
            <Card key={network} className="flex flex-col">
              <div className="mb-4 flex items-center justify-between">
                <NetworkBadge network={network} className="px-3 py-1 text-[0.78rem]" />
                <span className="text-[0.7rem] uppercase tracking-widest text-ash-500">90 days</span>
              </div>
              <ul className="flex-1 space-y-2.5">
                {networkPlans.length === 0 ? (
                  <li className="text-sm text-ash-500">Bundles loading…</li>
                ) : (
                  networkPlans.map((plan) => (
                    <li key={plan.id} className="flex items-center justify-between border-b border-white/5 pb-2.5 last:border-0">
                      <span className="text-sm font-semibold text-white">{plan.size_label}</span>
                      <span className="text-sm font-bold text-fire-300">{formatGhs(plan.price_ghs)}</span>
                    </li>
                  ))
                )}
              </ul>
              <Link
                href="/buy"
                className="mt-4 text-[0.82rem] font-semibold text-fire-400 transition hover:text-fire-300"
              >
                Buy {network} data →
              </Link>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------------------------------- STATS -------------------------------- */}
      {stats ? (
        <section className="mt-12 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Bundles live" value={stats.plans ?? 0} sub="Across three networks" />
          <Stat label="Orders delivered" value={stats.orders_delivered ?? 0} sub="Since launch" tone="fire" />
          <Stat label="Data delivered" value={`${Number(stats.gb_delivered ?? 0).toLocaleString("en-GH")} GB`} sub="Pushed to customers" tone="gold" />
          <Stat label="Agents & squads" value={`${stats.agents ?? 0} / ${stats.squads ?? 0}`} sub="Agents / squads" />
        </section>
      ) : null}

      {/* ---------------------------------- TIERS -------------------------------- */}
      <section className="mt-14">
        <SectionHeading
          eyebrow="Agent tiers"
          title="Three levels. Real money at every one."
          description="Start as a customer, register free as a Sub-Agent, then unlock Super Agent wholesale when you're ready to scale."
        />

        <div className="grid gap-5 md:grid-cols-3">
          <Card className="flex flex-col">
            <Badge tone="muted">Customer</Badge>
            <h3 className="mt-3 text-xl font-bold">Buy for yourself</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ash-400">
              Pay the retail rate and push data to any Ghanaian number. No monthly fees, no minimums.
            </p>
            <ul className="mt-4 space-y-2 text-[0.85rem] text-ash-300">
              <li>✓ All MTN, Telecel &amp; AirtelTigo bundles</li>
              <li>✓ MoMo wallet top-up with a reference code</li>
              <li>✓ Instant or Free Friday withdrawals</li>
            </ul>
            <Button href="/signup" variant="secondary" className="mt-5">
              Create a free account
            </Button>
          </Card>

          <Card className="flex flex-col">
            <Badge tone="fire">Sub-Agent</Badge>
            <h3 className="mt-3 text-xl font-bold">Sell at a discount</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ash-400">
              Free registration, standard discount pricing, and a squad that helps you keep it.
            </p>
            <ul className="mt-4 space-y-2 text-[0.85rem] text-ash-300">
              <li>✓ Sub-Agent pricing on every bundle</li>
              <li>✓ Join a Squad with your agent&apos;s code</li>
              <li>✓ Small fee for instant payouts, or free on Free Friday</li>
            </ul>
            <Button href="/signup?tier=sub_agent" className="mt-5">
              Register as Sub-Agent
            </Button>
          </Card>

          <Card variant="fire" className="flex flex-col">
            <Badge tone="gold">Super Agent</Badge>
            <h3 className="mt-3 text-xl font-bold">Wholesale + your own bot</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ash-200">
              Unlocks at {formatGhs(config?.super_agent_commitment_ghs ?? 500)} of lifetime wallet deposits — the money stays in
              your wallet, it just proves you&apos;re serious.
            </p>
            <ul className="mt-4 space-y-2 text-[0.85rem] text-ash-200">
              <li>✓ VIP wholesale pricing on everything</li>
              <li>✓ Unlimited free instant withdrawals</li>
              <li>✓ Recruit Sub-Agents into your Squad</li>
              <li>✓ Link your own Telegram / WhatsApp bot</li>
            </ul>
            <Button href="/agent" variant="gold" className="mt-5">
              Unlock Super Agent
            </Button>
          </Card>
        </div>
      </section>

      {/* ---------------------------------- SQUAD -------------------------------- */}
      <section className="mt-14 grid gap-6 lg:grid-cols-2">
        <Card variant="fire">
          <Badge tone="gold">The Squad mechanic</Badge>
          <h3 className="mt-3 text-2xl font-bold">Hit the target, keep the discount</h3>
          <p className="mt-3 text-sm leading-relaxed text-ash-200">
            Every Sub-Agent a Super Agent recruits joins their Squad. Squad sales are pooled
            against a monthly volume target of{" "}
            <strong className="text-white">{formatGhs(config?.squad_volume_target_ghs ?? 5000)}</strong>. Hit it and the whole
            squad keeps discount pricing into the next month. Miss it and pricing reverts to
            retail until the target is met again.
          </p>
          <ul className="mt-4 space-y-2 text-[0.85rem] text-ash-200">
            <li>→ Volume is recomputed automatically after every delivered order</li>
            <li>→ Super Agents earn {((Number(config?.commission_rate_squad_sale ?? 0.03)) * 100).toFixed(0)}% commission on squad sales</li>
            <li>→ Commission can be reinvested for a {config?.reinvest_bonus_min_pct ?? 2}–{config?.reinvest_bonus_max_pct ?? 5}% bonus</li>
          </ul>
        </Card>

        <Card>
          <Badge tone="fire">Bot-in-a-Box</Badge>
          <h3 className="mt-3 text-2xl font-bold">Your bot. Your customers.</h3>
          <p className="mt-3 text-sm leading-relaxed text-ash-400">
            Link your own Telegram bot token or WhatsApp Business endpoint. Customers chat with
            your bot, you sell at your wholesale tier, and every sale counts toward your Squad
            volume.
          </p>
          <div className="mt-4 space-y-2 rounded-xl border border-white/8 bg-charcoal-950/60 p-4 font-mono text-[0.8rem] text-ash-300">
            <p><span className="text-fire-400">balance</span> → wallet check</p>
            <p><span className="text-fire-400">prices</span> → your wholesale price list</p>
            <p><span className="text-fire-400">buy mtn 5gb 0244123456</span> → instant vend</p>
          </div>
          <Button href="/agent#bot" variant="secondary" className="mt-4">
            Set up your bot
          </Button>
        </Card>
      </section>

      {/* ----------------------------------- CTA --------------------------------- */}
      <section className="mt-14 rounded-3xl border border-fire-800/40 bg-charcoal-900/60 px-6 py-12 text-center sm:px-10">
        <h2 className="text-3xl font-extrabold sm:text-4xl">
          Ready to buy your first <span className="fire-text">bundle</span>?
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-ash-400">
          Create an account, top up with MoMo, and send data to any network in under a minute.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button href="/signup" size="lg">
            Create free account
          </Button>
          <Button href="/login" variant="secondary" size="lg">
            I already have an account
          </Button>
        </div>
      </section>
    </div>
  );
}
