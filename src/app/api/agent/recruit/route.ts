import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, readJson, str } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Super Agents recruit Sub-Agents into their Squad by phone number. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "recruit", 30, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const phone = str(body.phone, "Phone number");
    const name = typeof body.full_name === "string" ? body.full_name.trim().slice(0, 80) : null;

    const result = unwrap(
      await getDb().call<any>("fn_recruit_sub_agent", {
        p_super_agent_id: session.uid,
        p_phone: phone,
        p_full_name: name,
      })
    );
    return NextResponse.json({
      ok: true,
      recruited: result.recruited,
      created: Boolean(result.created),
      already_member: Boolean(result.already_member),
      message: result.already_member
        ? "That number is already in your squad."
        : result.created
          ? `${result.recruited.phone} was added to your squad. They'll activate by signing up with that number.`
          : `${result.recruited.phone} moved into your squad.`,
    });
  } catch (error) {
    return jsonError(error, "agent/recruit");
  }
}
