/**
 * T-529 R2 - what the Refills tab sends. The tablet's refill is the outbox kind `refill.requested` (T-525); a phone's is the Server Action's input. Both
 * carry the same lines, and NEVER a price (a refill is a price-0 line the server writes). `newId` is the caller's: a line id only makes a resend harmless
 * ("already recorded") when the SAME request is sent with the SAME ids, so the Refills tab keeps one cart's ids until the send succeeds or the cart
 * changes, and hands them back here. Rows with a quantity of 0 are left out; an all-zero cart is refused in one sentence.
 */
import type { NewPosEvent } from '@/lib/pos-device';

/** The domain's own line limit (T-524 `checkLineShape`): a shape bound, not a setting. */
export const REFILL_QTY_MAX = 999;
export const PICK_A_MEAT = 'Pick at least one meat.';

export const stepQty = (qty: number, delta: 1 | -1): number => Math.min(REFILL_QTY_MAX, Math.max(0, qty + delta));

type Cart = readonly { itemId: string; qty: number }[];
const pick = (cart: Cart, newId: () => string) => {
  const rows = cart.filter((c) => c.qty > 0);
  if (rows.length === 0) throw new Error(PICK_A_MEAT);
  return rows.map((c) => ({ lineId: newId(), menuItemId: c.itemId, qty: c.qty }));
};

export function refillEvent(i: { personId: string; sessionId: string; cart: Cart; now: Date; newId: () => string }): NewPosEvent {
  const at = i.now.toISOString();
  return {
    kind: 'refill.requested',
    personId: i.personId,
    occurredAtDevice: at,
    payload: { sessionId: i.sessionId, lines: pick(i.cart, i.newId).map((l) => ({ ...l, addedAtDevice: at })) },
  };
}

export function refillRequestInput(i: { sessionId: string; cart: Cart; newId: () => string; now?: Date }): { sessionId: string; lines: { lineId: string; menuItemId: string; qty: number }[] } {
  return { sessionId: i.sessionId, lines: pick(i.cart, i.newId) };
}
