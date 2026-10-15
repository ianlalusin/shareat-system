/**
 * T-392 S1 - v1 figures for one store-week, from a V1Snapshot (spec R1-R5). Pure; integer centavos out.
 *
 * Rules that matter (each is pinned by packages/etl/tests/t392-s1-v1-figures.test.ts):
 *  - A figure is placed by the leg's businessDate / the document's dayKey (Manila date strings). No timestamp is read.
 *  - Voided and any non-posted row contributes nothing. A store-week with no tie-set figure has lines === [].
 *  - cash_bank = sale, expense_payment, ap_payment legs on cash__ / online__ accounts; ap_supplier = the same
 *    sourceTypes on ap__ / supplier_advance__. Every other posted leg is named in `scope`; nothing is dropped.
 *  - cashResidual = remitted(salesDay.dineInSales) - online - credit - other, UNFLOORED, per trading day. A counted day
 *    whose dineInSales is 0 while its posted sale legs are not gets no residual and a V1_REMITTED_FIELD_ZERO flag.
 */
import { inferLegacyAccountNature } from '../../../domain/src/ledger/legacy-adapter';
import { parseAmount } from './amount';
import { addDays, normaliseBusinessDate } from './week';
import type { V1Snapshot } from './snapshot';
import type { KeyRow } from './keys';

export type V1LineKind = 'cash_bank' | 'sales_tender' | 'expense_category' | 'inventory_basis' | 'ap_supplier';

export interface V1Line {
  kind: V1LineKind;
  key: string;
  amount: number;
  days: Record<string, number>;
  group?: string | null;
  class?: 'V1_UNKNOWN_EXPENSE_GROUP';
  supplierId?: string;
  in?: number;
  out?: number;
  debit?: number;
  credit?: number;
  legs?: number;
}
export interface ScopeEntry {
  class: 'NOT_IN_DUAL_RUN_SCOPE' | 'PAYROLL_ON_V1';
  sourceType: string;
  legs: number;
  in: number;
  out: number;
}
export interface V1Warning { code: 'SUB_CENTAVO'; docId: string; value: number }
export type V1Flag = { code: 'V1_REMITTED_FIELD_ZERO'; date: string } | { code: 'V1_EXPENSE_ENTRY_GROUP_CONFLICT'; entryId: string };
export interface V1StoreFigures {
  storeId: string;
  name: string;
  v2Key?: string;
  hasData: boolean;
  tradingDays: string[];
  lines: V1Line[];
  scope: ScopeEntry[];
  posted: { legs: number; in: number; out: number };
  cashResidual: Record<string, number>;
  warnings: V1Warning[];
  flags: V1Flag[];
  voided: { legs: number; expenses: number; salesDays: number };
}
export interface V1Figures {
  weekStart: string;
  through: string;
  excluded: { id: string; name: string; reason: string }[];
  stores: Record<string, V1StoreFigures>;
}

/** salesDay statuses that count as a trading day (R4): submitted and voided do not. */
const COUNTED_STATUSES = new Set(['verified', 'remitted', 'partially_remitted']);
const IN_SCOPE_SOURCES = new Set(['sale', 'expense_payment', 'ap_payment']);
const TIE_EXPENSE_GROUPS = new Set(['OPEX', 'CAPEX', 'PERSONAL', 'OTHERS']);
const LEG_STATUSES = new Set(['posted', 'voided']);
const EXPENSE_STATUSES = new Set(['posted', 'voided']);
const SALESDAY_STATUSES = new Set(['open', 'submitted', 'verified', 'partially_remitted', 'remitted', 'voided']);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Acc { in: number; out: number; legs: number; days: Record<string, number> }

export function computeV1Figures(snapshot: V1Snapshot, opts: { weekStart: string; through?: string; keys?: KeyRow[] }): V1Figures {
  const weekStart = normaliseBusinessDate(opts.weekStart);
  if (!weekStart) throw new Error(`computeV1Figures: weekStart is not a date: ${opts.weekStart}`);
  const through = normaliseBusinessDate(opts.through ?? addDays(weekStart, 6));
  if (!through) throw new Error(`computeV1Figures: through is not a date: ${opts.through}`);
  const inRange = (d: string): boolean => d >= weekStart && d <= through;

  // With a keys sheet the roster is exactly its ticked store rows; without one, the snapshot's own stores.
  const v2Keys = new Map<string, string>();
  if (opts.keys) {
    const excludedIds = new Set(snapshot.excludedStores.map((e) => e.id));
    const heldIds = new Set(snapshot.stores.map((s) => s.id));
    const ticked = opts.keys.filter((r) => r.section === 'store' && r.ticked);
    for (const r of ticked) {
      if (excludedIds.has(r.v1Key)) throw new Error(`keys sheet ticks excluded store ${r.v1Key} (${r.v1Label}); excluded stores never enter the dual run`);
      if (!heldIds.has(r.v1Key)) throw new Error(`keys sheet ticks unknown store ${r.v1Key} (${r.v1Label}) that the snapshot does not hold`);
      if (r.v2Key.trim() !== '') v2Keys.set(r.v1Key, r.v2Key.trim());
    }
    const missing = snapshot.stores.filter((s) => !v2Keys.has(s.id)).map((s) => `${s.id} (${s.name})`);
    if (missing.length > 0) throw new Error(`keys sheet: snapshot stores without a ticked store row and v2 key - ${missing.join('; ')}`);
  }
  const stores: Record<string, V1StoreFigures> = {};
  for (const store of snapshot.stores) {
    const figures = figuresForStore(snapshot, store.id, store.name, inRange);
    const v2Key = v2Keys.get(store.id);
    stores[store.id] = v2Key === undefined ? figures : { ...figures, v2Key };
  }
  return {
    weekStart,
    through,
    excluded: snapshot.excludedStores.map((e) => ({ id: e.id, name: e.name, reason: e.reason })),
    stores,
  };
}

function figuresForStore(snapshot: V1Snapshot, storeId: string, name: string, inRange: (d: string) => boolean): V1StoreFigures {
  const warnings = new Map<string, V1Warning>();
  const cents = (pesos: number, docId: string): number => {
    const scaled = pesos * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6 && !warnings.has(`${docId}|${pesos}`)) {
      warnings.set(`${docId}|${pesos}`, { code: 'SUB_CENTAVO', docId, value: pesos });
    }
    return rounded;
  };
  const addDay = (days: Record<string, number>, date: string, v: number): void => {
    days[date] = (days[date] ?? 0) + v;
  };

  // ---- legs ---------------------------------------------------------------------------------------------------
  const voided = { legs: 0, expenses: 0, salesDays: 0 };
  const legs = snapshot.journal
    .filter((l) => l.storeId === storeId)
    .map((l) => ({ leg: l, date: normaliseBusinessDate(l.businessDate) }))
    .filter((x): x is { leg: typeof x.leg; date: string } => x.date !== null && inRange(x.date))
    .filter(({ leg }) => {
      if (!LEG_STATUSES.has(leg.status)) throw new Error(`leg ${leg.id}: unknown status ${JSON.stringify(leg.status)}`);
      if (leg.direction !== 'in' && leg.direction !== 'out') throw new Error(`leg ${leg.id}: unknown direction ${JSON.stringify(leg.direction)}`);
      if (leg.status === 'voided') { voided.legs += 1; return false; }
      return true;
    })
    .sort((a, b) => cmp(a.leg.id, b.leg.id));

  const posted = { legs: 0, in: 0, out: 0 };
  const cashBank = new Map<string, Acc>();
  const ap = new Map<string, Acc & { account: string; supplierId: string }>();
  const channelAr = new Map<string, Acc>();
  const scope = new Map<string, ScopeEntry>();
  const saleLegCash: Record<string, number> = {};
  const saleLegTotal: Record<string, number> = {};

  for (const { leg, date } of legs) {
    const amt = cents(parseAmount(leg.amount, leg.id, 'amount'), leg.id);
    const isIn = leg.direction === 'in';
    posted.legs += 1;
    if (isIn) posted.in += amt;
    else posted.out += amt;

    // S1b: a channel receivable CHARGE leg is sourceType 'sale' on ar__channel_<C> with legKey 'ar:channel_<C>'. The legKey is
    // the discriminator: settlement (ar_clear) and manual credit (ar:<customerId>) legs on the same prefix stay in scope.
    const chMatch = leg.sourceType === 'sale' ? /^ar__channel_(.+)$/.exec(leg.accountId) : null;
    if (chMatch && leg.legKey === `ar:channel_${chMatch[1]}`) {
      const key = `channel__${chMatch[1]}`;
      const acc = channelAr.get(key) ?? { in: 0, out: 0, legs: 0, days: {} };
      acc.legs += 1;
      if (isIn) acc.in += amt;
      else acc.out += amt;
      addDay(acc.days, date, isIn ? amt : -amt);
      channelAr.set(key, acc);
      continue;
    }
    if (leg.sourceType === 'sale') saleLegTotal[date] = (saleLegTotal[date] ?? 0) + amt;

    const acct = leg.accountId;
    const inScopeSource = IN_SCOPE_SOURCES.has(leg.sourceType);
    const isCashBank = acct.startsWith('cash__') || acct.startsWith('online__');
    const isAp = acct.startsWith('ap__') || acct.startsWith('supplier_advance__');
    if (inScopeSource && isCashBank) {
      const acc = cashBank.get(acct) ?? { in: 0, out: 0, legs: 0, days: {} };
      acc.legs += 1;
      if (isIn) acc.in += amt;
      else acc.out += amt;
      addDay(acc.days, date, isIn ? amt : -amt);
      cashBank.set(acct, acc);
      if (leg.sourceType === 'sale' && acct === 'cash__cashier') saleLegCash[date] = (saleLegCash[date] ?? 0) + (isIn ? amt : -amt);
    } else if (inScopeSource && isAp) {
      const acc = ap.get(acct) ?? { in: 0, out: 0, legs: 0, days: {}, account: acct, supplierId: acct.slice(acct.indexOf('__') + 2) };
      acc.legs += 1;
      if (isIn) acc.in += amt;
      else acc.out += amt;
      ap.set(acct, acc);
    } else {
      const cls = leg.sourceType.startsWith('payroll') ? 'PAYROLL_ON_V1' : 'NOT_IN_DUAL_RUN_SCOPE';
      const k = `${cls}|${leg.sourceType}`;
      const entry = scope.get(k) ?? { class: cls, sourceType: leg.sourceType, legs: 0, in: 0, out: 0 };
      entry.legs += 1;
      if (isIn) entry.in += amt;
      else entry.out += amt;
      scope.set(k, entry);
    }
  }

  // Polarity from the account (adapter table): cash/online/advance in = debit; ap in = credit.
  const debitOf = (acct: string, acc: Acc): { debit: number; credit: number } =>
    inferLegacyAccountNature(acct) === 'debit' ? { debit: acc.in, credit: acc.out } : { debit: acc.out, credit: acc.in };

  const lines: V1Line[] = [];
  for (const [acct, acc] of cashBank) {
    lines.push({ kind: 'cash_bank', key: acct, amount: acc.in - acc.out, days: acc.days, in: acc.in, out: acc.out, legs: acc.legs, ...debitOf(acct, acc) });
  }
  // ap legs: day placement is recorded on the leg's businessDate too.
  for (const { leg, date } of legs) {
    const acc = ap.get(leg.accountId);
    if (!acc || !IN_SCOPE_SOURCES.has(leg.sourceType)) continue;
    const signed = (leg.direction === 'in' ? 1 : -1) * Math.round(parseAmount(leg.amount, leg.id, 'amount') * 100);
    addDay(acc.days, date, signed);
  }
  for (const [acct, acc] of ap) {
    const pol = debitOf(acct, acc);
    const isAdvance = acct.startsWith('supplier_advance__');
    lines.push({
      kind: 'ap_supplier', key: acct, supplierId: acc.supplierId, in: acc.in, out: acc.out, legs: acc.legs, ...pol,
      amount: isAdvance ? pol.debit - pol.credit : acc.in - acc.out, days: acc.days,
    });
  }

  // ---- sales days --------------------------------------------------------------------------------------------
  const counted = snapshot.salesDays
    .filter((d) => d.storeId === storeId)
    .map((d) => ({ doc: d, date: normaliseBusinessDate(d.id) }))
    .filter((x): x is { doc: typeof x.doc; date: string } => x.date !== null && inRange(x.date))
    .filter(({ doc, date }) => {
      if (!SALESDAY_STATUSES.has(doc.status)) throw new Error(`salesDay ${date}: unknown status ${JSON.stringify(doc.status)}`);
      if (doc.status === 'voided') { voided.salesDays += 1; return false; }
      return COUNTED_STATUSES.has(doc.status);
    })
    .sort((a, b) => cmp(a.date, b.date));

  const tradingDays = counted.map((x) => x.date);
  const cashResidual: Record<string, number> = {};
  const flags: V1Flag[] = [];
  const tenders = new Map<string, Record<string, number>>();
  const tender = (key: string, date: string, v: number): void => {
    if (v === 0) return;
    const days = tenders.get(key) ?? {};
    addDay(days, date, v);
    tenders.set(key, days);
  };

  for (const { doc, date } of counted) {
    const docId = `salesDay:${date}`;
    const remitted = cents(parseAmount(doc.dineInSales, docId, 'dineInSales'), docId);
    let online = 0;
    for (const [wallet, pesos] of Object.entries(doc.onlineBreakdown ?? {})) {
      const v = cents(parseAmount(pesos, docId, `online ${wallet}`), docId);
      online += v;
      tender(`online__${wallet}`, date, v);
    }
    const credit = cents(parseAmount(doc.creditSales, docId, 'creditSales', true), docId);
    const other = cents(parseAmount(doc.otherPaymentSales, docId, 'otherPaymentSales', true), docId);
    tender('credit', date, credit);
    tender('other', date, other);
    if (saleLegCash[date] !== undefined) tender('cash__cashier', date, saleLegCash[date]!);
    if (remitted === 0 && ((saleLegTotal[date] ?? 0) !== 0 || online !== 0 || credit !== 0 || other !== 0)) flags.push({ code: 'V1_REMITTED_FIELD_ZERO', date });
    else cashResidual[date] = remitted - online - credit - other;
  }
  for (const [key, days] of tenders) {
    lines.push({ kind: 'sales_tender', key, amount: Object.values(days).reduce((a, b) => a + b, 0), days });
  }
  for (const [key, acc] of channelAr) {
    lines.push({ kind: 'sales_tender', key, amount: acc.in - acc.out, days: acc.days, in: acc.in, out: acc.out, legs: acc.legs });
  }

  // ---- expenses ----------------------------------------------------------------------------------------------
  const expenseLines = new Map<string, V1Line>();
  const basisDays: Record<string, number> = {};
  const expenses = snapshot.expenses
    .filter((e) => e.storeId === storeId)
    .map((e) => ({ e, date: normaliseBusinessDate(e.dayKey) }))
    .filter((x): x is { e: typeof x.e; date: string } => x.date !== null && inRange(x.date))
    .filter(({ e }) => {
      if (!EXPENSE_STATUSES.has(e.status)) throw new Error(`expense ${e.id}: unknown status ${JSON.stringify(e.status)}`);
      if (e.status === 'voided') { voided.expenses += 1; return false; }
      return true;
    })
    .sort((a, b) => cmp(a.e.id, b.e.id));
  // One entry id under two groups is never merged: such entries are flagged and keyed GROUP:entryId.
  const groupsByEntry = new Map<string, Set<string>>();
  for (const { e } of expenses) {
    const set = groupsByEntry.get(e.expenseEntryId) ?? new Set<string>();
    set.add(e.expenseEntryGroup);
    groupsByEntry.set(e.expenseEntryId, set);
  }
  for (const [entryId, groups] of groupsByEntry) {
    if (groups.size > 1) flags.push({ code: 'V1_EXPENSE_ENTRY_GROUP_CONFLICT', entryId });
  }
  for (const { e, date } of expenses) {
    const v = cents(parseAmount(e.totalAmount, e.id, 'totalAmount'), e.id);
    if (e.expenseEntryGroup === 'COGS') {
      addDay(basisDays, date, v);
    } else {
      const known = TIE_EXPENSE_GROUPS.has(e.expenseEntryGroup);
      const key = (groupsByEntry.get(e.expenseEntryId)?.size ?? 0) > 1 ? `${e.expenseEntryGroup}:${e.expenseEntryId}` : e.expenseEntryId;
      const l: V1Line = expenseLines.get(key) ?? (known
        ? { kind: 'expense_category' as const, key, group: e.expenseEntryGroup, amount: 0, days: {} }
        : { kind: 'expense_category' as const, key, group: e.expenseEntryGroup || null, class: 'V1_UNKNOWN_EXPENSE_GROUP' as const, amount: 0, days: {} });
      l.amount += v;
      addDay(l.days, date, v);
      expenseLines.set(key, l);
    }
  }
  lines.push(...expenseLines.values());
  if (Object.keys(basisDays).length > 0) {
    lines.push({ kind: 'inventory_basis', key: 'COGS', amount: Object.values(basisDays).reduce((a, b) => a + b, 0), days: basisDays });
  }

  lines.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));
  return {
    storeId,
    name,
    hasData: lines.length > 0 || tradingDays.length > 0 || Object.keys(cashResidual).length > 0,
    tradingDays,
    lines,
    scope: [...scope.values()].sort((a, b) => cmp(a.class + a.sourceType, b.class + b.sourceType)),
    posted,
    cashResidual,
    warnings: [...warnings.values()].sort((a, b) => cmp(a.docId, b.docId)),
    flags: flags.sort((a, b) => cmp(a.code, b.code) || cmp('date' in a ? a.date : a.entryId, 'date' in b ? b.date : b.entryId)),
    voided,
  };
}
