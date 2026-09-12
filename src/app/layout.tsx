import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav, { type NavUser } from "@/components/Nav";
import Footer from "@/components/Footer";
import { ToastProvider } from "@/components/Toast";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env, isConfigured } from "@/lib/env";

export const metadata: Metadata = {
  title: {
    default: "Priceless Bundle — Instant Data at Priceless Prices",
    template: "%s · Priceless Bundle",
  },
  description:
    "Buy MTN, Telecel and AirtelTigo data bundles instantly in Ghana. Top up your Priceless Bundle wallet with MoMo, resell data as a Sub-Agent or Super Agent, and grow your squad.",
  applicationName: "Priceless Bundle",
  keywords: ["Priceless Bundle", "data bundles Ghana", "MTN data", "Telecel data", "AirtelTigo data", "VTU Ghana", "data reseller"],
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
    shortcut: "/logo.png",
  },
  openGraph: {
    title: "Priceless Bundle — Instant Data at Priceless Prices",
    description: "The fastest way to buy and resell mobile data in Ghana.",
    siteName: "Priceless Bundle",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0e0e11",
  width: "device-width",
  initialScale: 1,
};

async function loadNavUser(): Promise<NavUser> {
  if (!isConfigured()) return null;
  try {
    const session = await currentUser();
    if (!session) return null;

    // The operator session has no wallet — render the header without one.
    if (session.admin && session.uid === "admin") {
      return {
        id: "admin",
        name: "Operator",
        phone: session.phone,
        tier: session.tier,
        balance: 0,
        commission: 0,
        admin: true,
        unread: 0,
      };
    }

    const result = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
    if (!result?.ok) return null;
    const user = result.user;
    return {
      id: user.id,
      name: user.full_name ?? user.phone,
      phone: user.phone,
      tier: user.tier,
      balance: Number(user.wallet?.balance_ghs ?? 0),
      commission: Number(user.wallet?.commission_balance_ghs ?? 0),
      admin: Boolean(user.is_admin || session.admin),
      unread: Number(result.unread_notifications ?? 0),
    };
  } catch (error) {
    // A database blip must never take down the shell.
    console.error("[layout] failed to load nav user:", (error as Error).message);
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await loadNavUser();
  const configured = isConfigured();
  const warnUnconfigured = !configured && env.nodeEnv === "production";

  return (
    <html lang="en-GH">
      <body className="min-h-dvh antialiased">
        <ToastProvider>
          <Nav user={user} />
          {warnUnconfigured ? (
            <div className="bg-crimson-700/30 px-4 py-2 text-center text-[0.8rem] text-red-100">
              Database not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
            </div>
          ) : null}
          <main className="mx-auto min-h-[70dvh] w-full max-w-6xl px-4 py-8">{children}</main>
          <Footer />
        </ToastProvider>
      </body>
    </html>
  );
}
