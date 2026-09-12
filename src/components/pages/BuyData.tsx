"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, Card, EmptyState, Field, NetworkBadge, SectionHeading, Spinner, inputClass,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiGet, apiPost } from "@/lib/client";
import { formatGhs, formatRelative, guessNetworkFromPhone, tierLabel } from "@/lib/format";

type Plan = {
  id: string;
  network: string;
  size_label: string;
  data_mb: number;
  validity_days: number;
  price_ghs: number;
  list_price_ghs: number;
  effective_tier: string;
  savings_ghs: number;
  reason: string;
};

type Wallet = { balance_ghs: number; commission_balance_ghs: number };

type PurchaseResponse = {
  order: { id: string; status: string; network: string; size_label: string; recipient_phone: string; price_charged_ghs: number };
  outcome: string;
  refunded: boolean;
  wallet: Wallet;
  finalised?: { refunded_ghs?: number; reason?: string };
};

const NETWORKS = ["MTN", "Telecel", "AirtelTigo"] as const;

export default function BuyData({
  initialPlans,
  initialWallet,
  tier,
  fullName,
}: {
  initialPlans: Plan[];
  initialWallet: Wallet;
  tier: string;
  fullName: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [plans, setPlans] = useState<Plan[]>(initialPlans);
  const [wallet, setWallet] = useState<Wallet>(initialWallet);
  const [network, setNetwork] = useState<string>("MTN");
  const [selected, setSelected] = useState<Plan | null>(initialPlans.find((p) => p.network === "MTN") ?? null);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PurchaseResponse | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);

  const networkPlans = useMemo(() => plans.filter((p) => p.network === network), [plans, network]);
  const suggestedNetwork = useMemo(() => guessNetworkFromPhone(recipient), [recipient]);

  // Keep the form in step with the number being typed (MTN number -> MTN tab)
  // and with the active network's catalogue. Adjusting state during render is
  // the pattern React recommends over a synchronising effect.
  const [lastSuggested, setLastSuggested] = useState<string | null>(null);
  if (suggestedNetwork && suggestedNetwork !== lastSuggested) {
    setLastSuggested(suggestedNetwork);
    if (suggestedNetwork !== network) setNetwork(suggestedNetwork);
  }

  if (!selected || selected.network !== network) {
    setSelected(networkPlans[0] ?? null);
  }

  const price = selected ? Number(selected.price_ghs) : 0;
  const balance = Number(wallet.balance_ghs ?? 0);
  const shortfall = Math.max(price - balance, 0);
  const canAfford = price > 0 && balance >= price;

  async function refresh() {
    setWalletBusy(true);
    try {
      const [planRes, walletRes] = await Promise.all([
        apiGet<{ plans: Plan[] }>("/api/plans"),
        apiGet<{ wallet: Wallet }>("/api/wallet"),
      ]);
      setPlans(planRes.plans ?? []);
      setWallet(walletRes.wallet ?? wallet);
    } catch {
      /* keep the previous data on a blip */
    } finally {
      setWalletBusy(false);
    }
  }

  async function purchase(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!selected) {
      setError("Choose a bundle first.");
      return;
    }
    const digits = recipient.replace(/[^0-9]/g, "");
    if (!/^(0[0-9]{9}|233[0-9]{9}|[0-9]{9})$/.test(digits)) {
      setError("Enter a valid Ghana number, e.g. 0244123456.");
      return;
    }
    if (!canAfford) {
      setError(
        `You need ${formatGhs(price)} but your wallet has ${formatGhs(balance)}. Top up ${formatGhs(shortfall)} to continue.`
      );
      return;
    }

    setBusy(true);
    try {
      // Only the plan id, recipient and (ignored) hint are sent — the price is
      // resolved server-side from the buyer's own tier.
      const response = await apiPost<PurchaseResponse>("/api/orders", {
        plan_id: selected.id,
        recipient_phone: digits,
      });
      setResult(response);
      setWallet(response.wallet ?? wallet);

      if (response.outcome === "delivered") {
        toast.success("Data delivered", `${selected.network} ${selected.size_label} sent to ${response.order.recipient_phone}.`);
        setRecipient("");
      } else {
        toast.error(
          "Delivery failed — you were refunded",
          response.finalised?.reason ?? "The supplier rejected the request."
        );
      }
      router.refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Purchase failed", message);
      if (message.toLowerCase().includes("insufficient")) void refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow={`Signed in as ${fullName || "you"} · ${tierLabel(tier)}`}
        title="Buy Data"
        description="Pick a network and bundle, enter the recipient's number, and we push the data instantly."
        action={
          <div className="flex items-center gap-2">
            <Button href="/wallet" variant="secondary" size="sm">
              Top up wallet
            </Button>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={walletBusy}>
              {walletBusy ? <Spinner /> : "↻"} Refresh
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.55fr_1fr]">
        {/* ------------------------------- bundle picker ------------------------------- */}
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {NETWORKS.map((name) => {
              const active = network === name;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setNetwork(name)}
                  className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition ${
                    active
                      ? "border-fire-500/70 bg-fire-500/10 text-white"
                      : "border-white/10 bg-charcoal-900/60 text-ash-300 hover:border-white/20"
                  }`}
                >
                  <NetworkBadge network={name} />
                  <span className="hidden sm:inline">{name} bundles</span>
                </button>
              );
            })}
          </div>

          {networkPlans.length === 0 ? (
            <EmptyState
              title="No bundles for this network yet"
              description="Pricing is updated often. Check another network or try again shortly."
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {networkPlans.map((plan) => {
                const active = selected?.id === plan.id;
                const affordable = Number(wallet.balance_ghs) >= Number(plan.price_ghs);
                return (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setSelected(plan)}
                    className={`relative rounded-2xl border p-4 text-left transition ${
                      active
                        ? "border-fire-500/80 bg-fire-500/10 shadow-[0_0_0_1px_rgba(255,106,21,0.4)]"
                        : "border-white/10 bg-charcoal-900/60 hover:border-fire-700/50"
                    }`}
                  >
                    {plan.savings_ghs > 0 ? (
                      <span className="absolute right-2 top-2 rounded-full bg-ember-500/20 px-2 py-0.5 text-[0.62rem] font-bold text-ember-300">
                        SAVE {formatGhs(plan.savings_ghs)}
                      </span>
                    ) : null}
                    <p className="text-lg font-extrabold text-white">{plan.size_label}</p>
                    <p className="mt-0.5 text-[0.7rem] text-ash-500">{plan.validity_days} days validity</p>
                    <p className="mt-2 text-base font-bold fire-text">{formatGhs(plan.price_ghs)}</p>
                    {plan.savings_ghs > 0 ? (
                      <p className="text-[0.68rem] text-ash-500 line-through">{formatGhs(plan.list_price_ghs)}</p>
                    ) : null}
                    {!affordable ? (
                      <p className="mt-1.5 text-[0.68rem] font-medium text-ember-400">Needs a top-up</p>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          {selected?.reason && selected.effective_tier !== "customer" ? (
            <Alert tone="info" title={`${tierLabel(selected.effective_tier)} pricing applied`}>
              {selected.reason}
            </Alert>
          ) : null}
        </div>

        {/* --------------------------------- checkout --------------------------------- */}
        <div className="space-y-4">
          <Card variant="fire">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[0.7rem] uppercase tracking-[0.14em] text-ash-400">Wallet balance</p>
                <p className="text-2xl font-extrabold text-white">{formatGhs(balance)}</p>
                {Number(wallet.commission_balance_ghs ?? 0) > 0 ? (
                  <p className="mt-0.5 text-[0.72rem] text-ember-300">
                    + {formatGhs(wallet.commission_balance_ghs)} commission waiting
                  </p>
                ) : null}
              </div>
              <Badge tone="fire">{tierLabel(tier)}</Badge>
            </div>
            {!canAfford && price > 0 ? (
              <div className="mt-3 rounded-xl border border-ember-600/40 bg-ember-600/10 p-3">
                <p className="text-[0.8rem] text-ember-200">
                  You need {formatGhs(shortfall)} more for {selected?.size_label}.{" "}
                  <Link href="/wallet" className="font-semibold underline">
                    Top up now
                  </Link>
                </p>
              </div>
            ) : null}
          </Card>

          <Card>
            <form onSubmit={purchase} className="space-y-4">
              <Field
                label="Recipient number"
                hint={suggestedNetwork ? `Looks like ${suggestedNetwork}` : "Any Ghana network"}
              >
                <input
                  className={inputClass}
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0244123456"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </Field>

              <div className="rounded-xl border border-white/8 bg-charcoal-950/60 p-3.5 text-sm">
                <Row label="Bundle" value={selected ? `${selected.network} ${selected.size_label}` : "—"} />
                <Row label="Validity" value={selected ? `${selected.validity_days} days` : "—"} />
                <Row label="Your price" value={selected ? formatGhs(selected.price_ghs) : "—"} strong />
                {selected && selected.savings_ghs > 0 ? (
                  <Row label="You save" value={formatGhs(selected.savings_ghs)} tone="save" />
                ) : null}
                <Row label="Balance after" value={formatGhs(Math.max(balance - price, 0))} />
              </div>

              {error ? <Alert tone="error">{error}</Alert> : null}

              {result ? (
                result.outcome === "delivered" ? (
                  <Alert tone="success" title="Delivered">
                    {result.order.network} {result.order.size_label} sent to {result.order.recipient_phone}.
                  </Alert>
                ) : (
                  <Alert tone="warning" title="Refunded automatically">
                    {result.finalised?.reason ?? "Delivery failed."} {formatGhs(result.finalised?.refunded_ghs ?? 0)} is back
                    in your wallet.
                  </Alert>
                )
              ) : null}

              <Button type="submit" size="lg" className="w-full" disabled={busy || !selected || !canAfford}>
                {busy ? <Spinner /> : null}
                {busy ? "Sending data…" : canAfford ? `Buy for ${formatGhs(price)}` : "Insufficient balance"}
              </Button>
              <p className="text-center text-[0.72rem] text-ash-500">
                Your price is applied automatically from your {tierLabel(tier).toLowerCase()} tier.
              </p>
            </form>
          </Card>

          <RecentOrders />
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "save";
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-ash-400">{label}</span>
      <span className={strong ? "font-bold text-white" : tone === "save" ? "font-semibold text-emerald-400" : "text-ash-200"}>
        {value}
      </span>
    </div>
  );
}

function RecentOrders() {
  const [orders, setOrders] = useState<any[] | null>(null);

  useEffect(() => {
    apiGet<{ orders: any[] }>("/api/orders?limit=5")
      .then((res) => setOrders(res.orders ?? []))
      .catch(() => setOrders([]));
  }, []);

  if (!orders) return <Card><div className="skeleton h-24 rounded-xl" /></Card>;
  if (orders.length === 0) return null;

  return (
    <Card>
      <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-ash-500">Recent orders</p>
      <ul className="space-y-2.5">
        {orders.map((order) => (
          <li key={order.id} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium text-ash-100">
                {order.network} {order.size_label} → {order.recipient_phone}
              </p>
              <p className="text-[0.7rem] text-ash-500">{formatRelative(order.created_at)}</p>
            </div>
            <span className="shrink-0 text-right">
              <span className="block text-[0.8rem] font-semibold text-ash-200">{formatGhs(order.price_charged_ghs)}</span>
              <span
                className={`text-[0.68rem] font-semibold ${
                  order.status === "delivered"
                    ? "text-emerald-400"
                    : order.status === "refunded"
                      ? "text-ember-400"
                      : order.status === "failed"
                        ? "text-red-400"
                        : "text-ash-500"
                }`}
              >
                {order.status}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
