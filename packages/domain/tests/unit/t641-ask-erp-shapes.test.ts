import { describe, expect, it } from 'vitest';
import { money, type Money } from '@shareat/core/money';
import { RefusalError } from '../../src/shared/refusal';
import { peso, plainKind, top } from '../../src/ask-erp/format';
import { budgetPeriodKey, resolvePeriod } from '../../src/ask-erp/period';
import { shapeBudgets, shapeCostDrivers, shapeFindings, shapeIncomeStatement, shapeKnowledge, shapeLowStock, shapeSalesRollup, shapeStoreComparison, shapeUnpaid, storesOut } from '../../src/ask-erp/shape';

/**
 * T-641 tests 2 and 3 (the pure half): the period is worked out by our code in Manila time, and every tool's answer is a NARROW PROJECTION. The scan at the bottom feeds each
 * shape a report loaded with pay, ID numbers, PINs and names in fields the shape must never copy, and proves none of it comes out.
 */
const m = (v: string): Money => money(v);
function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e instanceof RefusalError, `expected a refusal, got ${String((e as Error).message)}`).toBe(true);
    return (e as RefusalError).userMessage;
  }
  throw new Error('expected a refusal, got none');
}

describe('T-641 the period (Manila, ours, never the model\'s arithmetic)', () => {
  const today = '2026-11-26'; // a Thursday
  it('names resolve to the right days [kills: a wrong week start, month end or year rollover]', () => {
    expect(resolvePeriod({}, today)).toMatchObject({ from: '2026-11-01', to: '2026-11-26' });
    expect(resolvePeriod({ period: 'this_month' }, today)).toMatchObject({ from: '2026-11-01', to: '2026-11-26' });
    expect(resolvePeriod({ period: 'last_month' }, today)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolvePeriod({ period: 'last_month' }, '2026-01-15')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolvePeriod({ period: 'last_month' }, '2026-03-02')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolvePeriod({ period: 'today' }, today)).toMatchObject({ from: today, to: today });
    expect(resolvePeriod({ period: 'yesterday' }, '2026-03-01')).toMatchObject({ from: '2026-02-28', to: '2026-02-28' });
    expect(resolvePeriod({ period: 'this_week' }, today)).toMatchObject({ from: '2026-11-23', to: today });
    expect(resolvePeriod({ period: 'this_week' }, '2026-11-23')).toMatchObject({ from: '2026-11-23', to: '2026-11-23' });
    expect(resolvePeriod({ period: 'this_week' }, '2026-11-29')).toMatchObject({ from: '2026-11-23', to: '2026-11-29' });
    expect(resolvePeriod({ period: 'this_year' }, today)).toMatchObject({ from: '2026-01-01', to: today });
  });

  it('two real dates win over a name, and the label says what was used [kills: a name that beats explicit dates]', () => {
    const p = resolvePeriod({ period: 'last_month', from: '2026-09-01', to: '2026-09-15' }, today);
    expect(p).toMatchObject({ from: '2026-09-01', to: '2026-09-15', label: '2026-09-01 to 2026-09-15' });
    expect(resolvePeriod({ from: '2026-09-05', to: '2026-09-05' }, today).label).toBe('2026-09-05');
    expect(resolvePeriod({ period: 'this_month' }, today).label).toContain('November 2026');
  });

  it('bad input is a sentence, never a quiet different period [kills: a fallback to this month on a typo]', () => {
    expect(refusalOf(() => resolvePeriod({ from: '2026-09-01' }, today))).toMatch(/both dates/i);
    expect(refusalOf(() => resolvePeriod({ to: '2026-09-01' }, today))).toMatch(/both dates/i);
    expect(refusalOf(() => resolvePeriod({ from: '2026-02-30', to: '2026-03-01' }, today))).toMatch(/real calendar dates/i);
    expect(refusalOf(() => resolvePeriod({ from: '2026-09-10', to: '2026-09-01' }, today))).toMatch(/not be after/i);
    expect(refusalOf(() => resolvePeriod({ from: '2025-01-01', to: '2026-11-26' }, today))).toMatch(/366 days/);
    expect(refusalOf(() => resolvePeriod({ period: 'next_month' }, today))).toMatch(/this_month/);
    expect(resolvePeriod({ from: '2025-11-26', to: '2026-11-26' }, today).from).toBe('2025-11-26'); // 366 days exactly is allowed
  });

  it('the budget key is the month the period starts in [kills: the end month]', () => {
    expect(budgetPeriodKey(resolvePeriod({ period: 'last_month' }, '2026-01-15'))).toBe('202512');
    expect(budgetPeriodKey(resolvePeriod({ period: 'this_month' }, today))).toBe('202611');
  });
});

describe('T-641 formatting', () => {
  it('peso works on the decimal text, with commas and two places, and keeps the sign [kills: a float round trip]', () => {
    expect(peso('1234.5')).toBe('₱1,234.50');
    expect(peso('0.00')).toBe('₱0.00');
    expect(peso('-12')).toBe('-₱12.00');
    expect(peso('1234567890.10')).toBe('₱1,234,567,890.10');
    expect(peso('12345678901234.99')).toBe('₱12,345,678,901,234.99');
    expect(peso('n/a')).toBe('n/a');
  });
  it('plainKind and top', () => {
    expect(plainKind('expenseOutlier')).toBe('Expense outlier');
    expect(plainKind('some_new_check')).toBe('Some new check');
    expect(top([1, 2, 3], 2)).toEqual({ rows: [1, 2], more: 1 });
    expect(top([1], 5)).toEqual({ rows: [1], more: 0 });
  });
  it('storesOut says "All stores" only for the whole organisation', () => {
    expect(storesOut([{ id: 'x', name: 'Lipa', code: 'LIP' }], false)).toEqual(['Lipa (LIP)']);
    expect(storesOut([{ id: 'x', name: 'Lipa', code: 'LIP' }], true)).toEqual(['All stores']);
  });
});

// ---- the shapes ----------------------------------------------------------------------------------------------------------------------------------
const item = (name: string, total: string, pct: number) => ({ name, total: m(total), pct, timesBought: 3, avgUnitPrice: m('1.00'), byStore: [], employeeName: 'Juan Dela Cruz', tin: '123-456-789-000' });
const category = (c: string, total: string, pct: number, items: ReturnType<typeof item>[]) => ({ categoryId: 'c', category: c, total: m(total), pct, subcategories: [{ subcategoryId: null, name: 'x', total: m(total), pct, items }] });

describe('T-641 cost drivers', () => {
  const report = {
    total: m('10000.00'),
    groups: [
      { group: 'OPEX', total: m('3000.00'), pct: 30, categories: [category('Rent', '3000.00', 30, [item('Rent', '3000.00', 30)])] },
      { group: 'COGS', total: m('7000.00'), pct: 70, categories: [category('Meat', '5000.00', 50, [item('Pork belly', '4000.00', 40), item('Beef', '1000.00', 10)]), category('Rice', '2000.00', 20, [item('Rice 25kg', '2000.00', 20)])] },
    ],
  };
  it('lists the biggest categories and items first, with their share, as peso text [kills: unsorted output; a wrong share]', () => {
    const out = shapeCostDrivers(report) as { totalExpenses: string; biggestCategories: { category: string; total: string; shareOfTotal: string }[]; biggestItems: { item: string }[] };
    expect(out.totalExpenses).toBe('₱10,000.00');
    expect(out.biggestCategories.map((c) => [c.category, c.total, c.shareOfTotal])).toEqual([
      ['Meat', '₱5,000.00', '50%'],
      ['Rent', '₱3,000.00', '30%'],
      ['Rice', '₱2,000.00', '20%'],
    ]);
    expect(out.biggestItems.map((i) => i.item)).toEqual(['Pork belly', 'Rent', 'Rice 25kg', 'Beef']);
  });
  it('says how many were cut instead of presenting a cut list as whole [kills: a silent cut]', () => {
    const many = { total: m('1.00'), groups: [{ group: 'G', total: m('1.00'), pct: 100, categories: Array.from({ length: 11 }, (_, i) => category(`C${i}`, `${100 - i}.00`, 1, [item(`I${i}`, `${100 - i}.00`, 1)])) }] };
    const out = shapeCostDrivers(many) as { biggestCategories: unknown[]; categoriesNotShown: number; biggestItems: unknown[]; itemsNotShown: number };
    expect(out.biggestCategories).toHaveLength(8);
    expect(out.categoriesNotShown).toBe(3);
    expect(out.biggestItems).toHaveLength(10);
    expect(out.itemsNotShown).toBe(1);
  });
});

describe('T-641 income statement, comparison, sales', () => {
  const stmt = (r: string) => ({
    revenue: m(r), costOfSales: m('400.00'), grossProfit: m('600.00'), operatingExpenses: m('300.00'), operatingIncome: m('300.00'), netIncome: m('250.00'),
    operatingExpenseLines: [{ accountName: 'Utilities', amount: m('100.00') }, { accountName: 'Rent', amount: m('200.00') }],
    costOfSalesLines: [{ accountName: 'Food cost', amount: m('400.00') }],
    salary: '99999.00', basicPay: '88888.00',
  });
  it('the six figures and the biggest expense accounts, biggest first [kills: lines in report order]', () => {
    const out = shapeIncomeStatement(stmt('1000.00')) as Record<string, unknown>;
    expect(out).toMatchObject({ revenue: '₱1,000.00', costOfSales: '₱400.00', grossProfit: '₱600.00', operatingExpenses: '₱300.00', operatingIncome: '₱300.00', netIncome: '₱250.00' });
    expect((out.biggestOperatingExpenses as { account: string }[]).map((l) => l.account)).toEqual(['Rent', 'Utilities']);
  });
  it('a comparison is one row of figures per store [kills: stores merged]', () => {
    const out = shapeStoreComparison([{ store: 'A (A1)', statement: stmt('1000.00') }, { store: 'B (B1)', statement: stmt('2000.00') }]) as { comparison: { store: string; revenue: string }[] };
    expect(out.comparison.map((s) => [s.store, s.revenue])).toEqual([['A (A1)', '₱1,000.00'], ['B (B1)', '₱2,000.00']]);
  });
  it('the sales rollup names the channels and package types in words [kills: raw enum values shown]', () => {
    const out = shapeSalesRollup(
      { ledgerTotal: m('500.00'), reconciles: true, periods: [{ period: '2026-11-01', storeId: null, total: m('500.00') }, { period: null, storeId: 's1', total: m('9.00') }], channels: [{ channelName: 'Walk-in', total: m('300.00') }], modes: [{ mode: 'unli', total: m('200.00') }, { mode: 'ala_carte', total: m('300.00') }] },
      (id) => (id === 's1' ? 'Lipa (LIP)' : null),
      'day',
    ) as { totalSales: string; breakdown: Record<string, string>[]; byPackageType: { type: string }[] };
    expect(out.totalSales).toBe('₱500.00');
    expect(out.breakdown).toEqual([{ period: '2026-11-01', total: '₱500.00' }, { store: 'Lipa (LIP)', total: '₱9.00' }]);
    expect(out.byPackageType.map((t) => t.type)).toEqual(['Unlimited package', 'A la carte']);
  });
});

describe('T-641 budgets', () => {
  const line = (cat: string, cap: string, spent: string, remaining: string, over: boolean) => ({ categoryGroup: 'OPEX', categoryLabel: cat, amount: cap, consumed: spent, remaining, overBudget: over });
  it('over-budget categories come first, with exact totals and a negative remainder kept [kills: a floored remainder; unsorted rows]', () => {
    const out = shapeBudgets([line('Rent', '1000.00', '900.00', '100.00', false), line('Supplies', '200.00', '350.50', '-150.50', true)]) as {
      totalCap: string; totalSpent: string; overBudgetCount: number; categories: { category: string; remaining: string; overBudget: boolean }[];
    };
    expect(out.totalCap).toBe('₱1,200.00');
    expect(out.totalSpent).toBe('₱1,250.50');
    expect(out.overBudgetCount).toBe(1);
    expect(out.categories.map((c) => [c.category, c.remaining, c.overBudget])).toEqual([['Supplies', '-₱150.50', true], ['Rent', '₱100.00', false]]);
  });
});

describe('T-641 findings: a sentence is kept only where it names no person', () => {
  const f = (kind: string, severity: 'hard' | 'soft', status: 'open' | 'acknowledged', detail: string, storeId: string | null = 's1') => ({ kind, storeId, severity, status, detail });
  const names = (id: string) => (id === 's1' ? 'Lipa (LIP)' : null);
  it('keeps the sentence of the unusual-spending detectors, drops the one that names who approved, and drops every other detector\'s sentence [kills: a person\'s name reaching the model]', () => {
    const out = shapeFindings(
      [
        f('expenseOutlier', 'soft', 'open', 'Lipa: ₱9,000.00 for Meat to Acme Meats is far above the usual.'),
        f('expenseSelfApproved', 'soft', 'open', 'Lipa: Maria Santos recorded and approved their own ₱5,000.00 Meat expense.'),
        f('tillCountVarianceOpen', 'hard', 'open', 'Short ₱500.00 on the shift of Pedro Reyes.'),
      ],
      names,
    ) as { findings: { issue: string; detail?: string; severity: string }[] };
    const json = JSON.stringify(out);
    expect(json).not.toContain('Maria Santos');
    expect(json).not.toContain('Pedro Reyes');
    expect(out.findings.find((x) => x.issue === 'Expense outlier')?.detail).toContain('Acme Meats');
    expect(out.findings.find((x) => x.issue === 'Expense self approved')).not.toHaveProperty('detail');
    expect(out.findings.find((x) => x.issue === 'Till count variance open')).not.toHaveProperty('detail');
  });
  it('serious ones first, open before accepted; counts are over all of them; a long list says how many were cut [kills: a quiet cut; wrong order]', () => {
    const list = [
      f('a', 'soft', 'acknowledged', ''),
      f('b', 'hard', 'acknowledged', ''),
      f('c', 'soft', 'open', ''),
      f('d', 'hard', 'open', ''),
      ...Array.from({ length: 30 }, () => f('e', 'soft', 'open', '')),
    ];
    const out = shapeFindings(list, names) as { openOrAcceptedCount: number; hardCount: number; openCount: number; findings: { issue: string; severity: string; status: string }[]; notShown: number };
    expect(out.findings.slice(0, 2).map((x) => [x.issue, x.status])).toEqual([['D', 'open'], ['B', 'accepted for now']]);
    expect(out.openOrAcceptedCount).toBe(34);
    expect(out.hardCount).toBe(2);
    expect(out.openCount).toBe(32);
    expect(out.findings).toHaveLength(30);
    expect(out.notShown).toBe(4);
  });
  it('a finding with no store is "whole company" [kills: a null store shown as a name]', () => {
    const out = shapeFindings([f('trialBalanceDoesNotTie', 'hard', 'open', '', null)], names) as { findings: { store: string }[] };
    expect(out.findings[0]?.store).toBe('whole company');
  });
});

describe('T-641 low stock and unpaid liabilities', () => {
  it('low stock lists worst first as given, with the store named, and never claims to be complete about missing thresholds [kills: no note]', () => {
    const out = shapeLowStock([{ storeId: 's1', itemName: 'Rice', baseUnit: 'kg', onHand: '2.000', threshold: '10.000', shortfall: '8.000' }], () => 'Lipa (LIP)') as { items: { store: string; shortBy: string }[]; aboutThisList: string };
    expect(out.items).toEqual([{ store: 'Lipa (LIP)', item: 'Rice', unit: 'kg', onHand: '2.000', threshold: '10.000', shortBy: '8.000' }]);
    expect(out.aboutThisList).toMatch(/no threshold/i);
  });

  const unpaid = {
    kinds: [
      { id: 'supplier_invoices', title: 'Supplier invoices unpaid', visible: true, subtotal: '300.00', lines: [{ name: 'Invoice 17', counterparty: 'Acme Meats', dueOn: '2026-12-01', amount: '300.00' }] },
      { id: 'register', title: 'Other obligations', visible: true, subtotal: '50.00', lines: [{ name: 'Reimbursement', counterparty: 'Maria Santos', dueOn: null, amount: '50.00' }] },
      { id: 'wages', title: 'Wages worked, not yet paid', visible: true, subtotal: '90000.00', lines: [{ name: 'Pedro Reyes', counterparty: 'Pedro Reyes', dueOn: null, amount: '90000.00' }] },
      { id: 'other_ledger', title: 'Other amounts owed in the books', visible: true, subtotal: '1100.00', lines: [{ name: 'Accrued wages', counterparty: null, dueOn: null, amount: '1000.00', accountCode: '2300' }, { name: 'Accrued utilities', counterparty: null, dueOn: null, amount: '100.00', accountCode: '2120' }] },
      { id: 'loans', title: 'Loans', visible: false, subtotal: null, lines: [] },
    ],
  };
  it('leaves out wages and payroll account 2300 entirely, names the party only for suppliers and loans, and totals what is shown [kills: pay reaching the model; a total that still includes wages]', () => {
    const out = shapeUnpaid(unpaid) as { kinds: { kind: string; subtotal: string; lines: Record<string, string>[] }[]; totalUnpaidExcludingWages: string };
    const json = JSON.stringify(out);
    expect(json).not.toContain('Pedro Reyes');
    expect(json).not.toContain('Maria Santos');
    expect(json).not.toContain('Accrued wages');
    expect(json).not.toContain('90,000');
    expect(out.kinds.map((k) => k.kind)).toEqual(['Supplier invoices unpaid', 'Other obligations', 'Other amounts owed in the books']);
    expect(out.kinds[0]?.lines[0]).toEqual({ what: 'Invoice 17', owedTo: 'Acme Meats', due: '2026-12-01', amount: '₱300.00' });
    expect(out.kinds[2]?.subtotal).toBe('₱100.00');
    expect(out.totalUnpaidExcludingWages).toBe('₱450.00');
  });
});

describe('T-641 knowledge shape', () => {
  it('an empty search tells the model to say it does not know [kills: silence that invites a guess]', () => {
    expect(shapeKnowledge([])).toMatchObject({ results: [], note: expect.stringMatching(/do not know/i) });
    expect(shapeKnowledge([{ title: 'T', source: 'glossary', text: 'x' }])).toEqual({ results: [{ from: 'glossary', title: 'T', text: 'x' }] });
  });
});

describe('T-641 test 3: no tool output contains pay, IDs, PINs or credentials (a scan of every projection)', () => {
  // Every input below carries personal fields with distinctive values. A shape may copy only the fields it names.
  const POISON = ['HUNTER2-PIN-4821', 'SSS-34-1234567-8', 'TIN-123-456-789', 'NETPAY-77777', 'SALARY-66666', 'PHILHEALTH-12-345678901-2', 'secret.person@example.com'];
  const poisoned = {
    pin: POISON[0], sss: POISON[1], tin: POISON[2], netPay: POISON[3], salary: POISON[4], philhealth: POISON[5], email: POISON[6], password: POISON[0], payRate: POISON[4],
  };
  const outputs: Record<string, unknown> = {
    costDrivers: shapeCostDrivers({ total: m('1.00'), groups: [{ group: 'G', ...poisoned, categories: [{ category: 'C', total: m('1.00'), pct: 100, ...poisoned, subcategories: [{ ...poisoned, items: [{ name: 'I', total: m('1.00'), pct: 100, timesBought: 1, ...poisoned }] }] }] }] } as never),
    incomeStatement: shapeIncomeStatement({ revenue: m('1.00'), costOfSales: m('0.00'), grossProfit: m('1.00'), operatingExpenses: m('0.00'), operatingIncome: m('1.00'), netIncome: m('1.00'), operatingExpenseLines: [{ accountName: 'A', amount: m('1.00'), ...poisoned }], costOfSalesLines: [], ...poisoned } as never),
    salesRollup: shapeSalesRollup({ ledgerTotal: m('1.00'), reconciles: true, periods: [{ period: 'p', storeId: null, total: m('1.00'), ...poisoned }], channels: [{ channelName: 'c', total: m('1.00'), ...poisoned }], modes: [], ...poisoned } as never, () => null, 'day'),
    budgets: shapeBudgets([{ categoryGroup: 'G', categoryLabel: 'L', amount: '1.00', consumed: '1.00', remaining: '0.00', overBudget: false, ...poisoned }] as never),
    findings: shapeFindings([{ kind: 'expenseOutlier', storeId: null, severity: 'soft', status: 'open', detail: 'ok', ...poisoned }] as never, () => null),
    lowStock: shapeLowStock([{ storeId: 's', itemName: 'i', baseUnit: 'kg', onHand: '1', threshold: '2', shortfall: '1', ...poisoned }] as never, () => null),
    unpaid: shapeUnpaid({ kinds: [{ id: 'supplier_invoices', title: 'T', visible: true, subtotal: '1.00', ...poisoned, lines: [{ name: 'n', counterparty: 'c', dueOn: null, amount: '1.00', ...poisoned }] }] } as never),
  };
  for (const [name, out] of Object.entries(outputs)) {
    it(`${name} copies none of the personal fields [kills: a shape that spreads the report instead of naming fields]`, () => {
      const json = JSON.stringify(out);
      for (const p of POISON) expect(json, `${name} leaked ${p}`).not.toContain(p);
      for (const key of ['pin', 'sss', 'tin', 'netPay', 'salary', 'philhealth', 'email', 'password', 'payRate']) expect(json, `${name} carries a "${key}" field`).not.toContain(`"${key}"`);
    });
  }
});
