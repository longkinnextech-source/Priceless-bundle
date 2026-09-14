import type { Metadata } from "next";
import { redirect } from "next/navigation";
import WithdrawPage from "@/components/pages/WithdrawPage";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: "Withdraw",
  description: "Withdraw your Priceless Bundle wallet balance to Mobile Money — instantly or free on Fridays.",
};

export const dynamic = "force-dynamic";

export default async function Withdraw() {
  const session = await currentUser();
  if (!session) redirect("/login?next=/withdraw");
  if (session.admin && session.uid === "admin") redirect("/admin");

  let withdrawals: any[] = [];
  let wallet = { balance_ghs: 0, commission_balance_ghs: 0 };
  let config: Record<string, any> = {};
  let tier = session.tier;

  if (isConfigured()) {
    const db = getDb();
    const [rows, summary, configRes, me] = await Promise.all([
      db.call<any>("fn_list_withdrawals", { p_user_id: session.uid, p_limit: 50 }),
      db.call<any>("fn_wallet_summary", { p_user_id: session.uid }),
      db.call<any>("fn_public_config", {}),
      db.call<any>("fn_get_me", { p_user_id: session.uid }),
    ]);
    withdrawals = rows?.withdrawals ?? [];
    wallet = summary?.wallet ?? wallet;
    config = { ...(configRes ?? {}), free_friday_payout_at: null };
    tier = me?.user?.tier ?? tier;
  }

  return <WithdrawPage initialWithdrawals={withdrawals} wallet={wallet as any} tier={tier} config={config} />;
}
