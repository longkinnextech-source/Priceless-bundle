/**
 * Data supplier integration.
 *
 * ⚠️  THIS IS A MOCK —  ~95% success, as specified for the launch build.
 *
 * TODO(supplier): replace `dispatchDataOrder` with the real DataMartGH
 * reseller API call:
 *
 *   1. Read the vendor base URL + API key from env:
 *        DATAMARTGH_BASE_URL, DATAMARTGH_API_KEY
 *   2. POST /v1/data/purchase with
 *        { network, volume_mb, recipient, reference }
 *      and header `Authorization: Bearer <key>`.
 *   3. Map the vendor response:
 *        success  -> { ok: true,  reference: body.transactionId, raw: body }
 *        failure  -> { ok: false, error: body.message, raw: body }
 *   4. The call MUST stay server-side and MUST be idempotent on our order id
 *      (send `reference` and treat a duplicate-reference response as success).
 *   5. Never throw: return { ok:false } so fn_fulfill_order can refund.
 *
 * Everything downstream of this function (order state transitions, wallet
 * refunds, squad volume, commissions) is already wired and tested, so swapping
 * the mock out is a single-function change.
 */

import { randomUUID, randomInt } from "node:crypto";

export type SupplierOrderRequest = {
  orderId: string;
  network: "MTN" | "Telecel" | "AirtelTigo" | string;
  sizeLabel: string;
  dataMb: number;
  recipientPhone: string;
  amountGhs: number;
};

export type SupplierResult = {
  ok: boolean;
  reference: string | null;
  error?: string;
  raw: Record<string, unknown>;
  durationMs: number;
};

type MockMode = "random" | "always_succeed" | "always_fail";

function mockMode(): MockMode {
  const value = (process.env.SUPPLIER_MOCK_MODE ?? "random").toLowerCase();
  if (value === "always_succeed" || value === "always_fail") return value;
  return "random";
}

function successRate(): number {
  const parsed = Number(process.env.SUPPLIER_SUCCESS_RATE ?? "0.95");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.95;
}

const MOCK_FAILURES = [
  "Vendor temporarily out of stock for this bundle",
  "Vendor network timeout",
  "Recipient number rejected by the network operator",
  "Duplicate transaction detected by vendor",
];

/**
 * MOCK supplier call. ~95% success rate, small artificial latency, and a
 * stable vendor-shaped response so the rest of the stack is exercised exactly
 * as it will be in production.
 */
export async function dispatchDataOrder(request: SupplierOrderRequest): Promise<SupplierResult> {
  const started = Date.now();
  const mode = mockMode();

  // Simulate realistic vendor latency (150–450ms).
  await new Promise((resolve) => setTimeout(resolve, randomInt(150, 450)));

  let ok: boolean;
  switch (mode) {
    case "always_succeed":
      ok = true;
      break;
    case "always_fail":
      ok = false;
      break;
    default:
      ok = randomInt(0, 10_000) / 10_000 < successRate();
  }

  const durationMs = Date.now() - started;

  if (!ok) {
    const error = MOCK_FAILURES[randomInt(0, MOCK_FAILURES.length)]!;
    return {
      ok: false,
      reference: null,
      error,
      durationMs,
      raw: {
        mock: true,
        vendor: "mock_datamartgh",
        status: "failed",
        message: error,
        request: { ...request, amountGhs: request.amountGhs },
      },
    };
  }

  return {
    ok: true,
    reference: `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`,
    durationMs,
    raw: {
      mock: true,
      vendor: "mock_datamartgh",
      status: "success",
      transactionId: `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`,
      message: "Bundle delivered (mock supplier)",
      durationMs,
      request: { ...request, amountGhs: request.amountGhs },
    },
  };
}

/** True when we are still on the mock vendor (surfaced in the admin panel). */
export function isMockSupplier(): boolean {
  return !process.env.DATAMARTGH_API_KEY;
}
