import type { Metadata } from "next";
import { redirect } from "next/navigation";
import WalletPage from "@/components/pages/WalletPage";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: "Wallet",
  description: "Top up your Priceless Bundle wallet with Mobile Money and track every movement.",
};

export const dynamic = "force-dynamic";

export default async function Wallet() {
  const session = await currentUser();
  if (!session) redirect("/login?next=/wallet");
  if (session.admin && session.uid === "admin") redirect("/admin");

  let wallet = { balance_ghs: 0, commission_balance_ghs: 0, total_deposited_ghs: 0, total_spent_ghs: 0, total_withdrawn_ghs: 0 };
  let intents: any[] = [];
  let config: Record<string, any> = {};
  let tier = session.tier;

  if (isConfigured()) {
    const db = getDb();
    const [summary, configRes, me] = await Promise.all([
      db.call<any>("fn_wallet_summary", { p_user_id: session.uid }),
      db.call<any>("fn_public_config", {}),
      db.call<any>("fn_get_me", { p_user_id: session.uid }),
    ]);
    wallet = summary?.wallet ?? wallet;
    intents = summary?.active_intents ?? [];
    config = configRes ?? {};
    tier = me?.user?.tier ?? tier;
  }

  return <WalletPage initialWallet={wallet as any} initialIntents={intents} tier={tier} config={config} />;
}
