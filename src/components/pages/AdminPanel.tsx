"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert, Badge, Button, Card, EmptyState, Field, NetworkBadge, ProgressBar, SectionHeading, Spinner, Stat,
  TableWrap, Td, Th, inputClass,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiGet, apiPost } from "@/lib/client";
import { formatGhs, formatRelative, tierLabel } from "@/lib/format";

type Tab = "overview" | "pricing" | "orders" | "deposits" | "payouts" | "users" | "squads" | "integrity";

export default function AdminPanel({ operator, smsWebhookUrl }: { operator: string; smsWebhookUrl: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const toast = useToast();

  const TABS: Array<[Tab, string]> = [
    ["overview", "Overview"],
    ["pricing", "Pricing"],
    ["orders", "Orders"],
    ["deposits", "Deposits"],
    ["payouts", "Payouts"],
    ["users", "Users"],
    ["squads", "Squads"],
    ["integrity", "Integrity"],
  ];

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow={`Operator: ${operator}`}
        title="Admin"
        description="Pricing, orders, deposit review and revenue — all backed by the live database."
      />

      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto rounded-xl border border-white/8 bg-charcoal-900/50 p-1.5">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              tab === key ? "fire-gradient text-white" : "text-ash-300 hover:bg-white/5"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? <Overview smsWebhookUrl={smsWebhookUrl} toast={toast} /> : null}
      {tab === "pricing" ? <Pricing /> : null}
      {tab === "orders" ? <Orders /> : null}
      {tab === "deposits" ? <Deposits /> : null}
      {tab === "payouts" ? <Payouts /> : null}
      {tab === "users" ? <Users /> : null}
      {tab === "squads" ? <Squads /> : null}
      {tab === "integrity" ? <Integrity smsWebhookUrl={smsWebhookUrl} /> : null}
    </div>
  );
}

/* -------------------------------- OVERVIEW -------------------------------- */

function Overview({ smsWebhookUrl, toast }: { smsWebhookUrl: string; toast: ReturnType<typeof useToast> }) {
  const [data, setData] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet("/api/admin/metrics"));
    } catch (error) {
      toast.error("Could not load metrics", (error as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <Loading />;

  const revenue = data.revenue ?? {};
  const orders = data.orders ?? {};
  const deposits = data.deposits ?? {};
  const users = data.users ?? {};
  const squads = data.squads ?? {};
  const wallets = data.wallets ?? {};
  const withdrawals = data.withdrawals ?? {};
  const daily: any[] = data.daily ?? [];
  const maxGross = Math.max(...daily.map((d) => Number(d.gross_ghs ?? 0)), 1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Revenue (all time)" value={formatGhs(revenue.gross_all_time_ghs)} tone="fire" sub={`${orders.delivered ?? 0} delivered orders`} />
        <Stat label="Margin (all time)" value={formatGhs(revenue.margin_all_time_ghs)} tone="gold" sub={`Today ${formatGhs(revenue.margin_today_ghs)}`} />
        <Stat label="Deposits credited" value={formatGhs(deposits.credited_all_time_ghs)} sub={`Today ${formatGhs(deposits.credited_today_ghs)}`} />
        <Stat label="Needs review" value={deposits.unmatched_count ?? 0} sub={`${formatGhs(deposits.unmatched_value_ghs)} unmatched`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <h3 className="mb-4 text-lg font-bold">Last 14 days</h3>
          <div className="flex h-40 items-end gap-1.5">
            {daily.map((day) => {
              const gross = Number(day.gross_ghs ?? 0);
              const height = Math.max((gross / maxGross) * 100, gross > 0 ? 6 : 2);
              return (
                <div key={day.day} className="group flex flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className="w-full rounded-t-md fire-gradient transition-all duration-300"
                    style={{ height: `${height}%`, minHeight: 4 }}
                    title={`${day.day}: ${formatGhs(gross)} · ${day.orders} orders`}
                  />
                  <span className="text-[0.55rem] text-ash-500">{String(day.day).slice(8, 10)}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/8 pt-4 text-center">
            <div>
              <p className="text-[0.68rem] uppercase tracking-wider text-ash-500">Gross</p>
              <p className="font-bold text-white">{formatGhs(revenue.gross_all_time_ghs)}</p>
            </div>
            <div>
              <p className="text-[0.68rem] uppercase tracking-wider text-ash-500">Cost</p>
              <p className="font-bold text-ash-200">{formatGhs(revenue.cost_all_time_ghs)}</p>
            </div>
            <div>
              <p className="text-[0.68rem] uppercase tracking-wider text-ash-500">Avg order</p>
              <p className="font-bold text-ash-200">{formatGhs(revenue.avg_order_ghs)}</p>
            </div>
          </div>
        </Card>

        <Card>
          <h3 className="mb-4 text-lg font-bold">Order health</h3>
          <div className="space-y-3 text-sm">
            <HealthRow label="Delivered" value={orders.delivered ?? 0} tone="text-emerald-400" />
            <HealthRow label="Pending / processing" value={(orders.pending ?? 0) + (orders.processing ?? 0)} tone="text-ash-200" />
            <HealthRow label="Failed" value={orders.failed ?? 0} tone="text-red-400" />
            <HealthRow label="Refunded" value={orders.refunded ?? 0} tone="text-ember-400" />
          </div>
          <div className="mt-4 border-t border-white/8 pt-4">
            <div className="mb-1.5 flex items-center justify-between text-[0.8rem]">
              <span className="text-ash-400">Success rate</span>
              <span className="font-bold text-white">{orders.success_rate_pct ?? 100}%</span>
            </div>
            <ProgressBar value={Number(orders.success_rate_pct ?? 100)} tone="success" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/8 pt-4">
            <MiniStat label="Customers" value={users.customers ?? 0} />
            <MiniStat label="Sub-Agents" value={users.sub_agents ?? 0} />
            <MiniStat label="Super Agents" value={users.super_agents ?? 0} />
            <MiniStat label="With bots" value={users.with_bots ?? 0} />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <h3 className="text-sm font-bold text-white">By network</h3>
          <ul className="mt-3 space-y-2.5">
            {(data.networks ?? []).map((row: any) => (
              <li key={row.network} className="flex items-center justify-between gap-3">
                <NetworkBadge network={row.network} />
                <span className="text-[0.8rem] text-ash-300">{row.orders} orders</span>
                <span className="text-[0.82rem] font-semibold text-white">{formatGhs(row.gross_ghs)}</span>
              </li>
            ))}
            {(data.networks ?? []).length === 0 ? <li className="text-[0.82rem] text-ash-500">No orders yet.</li> : null}
          </ul>
        </Card>

        <Card>
          <h3 className="text-sm font-bold text-white">Squads</h3>
          <div className="mt-3 space-y-2 text-[0.82rem]">
            <p className="flex justify-between"><span className="text-ash-400">Total squads</span><span className="font-semibold text-white">{squads.count ?? 0}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Volume this period</span><span className="font-semibold text-white">{formatGhs(squads.volume_this_period_ghs)}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Targets met</span><span className="font-semibold text-emerald-400">{squads.targets_met ?? 0}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Targets missed</span><span className="font-semibold text-ember-400">{squads.targets_missed ?? 0}</span></p>
          </div>
        </Card>

        <Card>
          <h3 className="text-sm font-bold text-white">Money on the platform</h3>
          <div className="mt-3 space-y-2 text-[0.82rem]">
            <p className="flex justify-between"><span className="text-ash-400">Wallet balances</span><span className="font-semibold text-white">{formatGhs(wallets.total_balance_ghs)}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Commission pot</span><span className="font-semibold text-ember-300">{formatGhs(wallets.commission_pot_ghs)}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Lifetime deposited</span><span className="font-semibold text-white">{formatGhs(wallets.lifetime_deposited_ghs)}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Lifetime spent</span><span className="font-semibold text-white">{formatGhs(wallets.lifetime_spent_ghs)}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Pending payouts</span><span className="font-semibold text-ash-200">{formatGhs(withdrawals.pending_value_ghs)}</span></p>
            <p className="flex justify-between"><span className="text-ash-400">Free Friday queue</span><span className="font-semibold text-ash-200">{formatGhs(withdrawals.batched_value_ghs)}</span></p>
          </div>
        </Card>
      </div>

      <Card>
        <h3 className="text-sm font-bold text-white">SMS deposit webhook</h3>
        <p className="mt-1.5 text-[0.82rem] text-ash-400">
          Point your Android SMS-forwarder app at this URL and send the shared secret in the{" "}
          <code className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[0.75rem] text-fire-300">
            x-priceless-secret
          </code>{" "}
          header.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <code className="rounded-lg border border-white/10 bg-charcoal-950/70 px-3 py-2 font-mono text-[0.78rem] text-ash-200">
            {smsWebhookUrl}
          </code>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(smsWebhookUrl);
                toast.success("Copied", smsWebhookUrl);
              } catch {
                toast.error("Could not copy");
              }
            }}
          >
            Copy
          </Button>
        </div>
      </Card>
    </div>
  );
}

function HealthRow({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ash-400">{label}</span>
      <span className={`font-bold ${tone}`}>{value}</span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/8 bg-charcoal-950/40 p-2.5 text-center">
      <p className="text-[0.62rem] uppercase tracking-wider text-ash-500">{label}</p>
      <p className="text-lg font-bold text-white">{value}</p>
    </div>
  );
}

/* --------------------------------- PRICING -------------------------------- */

const EMPTY_PLAN = {
  plan_id: "",
  network: "MTN",
  size_label: "",
  data_mb: "",
  cost_price_ghs: "",
  retail_price_ghs: "",
  sub_agent_price_ghs: "",
  super_agent_price_ghs: "",
  validity_days: "90",
  active: true,
  sort_order: "100",
};

function Pricing() {
  const toast = useToast();
  const [plans, setPlans] = useState<any[] | null>(null);
  const [form, setForm] = useState<typeof EMPTY_PLAN>(EMPTY_PLAN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ plans: any[] }>("/api/admin/plans");
      setPlans(res.plans ?? []);
    } catch (err) {
      toast.error("Could not load pricing", (err as Error).message);
      setPlans([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(plan: any) {
    setForm({
      plan_id: plan.id,
      network: plan.network,
      size_label: plan.size_label,
      data_mb: String(plan.data_mb),
      cost_price_ghs: String(plan.cost_price_ghs),
      retail_price_ghs: String(plan.retail_price_ghs),
      sub_agent_price_ghs: String(plan.sub_agent_price_ghs),
      super_agent_price_ghs: String(plan.super_agent_price_ghs),
      validity_days: String(plan.validity_days),
      active: plan.active,
      sort_order: String(plan.sort_order),
    });
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost("/api/admin/plans", {
        plan_id: form.plan_id || null,
        network: form.network,
        size_label: form.size_label,
        data_mb: Number(form.data_mb),
        cost_price_ghs: Number(form.cost_price_ghs),
        retail_price_ghs: Number(form.retail_price_ghs),
        sub_agent_price_ghs: Number(form.sub_agent_price_ghs),
        super_agent_price_ghs: Number(form.super_agent_price_ghs),
        validity_days: Number(form.validity_days),
        active: form.active,
        sort_order: Number(form.sort_order),
      });
      toast.success(form.plan_id ? "Bundle updated" : "Bundle created", "Live pricing updated.");
      setForm(EMPTY_PLAN);
      await load();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not save pricing", message);
    } finally {
      setBusy(false);
    }
  }

  const visible = (plans ?? []).filter((p) => filter === "all" || p.network === filter);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
      <Card>
        <h3 className="text-lg font-bold">{form.plan_id ? "Edit bundle" : "Add bundle"}</h3>
        <p className="mt-1 text-[0.8rem] text-ash-400">
          Writes straight to <code className="font-mono text-fire-300">plans</code>. Super Agent ≤ Sub-Agent ≤ Retail, and never
          below cost.
        </p>

        <form onSubmit={save} className="mt-4 space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Network">
              <select className={inputClass} value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })}>
                {["MTN", "Telecel", "AirtelTigo"].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </Field>
            <Field label="Size label">
              <input className={inputClass} value={form.size_label} onChange={(e) => setForm({ ...form, size_label: e.target.value })} placeholder="5GB" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Size (MB)">
              <input className={inputClass} value={form.data_mb} onChange={(e) => setForm({ ...form, data_mb: e.target.value.replace(/[^0-9]/g, "") })} placeholder="5120" inputMode="numeric" />
            </Field>
            <Field label="Validity (days)">
              <input className={inputClass} value={form.validity_days} onChange={(e) => setForm({ ...form, validity_days: e.target.value.replace(/[^0-9]/g, "") })} inputMode="numeric" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost price">
              <input className={inputClass} value={form.cost_price_ghs} onChange={(e) => setForm({ ...form, cost_price_ghs: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="23.50" inputMode="decimal" />
            </Field>
            <Field label="Retail price">
              <input className={inputClass} value={form.retail_price_ghs} onChange={(e) => setForm({ ...form, retail_price_ghs: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="28.00" inputMode="decimal" />
            </Field>
            <Field label="Sub-Agent price">
              <input className={inputClass} value={form.sub_agent_price_ghs} onChange={(e) => setForm({ ...form, sub_agent_price_ghs: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="26.00" inputMode="decimal" />
            </Field>
            <Field label="Super Agent price">
              <input className={inputClass} value={form.super_agent_price_ghs} onChange={(e) => setForm({ ...form, super_agent_price_ghs: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="24.50" inputMode="decimal" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Sort order">
              <input className={inputClass} value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value.replace(/[^0-9]/g, "") })} inputMode="numeric" />
            </Field>
            <Field label="Status">
              <button
                type="button"
                onClick={() => setForm({ ...form, active: !form.active })}
                className={`mt-0.5 w-full rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition ${
                  form.active ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-white/10 text-ash-400"
                }`}
              >
                {form.active ? "Active (visible)" : "Inactive (hidden)"}
              </button>
            </Field>
          </div>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy ? <Spinner /> : null} {form.plan_id ? "Save changes" : "Create bundle"}
            </Button>
            {form.plan_id ? (
              <Button type="button" variant="ghost" onClick={() => { setForm(EMPTY_PLAN); setError(null); }}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-bold">Price list</h3>
          <div className="flex gap-1.5">
            {["all", "MTN", "Telecel", "AirtelTigo"].map((name) => (
              <button
                key={name}
                onClick={() => setFilter(name)}
                className={`rounded-lg px-2.5 py-1 text-[0.75rem] font-semibold transition ${
                  filter === name ? "bg-fire-500/15 text-fire-300" : "text-ash-400 hover:bg-white/5"
                }`}
              >
                {name === "all" ? "All" : name}
              </button>
            ))}
          </div>
        </div>

        {!plans ? (
          <Loading />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Bundle</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">Retail</Th>
                  <Th className="text-right">Sub-Agent</Th>
                  <Th className="text-right">Super</Th>
                  <Th className="text-right">Margin</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {visible.map((plan) => (
                  <tr key={plan.id} className={plan.active ? "" : "opacity-50"}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <NetworkBadge network={plan.network} />
                        <span className="font-semibold text-ash-100">{plan.size_label}</span>
                      </div>
                      <span className="text-[0.68rem] text-ash-500">{plan.data_mb} MB · {plan.validity_days}d</span>
                    </Td>
                    <Td className="text-right text-ash-400">{formatGhs(plan.cost_price_ghs)}</Td>
                    <Td className="text-right">{formatGhs(plan.retail_price_ghs)}</Td>
                    <Td className="text-right text-ash-300">{formatGhs(plan.sub_agent_price_ghs)}</Td>
                    <Td className="text-right text-ember-300">{formatGhs(plan.super_agent_price_ghs)}</Td>
                    <Td className="text-right font-semibold text-emerald-400">
                      {formatGhs(Number(plan.retail_price_ghs) - Number(plan.cost_price_ghs))}
                    </Td>
                    <Td className="text-right">
                      <button onClick={() => edit(plan)} className="text-[0.78rem] font-semibold text-fire-400 hover:text-fire-300">
                        Edit
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- ORDERS -------------------------------- */

function Orders() {
  const [orders, setOrders] = useState<any[] | null>(null);
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (query) params.set("q", query);
      const res = await apiGet<{ orders: any[] }>(`/api/admin/orders?${params}`);
      setOrders(res.orders ?? []);
    } catch (err) {
      toast.error("Could not load orders", (err as Error).message);
      setOrders([]);
    }
  }, [status, query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-bold">All orders</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} w-52`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search phone or ref"
          />
          <select className={`${inputClass} w-40`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {["all", "pending", "processing", "delivered", "failed", "refunded"].map((value) => (
              <option key={value} value={value}>{value === "all" ? "All statuses" : value}</option>
            ))}
          </select>
        </div>
      </div>

      {!orders ? (
        <Loading />
      ) : orders.length === 0 ? (
        <EmptyState title="No orders match" description="Try a different status or search term." />
      ) : (
        <TableWrap>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Bundle</Th>
                <Th>Recipient</Th>
                <Th>Buyer</Th>
                <Th>Agent</Th>
                <Th>Status</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Margin</Th>
                <Th className="text-right">When</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <NetworkBadge network={order.network} />
                      <span className="font-semibold text-ash-100">{order.size_label}</span>
                    </div>
                  </Td>
                  <Td><span className="font-mono text-[0.78rem]">{order.recipient_phone}</span></Td>
                  <Td>
                    <span className="block text-[0.8rem] text-ash-100">{order.buyer?.name ?? "—"}</span>
                    <span className="font-mono text-[0.68rem] text-ash-500">{order.buyer?.phone}</span>
                    <span className="ml-1 text-[0.68rem] text-fire-400">{tierLabel(order.buyer?.tier)}</span>
                  </Td>
                  <Td>
                    {order.agent ? (
                      <span className="font-mono text-[0.72rem] text-ash-400">{order.agent.phone}</span>
                    ) : (
                      <span className="text-ash-600">—</span>
                    )}
                  </Td>
                  <Td>
                    <StatusPill status={order.status} />
                    {order.failure_reason ? (
                      <span className="mt-0.5 block max-w-[12rem] truncate text-[0.65rem] text-red-300" title={order.failure_reason}>
                        {order.failure_reason}
                      </span>
                    ) : null}
                    {order.channel !== "web" ? (
                      <span className="mt-0.5 block text-[0.65rem] text-ember-400">{order.channel}</span>
                    ) : null}
                  </Td>
                  <Td className="text-right font-semibold">{formatGhs(order.price_charged_ghs)}</Td>
                  <Td className="text-right text-emerald-400">{formatGhs(order.margin_ghs)}</Td>
                  <Td className="text-right text-[0.72rem] text-ash-500">{formatRelative(order.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    delivered: "bg-emerald-500/15 text-emerald-300",
    pending: "bg-white/8 text-ash-300",
    processing: "bg-sky-500/15 text-sky-300",
    failed: "bg-red-500/15 text-red-300",
    refunded: "bg-ember-500/15 text-ember-300",
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[0.68rem] font-semibold ${map[status] ?? "bg-white/8 text-ash-300"}`}>
      {status}
    </span>
  );
}

/* --------------------------------- DEPOSITS -------------------------------- */

function Deposits() {
  const toast = useToast();
  const [queue, setQueue] = useState<any[] | null>(null);
  const [log, setLog] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<Record<string, { userId: string; amount: string; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [unmatched, all] = await Promise.all([
        apiGet<{ deposits: any[] }>("/api/admin/deposits?status=unmatched_review"),
        apiGet<{ deposits: any[] }>("/api/admin/deposits?limit=40"),
      ]);
      setQueue(unmatched.deposits ?? []);
      setLog(all.deposits ?? []);
    } catch (err) {
      toast.error("Could not load deposits", (err as Error).message);
      setQueue([]);
      setLog([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(depositId: string, action: "credit" | "reject") {
    const choice = selected[depositId] ?? { userId: "", amount: "", note: "" };
    if (action === "credit" && !choice.userId) {
      toast.error("Pick an account", "Choose which wallet to credit.");
      return;
    }
    setBusy(depositId);
    try {
      const result = await apiPost<{ message: string }>("/api/admin/deposits/resolve", {
        deposit_id: depositId,
        action,
        user_id: choice.userId || null,
        amount: choice.amount ? Number(choice.amount) : null,
        note: choice.note || null,
      });
      toast.success(action === "credit" ? "Deposit credited" : "Deposit rejected", result.message);
      await load();
    } catch (err) {
      toast.error("Could not resolve", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card variant="fire">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge tone="danger">Manual review</Badge>
            <h3 className="mt-2 text-lg font-bold">Unmatched deposits</h3>
            <p className="mt-1 text-[0.83rem] text-ash-200">
              Payments we could not match with confidence. Pick the account and credit — or reject it.
              Nothing here has touched a wallet yet.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={load}>
            ↻ Refresh
          </Button>
        </div>

        {!queue ? (
          <div className="mt-5"><Loading /></div>
        ) : queue.length === 0 ? (
          <div className="mt-5"><Alert tone="success">Nothing waiting for review. Every deposit matched automatically.</Alert></div>
        ) : (
          <ul className="mt-5 space-y-4">
            {queue.map((deposit) => {
              const choice = selected[deposit.id] ?? { userId: "", amount: String(deposit.amount_ghs ?? ""), note: "" };
              return (
                <li key={deposit.id} className="rounded-2xl border border-white/10 bg-charcoal-950/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xl font-extrabold text-white">{formatGhs(deposit.amount_ghs)}</p>
                      <p className="mt-0.5 text-[0.78rem] text-ash-300">
                        from <span className="font-mono">{deposit.sender_phone ?? "unknown"}</span> ·{" "}
                        {deposit.provider ?? "unknown provider"} · {formatRelative(deposit.created_at)}
                      </p>
                      <p className="mt-1 text-[0.72rem] text-ember-400">Reason held: {deposit.hold_reason}</p>
                    </div>
                    <Badge tone="danger">{formatGhs(deposit.amount_ghs)} unmatched</Badge>
                  </div>

                  <p className="mt-3 rounded-lg border border-white/8 bg-charcoal-900/60 p-2.5 font-mono text-[0.72rem] text-ash-400">
                    {deposit.raw_message}
                  </p>

                  {deposit.candidates?.length ? (
                    <div className="mt-3">
                      <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-ash-500">Suggested matches</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {deposit.candidates.map((candidate: any) => (
                          <button
                            key={candidate.intent_id}
                            onClick={() =>
                              setSelected({
                                ...selected,
                                [deposit.id]: { ...choice, userId: candidate.user_id, amount: String(candidate.expected_amount_ghs) },
                              })
                            }
                            className={`rounded-xl border px-3 py-2 text-left text-[0.75rem] transition ${
                              choice.userId === candidate.user_id
                                ? "border-fire-500/70 bg-fire-500/10"
                                : "border-white/10 hover:border-white/25"
                            }`}
                          >
                            <span className="block font-semibold text-white">{candidate.name ?? candidate.phone}</span>
                            <span className="font-mono text-ash-400">{candidate.phone}</span>
                            <span className="ml-2 text-ember-300">expects {formatGhs(candidate.expected_amount_ghs)}</span>
                            <span className="ml-2 text-ash-500">{candidate.reference_code}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3 grid gap-3 sm:grid-cols-[1.4fr_0.8fr_1.4fr_auto] sm:items-end">
                    <Field label="Credit to account">
                      <select
                        className={inputClass}
                        value={choice.userId}
                        onChange={(e) => setSelected({ ...selected, [deposit.id]: { ...choice, userId: e.target.value } })}
                      >
                        <option value="">Select account…</option>
                        {(deposit.all_users ?? []).map((user: any) => (
                          <option key={user.id} value={user.id}>
                            {user.phone} {user.name ? `· ${user.name}` : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Amount">
                      <input
                        className={inputClass}
                        value={choice.amount}
                        onChange={(e) =>
                          setSelected({ ...selected, [deposit.id]: { ...choice, amount: e.target.value.replace(/[^0-9.]/g, "") } })
                        }
                        inputMode="decimal"
                      />
                    </Field>
                    <Field label="Note (audit)">
                      <input
                        className={inputClass}
                        value={choice.note}
                        onChange={(e) => setSelected({ ...selected, [deposit.id]: { ...choice, note: e.target.value } })}
                        placeholder="Confirmed against MoMo statement"
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy === deposit.id} onClick={() => resolve(deposit.id, "credit")}>
                        {busy === deposit.id ? <Spinner /> : null} Credit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy === deposit.id} onClick={() => resolve(deposit.id, "reject")}>
                        Reject
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="mb-4 text-lg font-bold">Recent deposits</h3>
        {!log ? (
          <Loading />
        ) : log.length === 0 ? (
          <EmptyState title="No deposits yet" description="Credited and reviewed deposits appear here." />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Amount</Th>
                  <Th>Account</Th>
                  <Th>Sender</Th>
                  <Th>Strategy</Th>
                  <Th>Status</Th>
                  <Th className="text-right">When</Th>
                </tr>
              </thead>
              <tbody>
                {log.map((deposit) => (
                  <tr key={deposit.id}>
                    <Td className="font-semibold">{formatGhs(deposit.amount_ghs)}</Td>
                    <Td>
                      {deposit.user ? (
                        <>
                          <span className="block text-[0.8rem] text-ash-100">{deposit.user.name ?? "—"}</span>
                          <span className="font-mono text-[0.68rem] text-ash-500">{deposit.user.phone}</span>
                        </>
                      ) : (
                        <span className="text-ash-500">unmatched</span>
                      )}
                    </Td>
                    <Td><span className="font-mono text-[0.75rem] text-ash-400">{deposit.sender_phone ?? "—"}</span></Td>
                    <Td>
                      <span className="text-[0.75rem] text-ash-300">{deposit.match_strategy ?? "—"}</span>
                      {deposit.match_confidence ? (
                        <span className="ml-1 text-[0.68rem] text-ash-500">
                          {Math.round(Number(deposit.match_confidence) * 100)}%
                        </span>
                      ) : null}
                    </Td>
                    <Td><StatusPill status={deposit.status === "unmatched_review" ? "failed" : deposit.status} /></Td>
                    <Td className="text-right text-[0.72rem] text-ash-500">{formatRelative(deposit.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/** A readable payout reference for the operator's records. */
function makePayoutReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `PAYOUT-${suffix}`;
}

/* --------------------------------- PAYOUTS --------------------------------- */

function Payouts() {
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet("/api/admin/withdrawals"));
    } catch (err) {
      toast.error("Could not load payouts", (err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mark(id: string, status: string) {
    setBusy(id);
    try {
      const ref = makePayoutReference();
      const result = await apiPost<{ message: string }>("/api/admin/withdrawals", {
        withdrawal_id: id,
        status,
        payout_reference: status === "paid" ? ref : null,
      });
      toast.success("Payout updated", result.message);
      await load();
    } catch (err) {
      toast.error("Could not update", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runFreeFriday() {
    setBusy("free-friday");
    try {
      const result = await apiPost<{ message: string }>("/api/admin/withdrawals", { action: "run_free_friday" });
      toast.success("Free Friday queued", result.message);
      await load();
    } catch (err) {
      toast.error("Could not run Free Friday", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <Loading />;

  const totals = data.totals ?? {};
  const rows: any[] = data.withdrawals ?? [];
  const batched = rows.filter((row) => row.status === "batched");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Pending payouts" value={formatGhs(totals.pending_ghs)} />
        <Stat label="Free Friday queue" value={formatGhs(totals.batched_ghs)} tone="gold" sub={`${batched.length} requests`} />
        <Stat label="Paid all time" value={formatGhs(totals.paid_ghs)} />
        <Stat label="Fee income" value={formatGhs(totals.fees_ghs)} tone="fire" />
      </div>

      <Card variant="fire">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge tone="gold">Free Friday</Badge>
            <h3 className="mt-2 text-lg font-bold">Run the batched payout list</h3>
            <p className="mt-1 text-[0.83rem] text-ash-200">
              Queues every batched request for processing. {batched.length} request{batched.length === 1 ? "" : "s"} waiting.
            </p>
          </div>
          <Button variant="gold" onClick={runFreeFriday} disabled={busy === "free-friday" || batched.length === 0}>
            {busy === "free-friday" ? <Spinner /> : null} Run Free Friday
          </Button>
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 text-lg font-bold">Withdrawal requests</h3>
        {rows.length === 0 ? (
          <EmptyState title="No withdrawals yet" />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Agent</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">Fee</Th>
                  <Th>Mode</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Requested</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <Td>
                      <span className="block text-[0.8rem] text-ash-100">{row.user?.name ?? "—"}</span>
                      <span className="font-mono text-[0.68rem] text-ash-500">{row.user?.phone}</span>
                      <span className="ml-1 text-[0.66rem] text-fire-400">{tierLabel(row.user?.tier)}</span>
                    </Td>
                    <Td className="text-right font-semibold">{formatGhs(row.net_amount_ghs)}</Td>
                    <Td className="text-right text-ash-400">{formatGhs(row.fee_ghs)}</Td>
                    <Td><span className="text-[0.75rem] text-ash-300">{row.mode === "free_friday_batch" ? "Free Friday" : "Instant"}</span></Td>
                    <Td><StatusPill status={row.status} /></Td>
                    <Td className="text-right text-[0.72rem] text-ash-500">{formatRelative(row.created_at)}</Td>
                    <Td className="text-right">
                      {row.status !== "paid" && row.status !== "rejected" ? (
                        <div className="flex justify-end gap-1.5">
                          <button
                            onClick={() => mark(row.id, "paid")}
                            disabled={busy === row.id}
                            className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[0.72rem] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                          >
                            Mark paid
                          </button>
                          <button
                            onClick={() => mark(row.id, "rejected")}
                            disabled={busy === row.id}
                            className="rounded-lg bg-red-500/15 px-2.5 py-1 text-[0.72rem] font-semibold text-red-300 hover:bg-red-500/25"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-[0.7rem] text-ash-500">{row.payout_reference ?? "—"}</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- USERS ---------------------------------- */

function Users() {
  const toast = useToast();
  const [users, setUsers] = useState<any[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ users: any[] }>(`/api/admin/users?q=${encodeURIComponent(query)}&limit=200`);
      setUsers(res.users ?? []);
    } catch (err) {
      toast.error("Could not load users", (err as Error).message);
      setUsers([]);
    }
  }, [query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(userId: string, body: Record<string, unknown>, label: string) {
    setBusy(userId);
    try {
      const result = await apiPost<{ message: string }>("/api/admin/users", { user_id: userId, ...body });
      toast.success(label, result.message);
      await load();
    } catch (err) {
      toast.error(`${label} failed`, (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-bold">Users</h3>
        <input
          className={`${inputClass} w-60`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search phone or name"
        />
      </div>

      {!users ? (
        <Loading />
      ) : users.length === 0 ? (
        <EmptyState title="No accounts match" />
      ) : (
        <TableWrap>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Tier</Th>
                <Th>Squad</Th>
                <Th className="text-right">Wallet</Th>
                <Th className="text-right">Commission</Th>
                <Th className="text-right">Orders</Th>
                <Th>Bot</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <Td>
                    <span className="block text-[0.82rem] font-medium text-ash-100">{user.full_name ?? "—"}</span>
                    <span className="font-mono text-[0.68rem] text-ash-500">{user.phone}</span>
                  </Td>
                  <Td>
                    <select
                      className="rounded-lg border border-white/10 bg-charcoal-900/80 px-2 py-1 text-[0.72rem] text-ash-200"
                      value={user.tier}
                      onChange={(e) => act(user.id, { action: "set_tier", tier: e.target.value }, "Tier changed")}
                      disabled={busy === user.id}
                    >
                      <option value="customer">Customer</option>
                      <option value="sub_agent">Sub-Agent</option>
                      <option value="super_agent">Super Agent</option>
                    </select>
                  </Td>
                  <Td><span className="text-[0.72rem] text-ash-400">{user.squad_name ?? "—"}</span></Td>
                  <Td className="text-right font-semibold">{formatGhs(user.balance_ghs)}</Td>
                  <Td className="text-right text-ember-300">{formatGhs(user.commission_ghs)}</Td>
                  <Td className="text-right">{user.orders}</Td>
                  <Td>
                    {user.bot_enabled ? (
                      <Badge tone="success">{user.has_telegram ? "Telegram" : "WhatsApp"}</Badge>
                    ) : (
                      <span className="text-[0.7rem] text-ash-600">—</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => {
                          const raw = window.prompt(`Adjust ${user.phone}'s wallet. Use a negative number to debit:`, "10");
                          if (!raw) return;
                          const amount = Number(raw);
                          if (!Number.isFinite(amount) || amount === 0) {
                            toast.error("Invalid amount");
                            return;
                          }
                          void act(user.id, { action: "adjust_wallet", amount, reason: "Operator adjustment" }, "Wallet adjusted");
                        }}
                        className="rounded-lg bg-white/5 px-2.5 py-1 text-[0.72rem] font-semibold text-ash-200 hover:bg-white/10"
                      >
                        Adjust
                      </button>
                      <button
                        onClick={() =>
                          act(
                            user.id,
                            { action: "set_status", status: user.status === "active" ? "suspended" : "active" },
                            user.status === "active" ? "Account suspended" : "Account reactivated"
                          )
                        }
                        className="rounded-lg bg-white/5 px-2.5 py-1 text-[0.72rem] font-semibold text-ash-300 hover:bg-white/10"
                      >
                        {user.status === "active" ? "Suspend" : "Activate"}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/* ---------------------------------- SQUADS --------------------------------- */

function Squads() {
  const [squads, setSquads] = useState<any[] | null>(null);
  const toast = useToast();

  useEffect(() => {
    apiGet<{ squads: any[] }>("/api/admin/squads")
      .then((res) => setSquads(res.squads ?? []))
      .catch((err) => {
        toast.error("Could not load squads", err.message);
        setSquads([]);
      });
  }, [toast]);

  if (!squads) return <Loading />;
  if (squads.length === 0) return <EmptyState title="No squads yet" description="A squad is created automatically when someone becomes a Super Agent." />;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {squads.map((squad) => (
        <Card key={squad.id}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-bold text-white">{squad.name}</h3>
              <p className="mt-0.5 text-[0.75rem] text-ash-400">
                {squad.super_agent?.name ?? "—"} · <span className="font-mono">{squad.super_agent?.phone}</span>
              </p>
            </div>
            <Badge tone={squad.tier_retained ? "success" : "warning"}>
              {squad.tier_retained ? "Retained" : "At risk"}
            </Badge>
          </div>

          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between text-[0.78rem]">
              <span className="text-ash-400">{formatGhs(squad.current_volume_ghs)} of {formatGhs(squad.volume_target_ghs)}</span>
              <span className="font-semibold text-white">{squad.progress_pct}%</span>
            </div>
            <ProgressBar value={Number(squad.progress_pct ?? 0)} tone={squad.tier_retained ? "success" : "fire"} />
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <MiniStat label="Members" value={squad.members} />
            <MiniStat label="Orders" value={squad.orders_this_period} />
            <div className="rounded-xl border border-white/8 bg-charcoal-950/40 p-2.5 text-center">
              <p className="text-[0.62rem] uppercase tracking-wider text-ash-500">Invite</p>
              <p className="font-mono text-[0.8rem] font-bold text-fire-300">{squad.invite_code}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* -------------------------------- INTEGRITY -------------------------------- */

function Integrity({ smsWebhookUrl }: { smsWebhookUrl: string }) {
  const [data, setData] = useState<any>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [reconcile, webhooks] = await Promise.all([
        apiGet("/api/admin/reconcile"),
        apiGet<{ events: any[] }>("/api/admin/webhook-events?limit=30"),
      ]);
      setData(reconcile);
      setEvents(webhooks.events ?? []);
    } catch (err) {
      toast.error("Could not run reconciliation", (err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <Loading />;

  const clean = Number(data.drift_count ?? 0) === 0;

  return (
    <div className="space-y-6">
      <Card variant={clean ? "default" : "fire"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge tone={clean ? "success" : "danger"}>{clean ? "Ledger balanced" : "Drift detected"}</Badge>
            <h3 className="mt-2 text-lg font-bold">Wallet ⇄ ledger reconciliation</h3>
            <p className="mt-1 text-[0.83rem] text-ash-400">
              Every wallet balance is compared against the sum of its immutable ledger entries.
              {clean ? " All wallets agree." : " Investigate the accounts below."}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={load}>
            ↻ Re-run
          </Button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Wallets checked" value={data.checked_wallets ?? 0} />
          <Stat label="Drifting wallets" value={data.drift_count ?? 0} tone={clean ? "default" : "fire"} />
          <Stat label="Ledger entries" value={data.ledger?.entries ?? 0} />
          <Stat label="Ledger net" value={formatGhs(data.ledger?.net_ghs)} sub={`Terminal ${formatGhs(data.ledger?.terminal_balances)}`} />
        </div>

        {!clean ? (
          <div className="mt-5">
            <TableWrap>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>User</Th>
                    <Th className="text-right">Wallet</Th>
                    <Th className="text-right">Ledger</Th>
                    <Th className="text-right">Drift</Th>
                  </tr>
                </thead>
                <tbody>
                  {(data.drift ?? []).map((row: any) => (
                    <tr key={row.user_id}>
                      <Td><span className="font-mono text-[0.72rem]">{row.user_id}</span></Td>
                      <Td className="text-right">{formatGhs(row.balance_ghs)}</Td>
                      <Td className="text-right">{formatGhs(row.ledger_balance)}</Td>
                      <Td className="text-right font-semibold text-red-300">{formatGhs(row.balance_drift)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 border-t border-white/8 pt-5 sm:grid-cols-2">
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-ash-500">Money in</p>
            <ul className="mt-2 space-y-1.5 text-[0.82rem]">
              <MoneyRow label="Deposits credited" value={data.money_in?.deposits_credited_ghs} />
              <MoneyRow label="P2P received" value={data.money_in?.p2p_received_ghs} />
              <MoneyRow label="Commission reinvested" value={data.money_in?.reinvested_ghs} />
              <MoneyRow label="Reinvestment bonuses" value={data.money_in?.bonus_ghs} />
              <MoneyRow label="Refunds" value={data.money_in?.refunds_ghs} />
              <MoneyRow label="Admin adjustments" value={data.money_in?.adjustments_ghs} />
            </ul>
          </div>
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-ash-500">Money out</p>
            <ul className="mt-2 space-y-1.5 text-[0.82rem]">
              <MoneyRow label="Data purchases" value={data.money_out?.purchases_ghs} />
              <MoneyRow label="Withdrawals" value={data.money_out?.withdrawals_ghs} />
              <MoneyRow label="Withdrawal fees" value={data.money_out?.withdrawal_fees_ghs} />
              <MoneyRow label="P2P sent" value={data.money_out?.p2p_sent_ghs} />
            </ul>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-lg font-bold">SMS webhook activity</h3>
        <p className="mt-1 text-[0.8rem] text-ash-400">
          Every payload posted to <code className="font-mono text-fire-300">{smsWebhookUrl}</code> is logged before parsing.
        </p>
        {!events ? (
          <div className="mt-4"><Loading /></div>
        ) : events.length === 0 ? (
          <div className="mt-4"><Alert tone="info">No webhook traffic yet. Once your forwarder app is pointed here, every SMS shows up in this list.</Alert></div>
        ) : (
          <div className="mt-4">
            <TableWrap>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Outcome</Th>
                    <Th>Parsed</Th>
                    <Th>Raw</Th>
                    <Th className="text-right">ms</Th>
                    <Th className="text-right">When</Th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <Td>
                        <StatusPill status={event.outcome === "credited" ? "delivered" : event.outcome === "unmatched_review" ? "failed" : "pending"} />
                        <span className="ml-1.5 text-[0.7rem] text-ash-400">{event.outcome ?? "—"}</span>
                        {event.signature_ok === false ? (
                          <span className="ml-1 text-[0.65rem] text-red-300">bad secret</span>
                        ) : null}
                      </Td>
                      <Td>
                        <span className="text-[0.72rem] text-ash-300">
                          {event.parsed_payload?.amount != null ? formatGhs(event.parsed_payload.amount) : "—"}
                          {event.parsed_payload?.senderPhone ? ` · ${event.parsed_payload.senderPhone}` : ""}
                          {event.parsed_payload?.reference ? ` · ${event.parsed_payload.reference}` : ""}
                        </span>
                      </Td>
                      <Td>
                        <span className="block max-w-[22rem] truncate font-mono text-[0.68rem] text-ash-500" title={event.raw_body}>
                          {event.raw_body}
                        </span>
                      </Td>
                      <Td className="text-right text-[0.72rem] text-ash-500">{event.processing_ms ?? "—"}</Td>
                      <Td className="text-right text-[0.72rem] text-ash-500">{formatRelative(event.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
      </Card>
    </div>
  );
}

function MoneyRow({ label, value }: { label: string; value: unknown }) {
  return (
    <li className="flex justify-between">
      <span className="text-ash-400">{label}</span>
      <span className="font-semibold text-ash-100">{formatGhs(value)}</span>
    </li>
  );
}

function Loading() {
  return (
    <div className="space-y-3">
      <div className="skeleton h-20 rounded-xl" />
      <div className="skeleton h-32 rounded-xl" />
    </div>
  );
}
