"use client";

const QUEUE_KEY = "offline_payment_queue";

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

export function getQueue(): QueuedPayment[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addToQueue(item: Omit<QueuedPayment, "id" | "queuedAtMs" | "status">): QueuedPayment {
  const queue = getQueue();
  const newItem: QueuedPayment = {
    ...item,
    id: crypto.randomUUID(),
    queuedAtMs: Date.now(),
    status: "pending",
  };
  queue.push(newItem);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

  // Register background sync so SW can process when reconnected (PWA only)
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then(reg => {
      if ("sync" in reg) {
        (reg as any).sync.register("offline-payment-sync").catch((err: any) => {
          console.warn("[Queue] Background sync registration failed:", err);
        });
      }
    }).catch((err) => { console.warn("[Queue] SW ready failed:", err); });
  }

  return newItem;
}

export function updateQueueItem(id: string, patch: Partial<QueuedPayment>) {
  const queue = getQueue();
  const idx = queue.findIndex(q => q.id === id);
  if (idx === -1) return;
  queue[idx] = { ...queue[idx], ...patch };
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function removeFromQueue(id: string) {
  const queue = getQueue().filter(q => q.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY);
}
