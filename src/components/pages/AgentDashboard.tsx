"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert, Badge, Button, Card, EmptyState, Field, ProgressBar, SectionHeading, Spinner, Stat,
  TableWrap, Td, Th, inputClass,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiGet, apiPost } from "@/lib/client";
import { formatGhs, formatRelative, tierLabel } from "@/lib/format";

type AgentData = {
  user: any;
  eligibility: any;
  squad: any;
  commission: any;
  recruits: any;
  recent_orders: any[];
  config: Record<string, any>;
};

export default function AgentDashboard({ initial }: { initial: AgentData }) {
  const toast = useToast();
  const [data, setData] = useState<AgentData>(initial);
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [recruitPhone, setRecruitPhone] = useState("");
  const [recruitName, setRecruitName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const user = data.user;
  const tier = user?.tier ?? "customer";
  const balance = Number(user?.wallet?.balance_ghs ?? 0);

  const reload = useCallback(async () => {
    try {
      const fresh = await apiGet<AgentData>("/api/agent");
      setData(fresh);
    } catch {
      /* keep current state */
    }
  }, []);

  useEffect(() => {
    if (window.location.hash === "#bot") {
      document.getElementById("bot")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  async function upgrade(target: "sub_agent" | "super_agent") {
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<{ message: string }>("/api/agent/upgrade", { tier: target });
      toast.success(target === "super_agent" ? "Super Agent unlocked" : "Sub-Agent activated", result.message);
      await reload();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Upgrade could not be completed", message);
    } finally {
      setBusy(false);
    }
  }

  async function joinSquad(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<{ message: string }>("/api/agent/squad", { invite_code: joinCode });
      toast.success("Squad joined", result.message);
      setJoinCode("");
      await reload();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not join that squad", message);
    } finally {
      setBusy(false);
    }
  }

  async function recruit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<{ message: string }>("/api/agent/recruit", {
        phone: recruitPhone,
        full_name: recruitName || null,
      });
      toast.success("Sub-Agent added", result.message);
      setRecruitPhone("");
      setRecruitName("");
      await reload();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not add that Sub-Agent", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow={tierLabel(tier)}
        title="Agent Dashboard"
        description="Your tier, your squad's monthly volume, and the tools you sell with."
        action={
          <Button variant="ghost" size="sm" onClick={reload}>
            ↻ Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Wallet" value={formatGhs(balance)} tone="fire" />
        <Stat label="Commission pot" value={formatGhs(data.commission?.available_ghs ?? 0)} tone="gold" sub="Reinvest for a bonus" />
        <Stat
          label="Squad volume"
          value={formatGhs(data.squad?.squad?.current_volume_ghs ?? 0)}
          sub={`Target ${formatGhs(data.squad?.squad?.volume_target_ghs ?? data.config?.squad_volume_target_ghs ?? 5000)}`}
        />
        <Stat label="Your sales" value={formatGhs(data.squad?.my_volume_ghs ?? 0)} sub="This period" />
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Notifications />

      {/* ------------------------------- TIER LADDER ------------------------------- */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className={tier === "customer" ? "border-fire-500/40" : ""}>
          <div className="flex items-center justify-between">
            <Badge tone="muted">Customer</Badge>
            {tier === "customer" ? <Badge tone="fire">Current</Badge> : null}
          </div>
          <h3 className="mt-3 text-lg font-bold">Retail pricing</h3>
          <p className="mt-1.5 text-[0.85rem] text-ash-400">Buy for yourself at the walk-in rate.</p>
          {tier !== "customer" ? <p className="mt-3 text-[0.8rem] text-emerald-400">✓ Completed</p> : null}
        </Card>

        <Card className={tier === "sub_agent" ? "border-fire-500/40" : ""}>
          <div className="flex items-center justify-between">
            <Badge tone="fire">Sub-Agent</Badge>
            {tier === "sub_agent" ? <Badge tone="fire">Current</Badge> : null}
          </div>
          <h3 className="mt-3 text-lg font-bold">Free upgrade</h3>
          <p className="mt-1.5 text-[0.85rem] text-ash-400">
            Standard discount pricing on every bundle. Instant payouts carry a small fee, or use Free Friday free of charge.
          </p>
          {tier === "customer" ? (
            <Button className="mt-4 w-full" onClick={() => upgrade("sub_agent")} disabled={busy}>
              {busy ? <Spinner /> : null} Become a Sub-Agent
            </Button>
          ) : (
            <p className="mt-3 text-[0.8rem] text-emerald-400">✓ {tier === "super_agent" ? "Passed" : "Active"}</p>
          )}
        </Card>

        <Card variant="fire">
          <div className="flex items-center justify-between">
            <Badge tone="gold">Super Agent</Badge>
            {tier === "super_agent" ? <Badge tone="gold">Current</Badge> : null}
          </div>
          <h3 className="mt-3 text-lg font-bold">VIP wholesale</h3>
          <p className="mt-1.5 text-[0.85rem] text-ash-200">
            Unlocks at {formatGhs(data.eligibility?.commitment_ghs ?? 500)} of lifetime deposits — the money stays yours, it
            just proves volume. Includes unlimited free instant withdrawals and your own bot.
          </p>

          {tier === "super_agent" ? (
            <p className="mt-3 text-[0.8rem] text-emerald-300">✓ Unlocked {formatRelative(user?.super_agent_unlocked_at)}</p>
          ) : (
            <>
              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between text-[0.75rem] text-ash-300">
                  <span>{formatGhs(data.eligibility?.deposited_lifetime_ghs ?? 0)} deposited</span>
                  <span>{formatGhs(data.eligibility?.commitment_ghs ?? 500)}</span>
                </div>
                <ProgressBar
                  value={Number(data.eligibility?.deposited_lifetime_ghs ?? 0)}
                  max={Number(data.eligibility?.commitment_ghs ?? 500)}
                />
              </div>
              <Button
                variant="gold"
                className="mt-4 w-full"
                onClick={() => upgrade("super_agent")}
                disabled={busy || !data.eligibility?.eligible}
              >
                {data.eligibility?.eligible
                  ? "Unlock Super Agent"
                  : `Top up ${formatGhs(data.eligibility?.remaining_ghs ?? 0)} more to unlock`}
              </Button>
              <Button href="/wallet" variant="ghost" size="sm" className="mt-2 w-full">
                Top up your wallet
              </Button>
            </>
          )}
        </Card>
      </div>

      {/* --------------------------------- SQUAD ---------------------------------- */}
      {data.squad?.squad ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Badge tone={data.squad.squad.tier_retained ? "success" : "warning"}>
                {data.squad.squad.tier_retained ? "Tier retained" : "Tier at risk"}
              </Badge>
              <h3 className="mt-3 text-xl font-bold">{data.squad.squad.name}</h3>
              <p className="mt-1 text-sm text-ash-400">
                Led by {data.squad.squad.super_agent?.full_name ?? data.squad.squad.super_agent?.phone} ·{" "}
                {data.squad.member_count} member{data.squad.member_count === 1 ? "" : "s"} · period ends{" "}
                {formatRelative(data.squad.squad.period_end)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-extrabold fire-text">{formatGhs(data.squad.squad.current_volume_ghs)}</p>
              <p className="text-[0.75rem] text-ash-400">
                of {formatGhs(data.squad.squad.volume_target_ghs)} · {data.squad.squad.progress_pct}%
              </p>
            </div>
          </div>

          <ProgressBar value={Number(data.squad.squad.progress_pct ?? 0)} className="mt-4 h-2.5" />

          <p className="mt-3 text-[0.8rem] text-ash-400">
            {data.squad.squad.tier_retained
              ? `Hit the target to keep ${tierLabel(tier).toLowerCase()} pricing next month — ${formatGhs(data.squad.squad.remaining_ghs)} to go.`
              : "This squad missed last month's target, so pricing reverted to retail until the target is hit again."}
          </p>

          <TableWrap className="mt-5">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th>Tier</Th>
                  <Th className="text-right">Orders</Th>
                  <Th className="text-right">Volume</Th>
                  <Th className="text-right">Joined</Th>
                </tr>
              </thead>
              <tbody>
                {(data.squad.members ?? []).map((member: any) => (
                  <tr key={member.user_id}>
                    <Td>
                      <span className="block text-[0.85rem] font-medium text-ash-100">
                        {member.full_name ?? "—"}
                        {!member.activated ? <span className="ml-2 text-[0.68rem] text-ember-400">pending activation</span> : null}
                      </span>
                      <span className="font-mono text-[0.7rem] text-ash-500">{member.phone}</span>
                    </Td>
                    <Td><span className="text-[0.78rem]">{tierLabel(member.tier)}</span></Td>
                    <Td className="text-right">{member.orders}</Td>
                    <Td className="text-right font-semibold text-ash-100">{formatGhs(member.volume_ghs)}</Td>
                    <Td className="text-right text-[0.75rem] text-ash-500">{formatRelative(member.joined_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ) : (
        <Card>
          <h3 className="text-lg font-bold">You&apos;re not in a squad yet</h3>
          <p className="mt-1 text-sm text-ash-400">
            Squads pool their sales against a monthly target. Hit it and every member keeps discount pricing.
            Ask your Super Agent for their invite code, or join with the code you were given.
          </p>
          <form onSubmit={joinSquad} className="mt-4 flex flex-wrap items-end gap-3">
            <Field label="Squad invite code" className="flex-1 min-w-[12rem]">
              <input
                className={inputClass}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="SQL-AB12C"
              />
            </Field>
            <Button type="submit" disabled={busy || !joinCode}>
              {busy ? <Spinner /> : null} Join squad
            </Button>
          </form>
        </Card>
      )}

      {/* -------------------------------- RECRUITS -------------------------------- */}
      {tier === "super_agent" ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold">Recruit Sub-Agents</h3>
              <p className="mt-1 text-sm text-ash-400">
                Add agents to your squad and their sales count toward your monthly target.
              </p>
            </div>
            {data.recruits?.invite_code ? (
              <div className="rounded-xl border border-fire-700/40 bg-charcoal-950/60 px-4 py-2.5 text-right">
                <p className="text-[0.65rem] uppercase tracking-[0.14em] text-ash-500">Squad invite code</p>
                <p className="font-mono text-lg font-bold text-fire-300">{data.recruits.invite_code}</p>
              </div>
            ) : null}
          </div>

          <form onSubmit={recruit} className="mt-4 grid gap-3 sm:grid-cols-[1.2fr_1.4fr_auto] sm:items-end">
            <Field label="Sub-Agent phone">
              <input
                className={inputClass}
                value={recruitPhone}
                onChange={(e) => setRecruitPhone(e.target.value)}
                placeholder="0244123456"
                inputMode="tel"
              />
            </Field>
            <Field label="Name (optional)">
              <input
                className={inputClass}
                value={recruitName}
                onChange={(e) => setRecruitName(e.target.value)}
                placeholder="Ama Boateng"
              />
            </Field>
            <Button type="submit" disabled={busy || !recruitPhone} className="sm:mb-0">
              {busy ? <Spinner /> : null} Add
            </Button>
          </form>

          {data.recruits?.recruits?.length ? (
            <ul className="mt-5 space-y-2">
              {data.recruits.recruits.map((person: any) => (
                <li
                  key={person.id}
                  className="flex items-center justify-between rounded-xl border border-white/8 bg-charcoal-950/40 px-3.5 py-2.5"
                >
                  <div>
                    <p className="text-[0.85rem] font-medium text-ash-100">{person.full_name ?? "Unnamed agent"}</p>
                    <p className="font-mono text-[0.7rem] text-ash-500">{person.phone}</p>
                  </div>
                  <Badge tone={person.activated ? "success" : "warning"}>
                    {person.activated ? "Active" : "Awaiting signup"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-[0.82rem] text-ash-500">
              No Sub-Agents yet. Share your invite code {data.recruits?.invite_code ?? ""} or add them by number.
            </p>
          )}
        </Card>
      ) : null}

      {/* ----------------------------------- BOT ---------------------------------- */}
      {tier === "super_agent" ? <BotSection data={data} onSaved={reload} toast={toast} /> : null}

      {/* ------------------------------ RECENT ORDERS ----------------------------- */}
      <Card>
        <h3 className="mb-3 text-lg font-bold">Your recent orders</h3>
        {data.recent_orders.length === 0 ? (
          <EmptyState title="No orders yet" description="Your first sale will show up here." />
        ) : (
          <TableWrap>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Bundle</Th>
                  <Th>Recipient</Th>
                  <Th>Channel</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">When</Th>
                </tr>
              </thead>
              <tbody>
                {data.recent_orders.map((order) => (
                  <tr key={order.id}>
                    <Td>
                      <span className="text-[0.85rem] font-medium text-ash-100">
                        {order.network} {order.size_label}
                      </span>
                    </Td>
                    <Td><span className="font-mono text-[0.78rem]">{order.recipient_phone}</span></Td>
                    <Td><span className="text-[0.78rem] capitalize text-ash-400">{order.channel}</span></Td>
                    <Td className="text-right font-semibold">{formatGhs(order.price_charged_ghs)}</Td>
                    <Td className="text-right text-[0.75rem] text-ash-500">{formatRelative(order.created_at)}</Td>
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

/* ------------------------------ NOTIFICATIONS ------------------------------ */

function Notifications() {
  const [data, setData] = useState<{ notifications: any[]; unread: number } | null>(null);

  useEffect(() => {
    apiGet<{ notifications: any[]; unread: number }>("/api/notifications")
      .then(setData)
      .catch(() => setData({ notifications: [], unread: 0 }));
  }, []);

  if (!data || data.notifications.length === 0) return null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[0.8rem] font-bold text-white">
          Activity
          {data.unread > 0 ? (
            <span className="ml-2 rounded-full bg-fire-500/20 px-2 py-0.5 text-[0.65rem] font-bold text-fire-300">
              {data.unread} new
            </span>
          ) : null}
        </h3>
        {data.unread > 0 ? (
          <button
            onClick={async () => {
              await apiPost("/api/notifications", {}).catch(() => null);
              setData({ notifications: data.notifications, unread: 0 });
            }}
            className="text-[0.72rem] font-semibold text-ash-400 hover:text-white"
          >
            Mark all read
          </button>
        ) : null}
      </div>
      <ul className="space-y-2.5">
        {data.notifications.slice(0, 5).map((row) => (
          <li key={row.id} className="flex items-start gap-3">
            <span
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                row.read_at ? "bg-ash-500" : "bg-fire-400"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[0.83rem] font-medium text-ash-100">{row.title}</p>
              <p className="text-[0.75rem] text-ash-400">{row.body}</p>
              <p className="mt-0.5 text-[0.66rem] text-ash-500">{formatRelative(row.created_at)}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------------------------------- BOT ----------------------------------- */

function BotSection({
  data,
  onSaved,
  toast,
}: {
  data: AgentData;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [channel, setChannel] = useState<"telegram" | "whatsapp">("telegram");
  const [token, setToken] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = data.user;
  const commands = [
    { cmd: "help", desc: "Command list" },
    { cmd: "balance", desc: "Wallet balance" },
    { cmd: "prices", desc: "Your wholesale price list" },
    { cmd: "buy mtn 5gb 0244123456", desc: "Instant vend" },
    { cmd: "orders", desc: "Last five orders" },
  ];

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<any>("/api/agent/bot", {
        channel,
        token: channel === "telegram" ? token : null,
        endpoint: channel === "whatsapp" ? endpoint : null,
        phone_number_id: channel === "whatsapp" ? phoneNumberId : null,
        verify_token: channel === "whatsapp" ? verifyToken : null,
      });
      if (result.webhook_registered === false) {
        toast.error("Token saved, webhook pending", result.webhook_error ?? "Telegram rejected the webhook URL.");
      } else {
        toast.success("Bot linked", result.message);
      }
      setToken("");
      setEndpoint("");
      onSaved();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not link that bot", message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await apiPost("/api/agent/bot", { channel, token: null, endpoint: null });
      toast.info("Bot disconnected", "Your bot will no longer respond.");
      onSaved();
    } catch {
      toast.error("Could not disconnect", "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="bot" variant="fire">
      <div id="bot" className="scroll-mt-24" />
      <Badge tone="gold">Bot-in-a-Box</Badge>
      <h3 className="mt-3 text-xl font-bold">Sell through your own bot</h3>
      <p className="mt-1.5 max-w-2xl text-sm text-ash-200">
        Link your own Telegram bot or WhatsApp Business endpoint. Customers chat with your bot; every
        sale runs at your wholesale tier and counts toward your squad volume.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {(
          [
            ["telegram", user?.has_telegram_bot ? "Telegram · linked" : "Telegram"],
            ["whatsapp", user?.has_whatsapp_endpoint ? "WhatsApp · linked" : "WhatsApp"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setChannel(key)}
            className={`rounded-xl border px-4 py-2.5 text-sm font-semibold transition ${
              channel === key ? "border-ember-500/70 bg-ember-500/10 text-white" : "border-white/10 text-ash-300 hover:border-white/25"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={save} className="mt-4 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          {channel === "telegram" ? (
            <Field label="Telegram bot token" hint="From @BotFather">
              <input
                className={inputClass}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="1234567890:AAHk3Lm9QqWxYz..."
                autoComplete="off"
              />
            </Field>
          ) : (
            <>
              <Field label="WhatsApp Business endpoint" hint="https://...">
                <input
                  className={inputClass}
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://graph.facebook.com/v21.0/1234567890/messages"
                />
              </Field>
              <Field label="Phone number ID">
                <input
                  className={inputClass}
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="109876543210987"
                />
              </Field>
              <Field label="Verify token" hint="Echoed back during Meta's handshake">
                <input
                  className={inputClass}
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  placeholder="priceless-verify-token"
                />
              </Field>
            </>
          )}

          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="gold" disabled={busy}>
              {busy ? <Spinner /> : null} {channel === "telegram" ? "Link bot" : "Link endpoint"}
            </Button>
            {user?.has_telegram_bot || user?.has_whatsapp_endpoint ? (
              <Button type="button" variant="ghost" onClick={disconnect} disabled={busy}>
                Disconnect
              </Button>
            ) : null}
          </div>

          {channel === "whatsapp" ? (
            <p className="text-[0.75rem] text-ash-300">
              Point Meta&apos;s webhook at <span className="font-mono text-ember-300">/api/bot/whatsapp</span> and use the verify
              token above. GET requests are validated against your linked endpoint.
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-white/10 bg-charcoal-950/60 p-4">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-ash-400">Commands your bot answers</p>
          <ul className="mt-3 space-y-2">
            {commands.map((command) => (
              <li key={command.cmd} className="text-[0.8rem]">
                <span className="font-mono text-fire-300">{command.cmd}</span>
                <span className="ml-2 text-ash-400">{command.desc}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 border-t border-white/8 pt-3">
            <p className="text-[0.72rem] text-ash-400">
              Status:{" "}
              {user?.bot_enabled ? (
                <span className="font-semibold text-emerald-400">connected</span>
              ) : (
                <span className="font-semibold text-ash-400">not connected</span>
              )}
            </p>
          </div>
        </div>
      </form>
    </Card>
  );
}
