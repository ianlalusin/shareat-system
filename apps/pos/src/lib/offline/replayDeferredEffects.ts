"use client";

import {
  type QueuedPayment,
  type DeferredEffect,
  pendingEffects,
  markEffect,
  isItemComplete,
} from "@/lib/offline/payment-queue";

export interface ReplayDeps {
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  onEffectDone?: (item: QueuedPayment) => void;
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Replays the pending deferred server-effects for one offline sale. Runs each
 * pending effect once; marks it "done" on HTTP success, leaves it "pending" on
 * failure for a later retry. Never re-records the sale. Returns the updated
 * item and whether all effects are now resolved.
 */
export async function replayDeferredEffects(
  item: QueuedPayment,
  deps: ReplayDeps,
): Promise<{ item: QueuedPayment; complete: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let token: string;
  try {
    token = await deps.getToken();
  } catch {
    // Transient: can't authenticate right now — leave effects pending for retry.
    return { item, complete: isItemComplete(item) };
  }
  const { storeId, sessionId, receiptId, ctx } = item;
  let out = item;

  for (const effect of pendingEffects(item)) {
    let okResult = false;
    if (effect === "analytics") {
      okResult = await post(fetchImpl, "/api/analytics/apply-delta", token, { storeId, receiptId, op: "payment" });
    } else if (effect === "loyaltyFinalize") {
      okResult = await post(fetchImpl, "/api/loyalty/finalize", token, { storeId, sessionId, receiptId });
    } else if (effect === "loyaltyEarn") {
      okResult = await post(fetchImpl, "/api/loyalty/earn", token, { storeId, sessionId, phone: ctx.phone, amount: ctx.amount, receiptId });
    } else if (effect === "pinFinalize") {
      const reason = item.kind === "void" ? "session_voided" : "payment_closed";
      okResult = await post(fetchImpl, "/api/pins/finalize", token, { storeId, sessionId, pin: ctx.pin, reason });
      if (!okResult) {
        okResult = await post(fetchImpl, "/api/pins/disable", token, { storeId, sessionId });
      }
    } else if (effect === "loyaltyReverse") {
      const redemptionIds = ctx.redemptionIds ?? [];
      okResult = true;
      for (const redemptionId of redemptionIds) {
        const deleted = await post(fetchImpl, "/api/loyalty/redeem", token, { redemptionId, storeId, reason: "void" }, "DELETE");
        if (!deleted) {
          okResult = false;
          break;
        }
      }
    }
    if (okResult) {
      out = markEffect(out, effect, "done");
      deps.onEffectDone?.(out);
    }
    // on failure: leave the effect "pending" (unchanged) for a later retry
  }

  return { item: out, complete: isItemComplete(out) };
}
