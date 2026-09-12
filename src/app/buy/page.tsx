import type { Metadata } from "next";
import { redirect } from "next/navigation";
import BuyData from "@/components/pages/BuyData";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: "Buy Data",
  description: "Buy MTN, Telecel and AirtelTigo data bundles instantly with your Priceless Bundle wallet.",
};

export const dynamic = "force-dynamic";

export default async function BuyPage() {
  const session = await currentUser();
  if (!session) redirect("/login?next=/buy");
  if (session.admin && session.uid === "admin") redirect("/admin");

  let plans: any[] = [];
  let user: any = null;
  if (isConfigured()) {
    const db = getDb();
    const [planRes, me] = await Promise.all([
      db.call<any>("fn_list_plans", { p_user_id: session.uid }),
      db.call<any>("fn_get_me", { p_user_id: session.uid }),
    ]);
    plans = planRes?.plans ?? [];
    user = me?.user ?? null;
  }

  return (
    <BuyData
      initialPlans={plans}
      initialWallet={(user?.wallet as any) ?? { balance_ghs: 0, commission_balance_ghs: 0 }}
      tier={user?.tier ?? session.tier}
      fullName={user?.full_name ?? ""}
    />
  );
}
