/**
 * T-392 S1 - the v1 snapshot: a WHITELISTED, windowed, store-filtered copy of the v1 documents the figures need
 * (spec R8/R9). Whitelist, not blacklist: a field nobody listed here cannot reach the file. Pure; no I/O.
 * Documents keep v1's pesos-as-floats; centavos are produced in v1-figures.
 */
import { createHash } from 'node:crypto';
import { parseAmount } from './amount';
import { addDays, normaliseBusinessDate } from './week';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export interface SnapshotStore { id: string; name: string }
export interface ExcludedStore { id: string; name: string; reason: string }
export interface SnapshotLeg {
  id: string; storeId: string; businessDate: string; sourceType: string; sourceId: string; legKey: string;
  accountId: string; direction: string; amount: number; status: string; supplierId?: string; createdAtMs?: number;
}
export interface SnapshotExpensePayment { method: string; amount: number; accountId?: string }
export interface SnapshotExpense {
  id: string; storeId: string; dayKey: string; totalAmount: number; status: string; supplierId: string;
  expenseEntryId: string; expenseEntryGroup: string; category: string; createdAt?: number; payments: SnapshotExpensePayment[];
}
export interface SnapshotSalesDay {
  id: string; storeId: string; status: string; dineInSales: number; onlineBreakdown: Record<string, number>;
  creditSales: number; otherPaymentSales: number;
}
export interface SnapshotSupplier { id: string; name: string }
export interface SnapshotPaymentAccount { id: string; storeId: string; name: string }

export interface V1Snapshot {
  version: 1;
  from: string;
  through: string;
  window: { from: string; through: string };
  extractedAt: string;
  stores: SnapshotStore[];
  excludedStores: ExcludedStore[];
  suppliers: SnapshotSupplier[];
  paymentAccounts: SnapshotPaymentAccount[];
  journal: SnapshotLeg[];
  expenses: SnapshotExpense[];
  salesDays: SnapshotSalesDay[];
}

/** The four operating v1 stores. Anything not here or in EXCLUDED is refused, never skipped. */
const OPERATING: Record<string, string> = {
  b9DzsnPbr1BUnY88lyT4: 'SharEat Lipa',
  dZUyvX4q824JBSVDAfE9: 'SharEat Malvar',
  iGOW7q2pZbeHWV832UNh: 'SharEat Banay-Banay',
  eVYKj6wABdakk8RgEotW: 'SharEat Davao',
};
/** Named exclusions: Padre Garcia is not part of the dual run; the test stores are not trading. */
const EXCLUDED: Record<string, string> = {
  y1DMgfisuTHBF57cNL6i: 'not operating yet',
  XbkyEgZqunmj2wzhicNf: 'test store',
  TEST: 'test store',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildSnapshot(raw: Raw, opts: { from: string; through: string; extractedAt?: string }): V1Snapshot {
  const from = normaliseBusinessDate(opts.from);
  const through = normaliseBusinessDate(opts.through);
  if (!from || !through) throw new Error('buildSnapshot: from and through must be calendar dates');
  const window = { from: addDays(from, -7), through: addDays(through, 7) };

  const rosterNames = new Map<string, string>();
  const excludedStores: ExcludedStore[] = [];
  for (const s of (raw.stores ?? []) as Raw[]) {
    const id = str(s.id);
    if (id in OPERATING) rosterNames.set(id, str(s.name) || OPERATING[id]!);
    else if (id in EXCLUDED) excludedStores.push({ id, name: str(s.name), reason: EXCLUDED[id]! });
    else throw new Error(`unknown store in roster: ${id} (${str(s.name)}) - add it to the operating or excluded list`);
  }
  const classify = (storeId: unknown, docId: unknown): 'keep' | 'drop' => {
    const id = str(storeId);
    if (rosterNames.has(id)) return 'keep';
    if (id in EXCLUDED) return 'drop';
    throw new Error(`unknown store ${JSON.stringify(id)} on document ${str(docId)}`);
  };
  const inWindow = (date: string): boolean => date >= window.from && date <= window.through;
  const dateOf = (v: unknown, docId: unknown): string => {
    const d = normaliseBusinessDate(v);
    if (d === null) throw new Error(`document ${str(docId)} has no usable business date (${JSON.stringify(v)})`);
    return d;
  };

  const journal: SnapshotLeg[] = [];
  for (const j of (raw.journal ?? []) as Raw[]) {
    if (classify(j.storeId, j.id) === 'drop') continue;
    const businessDate = dateOf(j.businessDate, j.id);
    if (!inWindow(businessDate)) continue;
    const leg: SnapshotLeg = {
      id: str(j.id), storeId: str(j.storeId), businessDate, sourceType: str(j.sourceType), sourceId: str(j.sourceId),
      legKey: str(j.legKey), accountId: str(j.accountId), direction: str(j.direction), amount: parseAmount(j.amount, str(j.id), 'amount'), status: str(j.status),
    };
    if (j.supplierId) leg.supplierId = str(j.supplierId);
    if (typeof j.createdAtMs === 'number') leg.createdAtMs = j.createdAtMs;
    journal.push(leg);
  }

  const expenses: SnapshotExpense[] = [];
  for (const e of (raw.expenses ?? []) as Raw[]) {
    if (classify(e.storeId, e.id) === 'drop') continue;
    const dayKey = dateOf(e.dayKey, e.id);
    if (!inWindow(dayKey)) continue;
    const ex: SnapshotExpense = {
      id: str(e.id), storeId: str(e.storeId), dayKey, totalAmount: parseAmount(e.totalAmount, str(e.id), 'totalAmount'), status: str(e.status),
      supplierId: str(e.supplierId), expenseEntryId: str(e.expenseEntryId), expenseEntryGroup: str(e.expenseEntryGroup),
      category: str(e.category),
      payments: ((e.payments ?? []) as Raw[]).map((p) => {
        const pay: SnapshotExpensePayment = { method: str(p.method), amount: parseAmount(p.amount, str(e.id), 'payment amount') };
        if (p.accountId) pay.accountId = str(p.accountId);
        return pay;
      }),
    };
    if (typeof e.createdAt === 'number') ex.createdAt = e.createdAt;
    expenses.push(ex);
  }

  const salesDays: SnapshotSalesDay[] = [];
  for (const s of (raw.salesDays ?? []) as Raw[]) {
    if (classify(s.storeId, s.id) === 'drop') continue;
    const date = dateOf(s.id, s.id);
    if (!inWindow(date)) continue;
    const online: Record<string, number> = {};
    for (const [k, v] of Object.entries((s.onlineBreakdown ?? {}) as Record<string, unknown>)) online[k] = parseAmount(v, `salesDay ${date}`, `online ${k}`);
    salesDays.push({
      id: date, storeId: str(s.storeId), status: str(s.status), dineInSales: parseAmount(s.dineInSales, `salesDay ${date}`, 'dineInSales'), onlineBreakdown: online,
      creditSales: parseAmount(s.creditSales, `salesDay ${date}`, 'creditSales', true),
      otherPaymentSales: parseAmount(s.otherPaymentSales, `salesDay ${date}`, 'otherPaymentSales', true),
    });
  }

  const paymentAccountsAll: SnapshotPaymentAccount[] = [];
  for (const a of (raw.paymentAccounts ?? []) as Raw[]) {
    if (classify(a.storeId, a.id) === 'drop') continue;
    paymentAccountsAll.push({ id: str(a.id), storeId: str(a.storeId), name: str(a.name) });
  }
  const suppliersAll: SnapshotSupplier[] = ((raw.suppliers ?? []) as Raw[]).map((s) => ({ id: str(s.id), name: str(s.name) }));

  // Keep only the suppliers / payment accounts that an in-window document points at.
  const supplierRefs = new Set<string>();
  const accountRefs = new Set<string>();
  for (const l of journal) {
    if (l.supplierId) supplierRefs.add(l.supplierId);
    const ap = /^(?:ap|supplier_advance)__(.+)$/.exec(l.accountId);
    if (ap) supplierRefs.add(ap[1]!);
    const on = /^online__(.+)$/.exec(l.accountId);
    if (on) accountRefs.add(`${l.storeId}|${on[1]}`);
  }
  for (const e of expenses) {
    if (e.supplierId) supplierRefs.add(e.supplierId);
    for (const p of e.payments) if (p.accountId) accountRefs.add(`${e.storeId}|${p.accountId}`);
  }
  for (const d of salesDays) for (const w of Object.keys(d.onlineBreakdown)) accountRefs.add(`${d.storeId}|${w}`);
  const suppliers = suppliersAll.filter((x) => supplierRefs.has(x.id));
  const paymentAccounts = paymentAccountsAll.filter((a) => accountRefs.has(`${a.storeId}|${a.id}`));

  const snapshot: V1Snapshot = {
    version: 1,
    from,
    through,
    window,
    extractedAt: opts.extractedAt ?? new Date().toISOString(),
    stores: [...rosterNames].map(([id, name]) => ({ id, name })).sort((a, b) => cmp(a.id, b.id)),
    excludedStores: excludedStores.sort((a, b) => cmp(a.id, b.id)),
    suppliers: suppliers.sort((a, b) => cmp(a.id, b.id)),
    paymentAccounts: paymentAccounts.sort((a, b) => cmp(a.storeId + '|' + a.id, b.storeId + '|' + b.id)),
    journal: journal.sort((a, b) => cmp(a.id, b.id)),
    expenses: expenses.sort((a, b) => cmp(a.id, b.id)),
    salesDays: salesDays.sort((a, b) => cmp(a.storeId + '|' + a.id, b.storeId + '|' + b.id)),
  };
  return redactStaff(snapshot, (raw.journal ?? []) as Raw[]);
}

/**
 * staff_<kind>__<staffId> accounts name a person. Replace the staff id, wherever it appears in the snapshot (account id,
 * leg id, legKey, sourceId, ...), with a stable per-person token, so legs still count and still group by person.
 */
function redactStaff(snapshot: V1Snapshot, rawJournal: Raw[]): V1Snapshot {
  const ids = new Set<string>();
  for (const l of rawJournal) {
    const m = /^staff_[a-z_]+?__(.+)$/.exec(str(l.accountId));
    if (m) ids.add(m[1]!);
  }
  if (ids.size === 0) return snapshot;
  let text = JSON.stringify(snapshot);
  const byLength = [...ids].sort((a, b) => b.length - a.length);
  for (const id of byLength) {
    const token = createHash('sha256').update(`staff:${id}`).digest('hex').slice(0, 12);
    const needle = JSON.stringify(id).slice(1, -1);
    // A very short id would corrupt unrelated text if replaced everywhere; confine it to the account id itself.
    if (needle.length < 6) text = text.split(`__${needle}"`).join(`__${token}"`);
    else text = text.split(needle).join(token);
  }
  return JSON.parse(text) as V1Snapshot;
}
