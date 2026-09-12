"use client";

import { useMemo, useState } from "react";
import {
  Alert, Badge, Button, Card, EmptyState, Field, SectionHeading, Spinner, Stat,
  TableWrap, Td, Th, inputClass,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiPost } from "@/lib/client";
import { formatGhs, formatRelative, tierLabel } from "@/lib/format";

type Withdrawal = {
  id: string;
  amount_ghs: number;
  fee_ghs: number;
  net_amount_ghs: number;
  mode: string;
  status: string;
  payout_method: string;
  payout_reference: string | null;
  scheduled_for: string | null;
  created_at: string;
  note: string | null;
};

type Wallet = { balance_ghs: number; commission_balance_ghs: number };

export default function WithdrawPage({
  initialWithdrawals,
  wallet,
  tier,
  config,
}: {
  initialWithdrawals: Withdrawal[];
  wallet: Wallet;
  tier: string;
  config: Record<string, any>;
}) {
  const toast = useToast();
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>(initialWithdrawals);
  const [balance, setBalance] = useState(Number(wallet.balance_ghs ?? 0));
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"instant" | "free_friday_batch">("instant");
  const [payoutNumber, setPayoutNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSuperAgent = tier === "super_agent";
  const fee = isSuperAgent ? 0 : mode === "instant" ? Number(config?.instant_withdrawal_fee_ghs ?? 1.5) : 0;
  const value = Number(amount || 0);
  const net = Math.max(value - fee, 0);

  const invalid = useMemo(() => {
    if (!value || value <= 0) return "Enter an amount to withdraw.";
    if (value < Number(config?.min_withdrawal_ghs ?? 5)) return `Minimum withdrawal is ${formatGhs(config?.min_withdrawal_ghs ?? 5)}.`;
    if (value > balance) return `You only have ${formatGhs(balance)} available.`;
    if (mode === "instant" && !isSuperAgent && value > Number(config?.max_instant_withdrawal_ghs ?? 2000)) {
      return `Instant withdrawals are capped at ${formatGhs(config?.max_instant_withdrawal_ghs ?? 2000)}. Use Free Friday for larger amounts.`;
    }
    if (fee > 0 && value <= fee) return "Amount must be larger than the payout fee.";
    return null;
  }, [value, balance, fee, mode, isSuperAgent, config]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<{ withdrawal: Withdrawal; wallet: { balance_ghs: number }; message: string }>(
        "/api/withdrawals",
        {
          amount: value,
          mode,
          payout_method: "momo",
          payout_details: payoutNumber ? { number: payoutNumber } : {},
        }
      );
      setWithdrawals([result.withdrawal, ...withdrawals]);
      setBalance(Number(result.wallet?.balance_ghs ?? balance - value));
      setAmount("");
      toast.success(
        mode === "free_friday_batch" ? "Queued for Free Friday" : "Withdrawal submitted",
        result.message
      );
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Withdrawal failed", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow={tierLabel(tier)}
        title="Withdraw"
        description="Move your wallet balance back to Mobile Money — instantly for a small fee, or free on Free Friday."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Available" value={formatGhs(balance)} tone="fire" />
        <Stat label="Your payout fee" value={isSuperAgent ? "Free" : formatGhs(fee)} tone={isSuperAgent ? "gold" : "default"} sub={isSuperAgent ? "Super Agent perk" : "Instant payouts"} />
        <Stat label="Free Friday run" value={config?.free_friday_payout_at ? formatRelative(config.free_friday_payout_at) : "Every Friday"} sub="Zero fee payouts" />
        <Stat label="Min withdrawal" value={formatGhs(config?.min_withdrawal_ghs ?? 5)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Amount (GHS)" hint={`Available ${formatGhs(balance)}`}>
              <input
                className={inputClass}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="100"
                inputMode="decimal"
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              {[50, 100, 250, 500].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmount(String(preset))}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-[0.8rem] font-semibold text-ash-300 transition hover:border-white/25"
                >
                  {formatGhs(preset, { symbol: false })}
                </button>
              ))}
            </div>

            <Field label="Payout mode">
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setMode("instant")}
                  className={`rounded-xl border px-4 py-3 text-left transition ${
                    mode === "instant" ? "border-fire-500/70 bg-fire-500/10" : "border-white/10 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">Instant payout</span>
                    <span className="text-sm font-bold text-fire-300">
                      {isSuperAgent ? "Free" : formatGhs(config?.instant_withdrawal_fee_ghs ?? 1.5)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[0.75rem] text-ash-400">
                    {isSuperAgent
                      ? "Unlimited, zero fee, processed as soon as we approve it."
                      : `Processed within the hour. Capped at ${formatGhs(config?.max_instant_withdrawal_ghs ?? 2000)}.`}
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setMode("free_friday_batch")}
                  className={`rounded-xl border px-4 py-3 text-left transition ${
                    mode === "free_friday_batch" ? "border-fire-500/70 bg-fire-500/10" : "border-white/10 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">Free Friday batch</span>
                    <span className="text-sm font-bold text-emerald-400">Free</span>
                  </div>
                  <p className="mt-0.5 text-[0.75rem] text-ash-400">
                    Queued and paid out every Friday at 18:00 GMT. No cap, no fee.
                  </p>
                </button>
              </div>
            </Field>

            <Field label="Payout MoMo number (optional)" hint="Defaults to your account number">
              <input
                className={inputClass}
                value={payoutNumber}
                onChange={(e) => setPayoutNumber(e.target.value)}
                placeholder="0244123456"
                inputMode="tel"
              />
            </Field>

            <div className="rounded-xl border border-white/8 bg-charcoal-950/60 p-3.5 text-sm">
              <div className="flex justify-between py-1">
                <span className="text-ash-400">Withdrawal</span>
                <span className="text-ash-200">{formatGhs(value)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-ash-400">Fee</span>
                <span className={fee === 0 ? "font-semibold text-emerald-400" : "text-ash-200"}>
                  {fee === 0 ? "Free" : formatGhs(fee)}
                </span>
              </div>
              <div className="mt-1 flex justify-between border-t border-white/8 pt-2">
                <span className="font-semibold text-ash-200">You receive</span>
                <span className="font-bold text-white">{formatGhs(net)}</span>
              </div>
            </div>

            {error ? <Alert tone="error">{error}</Alert> : null}

            <Button type="submit" size="lg" className="w-full" disabled={busy || Boolean(invalid)}>
              {busy ? <Spinner /> : null}
              {busy
                ? "Submitting…"
                : mode === "free_friday_batch"
                  ? `Queue ${formatGhs(value)} for Free Friday`
                  : `Withdraw ${formatGhs(net)}`}
            </Button>
          </form>
        </Card>

        <div className="space-y-5">
          <Card variant="fire">
            <Badge tone="gold">{isSuperAgent ? "Super Agent" : "Agent"}</Badge>
            <h3 className="mt-3 text-lg font-bold">How payouts work</h3>
            <ul className="mt-3 space-y-2 text-[0.83rem] text-ash-200">
              {isSuperAgent ? (
                <>
                  <li>→ Unlimited instant withdrawals at zero fee.</li>
                  <li>→ No cap on instant payout amounts.</li>
                  <li>→ Free Friday batching is still available if you prefer.</li>
                </>
              ) : (
                <>
                  <li>→ Instant payouts carry a {formatGhs(config?.instant_withdrawal_fee_ghs ?? 1.5)} fee and are capped at {formatGhs(config?.max_instant_withdrawal_ghs ?? 2000)}.</li>
                  <li>→ Free Friday batches pay out every Friday at 18:00 GMT with no fee and no cap.</li>
                  <li>→ Upgrade to Super Agent (GHS {Number(config?.super_agent_commitment_ghs ?? 500).toFixed(0)} lifetime deposits) for unlimited free instant payouts.</li>
                </>
              )}
              <li>→ Funds leave your wallet when you submit; a rejected payout is returned automatically.</li>
            </ul>
            <Button href="/agent" variant="secondary" size="sm" className="mt-4">
              View agent tiers
            </Button>
          </Card>

          <Card>
            <h3 className="mb-3 text-sm font-bold text-white">Payout history</h3>
            {withdrawals.length === 0 ? (
              <EmptyState title="No withdrawals yet" description="Your payout requests will appear here." />
            ) : (
              <TableWrap>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <Th>Amount</Th>
                      <Th>Mode</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Requested</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {withdrawals.map((row) => (
                      <tr key={row.id}>
                        <Td>
                          <span className="font-semibold text-ash-100">{formatGhs(row.amount_ghs)}</span>
                          {Number(row.fee_ghs) > 0 ? (
                            <span className="block text-[0.68rem] text-ash-500">fee {formatGhs(row.fee_ghs)}</span>
                          ) : null}
                        </Td>
                        <Td>
                          <span className="text-[0.78rem] capitalize text-ash-300">
                            {row.mode === "free_friday_batch" ? "Free Friday" : "Instant"}
                          </span>
                        </Td>
                        <Td>
                          <span
                            className={`text-[0.75rem] font-semibold ${
                              row.status === "paid"
                                ? "text-emerald-400"
                                : row.status === "rejected"
                                  ? "text-red-400"
                                  : "text-ember-400"
                            }`}
                          >
                            {row.status}
                          </span>
                        </Td>
                        <Td className="text-right text-[0.75rem] text-ash-500">{formatRelative(row.created_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
