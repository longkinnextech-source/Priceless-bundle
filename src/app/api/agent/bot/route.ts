import { NextResponse } from "next/server";
import { ApiError, jsonError, readJson } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { isConfigured } from "@/lib/env";
import { absoluteUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/** Bot-in-a-Box status for the signed-in Super Agent. */
export async function GET() {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const me = await getDb().call<any>("fn_get_me", { p_user_id: session.uid });
    if (!me?.ok) throw ApiError.unauthorized();
    const user = me.user;
    return NextResponse.json({
      ok: true,
      tier: user.tier,
      bot_enabled: user.bot_enabled,
      telegram_bot_username: user.telegram_bot_username,
      has_telegram_bot: user.has_telegram_bot,
      has_whatsapp_endpoint: user.has_whatsapp_endpoint,
      whatsapp_phone_number_id: user.whatsapp_phone_number_id,
      webhook_url_template: `${absoluteUrl("/api/bot/whatsapp")}`,
      commands: [
        { command: "balance", description: "Check the wallet balance" },
        { command: "prices", description: "Today's wholesale price list" },
        { command: "buy <network> <size> <phone>", description: "Instant vend, e.g. buy mtn 5gb 0244123456" },
        { command: "orders", description: "Last five orders" },
      ],
    });
  } catch (error) {
    return jsonError(error, "agent/bot");
  }
}

/** Link or unlink a Telegram bot token / WhatsApp Business endpoint. */
export async function POST(request: Request) {
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    const body = await readJson<Record<string, unknown>>(request);

    const channel = body.channel === "whatsapp" ? "whatsapp" : "telegram";
    const db = getDb();

    const result = unwrap(
      await db.call<any>("fn_set_bot_config", {
        p_user_id: session.uid,
        p_channel: channel,
        p_token: typeof body.token === "string" ? body.token.trim() : null,
        p_endpoint: typeof body.endpoint === "string" ? body.endpoint.trim() : null,
        p_phone_number_id: typeof body.phone_number_id === "string" ? body.phone_number_id.trim() : null,
        p_verify_token: typeof body.verify_token === "string" ? body.verify_token.trim() : null,
        p_enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      })
    );

    // For Telegram, register the webhook with Telegram itself so linking the
    // token in the dashboard is genuinely all a Super Agent has to do.
    let webhookRegistered: boolean | null = null;
    let webhookError: string | null = null;
    if (channel === "telegram" && result.linked && typeof body.token === "string") {
      const token = body.token.trim();
      const url = absoluteUrl(`/api/bot/telegram/${token}`);
      const payload: Record<string, unknown> = { url, allowed_updates: ["message"] };
      if (process.env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;

      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
        webhookRegistered = Boolean(json.ok);
        if (!json.ok) webhookError = json.description ?? `HTTP ${response.status}`;
      } catch (error) {
        webhookError = (error as Error).message;
      }
    }

    const me = await db.call<any>("fn_get_me", { p_user_id: session.uid });

    return NextResponse.json({
      ok: true,
      linked: Boolean(result.linked),
      channel,
      webhook_registered: webhookRegistered,
      webhook_error: webhookError,
      user: me?.user ?? null,
      message: result.linked
        ? channel === "telegram"
          ? webhookRegistered === false
            ? `Bot token saved, but Telegram rejected the webhook: ${webhookError}`
            : "Telegram bot linked. Send it 'help' to test it."
          : "WhatsApp endpoint linked."
        : "Bot disconnected.",
    });
  } catch (error) {
    return jsonError(error, "agent/bot");
  }
}
