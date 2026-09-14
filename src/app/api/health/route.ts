import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Deployment + database health. Used by uptime checks and the admin panel. */
export async function GET() {
  const base = {
    ok: true,
    app: "Priceless Bundle",
    by: "LongKinnex Tech and Data",
    configured: isConfigured(),
    time: new Date().toISOString(),
  };

  if (!isConfigured()) {
    return NextResponse.json({ ...base, ok: false, database: "unconfigured" }, { status: 503 });
  }

  try {
    const health = await getDb().call<any>("fn_health", {});
    return NextResponse.json({ ...base, database: "up", health });
  } catch (error) {
    return NextResponse.json(
      { ...base, ok: false, database: "down", error: (error as Error).message },
      { status: 503 }
    );
  }
}
