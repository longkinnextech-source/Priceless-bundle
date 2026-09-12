import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AdminPanel from "@/components/pages/AdminPanel";
import { currentUser } from "@/lib/auth";
import { absoluteUrl } from "@/lib/url";

export const metadata: Metadata = {
  title: "Admin",
  description: "Priceless Bundle operations console.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await currentUser();
  if (!session) redirect("/login?next=/admin");
  if (!session.admin) redirect("/buy");

  return <AdminPanel operator={session.phone} smsWebhookUrl={absoluteUrl("/api/webhook/sms-deposit")} />;
}
