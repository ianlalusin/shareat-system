import type { OrderLine } from '@/data/types';

/** A cart is item ids and quantities only. No price ever lives on the phone. Helpers never mutate their input. */
export interface Cart {
  lines: OrderLine[];
}

export const MAX_QTY = 20;

export function emptyCart(): Cart {
  return { lines: [] };
}

export function setQty(cart: Cart, itemId: string, qty: number): Cart {
  const rest = cart.lines.filter((l) => l.itemId !== itemId);
  if (!Number.isFinite(qty) || qty <= 0) return { lines: rest };
  const next = { itemId, qty: Math.min(Math.floor(qty), MAX_QTY) };
  const at = cart.lines.findIndex((l) => l.itemId === itemId);
  if (at === -1) return { lines: [...rest, next] };
  const lines = cart.lines.slice();
  lines[at] = next;
  return { lines };
}

export function addItem(cart: Cart, itemId: string): Cart {
  const have = cart.lines.find((l) => l.itemId === itemId)?.qty ?? 0;
  return setQty(cart, itemId, have + 1);
}

export function removeItem(cart: Cart, itemId: string): Cart {
  return { lines: cart.lines.filter((l) => l.itemId !== itemId) };
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((sum, l) => sum + l.qty, 0);
}

export function toOrderLines(cart: Cart): OrderLine[] {
  return cart.lines.map((l) => ({ itemId: l.itemId, qty: l.qty }));
}
