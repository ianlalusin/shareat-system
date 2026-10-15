/**
 * T-392 S4b - v1 documents for document-level matching (spec R9). Pure; integer centavos out; no clock.
 *
 * The comparator pairs a delta with the individual documents behind it, so each v1 line is also emitted as the documents it is
 * made of, over the window [weekStart - 7, through + 7] (a document just outside the week can be the other half of a date shift).
 * Posted only: the snapshot holds no unposted v1 tender split, so PENDING_V1 never comes from here. Keys are RAW v1 keys; the
 * comparator maps them. A group that nets to zero is not emitted.
 */
import { parseAmount } from './amount';
import type { CompareDoc } from './compare';
import type { V1Snapshot } from './snapshot';
import { computeV1Figures, type V1LineKind } from './v1-figures';
import { addDays, normaliseBusinessDate } from './week';

const IN_SCOPE_SOURCES = new Set(['sale', 'expense_payment', 'ap_payment']);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Uppercase and drop every character outside A-Z0-9. An empty result means "no link". */
export function normaliseReceiptNo(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function v1Documents(snapshot: V1Snapshot, opts: { storeId: string; weekStart: string; through: string }): CompareDoc[] {
  const storeId = opts.storeId;
  const lo = addDays(opts.weekStart, -7);
  const hi = addDays(opts.through, 7);
  const inWindow = (d: string): boolean => d >= lo && d <= hi;
  const centsOf = (pesos: number): number => Math.round(pesos * 100);

  // receipt link: expense id -> 'rn:<normalised number>' (absent when there is no receipt, no number, or an empty normal form)
  const receiptNoById = new Map<string, string>();
  for (const r of snapshot.receipts ?? []) if (r.storeId === storeId) receiptNoById.set(r.id, r.receiptNo);
  const receiptOf = new Map<string, string>();
  for (const e of snapshot.expenses) {
    if (e.storeId !== storeId || !e.receiptId) continue;
    const no = receiptNoById.get(e.receiptId);
    if (no === undefined) continue;
    const norm = normaliseReceiptNo(no);
    if (norm !== '') receiptOf.set(e.id, `rn:${norm}`);
  }

  const out: CompareDoc[] = [];

  // ---- legs: cash_bank, staff_cash, ap_supplier ---------------------------------------------------------------
  const groups = new Map<string, { kind: V1LineKind; key: string; date: string; id: string; amount: number; sourceType: string; sourceId: string }>();
  for (const leg of snapshot.journal) {
    if (leg.storeId !== storeId || leg.status === 'voided' || leg.status !== 'posted') continue;
    const date = normaliseBusinessDate(leg.businessDate);
    if (date === null || !inWindow(date)) continue;
    if (!IN_SCOPE_SOURCES.has(leg.sourceType)) continue;
    const acct = leg.accountId;
    let kind: V1LineKind | null = null;
    if (acct === 'cash__staff') kind = 'staff_cash' as V1LineKind;
    else if (acct.startsWith('cash__') || acct.startsWith('online__')) kind = 'cash_bank';
    else if (acct.startsWith('ap__') || acct.startsWith('supplier_advance__')) kind = 'ap_supplier';
    if (kind === null) continue;
    const id = `v1:leg:${leg.sourceType}:${leg.sourceId}:${acct}:${date}`;
    const signed = centsOf(parseAmount(leg.amount, leg.id, 'amount')) * (leg.direction === 'in' ? 1 : -1);
    const g = groups.get(id) ?? { kind, key: acct, date, id, amount: 0, sourceType: leg.sourceType, sourceId: leg.sourceId };
    g.amount += signed;
    groups.set(id, g);
  }
  for (const g of groups.values()) {
    if (g.amount === 0) continue;
    const doc: CompareDoc = { id: g.id, kind: g.kind, key: g.key, date: g.date, amount: g.amount, state: 'posted' };
    const rc = g.kind === 'ap_supplier' && g.sourceType === 'expense_payment' ? receiptOf.get(g.sourceId) : undefined;
    if (rc !== undefined) doc.receiptId = rc;
    out.push(doc);
  }

  // ---- expenses: one doc per posted non-COGS expense ----------------------------------------------------------
  const expenses = snapshot.expenses
    .filter((e) => e.storeId === storeId && e.status === 'posted')
    .map((e) => ({ e, date: normaliseBusinessDate(e.dayKey) }))
    .filter((x): x is { e: typeof x.e; date: string } => x.date !== null && inWindow(x.date));
  const groupsByEntry = new Map<string, Set<string>>();
  for (const { e } of expenses) {
    const set = groupsByEntry.get(e.expenseEntryId) ?? new Set<string>();
    set.add(e.expenseEntryGroup);
    groupsByEntry.set(e.expenseEntryId, set);
  }
  for (const { e, date } of expenses) {
    if (e.expenseEntryGroup === 'COGS') continue;
    const amount = centsOf(parseAmount(e.totalAmount, e.id, 'totalAmount'));
    if (amount === 0) continue;
    const key = (groupsByEntry.get(e.expenseEntryId)?.size ?? 0) > 1 ? `${e.expenseEntryGroup}:${e.expenseEntryId}` : e.expenseEntryId;
    const doc: CompareDoc = { id: `v1:exp:${e.id}`, kind: 'expense_category', key, date, amount, state: 'posted' };
    const rc = receiptOf.get(e.id);
    if (rc !== undefined) doc.receiptId = rc;
    out.push(doc);
  }

  // ---- sales tender: one per (key, date) of the windowed figures ----------------------------------------------
  const figures = computeV1Figures(snapshot, { weekStart: lo, through: hi }).stores[storeId];
  for (const line of figures?.lines ?? []) {
    if (line.kind !== 'sales_tender') continue;
    for (const [date, amount] of Object.entries(line.days)) {
      if (amount === 0) continue;
      const doc: CompareDoc = { id: `v1:sd:${line.key}:${date}`, kind: 'sales_tender', key: line.key, date, amount, state: 'posted' };
      if (line.key.startsWith('channel__')) doc.channel = true;
      out.push(doc);
    }
  }

  return out.sort((a, b) => cmp(a.id, b.id));
}
