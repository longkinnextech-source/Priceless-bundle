import { NextResponse } from "next/server";
import { getDb, jsonb } from "@/lib/db";
import { isConfigured } from "@/lib/env";
import { dispatchDataOrder } from "@/lib/supplier";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * BOT-IN-A-BOX — Telegram webhook for a Super Agent's own bot.
 *
 * The Super Agent pastes their bot token into their dashboard; the app
 * registers this URL with Telegram (see POST /api/agent/bot). Inbound updates
 * are attributed to that agent, priced at THEIR wholesale tier, and recorded in
 * `bot_orders` for squad volume.
 *
 * We answer Telegram with 200 immediately and only report errors in the reply
 * text, so a failure never makes Telegram retry-storm the endpoint.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Only accept updates whose path token looks like a Telegram bot token.
  if (!/^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return NextResponse.json({ ok: false, error: "INVALID_BOT_TOKEN_PATH" }, { status: 404 });
  }

  let body: any = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" });
  }

  // Optional shared-secret header Telegram sends if configured on the bot.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  }

  if (!isConfigured()) {
    return NextResponse.json({ ok: false, error: "DB_UNCONFIGURED" }, { status: 503 });
  }

  const message = body?.message ?? body?.edited_message ?? null;
  const chatId = message?.chat?.id;
  const text: string = typeof message?.text === "string" ? message.text : "";
  const fromId = message?.from?.id;

  if (!chatId) {
    return NextResponse.json({ ok: true, ignored: "no message" });
  }

  try {
    const db = getDb();

    // 1. Which Super Agent owns this bot?
    const owner = await db.call<any>("fn_resolve_bot_owner", { p_channel: "telegram", p_token: token });
    if (!owner?.ok) {
      await sendTelegram(token, chatId, "This bot is not linked to a Priceless Bundle account yet.");
      return NextResponse.json({ ok: true, ignored: "bot not linked" });
    }

    // 2. Run the command.
    const result = await db.call<any>("fn_bot_command", {
      p_super_agent_id: owner.user_id,
      p_channel: "telegram",
      p_text: text,
      p_external_user_ref: fromId ? `tg:${fromId}` : null,
    });

    if (!result) {
      await sendTelegram(token, chatId, "Something went wrong. Please try again.");
      return NextResponse.json({ ok: true, error: "NO_RESULT" });
    }

    if (result.action === "error") {
      await sendTelegram(token, chatId, result.reply ?? "That command could not be completed.");
      return NextResponse.json({ ok: true, reply: result.reply });
    }

    // 3. A vend was queued: tell the customer, hit the supplier, finalise.
    if (result.action === "vend" && result.purchase?.order) {
      await sendTelegram(token, chatId, result.pending_reply ?? "Processing your order...");

      const order = result.purchase.order;
      const supplier = await dispatchDataOrder({
        orderId: order.id,
        network: order.network,
        sizeLabel: order.size_label,
        dataMb: 0,
        recipientPhone: order.recipient_phone,
        amountGhs: Number(order.price_charged_ghs),
      });

      const finalised = await db.call<any>("fn_fulfill_order", {
        p_order_id: order.id,
        p_success: supplier.ok,
        p_supplier_reference: supplier.reference,
        p_supplier_response: jsonb({ ...supplier.raw, channel: "telegram", duration_ms: supplier.durationMs }),
        p_failure_reason: supplier.error ?? null,
      });

      const reply =
        finalised?.status === "delivered"
          ? `✅ ${order.network} ${order.size_label} delivered to ${order.recipient_phone}.\nRef: ${finalised.supplier_reference ?? order.id}\nWallet: GHS ${Number(result.purchase.wallet?.balance_ghs ?? 0).toFixed(2)}`
          : `⚠️ That delivery failed, so GHS ${Number(order.price_charged_ghs).toFixed(2)} was refunded to your wallet.\nReason: ${supplier.error ?? "supplier error"}`;

      await sendTelegram(token, chatId, reply);
      return NextResponse.json({ ok: true, action: "vend", status: finalised?.status });
    }

    await sendTelegram(token, chatId, result.reply ?? "OK");
    return NextResponse.json({ ok: true, action: result.action });
  } catch (error) {
    console.error("[bot/telegram] error", error);
    try {
      await sendTelegram(token, chatId, "Temporary problem on our side. Please try again in a moment.");
    } catch {
      /* ignore */
    }
    return NextResponse.json({ ok: true, error: "PROCESSING_ERROR" });
  }
}

/** Telegram health-check / webhook info ping. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isConfigured()) return NextResponse.json({ ok: false, error: "DB_UNCONFIGURED" }, { status: 503 });
  try {
    const owner = await getDb().call<any>("fn_resolve_bot_owner", { p_channel: "telegram", p_token: token });
    return NextResponse.json({ ok: true, linked: Boolean(owner?.ok), agent: owner?.name ?? null });
  } catch {
    return NextResponse.json({ ok: false, error: "DB_UNREACHABLE" }, { status: 503 });
  }
}

async function sendTelegram(token: string, chatId: number | string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: undefined,
      disable_web_page_preview: true,
    }),
  }).catch((error) => {
    console.error("[bot/telegram] sendMessage failed", error);
    return null;
  });

  if (response && !response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[bot/telegram] sendMessage returned ${response.status}: ${detail.slice(0, 300)}`);
  }
}
