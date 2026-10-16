/**
 * T-423 slice T - seeds and constants shared by the payment-number and void tests. No app imports: plain data and the fake.
 */
import { FakeTimestamp, type FakeFirestore } from '@/test-helpers/fakeFirestore';

export const STORE_ID = 'S1';
export const store = { id: STORE_ID, name: 'Shareat Test', code: 'SHT', taxType: 'VAT_INCLUSIVE', taxRatePct: 12 } as any;
export const user = { uid: 'u1', email: 'cashier@example.test', displayName: 'Cashier One' } as any;
export const paymentMethods = [
  { id: 'm-cash', name: 'Cash', type: 'cash' },
  { id: 'm-gcash', name: 'GCash', type: 'ewallet' },
] as any[];

export interface SeedOptions {
  sessionId?: string;
  tableId?: string | null;
  unitPrice?: number;
  qty?: number;
  billingRevision?: number;
  loyaltyRedemptions?: { redemptionId: string; type: 'fixed' | 'percent'; value: number }[];
  tickets?: { id: string; status: string }[];
}

/** One package line (default 2 x 299.00 VAT-inclusive 12% = 598.00 due), an occupied table, an active projection. */
export function seedSession(fs: FakeFirestore, o: SeedOptions = {}) {
  const sessionId = o.sessionId ?? 'sess1';
  const tableId = o.tableId === undefined ? 't1' : o.tableId;
  const sp = `stores/${STORE_ID}/sessions/${sessionId}`;
  fs.seed(sp, {
    status: 'active', isPaid: false, billingRevision: o.billingRevision ?? 3, sessionMode: 'package_dinein',
    tableId, tableNumber: '1', customer: { name: 'Ana' }, startedAt: FakeTimestamp.fromMillis(1_700_000_000_000),
    startedAtClientMs: 1_700_000_000_000, loyaltyRedemptions: o.loyaltyRedemptions ?? [], guestCountCashierInitial: 2,
  });
  fs.seed(`${sp}/sessionBillLines/l1`, {
    id: 'l1', type: 'package', itemId: 'pk1', itemName: 'Unli Pack', unitPrice: o.unitPrice ?? 299, qtyOrdered: o.qty ?? 2,
    discountType: null, discountValue: null, discountQty: 0, freeQty: 0, voidedQty: 0, createdAt: 1, updatedAt: 1,
  });
  fs.seed(`stores/${STORE_ID}/activeSessions/${sessionId}`, { status: 'active', customerPin: null });
  if (tableId) {
    fs.seed(`stores/${STORE_ID}/tables/${tableId}`, { status: 'occupied', currentSessionId: sessionId });
    fs.seed(`stores/${STORE_ID}/storeConfig/current/tables/${tableId}`, { status: 'occupied', currentSessionId: sessionId, customerName: 'Ana' });
  }
  for (const t of o.tickets ?? []) fs.seed(`${sp}/kitchentickets/${t.id}`, { id: t.id, status: t.status, createdAtClientMs: 1_700_000_000_500 });
  return { sessionId, sessionPath: sp };
}

export const cashPayment = (amount: number) => [{ id: 'p1', methodId: 'm-cash', amount }] as any[];

/** The receipt document a transaction or batch wrote, from the fake's commit log. */
export function writtenReceipt(fs: FakeFirestore, sessionId = 'sess1'): Record<string, any> | undefined {
  const path = `stores/${STORE_ID}/receipts/${sessionId}`;
  for (const rec of [...fs.commits].reverse()) {
    const w = rec.writes.find((x) => x.op === 'set' && x.path === path);
    if (w && w.op === 'set') return w.data as Record<string, any>;
  }
  return undefined;
}

/** Minimal in-memory localStorage (the offline deferred-effects queue still lives there until PC-5). */
export function memoryLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}
