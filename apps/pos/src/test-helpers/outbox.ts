/**
 * T-425 slice T - shared data builders for the ledger / reconcile / soak tests. Plain data only; no app imports except TYPES-free helpers.
 * `saleOps(...)` builds the COMPLETE write list of one offline sale as ledger `ops` (Ruling 1): payments with FIXED ids, kitchen ticket
 * served, session close, closed/active projection copies, the receipt, receiptNumbers, table free (+ projection), with server-timestamp
 * markers `{"__serverTimestamp__": true}`.
 */
import { FakeTimestamp, type FakeFirestore } from '@/test-helpers/fakeFirestore';

export const TS = { __serverTimestamp__: true } as const;
export const STORE = 'S1';

export interface SaleSpec {
  sessionId: string;
  tableId?: string | null;
  receiptNumber: string;
  terminalNo?: number;
  terminalSeq: number;
  deviceId?: string;
  totalPesos?: number;
  lines?: any[];
  tickets?: string[];
  tenders?: { method: string; pesos: number; reference?: string }[];
}

export const LINES = [{ id: 'l1', type: 'package', itemName: 'Unli Pack', unitPrice: 299, qtyOrdered: 2 }];

export function saleOps(o: SaleSpec): any[] {
  const sid = o.sessionId;
  const total = o.totalPesos ?? 598;
  const tableId = o.tableId === undefined ? `t-${sid}` : o.tableId;
  const tenders = o.tenders ?? [{ method: 'Cash', pesos: total }];
  const ops: any[] = [];
  tenders.forEach((t, i) =>
    ops.push({ op: 'set', path: `stores/${STORE}/sessions/${sid}/payments/${sid}-p${i}`, data: { id: `${sid}-p${i}`, methodId: t.method, amount: t.pesos, createdAt: TS } }));
  for (const t of o.tickets ?? []) {
    ops.push({ op: 'update', path: `stores/${STORE}/sessions/${sid}/kitchentickets/${t}`, data: { status: 'served', servedAt: TS, updatedAt: TS } });
  }
  ops.push({ op: 'update', path: `stores/${STORE}/sessions/${sid}`, data: { status: 'closed', isPaid: true, closedAt: TS, updatedAt: TS, revision: 4 } });
  ops.push({ op: 'set', path: `stores/${STORE}/closedSessions/${sid}`, data: { status: 'closed', customerAccessEnabled: false, closedAt: TS } });
  ops.push({ op: 'delete', path: `stores/${STORE}/activeSessions/${sid}` });
  ops.push({
    op: 'set', path: `stores/${STORE}/receipts/${sid}`,
    data: {
      id: sid, storeId: STORE, sessionId: sid, receiptId: sid, total, totalPaid: total, status: 'final', receiptNumber: o.receiptNumber,
      terminalNo: o.terminalNo ?? 1, terminalSeq: o.terminalSeq, deviceId: o.deviceId ?? 'DEV-A', offlineOrigin: true,
      lines: o.lines ?? LINES, analyticsApplied: false, createdAt: TS,
    },
  });
  ops.push({ op: 'set', path: `stores/${STORE}/receiptNumbers/${o.receiptNumber}`, data: { receiptId: sid, terminalNo: o.terminalNo ?? 1, terminalSeq: o.terminalSeq, createdAt: TS } });
  if (tableId) {
    ops.push({ op: 'update', path: `stores/${STORE}/tables/${tableId}`, data: { status: 'available', currentSessionId: null, updatedAt: TS } });
    ops.push({ op: 'update', path: `stores/${STORE}/storeConfig/current/tables/${tableId}`, data: { status: 'available', currentSessionId: null, customerName: null, updatedAt: TS } });
  }
  return ops;
}

/** A voided-session ops list (the void batch, incl. deleteField / arrayRemove markers on a kitchen station doc). */
export function voidOps(o: { sessionId: string; tableId?: string | null; ticketId?: string; stationId?: string }): any[] {
  const sid = o.sessionId;
  const tableId = o.tableId === undefined ? `t-${sid}` : o.tableId;
  const ops: any[] = [];
  if (o.ticketId && o.stationId) {
    ops.push({ op: 'update', path: `stores/${STORE}/sessions/${sid}/kitchentickets/${o.ticketId}`, data: { status: 'cancelled', cancelledAt: TS, updatedAt: TS } });
    ops.push({
      op: 'update', path: `stores/${STORE}/rtKdsTickets/${o.stationId}`,
      data: { [`tickets.${o.ticketId}`]: { __deleteField__: true }, activeIds: { __arrayRemove__: [o.ticketId] }, 'meta.updatedAt': TS },
    });
  }
  ops.push({ op: 'update', path: `stores/${STORE}/sessions/${sid}`, data: { status: 'voided', voidedAt: TS, voidedOffline: true, offlineOrigin: true, updatedAt: TS } });
  ops.push({ op: 'delete', path: `stores/${STORE}/activeSessions/${sid}` });
  if (tableId) ops.push({ op: 'update', path: `stores/${STORE}/tables/${tableId}`, data: { status: 'available', currentSessionId: null, updatedAt: TS } });
  return ops;
}

/** Seeds the server-side state a sale of `sessionId` starts from (open session, active projection, occupied table, optional tickets). */
export function seedServerSession(fs: FakeFirestore, sessionId: string, o: { tableId?: string | null; tickets?: string[]; status?: string } = {}) {
  const tableId = o.tableId === undefined ? `t-${sessionId}` : o.tableId;
  fs.seed(`stores/${STORE}/sessions/${sessionId}`, { status: o.status ?? 'active', isPaid: false, tableId, billingRevision: 3, revision: 3, startedAt: FakeTimestamp.fromMillis(1_700_000_000_000) });
  fs.seed(`stores/${STORE}/activeSessions/${sessionId}`, { status: 'active' });
  if (tableId) {
    fs.seed(`stores/${STORE}/tables/${tableId}`, { status: 'occupied', currentSessionId: sessionId });
    fs.seed(`stores/${STORE}/storeConfig/current/tables/${tableId}`, { status: 'occupied', currentSessionId: sessionId, customerName: 'Ana' });
  }
  for (const t of o.tickets ?? []) fs.seed(`stores/${STORE}/sessions/${sessionId}/kitchentickets/${t}`, { id: t, status: 'preparing' });
}

/** Lets pending timers/microtasks (fake IndexedDB commits, fake Firestore flushes) run. */
export const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A Web Locks stand-in: `request(name, {ifAvailable:true}, cb)` runs cb(lock) once, or cb(null) when `name` is held. */
export function fakeLocks() {
  const held = new Set<string>();
  return {
    held,
    request: async (name: string, _opts: { ifAvailable: boolean }, cb: (lock: unknown | null) => Promise<unknown>) => {
      if (held.has(name)) return cb(null);
      held.add(name);
      try { return await cb({ name }); } finally { held.delete(name); }
    },
  };
}
