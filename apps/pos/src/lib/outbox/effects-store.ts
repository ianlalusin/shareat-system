/**
 * T-425 S2 - deferred server effects (analytics, loyalty, PIN) in IndexedDB (Ruling 3), store `effects` of the shared tablet database.
 * Item shape = `QueuedPayment` of lib/offline/payment-queue.ts, unchanged. This replaces the localStorage `offline_payment_queue`, whose
 * parse error returned [] and let the next write erase the whole queue.
 *
 * The ONE use of the old localStorage key is `migrateLegacyQueue`: on first start a valid queue is copied in ONE IndexedDB transaction and
 * only AFTER that transaction completed is the key removed; a value that does not parse as an array is kept under `.corrupt` and reported,
 * never dropped.
 *
 * A receipt's effects run only after that receipt's ledger row is `acknowledged` (`listRunnableEffectItems`), so apply-delta never runs
 * before the receipt exists on the server.
 */
import { listEvents, type LedgerEvent } from '@/lib/outbox/ledger';
import { STORE_EFFECTS, inTerminalTransaction } from '@/lib/terminal/db';
import type { QueuedPayment } from '@/lib/offline/payment-queue';

export const LEGACY_QUEUE_KEY = 'offline_payment_queue';
export const CORRUPT_QUEUE_KEY = 'offline_payment_queue.corrupt';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export async function migrateLegacyQueue(storage?: KeyValueStorage): Promise<{ moved: number; corrupt: boolean }> {
  const ls: KeyValueStorage | undefined = storage ?? (globalThis as { localStorage?: KeyValueStorage }).localStorage;
  if (!ls) return { moved: 0, corrupt: false };
  const raw = ls.getItem(LEGACY_QUEUE_KEY);
  if (raw === null || raw === '') return { moved: 0, corrupt: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    // Never drop it: keep the bytes (under a fresh key if an older corrupt copy is already there), then clear the live key.
    const key = ls.getItem(CORRUPT_QUEUE_KEY) === null ? CORRUPT_QUEUE_KEY : `${CORRUPT_QUEUE_KEY}.${Date.now()}`;
    ls.setItem(key, raw);
    ls.removeItem(LEGACY_QUEUE_KEY);
    return { moved: 0, corrupt: true };
  }
  if (parsed.length === 0) {
    ls.removeItem(LEGACY_QUEUE_KEY);
    return { moved: 0, corrupt: false };
  }

  const items = (parsed as Partial<QueuedPayment>[]).map((x) => (x && typeof x === 'object' && typeof x.id === 'string' && x.id ? x : { ...x, id: crypto.randomUUID() })) as QueuedPayment[];
  await inTerminalTransaction<void>(STORE_EFFECTS, 'readwrite', (tx, done) => {
    const store = tx.objectStore(STORE_EFFECTS);
    for (const item of items) store.put(item);
    done(undefined);
  });
  ls.removeItem(LEGACY_QUEUE_KEY); // only after the copy COMPLETED
  return { moved: items.length, corrupt: false };
}

function readAll(): Promise<QueuedPayment[]> {
  return inTerminalTransaction<QueuedPayment[]>(STORE_EFFECTS, 'readonly', (tx, done, fail) => {
    const req = tx.objectStore(STORE_EFFECTS).getAll();
    req.onsuccess = () => done((req.result as QueuedPayment[]) ?? []);
    req.onerror = () => fail(req.error ?? new Error('Could not read the deferred effects.'));
  });
}

export async function listEffectItems(): Promise<QueuedPayment[]> {
  return (await readAll()).sort((a, b) => a.queuedAtMs - b.queuedAtMs);
}

export async function addEffectItem(item: Omit<QueuedPayment, 'id' | 'queuedAtMs' | 'status'>): Promise<QueuedPayment> {
  const row: QueuedPayment = { ...item, id: crypto.randomUUID(), queuedAtMs: Date.now(), status: 'pending' };
  await inTerminalTransaction<void>(STORE_EFFECTS, 'readwrite', (tx, done) => {
    tx.objectStore(STORE_EFFECTS).put(row);
    done(undefined);
  });
  return row;
}

/** Read-modify-write of one item in one transaction; a missing item is left missing. */
function change(id: string, fn: (cur: QueuedPayment) => QueuedPayment): Promise<void> {
  return inTerminalTransaction<void>(STORE_EFFECTS, 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore(STORE_EFFECTS);
    const req = store.get(id);
    req.onerror = () => fail(req.error ?? new Error('Could not read the deferred effects.'));
    req.onsuccess = () => {
      const cur = req.result as QueuedPayment | undefined;
      if (cur) store.put(fn(cur));
      done(undefined);
    };
  });
}

export function updateEffectItem(id: string, patch: Partial<QueuedPayment>): Promise<void> {
  return change(id, (cur) => ({ ...cur, ...patch, id: cur.id }));
}

export function removeEffectItem(id: string): Promise<void> {
  return inTerminalTransaction<void>(STORE_EFFECTS, 'readwrite', (tx, done) => {
    tx.objectStore(STORE_EFFECTS).delete(id);
    done(undefined);
  });
}

/**
 * `pending` items whose receipt is on the server. A sale item waits for its `sale` ledger row, a void item for its `void` row; skipped rows
 * do not count (a failed online attempt explains a number, it is not the sale). An item with NO ledger row (legacy, migrated, online void)
 * is runnable.
 */
export async function listRunnableEffectItems(): Promise<QueuedPayment[]> {
  const [items, events] = await Promise.all([listEffectItems(), listEvents()]);
  const rowsFor = (item: QueuedPayment): LedgerEvent[] =>
    events.filter((e) => e.receiptId === item.receiptId && e.kind === (item.kind === 'void' ? 'void' : 'sale') && e.status !== 'skipped');
  return items.filter((item) => {
    if (item.status !== 'pending') return false;
    const rows = rowsFor(item);
    return rows.length === 0 || rows.some((r) => r.status === 'acknowledged');
  });
}

/** The manager list: effects that threw (a terminal conflict) and still need a person. */
export async function listFailedEffectItems(): Promise<QueuedPayment[]> {
  return (await listEffectItems()).filter((i) => i.status === 'failed');
}

export function retryFailedEffectItem(id: string): Promise<void> {
  return change(id, (cur) => {
    if (cur.status !== 'failed') return cur;
    const { errorMessage: _drop, ...rest } = cur;
    return { ...rest, status: 'pending' };
  });
}
