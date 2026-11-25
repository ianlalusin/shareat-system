/**
 * T-641 - what each tool hands the model: a NARROW PROJECTION of a report the screens already compute. Pure functions, no database, no authorization (the tool authorized before it
 * read). Each one names the fields it keeps; a field it does not name cannot reach the model however the report grows (bible section 7 rule 10: repos expose narrow projections).
 *
 * ⛔ Nothing here returns person-level pay, an ID number, a PIN or a credential, and a test (t641-ask-erp-shapes.test.ts) feeds every shape a report loaded with exactly those fields to prove
 * it. Wages are left out of the unpaid-liabilities shape altogether. A finding's own sentence is kept ONLY for the unusual-spending detectors, whose text names a store, a category, a supplier
 * and amounts; every other finding is named by its kind (some detectors' sentences name a person).
 */
import { compare, add, money, ZERO, type Money } from '@shareat/core/money';
import { peso, plainKind, top } from './format';
import type { ResolvedPeriod } from './period';
import type { StoreRef } from './scope';

const byTotalDesc = <T extends { total: Money }>(a: T, b: T): number => compare(b.total, a.total);

export interface Named {
  readonly period: { from: string; to: string; label: string };
}
export const periodOut = (p: ResolvedPeriod): Named['period'] => ({ from: p.from, to: p.to, label: p.label });
export const storesOut = (stores: readonly StoreRef[], wholeOrg: boolean): string[] => (wholeOrg ? ['All stores'] : stores.map((s) => `${s.name} (${s.code})`));

// ---- cost drivers: the expense-by-item report -----------------------------------------------------------------------------------------------------
interface ExpenseItemsLike {
  total: Money;
  groups: readonly {
    group: string;
    categories: readonly {
      category: string;
      total: Money;
      pct: number;
      subcategories: readonly { items: readonly { name: string; total: Money; pct: number; timesBought: number }[] }[];
    }[];
  }[];
}

export function shapeCostDrivers(r: ExpenseItemsLike): Record<string, unknown> {
  const categories = r.groups.flatMap((g) => g.categories.map((c) => ({ group: g.group, category: c.category, total: c.total, pct: c.pct }))).sort(byTotalDesc);
  const items = r.groups
    .flatMap((g) => g.categories.flatMap((c) => c.subcategories.flatMap((s) => s.items.map((i) => ({ item: i.name, category: c.category, total: i.total, pct: i.pct, timesBought: i.timesBought })))))
    .sort(byTotalDesc);
  const cats = top(categories, 8);
  const its = top(items, 10);
  return {
    totalExpenses: peso(r.total),
    biggestCategories: cats.rows.map((c) => ({ group: c.group, category: c.category, total: peso(c.total), shareOfTotal: `${c.pct}%` })),
    categoriesNotShown: cats.more,
    biggestItems: its.rows.map((i) => ({ item: i.item, category: i.category, total: peso(i.total), shareOfTotal: `${i.pct}%`, timesBought: i.timesBought })),
    itemsNotShown: its.more,
  };
}

// ---- income statement ------------------------------------------------------------------------------------------------------------------------------
interface StatementLike {
  revenue: Money;
  costOfSales: Money;
  grossProfit: Money;
  operatingExpenses: Money;
  operatingIncome: Money;
  netIncome: Money;
  operatingExpenseLines: readonly { accountName: string; amount: Money }[];
  costOfSalesLines: readonly { accountName: string; amount: Money }[];
}

export function statementFigures(s: StatementLike): Record<string, string> {
  return { revenue: peso(s.revenue), costOfSales: peso(s.costOfSales), grossProfit: peso(s.grossProfit), operatingExpenses: peso(s.operatingExpenses), operatingIncome: peso(s.operatingIncome), netIncome: peso(s.netIncome) };
}

export function shapeIncomeStatement(s: StatementLike): Record<string, unknown> {
  const opex = top([...s.operatingExpenseLines].sort((a, b) => compare(b.amount, a.amount)), 8);
  const cogs = top([...s.costOfSalesLines].sort((a, b) => compare(b.amount, a.amount)), 5);
  return {
    ...statementFigures(s),
    biggestOperatingExpenses: opex.rows.map((l) => ({ account: l.accountName, amount: peso(l.amount) })),
    biggestCostOfSales: cogs.rows.map((l) => ({ account: l.accountName, amount: peso(l.amount) })),
  };
}

export function shapeStoreComparison(rows: readonly { store: string; statement: StatementLike }[]): Record<string, unknown> {
  return { comparison: rows.map((r) => ({ store: r.store, ...statementFigures(r.statement) })) };
}

// ---- sales rollup ----------------------------------------------------------------------------------------------------------------------------------
interface RollupLike {
  ledgerTotal: Money;
  reconciles: boolean;
  periods: readonly { period: string | null; storeId: string | null; total: Money }[];
  channels: readonly { channelName: string; total: Money }[];
  modes: readonly { mode: string; total: Money }[];
}
const MODE_LABEL: Record<string, string> = { unli: 'Unlimited package', ala_carte: 'A la carte' };

export function shapeSalesRollup(r: RollupLike, storeName: (id: string) => string | null, groupBy: string): Record<string, unknown> {
  const lines = top(r.periods, 31);
  return {
    totalSales: peso(r.ledgerTotal),
    groupedBy: groupBy,
    breakdown: lines.rows.map((p) => ({ ...(p.period ? { period: p.period } : {}), ...(p.storeId ? { store: storeName(p.storeId) ?? 'a store' } : {}), total: peso(p.total) })),
    breakdownNotShown: lines.more,
    byChannel: r.channels.map((c) => ({ channel: c.channelName, total: peso(c.total) })),
    byPackageType: r.modes.map((m) => ({ type: MODE_LABEL[m.mode] ?? m.mode, total: peso(m.total) })),
    channelsAndPackagesAgreeWithLedger: r.reconciles,
  };
}

// ---- budget against actual -------------------------------------------------------------------------------------------------------------------------
interface BudgetLike {
  categoryGroup: string;
  categoryLabel: string;
  amount: string;
  consumed: string;
  remaining: string;
  overBudget: boolean;
}

export function shapeBudgets(lines: readonly BudgetLike[]): Record<string, unknown> {
  const sorted = [...lines].sort((a, b) => Number(b.overBudget) - Number(a.overBudget) || compare(money(b.consumed), money(a.consumed)));
  const cut = top(sorted, 25);
  const capped = lines.reduce((t, l) => add(t, money(l.amount)), ZERO);
  const spent = lines.reduce((t, l) => add(t, money(l.consumed)), ZERO);
  return {
    totalCap: peso(capped),
    totalSpent: peso(spent),
    overBudgetCount: lines.filter((l) => l.overBudget).length,
    categories: cut.rows.map((l) => ({ group: l.categoryGroup, category: l.categoryLabel, cap: peso(l.amount), spent: peso(l.consumed), remaining: peso(l.remaining), overBudget: l.overBudget })),
    categoriesNotShown: cut.more,
  };
}

// ---- findings --------------------------------------------------------------------------------------------------------------------------------------
interface FindingLike {
  kind: string;
  storeId: string | null;
  severity: 'hard' | 'soft';
  detail: string;
  status: 'open' | 'acknowledged';
}

/** The unusual-spending detectors (T-639) whose sentence names a store, a category, a supplier and amounts, and no person. `expenseSelfApproved` is NOT here: its sentence names who approved. */
const SENTENCE_KINDS: ReadonlySet<string> = new Set(['expenseCategorySpike', 'expenseFrequencySpike', 'expenseOutlier', 'expenseDuplicate', 'expenseOverBudget']);

export function shapeFindings(findings: readonly FindingLike[], storeName: (id: string) => string | null): Record<string, unknown> {
  const ordered = [...findings].sort((a, b) => Number(b.severity === 'hard') - Number(a.severity === 'hard') || Number(b.status === 'open') - Number(a.status === 'open'));
  const cut = top(ordered, 30);
  return {
    openOrAcceptedCount: findings.length,
    hardCount: findings.filter((f) => f.severity === 'hard').length,
    openCount: findings.filter((f) => f.status === 'open').length,
    findings: cut.rows.map((f) => ({
      issue: plainKind(f.kind),
      store: f.storeId ? (storeName(f.storeId) ?? 'a store') : 'whole company',
      severity: f.severity === 'hard' ? 'serious' : 'minor',
      status: f.status === 'open' ? 'open' : 'accepted for now',
      ...(SENTENCE_KINDS.has(f.kind) ? { detail: f.detail } : {}),
    })),
    notShown: cut.more,
  };
}

// ---- low stock -------------------------------------------------------------------------------------------------------------------------------------
interface LowStockLike {
  storeId: string;
  itemName: string;
  baseUnit: string;
  onHand: string;
  threshold: string;
  shortfall: string;
}

export function shapeLowStock(rows: readonly LowStockLike[], storeName: (id: string) => string | null): Record<string, unknown> {
  const cut = top(rows, 30);
  return {
    itemsAtOrBelowThreshold: rows.length,
    items: cut.rows.map((r) => ({ store: storeName(r.storeId) ?? 'a store', item: r.itemName, unit: r.baseUnit, onHand: r.onHand, threshold: r.threshold, shortBy: r.shortfall })),
    notShown: cut.more,
    aboutThisList: 'Items with no threshold set are not listed here; they appear as a finding.',
  };
}

// ---- unpaid liabilities ----------------------------------------------------------------------------------------------------------------------------
interface UnpaidLike {
  kinds: readonly {
    id: string;
    title: string;
    visible: boolean;
    subtotal: string | null;
    lines: readonly { name: string; counterparty: string | null; dueOn: string | null; amount: string; accountCode?: string }[];
  }[];
}

/** Kinds whose lines may name the party owed (a supplier, a lender). The others are shown by what they are, never who. */
const NAMES_THE_PARTY: ReadonlySet<string> = new Set(['supplier_invoices', 'loans']);
/** Payroll liabilities are never shown: `wages` is a whole kind, and ledger account 2300 is payroll. */
const PAYROLL_ACCOUNT = '2300';

export function shapeUnpaid(r: UnpaidLike): Record<string, unknown> {
  const shown = r.kinds
    .filter((k) => k.id !== 'wages' && k.visible)
    .map((k) => {
      const lines = k.lines.filter((l) => l.accountCode !== PAYROLL_ACCOUNT);
      // the report's own subtotal when nothing was taken out of the kind, else the sum of what is shown
      const subtotal = lines.length === k.lines.length && k.subtotal !== null ? money(k.subtotal) : lines.reduce((t, l) => add(t, money(l.amount)), ZERO);
      const cut = top([...lines].sort((a, b) => (a.dueOn ?? '9999-99-99').localeCompare(b.dueOn ?? '9999-99-99')), 8);
      const out = {
        kind: k.title,
        subtotal: peso(subtotal),
        lines: cut.rows.map((l) => ({ what: l.name, ...(NAMES_THE_PARTY.has(k.id) && l.counterparty ? { owedTo: l.counterparty } : {}), ...(l.dueOn ? { due: l.dueOn } : {}), amount: peso(l.amount) })),
        linesNotShown: cut.more,
      };
      return { out, subtotal };
    });
  return {
    kinds: shown.map((k) => k.out),
    totalUnpaidExcludingWages: peso(shown.reduce((t, k) => add(t, k.subtotal), ZERO)),
    aboutThisList: 'Wages and payroll are not covered here.',
  };
}

// ---- knowledge -------------------------------------------------------------------------------------------------------------------------------------
export function shapeKnowledge(hits: readonly { title: string; source: string; text: string }[]): Record<string, unknown> {
  return hits.length === 0
    ? { results: [], note: 'Nothing in the approved documents matches. Say you do not know; do not guess.' }
    : { results: hits.map((h) => ({ from: h.source, title: h.title, text: h.text })) };
}
