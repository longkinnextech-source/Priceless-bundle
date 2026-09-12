import { NextResponse } from "next/server";
import { ApiError, assertRateLimit, jsonError, readJson, str } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { getDb, jsonb } from "@/lib/db";
import { unwrap } from "@/lib/rpc";
import { dispatchDataOrder, isMockSupplier } from "@/lib/supplier";
import { isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET  /api/orders   — the signed-in user's order history
 * POST /api/orders   — buy data
 *
 * The purchase itself (price resolution, wallet debit, order creation) happens
 * inside fn_purchase_data() in ONE transaction. The supplier call happens
 * afterwards; its result is applied by fn_fulfill_order(), which refunds the
 * wallet atomically when delivery fails.
 */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const status = url.searchParams.get("status");

    const result = await getDb().call<any>("fn_list_orders", {
      p_user_id: session.uid,
      p_limit: limit,
      p_offset: offset,
      p_status: status && status !== "all" ? status : null,
    });
    return NextResponse.json({ ok: true, orders: result?.orders ?? [], count: result?.count ?? 0 });
  } catch (error) {
    return jsonError(error, "orders/list");
  }
}

export async function POST(request: Request) {
  let orderId: string | null = null;
  try {
    if (!isConfigured()) throw ApiError.server("The platform database is not configured yet.");
    const session = await requireSession();
    assertRateLimit(request, "purchase", 30, 60_000);

    const body = await readJson<Record<string, unknown>>(request);
    const planId = str(body.plan_id ?? body.planId, "Bundle");
    const recipient = str(body.recipient_phone ?? body.recipientPhone ?? body.phone, "Recipient number");
    // NOTE: any price sent by the client is ignored on purpose.

    const db = getDb();
    const purchase = unwrap(
      await db.call<any>("fn_purchase_data", {
        p_user_id: session.uid,
        p_plan_id: planId,
        p_recipient_phone: recipient,
        p_channel: "web",
      })
    );

    orderId = purchase.order.id;
    await db.call("fn_mark_order_processing", { p_order_id: orderId });

    // ---- Supplier dispatch (mock for now — see src/lib/supplier.ts TODO) ----
    const supplier = await dispatchDataOrder({
      orderId: orderId as string,
      network: purchase.order.network,
      sizeLabel: purchase.order.size_label,
      dataMb: 0,
      recipientPhone: purchase.order.recipient_phone,
      amountGhs: Number(purchase.order.price_charged_ghs),
    });

    const finalised = unwrap(
      await db.call<any>("fn_fulfill_order", {
        p_order_id: orderId,
        p_success: supplier.ok,
        p_supplier_reference: supplier.reference,
        p_supplier_response: jsonb({ ...supplier.raw, duration_ms: supplier.durationMs, mock: isMockSupplier() }),
        p_failure_reason: supplier.error ?? null,
      })
    );

    const me = await db.call<any>("fn_get_me", { p_user_id: session.uid });

    return NextResponse.json({
      ok: true,
      order: { ...purchase.order, status: finalised.status, supplier_reference: finalised.supplier_reference },
      pricing: purchase.pricing,
      outcome: finalised.status,
      refunded: finalised.status === "refunded",
      message:
        finalised.status === "delivered"
          ? `${purchase.order.network} ${purchase.order.size_label} delivered to ${purchase.order.recipient_phone}.`
          : `That order could not be delivered, so ${finalised.refunded_ghs ? `GHS ${Number(finalised.refunded_ghs).toFixed(2)} ` : ""}was refunded to your wallet.`,
      wallet: me?.user?.wallet ?? purchase.wallet,
      finalised,
    });
  } catch (error) {
    // If the supplier step blew up after the debit, never leave the buyer short.
    if (orderId) {
      try {
        const repaired = await getDb().call<any>("fn_fulfill_order", {
          p_order_id: orderId,
          p_success: false,
          p_failure_reason: "Internal error while contacting the data supplier",
        });
        if (repaired?.ok) {
          console.error(`[orders/create] auto-refunded order ${orderId} after an internal error`);
        }
      } catch (refundError) {
        console.error(`[orders/create] FAILED to auto-refund order ${orderId}:`, refundError);
      }
    }
    return jsonError(error, "orders/create");
  }
}
