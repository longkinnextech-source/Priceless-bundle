import { NextResponse } from "next/server";
import { getDb, jsonb } from "@/lib/db";
import { isConfigured } from "@/lib/env";
import { dispatchDataOrder } from "@/lib/supplier";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * BOT-IN-A-BOX — WhatsApp Business (Cloud API) webhook.
 *
 * Super Agents link their own WhatsApp Business endpoint in the dashboard. The
 * endpoint is routed here, where the message is attributed to the owning agent,
 * priced at their wholesale tier and rolled into their Squad's volume.
 *
 * GET  — Meta's webhook verification handshake (hub.challenge).
 * POST — inbound messages.
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const token = url.searchParams.get("hub.verify_token");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ ok: false, error: "BAD_VERIFY_REQUEST" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ ok: false, error: "MISSING_VERIFY_TOKEN" }, { status: 400 });
  if (!isConfigured()) return NextResponse.json({ ok: false, error: "DB_UNCONFIGURED" }, { status: 503 });

  try {
    const owner = await getDb().call<any>("fn_resolve_bot_owner", { p_channel: "whatsapp", p_token: token });
    if (!owner?.ok) {
      return NextResponse.json({ ok: false, error: "VERIFY_TOKEN_NOT_LINKED" }, { status: 403 });
    }
    // Meta expects the raw challenge string echoed back.
    return new NextResponse(String(challenge), { status: 200, headers: { "Content-Type": "text/plain" } });
  } catch (error) {
    console.error("[bot/whatsapp] verify failed", error);
    return NextResponse.json({ ok: false, error: "DB_UNREACHABLE" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" });
  }

  if (!isConfigured()) return NextResponse.json({ ok: false, error: "DB_UNCONFIGURED" }, { status: 503 });

  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const phoneNumberId: string | null = value?.metadata?.phone_number_id ?? null;
    const message = value?.messages?.[0];
    const text: string =
      message?.text?.body ??
      message?.button?.text ??
      message?.interactive?.list_reply?.title ??
      message?.interactive?.button_reply?.title ??
      "";
    const from: string | null = message?.from ?? null;

    // Ignore delivery-status callbacks.
    if (!message || !text) return NextResponse.json({ ok: true, ignored: "no inbound message" });

    const db = getDb();
    const owner = await db.call<any>("fn_resolve_bot_owner", {
      p_channel: "whatsapp",
      p_token: null,
      p_phone_number_id: phoneNumberId,
    });

    if (!owner?.ok) {
      console.warn(`[bot/whatsapp] no agent linked to phone_number_id=${phoneNumberId}`);
      return NextResponse.json({ ok: true, ignored: "endpoint not linked" });
    }

    const result = await db.call<any>("fn_bot_command", {
      p_super_agent_id: owner.user_id,
      p_channel: "whatsapp",
      p_text: text,
      p_external_user_ref: from ? `wa:${from}` : null,
    });

    const replyText =
      result?.action === "error"
        ? (result.reply ?? "That command could not be completed.")
        : result?.action === "vend"
          ? (result.pending_reply ?? "Processing your order...")
          : (result?.reply ?? "OK");

    await sendWhatsApp(owner.phone ?? null, phoneNumberId, from, replyText);

    // Finalise the vend asynchronously in-line (Cloud API expects a fast ack,
    // and the supplier round-trip is short and already mocked).
    if (result?.action === "vend" && result.purchase?.order) {
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
        p_supplier_response: jsonb({ ...supplier.raw, channel: "whatsapp", duration_ms: supplier.durationMs }),
        p_failure_reason: supplier.error ?? null,
      });

      const followUp =
        finalised?.status === "delivered"
          ? `✅ ${order.network} ${order.size_label} delivered to ${order.recipient_phone}. Ref: ${finalised.supplier_reference ?? order.id}`
          : `⚠️ Delivery failed — GHS ${Number(order.price_charged_ghs).toFixed(2)} was refunded to your wallet.`;

      await sendWhatsApp(owner.phone ?? null, phoneNumberId, from, followUp);
      return NextResponse.json({ ok: true, action: "vend", status: finalised?.status });
    }

    return NextResponse.json({ ok: true, action: result?.action });
  } catch (error) {
    console.error("[bot/whatsapp] error", error);
    return NextResponse.json({ ok: true, error: "PROCESSING_ERROR" });
  }
}

/**
 * Send a WhatsApp reply through the agent's own Cloud API endpoint.
 * Every failure is logged, never thrown — the webhook must always 200.
 */
async function sendWhatsApp(agentPhone: string | null, phoneNumberId: string | null, to: string | null, text: string) {
  const endpoint = process.env.WHATSAPP_CLOUD_API_URL ?? "https://graph.facebook.com/v21.0";
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !token || !to) {
    console.log(`[bot/whatsapp] reply (not sent — missing endpoint credentials): ${text.slice(0, 160)}`);
    return;
  }
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000) } }),
    });
    if (!response.ok) {
      console.error(`[bot/whatsapp] send failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
  } catch (error) {
    console.error("[bot/whatsapp] send threw", error);
  }
}
