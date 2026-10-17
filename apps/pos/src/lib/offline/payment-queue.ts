/**
 * Deferred-effect item shapes and the pure helpers over them. T-425 moved the QUEUE itself out of localStorage into IndexedDB
 * (`lib/outbox/effects-store.ts`); nothing in this file touches a storage API.
 */

export type DeferredEffect = "analytics" | "loyaltyFinalize" | "loyaltyEarn" | "pinFinalize" | "loyaltyReverse";
export type EffectState = "pending" | "done" | "skip";

export interface QueuedReceiptContext {
  pin?: string | null;
  phone?: string | null;
  amount: number;
  redemptionIds?: string[];
}

export interface QueuedPayment {
  id: string;
  storeId: string;
  sessionId: string;
  receiptId: string;
  queuedAtMs: number;
  status: "pending" | "syncing" | "failed";
  kind?: "payment" | "void";
  ctx: QueuedReceiptContext;
  effects: Record<DeferredEffect, EffectState>;
  errorMessage?: string;
}

const ALL_EFFECTS: DeferredEffect[] = ["analytics", "loyaltyFinalize", "loyaltyEarn", "pinFinalize", "loyaltyReverse"];

export function pendingEffects(item: QueuedPayment): DeferredEffect[] {
  return ALL_EFFECTS.filter((e) => item.effects[e] === "pending");
}

export function markEffect(item: QueuedPayment, effect: DeferredEffect, state: EffectState): QueuedPayment {
  return { ...item, effects: { ...item.effects, [effect]: state } };
}

export function isItemComplete(item: QueuedPayment): boolean {
  return pendingEffects(item).length === 0;
}
