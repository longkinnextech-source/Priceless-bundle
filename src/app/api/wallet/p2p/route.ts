import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, num, readJson, str } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Peer-to-peer wallet transfer. Both sides are ledgered in one transaction. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "p2p", 20, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const recipient = str(body.recipient ?? body.phone ?? body.recipient_phone, "Recipient");
    const amount = num(body.amount ?? body.amount_ghs, "amount");
    const note = typeof body.note === "string" ? body.note.slice(0, 180) : null;

    const result = unwrap(
      await getDb().call<any>("fn_p2p_transfer", {
        p_from_user_id: session.uid,
        p_recipient: recipient,
        p_amount: amount,
        p_note: note,
      })
    );

    const me = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
    return NextResponse.json({ ok: true, ...result, wallet: me?.user?.wallet ?? null });
  } catch (error) {
    return jsonError(error, "wallet/p2p");
  }
}
