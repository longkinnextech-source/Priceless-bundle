import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AgentDashboard from "@/components/pages/AgentDashboard";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: "Agent Dashboard",
  description: "Manage your Priceless Bundle agent tier, squad volume, recruits and bots.",
};

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const session = await currentUser();
  if (!session) redirect("/login?next=/agent");

  const empty = {
    user: null,
    eligibility: null,
    squad: null,
    commission: null,
    recruits: null,
    recent_orders: [],
    config: {},
  };

  if (!isConfigured()) return <AgentDashboard initial={empty as any} />;

  // Load first, render second: JSX built inside a try/catch is not protected by
  // it (React renders it later), so keep the data fetch in its own step.
  let loaded = empty;
  try {
    const db = getDb();
    const [me, eligibility, squad, commission, recruits, config, orders] = await Promise.all([
      db.call<any>("fn_get_me", { p_user_id: session.uid }),
      db.call<any>("fn_upgrade_eligibility", { p_user_id: session.uid }),
      db.call<any>("fn_squad_dashboard", { p_user_id: session.uid }),
      db.call<any>("fn_commission_summary", { p_user_id: session.uid }),
      db.call<any>("fn_list_recruits", { p_super_agent_id: session.uid }),
      db.call<any>("fn_public_config", {}),
      db.call<any>("fn_list_orders", { p_user_id: session.uid, p_limit: 10 }),
    ]);

    loaded = {
      user: me?.user ?? null,
      eligibility: eligibility ?? null,
      squad: squad ?? null,
      commission: commission ?? null,
      recruits: recruits ?? null,
      recent_orders: orders?.orders ?? [],
      config: config ?? {},
    };
  } catch (error) {
    console.error("[agent page] failed to load:", (error as Error).message);
  }

  return <AgentDashboard initial={loaded as any} />;
}
