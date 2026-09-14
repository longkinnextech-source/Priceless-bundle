import { NextResponse } from "next/server";
import { ApiError, jsonError, readJson, str } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getDb, jsonb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    await requireAdmin();
    const result = await getDb().call<any>("fn_admin_settings", {});
    return NextResponse.json({ ok: true, settings: result?.settings ?? [] });
  } catch (error) {
    return jsonError(error, "admin/settings");
  }
}

export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireAdmin();
    const body = await readJson<Record<string, unknown>>(request);
    const key = str(body.key, "Setting key");
    if (body.value === undefined) throw ApiError.badRequest("Provide a value.");

    // Settings are stored as jsonb. An operator typing "0551112222" or "500"
    // means a string/number, not raw JSON — coerce it rather than failing.
    const value = coerceSettingValue(body.value);

    await getDb().call("fn_admin_upsert_setting", {
      p_key: key,
      p_value: jsonb(value),
      p_actor: `operator:${session.phone}`,
      p_description: typeof body.description === "string" ? body.description.slice(0, 200) : null,
    });
    return NextResponse.json({ ok: true, value, message: `${key} updated.` });
  } catch (error) {
    return jsonError(error, "admin/settings");
  }
}

/** Accept real JSON, or wrap a plain scalar/string into valid jsonb. */
function coerceSettingValue(input: unknown): unknown {
  if (input === null) return null;
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "object") return input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return "";
    try {
      return JSON.parse(trimmed);
    } catch {
      return input; // e.g. "0551112222" -> plain JSON string
    }
  }
  return String(input);
}
