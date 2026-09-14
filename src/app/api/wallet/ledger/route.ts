import { NextResponse } from "next/server";
import { ApiError, jsonError } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Immutable wallet history. Every row carries the balance it produced. */
export async function GET(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const type = url.searchParams.get("type");

    const result = await getDb().call<any>("fn_ledger_list", {
      p_user_id: session.uid,
      p_limit: limit,
      p_offset: offset,
      p_type: type && type !== "all" ? type : null,
    });
    return NextResponse.json({ ok: true, entries: result?.entries ?? [], count: result?.count ?? 0 });
  } catch (error) {
    return jsonError(error, "wallet/ledger");
  }
}
