"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Badge, Button, Card, EmptyState, Field, ProgressBar, SectionHeading, Spinner, Stat,
  TableWrap, Td, Th, inputClass,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiGet, apiPost } from "@/lib/client";
import { formatGhs, formatRelative, ledgerLabel, tierLabel } from "@/lib/format";

type Wallet = {
  balance_ghs: number;
  commission_balance_ghs: number;
  total_deposited_ghs: number;
  total_spent_ghs: number;
  total_withdrawn_ghs: number;
};

type Intent = {
  id: string;
  reference_code: string;
  expected_amount_ghs: number;
  status: string;
  collection_number: string | null;
  expires_at: string;
  created_at: string;
  channel: string;
};

type LedgerEntry = {
  id: number;
  entry_type: string;
  amount_ghs: number;
  commission_amount_ghs: number;
  balance_after: number;
  description: string;
  reference: string | null;
  created_at: string;
};

const QUICK_AMOUNTS = [10, 20, 50, 100, 200, 500];

export default function WalletPage({
  initialWallet,
  initialIntents,
  tier,
  config,
}: {
  initialWallet: Wallet;
  initialIntents: Intent[];
  tier: string;
  config: Record<string, any>;
}) {
  const toast = useToast();
  const [wallet, setWallet] = useState<Wallet>(initialWallet);
  const [intents, setIntents] = useState<Intent[]>(initialIntents);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [commission, setCommission] = useState<any>(null);
  const [tab, setTab] = useState<"topup" | "history" | "p2p" | "commission">("topup");

  const refreshWallet = useCallback(async () => {
    try {
      const [walletRes, commissionRes] = await Promise.all([
        apiGet<{ wallet: Wallet; active_intents: Intent[] }>("/api/wallet"),
        apiGet<any>("/api/wallet/commission"),
      ]);
      setWallet(walletRes.wallet ?? wallet);
      setIntents(walletRes.active_intents ?? []);
      setCommission(commissionRes);
    } catch {
      /* ignore transient errors */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiGet<{ entries: LedgerEntry[] }>("/api/wallet/ledger?limit=60")
      .then((res) => setEntries(res.entries ?? []))
      .catch(() => setEntries([]));
    apiGet<any>("/api/wallet/commission").then(setCommission).catch(() => {});
  }, []);

  // Poll while a top-up is pending so the credit appears without a refresh.
  const pending = intents.length > 0;
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(refreshWallet, 8000);
    return () => clearInterval(id);
  }, [pending, refreshWallet]);

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow={tierLabel(tier)}
        title="Wallet"
        description="Top up by Mobile Money, keep an eye on every movement, and move commission into your spending balance."
        action={
          <Button variant="ghost" size="sm" onClick={refreshWallet}>
            ↻ Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Available" value={formatGhs(wallet.balance_ghs)} tone="fire" />
        <Stat label="Commission pot" value={formatGhs(wallet.commission_balance_ghs)} tone="gold" sub="Reinvest for a bonus" />
        <Stat label="Total deposited" value={formatGhs(wallet.total_deposited_ghs)} />
        <Stat label="Total spent" value={formatGhs(wallet.total_spent_ghs)} />
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-white/8 bg-charcoal-900/50 p-1.5">
        {(
          [
            ["topup", "Top up"],
            ["history", "History"],
            ["p2p", "Send money"],
            ["commission", "Commission"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              tab === key ? "fire-gradient text-white" : "text-ash-300 hover:bg-white/5"
            }`}
          >
            {label}
            {key === "commission" && Number(commission?.available_ghs ?? 0) > 0 ? (
              <span className="ml-2 rounded-full bg-ember-500/25 px-1.5 py-0.5 text-[0.65rem] text-ember-200">
                {formatGhs(commission.available_ghs)}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "topup" ? (
        <TopUpSection
          wallet={wallet}
          intents={intents}
          setIntents={setIntents}
          onCredited={refreshWallet}
          config={config}
          toast={toast}
        />
      ) : null}

      {tab === "history" ? <HistorySection entries={entries} /> : null}

      {tab === "p2p" ? <P2PSection wallet={wallet} onDone={refreshWallet} toast={toast} /> : null}

      {tab === "commission" ? (
        <CommissionSection commission={commission} onDone={refreshWallet} toast={toast} />
      ) : null}
    </div>
  );
}

/* ------------------------------- TOP UP ---------------------------------- */

function TopUpSection({
  wallet,
  intents,
  setIntents,
  onCredited,
  config,
  toast,
}: {
  wallet: Wallet;
  intents: Intent[];
  setIntents: (value: Intent[]) => void;
  onCredited: () => void;
  config: Record<string, any>;
  toast: ReturnType<typeof useToast>;
}) {
  const [amount, setAmount] = useState<string>("50");
  const [channel, setChannel] = useState<"momo" | "telecel">("momo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ intent: Intent; instructions: any } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeIntent = created?.intent ?? intents[0] ?? null;
  const collectionNumber =
    channel === "telecel"
      ? config?.collection_number_telecel ?? "0501234567"
      : config?.collection_number_momo ?? "0551234567";

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function createIntent(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter the amount you want to top up.");
      return;
    }
    setBusy(true);
    try {
      const response = await apiPost<{ intent: Intent; instructions: any; reused: boolean }>("/api/wallet/topup", {
        amount: value,
        channel,
      });
      setCreated({ intent: response.intent, instructions: response.instructions });
      setIntents([response.intent, ...intents.filter((i) => i.id !== response.intent.id)]);
      toast.info(
        response.reused ? "Existing top-up request reused" : `Reference ${response.intent.reference_code} created`,
        `Send ${formatGhs(response.intent.expected_amount_ghs)} and your wallet updates automatically.`
      );

      // Poll this intent until it is matched.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const status = await apiGet<{ credited: boolean; status: string }>(
            `/api/wallet/topup/${response.intent.id}`
          );
          if (status.credited) {
            if (pollRef.current) clearInterval(pollRef.current);
            setCreated(null);
            setIntents([]);
            onCredited();
            toast.success("Wallet credited", `${formatGhs(response.intent.expected_amount_ghs)} has landed in your wallet.`);
          }
        } catch {
          /* keep polling */
        }
      }, 6000);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not start the top-up", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <h3 className="text-lg font-bold">Request a top-up</h3>
        <p className="mt-1 text-sm text-ash-400">
          We generate a short reference code. Send the money to the collection number with that
          code, and your wallet is credited automatically.
        </p>

        <form onSubmit={createIntent} className="mt-5 space-y-4">
          <Field label="Amount (GHS)" hint={`Min ${formatGhs(config?.min_deposit_ghs ?? 1)}`}>
            <input
              className={inputClass}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="50"
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            {QUICK_AMOUNTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAmount(String(value))}
                className={`rounded-lg border px-3 py-1.5 text-[0.8rem] font-semibold transition ${
                  amount === String(value)
                    ? "border-fire-500/70 bg-fire-500/10 text-fire-200"
                    : "border-white/10 text-ash-300 hover:border-white/25"
                }`}
              >
                {formatGhs(value, { symbol: false })}
              </button>
            ))}
          </div>

          <Field label="Send from">
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["momo", "MTN MoMo"],
                  ["telecel", "Telecel Cash"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setChannel(key)}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${
                    channel === key
                      ? "border-fire-500/70 bg-fire-500/10 text-white"
                      : "border-white/10 text-ash-300 hover:border-white/25"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? "Creating reference…" : "Get my reference code"}
          </Button>
        </form>
      </Card>

      <div className="space-y-5">
        {activeIntent ? (
          <Card variant="fire" className="animate-rise">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[0.7rem] uppercase tracking-[0.14em] text-ash-300">Send exactly</p>
                <p className="text-3xl font-extrabold text-white">{formatGhs(activeIntent.expected_amount_ghs)}</p>
              </div>
              <Badge tone="gold">{activeIntent.status === "pending_match" ? "Awaiting payment" : activeIntent.status}</Badge>
            </div>

            <div className="mt-5 space-y-3 rounded-xl border border-white/10 bg-charcoal-950/70 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[0.75rem] text-ash-400">Collection number</span>
                <CopyValue value={activeIntent.collection_number ?? collectionNumber} big />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[0.75rem] text-ash-400">Reference code</span>
                <CopyValue value={activeIntent.reference_code} big />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[0.75rem] text-ash-400">Expires</span>
                <span className="text-[0.8rem] text-ash-200">{formatRelative(activeIntent.expires_at)}</span>
              </div>
            </div>

            <ol className="mt-5 space-y-2.5 text-[0.83rem] text-ash-200">
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fire-500/20 text-[0.7rem] font-bold text-fire-300">1</span>
                <span>
                  Dial your MoMo menu and send <strong className="text-white">{formatGhs(activeIntent.expected_amount_ghs)}</strong> to{" "}
                  <strong className="text-white">{activeIntent.collection_number ?? collectionNumber}</strong>.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fire-500/20 text-[0.7rem] font-bold text-fire-300">2</span>
                <span>
                  Use <strong className="text-fire-300">{activeIntent.reference_code}</strong> as the reference / narrative.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fire-500/20 text-[0.7rem] font-bold text-fire-300">3</span>
                <span className="flex items-center gap-2">
                  <Spinner className="h-3 w-3" /> Watching for your payment — this page updates itself.
                </span>
              </li>
            </ol>

            <p className="mt-4 text-[0.72rem] text-ash-400">
              Payments without the reference still work when your number or the exact amount matches. Anything
              we can&apos;t match confidently goes to a human for review — we never guess with your money.
            </p>
          </Card>
        ) : (
          <Card className="text-center">
            <p className="text-4xl">📲</p>
            <h3 className="mt-3 text-lg font-bold">No active top-up request</h3>
            <p className="mt-1 text-sm text-ash-400">
              Create one and we&apos;ll show you the collection number plus a unique reference code.
            </p>
          </Card>
        )}

        <Card>
          <h3 className="text-sm font-bold text-white">How the automatic top-up works</h3>
          <ul className="mt-3 space-y-2 text-[0.83rem] text-ash-400">
            <li>→ Every incoming Mobile Money SMS is read by a dedicated collection phone.</li>
            <li>→ We match it to your request by reference code first, then by your number, then by exact amount.</li>
            <li>→ The credit lands in your wallet automatically, with a ledger entry you can audit.</li>
          </ul>
          <p className="mt-3 text-[0.75rem] text-ash-500">
            Support: {config?.support_phone ?? "0551234567"} · Balance {formatGhs(wallet.balance_ghs)}
          </p>
        </Card>
      </div>
    </div>
  );
}

function CopyValue({ value, big }: { value: string; big?: boolean }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success("Copied", value);
        } catch {
          toast.error("Could not copy", "Copy it manually please.");
        }
      }}
      className={`group flex items-center gap-2 font-mono font-bold text-white transition hover:text-fire-300 ${
        big ? "text-lg" : "text-sm"
      }`}
      title="Tap to copy"
    >
      {value}
      <span className="text-[0.7rem] font-normal text-ash-500 group-hover:text-fire-400">copy</span>
    </button>
  );
}

/* ------------------------------- HISTORY --------------------------------- */

function HistorySection({ entries }: { entries: LedgerEntry[] | null }) {
  if (!entries) return <Card><div className="skeleton h-40 rounded-xl" /></Card>;
  if (entries.length === 0) {
    return <EmptyState title="No wallet activity yet" description="Your deposits, purchases, refunds and payouts will appear here." />;
  }

  const credits = entries.filter((e) => Number(e.amount_ghs) > 0).reduce((sum, e) => sum + Number(e.amount_ghs), 0);
  const debits = entries.filter((e) => Number(e.amount_ghs) < 0).reduce((sum, e) => sum + Math.abs(Number(e.amount_ghs)), 0);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-bold">Wallet history</h3>
        <div className="flex gap-2 text-[0.75rem]">
          <Badge tone="success">In {formatGhs(credits)}</Badge>
          <Badge tone="danger">Out {formatGhs(debits)}</Badge>
        </div>
      </div>

      <TableWrap>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Type</Th>
              <Th>Detail</Th>
              <Th className="text-right">Amount</Th>
              <Th className="text-right">Balance after</Th>
              <Th className="text-right">When</Th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const amount = Number(entry.amount_ghs);
              const commission = Number(entry.commission_amount_ghs);
              return (
                <tr key={entry.id}>
                  <Td>
                    <span className="text-[0.8rem] font-semibold text-ash-100">{ledgerLabel(entry.entry_type)}</span>
                  </Td>
                  <Td>
                    <span className="block max-w-[24rem] truncate text-[0.8rem] text-ash-300">{entry.description}</span>
                    {entry.reference ? (
                      <span className="font-mono text-[0.68rem] text-ash-500">{entry.reference}</span>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    {amount !== 0 ? (
                      <span className={`text-[0.85rem] font-bold ${amount > 0 ? "text-emerald-400" : "text-red-300"}`}>
                        {amount > 0 ? "+" : "−"}
                        {formatGhs(Math.abs(amount), { symbol: false })}
                      </span>
                    ) : null}
                    {commission !== 0 ? (
                      <span className={`block text-[0.7rem] font-semibold ${commission > 0 ? "text-ember-300" : "text-ash-400"}`}>
                        {commission > 0 ? "+" : "−"}
                        {formatGhs(Math.abs(commission), { symbol: false })} comm.
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    <span className="text-[0.8rem] text-ash-300">{formatGhs(entry.balance_after)}</span>
                  </Td>
                  <Td className="text-right">
                    <span className="text-[0.75rem] text-ash-500">{formatRelative(entry.created_at)}</span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

/* --------------------------------- P2P ----------------------------------- */

function P2PSection({
  wallet,
  onDone,
  toast,
}: {
  wallet: Wallet;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<{ message: string; recipient: { phone: string; full_name: string | null } }>(
        "/api/wallet/p2p",
        { recipient, amount: Number(amount), note }
      );
      toast.success("Money sent", result.message);
      setRecipient("");
      setAmount("");
      setNote("");
      onDone();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Transfer failed", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <h3 className="text-lg font-bold">Send wallet balance</h3>
      <p className="mt-1 text-sm text-ash-400">
        Move money to any Priceless Bundle user instantly. Available: {formatGhs(wallet.balance_ghs)}.
      </p>

      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Recipient phone number">
          <input
            className={inputClass}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0244123456"
            inputMode="tel"
          />
        </Field>
        <Field label="Amount (GHS)">
          <input
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="20"
            inputMode="decimal"
          />
        </Field>
        <Field label="Note (optional)">
          <input
            className={inputClass}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 120))}
            placeholder="For the bundle you sent"
          />
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? <Spinner /> : null}
          {busy ? "Sending…" : "Send money"}
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------ COMMISSION -------------------------------- */

function CommissionSection({
  commission,
  onDone,
  toast,
}: {
  commission: any;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = Number(commission?.available_ghs ?? 0);
  const minPct = Number(commission?.min_pct ?? 2);
  const maxPct = Number(commission?.max_pct ?? 5);
  const tiers = Array.isArray(commission?.bonus_tiers) ? commission.bonus_tiers : [];

  async function reinvest(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<any>("/api/wallet/commission", {
        amount: amount === "" ? null : Number(amount),
      });
      toast.success("Reinvested", result.message);
      setAmount("");
      onDone();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not reinvest", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Card variant="fire">
        <Badge tone="gold">Commission pot</Badge>
        <p className="mt-3 text-4xl font-extrabold text-white">{formatGhs(available)}</p>
        <p className="mt-1 text-sm text-ash-300">
          Earned from sales in your squad. Move it into your main wallet and we&apos;ll top it up with a{" "}
          {minPct}–{maxPct}% bonus.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/10 bg-charcoal-950/50 p-3">
            <p className="text-[0.68rem] uppercase tracking-wider text-ash-400">Lifetime earned</p>
            <p className="text-lg font-bold text-white">{formatGhs(commission?.lifetime_ghs ?? 0)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-charcoal-950/50 p-3">
            <p className="text-[0.68rem] uppercase tracking-wider text-ash-400">Already reinvested</p>
            <p className="text-lg font-bold text-white">{formatGhs(commission?.reinvested_ghs ?? 0)}</p>
          </div>
        </div>

        <form onSubmit={reinvest} className="mt-5 space-y-3">
          <Field label="Amount to reinvest" hint="Leave blank to reinvest everything">
            <input
              className={inputClass}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder={available > 0 ? String(available.toFixed(2)) : "0.00"}
              inputMode="decimal"
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" variant="gold" className="w-full" disabled={busy || available <= 0}>
            {busy ? <Spinner /> : null}
            {available > 0 ? `Reinvest ${formatGhs(amount === "" ? available : Number(amount) || 0)}` : "Nothing to reinvest yet"}
          </Button>
        </form>
      </Card>

      <div className="space-y-5">
        <Card>
          <h3 className="text-sm font-bold text-white">Bonus ladder</h3>
          <p className="mt-1 text-[0.8rem] text-ash-400">The more commission you reinvest at once, the bigger the bonus.</p>
          <ul className="mt-4 space-y-3">
            {tiers.map((tier: any, index: number) => {
              const next = tiers[index + 1];
              const from = Number(tier.min ?? 0);
              const rate = Number(tier.rate ?? 0) * 100;
              return (
                <li key={index}>
                  <div className="flex items-center justify-between text-[0.82rem]">
                    <span className="text-ash-300">
                      {next ? `${formatGhs(from)}+` : `${formatGhs(from)} and above`}
                    </span>
                    <span className="font-bold text-ember-300">{rate}% bonus</span>
                  </div>
                  <ProgressBar
                    value={rate}
                    max={maxPct}
                    tone="gold"
                    className="mt-1.5"
                  />
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <h3 className="text-sm font-bold text-white">Recent commission</h3>
          <ul className="mt-3 space-y-2.5">
            {(commission?.recent ?? []).slice(0, 6).map((row: any) => (
              <li key={row.id} className="flex items-start justify-between gap-3 text-[0.82rem]">
                <div className="min-w-0">
                  <p className="truncate text-ash-200">{row.description}</p>
                  <p className="text-[0.68rem] text-ash-500">{formatRelative(row.created_at)}</p>
                </div>
                <span className="shrink-0 font-semibold text-ember-300">{formatGhs(row.amount_ghs)}</span>
              </li>
            ))}
            {(commission?.recent ?? []).length === 0 ? (
              <li className="text-[0.82rem] text-ash-500">
                No commission yet. Grow your squad and every delivered sale pays you.
              </li>
            ) : null}
          </ul>
        </Card>
      </div>
    </div>
  );
}
