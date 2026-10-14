/**
 * T-392 S4b (TESTER) - document-level matching (R9), the PURE half. docs/tasks/392-dual-run-comparator.md "S4b spec",
 * invariants 38 (v1 side), 39, 40, 41, 43, 44. No database. Synthetic data, invented names.
 *
 * ---- PINNED CONTRACT (the spec names rules; the builder follows these or reports the one it cannot) ----
 * packages/etl/src/dual-run/docs.ts  (NEW module - it does not exist on HEAD, so every test that needs it is red with a
 * missing-module failure; the tests that do not need it say so and are red on the BEHAVIOUR of compare.ts):
 *   normaliseReceiptNo(s: string): string      uppercase, drop every char outside [A-Z0-9]; '' = no link
 *   v1Documents(snapshot: V1Snapshot, opts: { storeId: string; weekStart: string; through: string }): CompareDoc[]
 *     window [weekStart-7, through+7] (string dates); posted only (state always 'posted'); RAW v1 keys (compare maps them);
 *     cash_bank  per (sourceType, sourceId, accountId, businessDate) over in-scope legs on cash__/online__, amount sum(in-out),
 *                id `v1:leg:<sourceType>:<sourceId>:<accountId>:<date>`; cash__staff is kind 'staff_cash'
 *     ap_supplier same grouping on ap__/supplier_advance__; receiptId 'rn:'+normalised number when sourceType is
 *                'expense_payment' and the expense (id = sourceId) links a receipt that has a number
 *     expense_category one per posted NON-COGS expense, key as v1-figures (entryId, or GROUP:entryId on a conflict), date dayKey,
 *                id `v1:exp:<id>`, same receiptId rule
 *     sales_tender one per (key, date) of computeV1Figures(window).sales_tender days, id `v1:sd:<key>:<date>`, channel: true
 *                when the key starts 'channel__'
 *     A group whose amount nets to 0 is not emitted. No inventory_basis docs. Output order is not pinned (compare sorts).
 *   compare.ts: `empty` (no_data) stops reading v1Docs/v2Docs.
 * Mutant for each test is named above it. Where a CompareDoc is hand-built it is because the test is about compare.ts alone.
 */
import { describe, expect, it } from 'vitest';
import { compareStoreWeek } from '../src/dual-run/compare';
import { computeV1Figures } from '../src/dual-run/v1-figures';
import { v1SalesDay } from './fixtures/t392-v1-sales-day';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const W19 = { weekStart: '2026-10-19', through: '2026-10-25' };
const W26 = { weekStart: '2026-10-26', through: '2026-11-01' };
const SUP = '0a0a0a0a-0000-4000-8000-000000000001';
const CAT = '0b0b0b0b-0000-4000-8000-000000000002';

// docs.ts is NEW: load it inside each test so a missing module fails THAT test, not the file.
const docs = (): Promise<Any> => import('../src/dual-run/docs');
const v1Docs = async (snapshot: Any, w: { weekStart: string; through: string }): Promise<Any[]> =>
  (await docs()).v1Documents(snapshot, { storeId: L, ...w });

let n = 0;
const leg = (over: Any = {}): Any => {
  n += 1;
  return {
    id: `leg${n}`, storeId: L, businessDate: '2026-10-20', sourceType: 'sale', sourceId: `src${n}`, legKey: `k${n}`,
    accountId: 'cash__cashier', direction: 'in', amount: 0, status: 'posted', ...over,
  };
};
const exp = (id: string, over: Any = {}): Any => ({
  id, storeId: L, dayKey: '2026-10-22', totalAmount: 0, status: 'posted', supplierId: 'sup1', expenseEntryId: `ent-${id}`,
  expenseEntryGroup: 'OPEX', category: 'X', payments: [], ...over,
});
const snap = (o: Any = {}): Any => ({
  version: 1, from: '2026-10-19', through: '2026-10-25', window: { from: '2026-10-12', through: '2026-11-01' },
  extractedAt: '2026-10-26T01:00:00.000Z', stores: [{ id: L, name: 'SharEat Lipa' }], excludedStores: [], suppliers: [],
  paymentAccounts: [], journal: [], expenses: [], salesDays: [], ...o,
});
const sum = (days: Record<string, number>): number => Object.values(days).reduce((a, b) => a + b, 0);
const mkLine = (kind: string, key: string, days: Record<string, number>): Any => ({ kind, key, days, amount: sum(days) });
const cd = (id: string, kind: string, key: string, date: string, amount: number, extra: Any = {}): Any => ({ id, kind, key, date, amount, state: 'posted', ...extra });
const D = (day: number): string => `2026-10-${String(day).padStart(2, '0')}`;

/** v1 side of compareStoreWeek exactly as the domain builds it (cash__staff re-kinded to staff_cash). */
function v1Side(snapshot: Any, w: { weekStart: string; through: string }): Any {
  const f = computeV1Figures(snapshot, w).stores[L]!;
  return {
    lines: f.lines.map((l: Any) => (l.kind === 'cash_bank' && l.key === 'cash__staff' ? { ...l, kind: 'staff_cash' } : l)),
    tradingDays: f.tradingDays, cashResidual: f.cashResidual, scope: f.scope, flags: f.flags,
  };
}
async function compareWeek(snapshot: Any, w: { weekStart: string; through: string }, v2: Any, keyMap: Record<string, string>): Promise<Any> {
  return compareStoreWeek({
    orgId: 'org-1', storeId: 'LIPA', ...w,
    v1: v1Side(snapshot, w), v2: { lines: v2.lines, tradingDays: v2.tradingDays }, keyMap,
    v1Docs: await v1Docs(snapshot, w), v2Docs: v2.docs ?? [], dispositions: [],
  });
}
const lineOf = (r: Any, kind: string, key: string): Any => {
  const l = r.lines.find((x: Any) => x.kind === kind && x.key === key);
  if (!l) throw new Error(`no result line ${kind}/${key}; have ${r.lines.map((x: Any) => `${x.kind}/${x.key}`).join(', ')}`);
  return l;
};
/** A tied cash sale of 1000.00 on `date` on both sides (v1 leg + salesDay; v2 lines are added by the caller). */
const saleLeg = (date: string): Any => leg({ businessDate: date, sourceType: 'sale', sourceId: `sale-${date}`, amount: 1000 });
const KEYS = { 'cash_bank|cash__cashier': '1110', 'sales_tender|cash__cashier': '1110' };
const v2Sale = (dates: string[]): Any[] => dates.map((d) => cd(`v2:sale:${d}`, 'cash_bank', '1110', d, 100000));

// ======================================================================================================
describe('normaliseReceiptNo (docs.ts is a NEW module)', () => {
  // Mutant for inv 41 "no normalisation": 'SI-00123' and 'si00123' must meet.
  it('uppercases and drops every char outside A-Z0-9; an empty result means "no link"', async () => {
    const { normaliseReceiptNo } = await docs();
    expect(normaliseReceiptNo('SI-00123')).toBe('SI00123');
    expect(normaliseReceiptNo('si00123')).toBe('SI00123');
    expect(normaliseReceiptNo('  si 00-123 ')).toBe('SI00123');
    expect(normaliseReceiptNo('a/b.c#9')).toBe('ABC9');
    expect(normaliseReceiptNo('--')).toBe('');
    expect(normaliseReceiptNo('')).toBe('');
  });
});

// ======================================================================================================
function bigSnapshot(): Any {
  const journal = [
    leg({ businessDate: '2026-10-10', sourceId: 'too-early', amount: 5 }), // before ws-7: outside the window
    leg({ businessDate: '2026-11-02', sourceId: 'too-late', amount: 6 }), // after through+7: outside the window
    leg({ businessDate: '2026-10-16', sourceId: 'sale-s0', amount: 77 }), // week-3: in the window, not in the week
    leg({ businessDate: '2026-10-28', sourceId: 'sale-s8', amount: 88 }), // through+3
    leg({ businessDate: '2026-10-20', sourceId: 'sale-s1', amount: 1000 }),
    leg({ businessDate: '2026-10-20', sourceId: 'sale-s1', amount: 100, direction: 'out' }), // same group: ONE doc of 900
    leg({ businessDate: '2026-10-22', sourceId: 'sale-s7', amount: 40 }),
    leg({ businessDate: '2026-10-22', sourceId: 'sale-s7', amount: 40, direction: 'out' }), // nets to 0: no doc
    leg({ businessDate: '2026-10-21', sourceId: 'sale-v', amount: 999, status: 'voided' }), // voided: nothing
    leg({ businessDate: '2026-10-21', sourceId: 'sale-s2', accountId: 'online__gcash', amount: 300 }),
    leg({ businessDate: '2026-10-22', sourceType: 'expense_payment', sourceId: 'ex1', amount: 500, direction: 'out' }),
    leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex2', accountId: 'ap__sup1', amount: 8000, supplierId: 'sup1' }),
    leg({ businessDate: '2026-10-23', sourceType: 'ap_payment', sourceId: 'pay1', accountId: 'ap__sup1', amount: 3000, direction: 'out', supplierId: 'sup1' }),
    leg({ businessDate: '2026-10-24', sourceType: 'ap_payment', sourceId: 'adv1', accountId: 'supplier_advance__sup1', amount: 200 }),
    leg({ businessDate: '2026-10-22', sourceType: 'expense_payment', sourceId: 'ex3', accountId: 'cash__staff', amount: 250, direction: 'out' }),
    leg({ businessDate: '2026-10-22', sourceType: 'depreciation', sourceId: 'dep1', amount: 9 }), // scope: no doc
    leg({ businessDate: '2026-10-21', sourceType: 'sale', sourceId: 'ch_grab1_2026-10-21', legKey: 'ar:channel_grab1', accountId: 'ar__channel_grab1', amount: 1250 }),
  ];
  const expenses = [
    exp('ex1', { totalAmount: 500, expenseEntryId: 'E1', dayKey: '2026-10-22' }),
    exp('ex4', { totalAmount: 200, expenseEntryId: 'E1', dayKey: '2026-10-23' }), // same entry: two docs, one line of 700
    exp('ex5', { totalAmount: 800, expenseEntryGroup: 'COGS', dayKey: '2026-10-22' }), // COGS: no doc
    exp('ex6', { totalAmount: 60, status: 'voided', dayKey: '2026-10-22' }), // voided: no doc
    exp('ex7', { totalAmount: 33, expenseEntryId: 'E7', dayKey: '2026-10-16' }), // week-3
    exp('ex8', { totalAmount: 44, expenseEntryId: 'E8', dayKey: '2026-10-28' }), // through+3
    exp('ex9', { totalAmount: 11, expenseEntryId: 'E9', dayKey: '2026-10-10' }), // outside the window
  ];
  const salesDays = [
    v1SalesDay(L, '2026-10-16', 77),
    v1SalesDay(L, '2026-10-20', 900),
    v1SalesDay(L, '2026-10-21', 300, { onlineBreakdown: { gcash: 300 } }),
    v1SalesDay(L, '2026-10-22', 100, { status: 'submitted', creditSales: 100 }), // submitted is not a sale: no doc
    v1SalesDay(L, '2026-10-23', 150, { creditSales: 150 }),
    v1SalesDay(L, '2026-10-28', 88),
  ];
  return snap({ journal, expenses, salesDays });
}

describe('inv 38 (v1 side) - document sums equal the line amounts', () => {
  // Mutants: window = the week only (the week-3 / through+3 docs vanish); a status filter that differs from the figures.
  it('per (kind, key), the posted docs dated in the week sum to the v1 line amount, over a fixture with a voided leg, a net-zero group and docs outside the week', async () => {
    const snapshot = bigSnapshot();
    const figs = computeV1Figures(snapshot, W19).stores[L]!;
    const all: Any[] = await v1Docs(snapshot, W19);
    const inWeek = (d: Any): boolean => d.date >= W19.weekStart && d.date <= W19.through;
    const groups = new Map<string, number>();
    for (const d of all.filter(inWeek)) groups.set(`${d.kind}|${d.key}`, (groups.get(`${d.kind}|${d.key}`) ?? 0) + d.amount);
    const want = new Map<string, number>();
    for (const l of figs.lines) {
      if (l.kind === 'inventory_basis') continue;
      const kind = l.kind === 'cash_bank' && l.key === 'cash__staff' ? 'staff_cash' : l.kind;
      want.set(`${kind}|${l.key}`, l.amount);
    }
    expect([...want.keys()].length, 'the fixture must exercise every doc kind').toBeGreaterThanOrEqual(9);
    for (const [k, amount] of want) expect(groups.get(k) ?? 0, `Σ docs of ${k}`).toBe(amount);
    for (const [k, amount] of groups) if (amount !== 0) expect(want.get(k), `a doc group ${k} with no v1 line`).toBe(amount);
    expect(all.every((d) => d.state === 'posted')).toBe(true);
    expect(all.some((d) => d.kind === 'inventory_basis')).toBe(false);
  });

  it('the window is [weekStart-7, through+7]: week-3 and through+3 docs are present, 10 Oct and 2 Nov are not; the voided, COGS, scope, net-zero and submitted-day items give nothing', async () => {
    const all: Any[] = await v1Docs(bigSnapshot(), W19);
    const dates = all.map((d) => d.date);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => d >= '2026-10-12' && d <= '2026-11-01'), JSON.stringify(dates)).toBe(true);
    expect(all.find((d) => d.kind === 'cash_bank' && d.key === 'cash__cashier' && d.date === '2026-10-16')?.amount).toBe(7700);
    expect(all.find((d) => d.kind === 'cash_bank' && d.key === 'cash__cashier' && d.date === '2026-10-28')?.amount).toBe(8800);
    expect(all.find((d) => d.id === 'v1:exp:ex7')?.amount).toBe(3300);
    expect(all.find((d) => d.id === 'v1:exp:ex8')?.amount).toBe(4400);
    expect(all.some((d) => d.id === 'v1:exp:ex9')).toBe(false);
    const ids = all.map((d) => d.id).join('\n');
    for (const gone of ['sale-v', 'sale-s7', 'dep1', 'too-early', 'too-late', 'v1:exp:ex5', 'v1:exp:ex6', 'v1:sd:credit:2026-10-22']) {
      expect(ids.includes(gone), gone).toBe(false);
    }
  });

  it('ids, kinds and flags are as pinned: one cash doc of 900 for the two legs of one sale; staff cash is its own kind; a channel charge is a sales_tender doc flagged channel', async () => {
    const all: Any[] = await v1Docs(bigSnapshot(), W19);
    const byId = (id: string): Any => all.find((d) => d.id === id);
    expect(byId('v1:leg:sale:sale-s1:cash__cashier:2026-10-20')).toMatchObject({ kind: 'cash_bank', key: 'cash__cashier', date: '2026-10-20', amount: 90000, state: 'posted' });
    expect(byId('v1:leg:expense_payment:ex3:cash__staff:2026-10-22')).toMatchObject({ kind: 'staff_cash', key: 'cash__staff', amount: -25000 });
    expect(byId('v1:leg:sale:sale-s2:online__gcash:2026-10-21')).toMatchObject({ kind: 'cash_bank', key: 'online__gcash', amount: 30000 });
    expect(byId('v1:leg:expense_payment:ex2:ap__sup1:2026-10-21')).toMatchObject({ kind: 'ap_supplier', key: 'ap__sup1', amount: 800000 });
    expect(byId('v1:leg:ap_payment:pay1:ap__sup1:2026-10-23')).toMatchObject({ kind: 'ap_supplier', key: 'ap__sup1', amount: -300000 });
    expect(byId('v1:leg:ap_payment:adv1:supplier_advance__sup1:2026-10-24')).toMatchObject({ kind: 'ap_supplier', key: 'supplier_advance__sup1', amount: 20000 });
    expect(byId('v1:exp:ex1')).toMatchObject({ kind: 'expense_category', key: 'E1', date: '2026-10-22', amount: 50000 });
    expect(byId('v1:exp:ex4')).toMatchObject({ kind: 'expense_category', key: 'E1', date: '2026-10-23', amount: 20000 });
    expect(byId('v1:sd:cash__cashier:2026-10-20')).toMatchObject({ kind: 'sales_tender', key: 'cash__cashier', amount: 90000 });
    expect(byId('v1:sd:online__gcash:2026-10-21')).toMatchObject({ kind: 'sales_tender', key: 'online__gcash', amount: 30000 });
    expect(byId('v1:sd:credit:2026-10-23')).toMatchObject({ kind: 'sales_tender', key: 'credit', amount: 15000 });
    expect(byId('v1:sd:channel__grab1:2026-10-21')).toMatchObject({ kind: 'sales_tender', key: 'channel__grab1', amount: 125000, channel: true });
    expect(byId('v1:sd:cash__cashier:2026-10-20').channel).not.toBe(true);
    expect(new Set(all.map((d) => d.id)).size, 'doc ids are unique').toBe(all.length);
  });

  it('another store never contributes', async () => {
    const snapshot = snap({
      stores: [{ id: L, name: 'SharEat Lipa' }, { id: 'dZUyvX4q824JBSVDAfE9', name: 'SharEat Malvar' }],
      journal: [leg({ amount: 10 }), leg({ storeId: 'dZUyvX4q824JBSVDAfE9', sourceId: 'm-sale', amount: 20 })],
      expenses: [exp('exL', { totalAmount: 5 }), exp('exM', { totalAmount: 6, storeId: 'dZUyvX4q824JBSVDAfE9' })],
    });
    const all: Any[] = await v1Docs(snapshot, W19);
    const ids = all.map((d) => d.id).sort();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('v1:exp:exL');
    expect(ids[1]).toMatch(/^v1:leg:sale:src\d+:cash__cashier:2026-10-20$/);
    expect(all.find((d) => d.id === ids[1])?.amount).toBe(1000);
  });
});

describe('receipt links on v1 documents (inv 40, 41)', () => {
  const withReceipts = (): Any =>
    snap({
      journal: [
        leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex1', accountId: 'ap__sup1', amount: 500, supplierId: 'sup1' }),
        leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex2', accountId: 'ap__sup1', amount: 600, supplierId: 'sup1' }),
        leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex3', accountId: 'ap__sup1', amount: 700, supplierId: 'sup1' }),
        leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex4', accountId: 'ap__sup1', amount: 800, supplierId: 'sup1' }),
        leg({ businessDate: '2026-10-21', sourceType: 'ap_payment', sourceId: 'ex1', accountId: 'ap__sup1', amount: 50, direction: 'out', supplierId: 'sup1' }),
      ],
      expenses: [
        exp('ex1', { totalAmount: 500, dayKey: '2026-10-21', receiptId: 'rc1' }),
        exp('ex2', { totalAmount: 600, dayKey: '2026-10-21', receiptId: 'rc2' }), // number '--': no link
        exp('ex3', { totalAmount: 700, dayKey: '2026-10-21', receiptId: 'rcGone' }), // receipt not in the snapshot: no link
        exp('ex4', { totalAmount: 800, dayKey: '2026-10-21' }), // no receipt
      ],
      receipts: [{ id: 'rc1', storeId: L, receiptNo: 'SI-00123' }, { id: 'rc2', storeId: L, receiptNo: '--' }],
    });

  // Mutants: receiptId ignored; no normalisation; '--' becomes 'rn:' and links every such document to every other.
  it('an expense_payment ap doc and an expense doc carry rn:<normalised number>; no number, a missing receipt or "--" leaves receiptId undefined; an ap_payment doc never does', async () => {
    const all: Any[] = await v1Docs(withReceipts(), W19);
    const ap = (src: string, type = 'expense_payment'): Any => all.find((d) => d.id === `v1:leg:${type}:${src}:ap__sup1:2026-10-21`);
    expect(ap('ex1').receiptId).toBe('rn:SI00123');
    expect(all.find((d) => d.id === 'v1:exp:ex1').receiptId).toBe('rn:SI00123');
    for (const src of ['ex2', 'ex3', 'ex4']) {
      expect(ap(src).receiptId, `ap doc of ${src}`).toBeUndefined();
      expect(all.find((d) => d.id === `v1:exp:${src}`).receiptId, `expense doc of ${src}`).toBeUndefined();
    }
    expect(ap('ex1', 'ap_payment').receiptId).toBeUndefined();
  });
});

// ======================================================================================================
describe('inv 39 - a v1-only expense is NOT_DOUBLE_ENTERED, PENDING_V2 beside a v2 draft, and the age rule decides the week', () => {
  async function scenario(dayKey: string, v2: 'none' | 'draft'): Promise<Any> {
    const snapshot = snap({
      journal: [saleLeg('2026-10-20'), leg({ businessDate: dayKey, sourceType: 'expense_payment', sourceId: 'ex1', amount: 500, direction: 'out' })],
      expenses: [exp('ex1', { totalAmount: 500, dayKey })],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000)],
    });
    const lines = [mkLine('cash_bank', '1110', { '2026-10-20': 100000 }), mkLine('sales_tender', '1110', { '2026-10-20': 100000 })];
    const draftDocs = v2 === 'draft'
      ? [
          cd('v2:draft:exp', 'expense_category', CAT, dayKey, 50000, { state: 'unposted' }),
          cd('v2:draft:cash', 'cash_bank', '1110', dayKey, -50000, { state: 'unposted' }),
        ]
      : [];
    return compareWeek(snapshot, W19, { lines, tradingDays: ['2026-10-20'], docs: [...v2Sale(['2026-10-20']), ...draftDocs] }, { ...KEYS, 'expense_category|ent-ex1': CAT });
  }

  // Mutant: PENDING without a v2 look (always NOT_DOUBLE_ENTERED) - and the cash side without its funding doc.
  it('nothing in v2: the expense line AND its cash line are NOT_DOUBLE_ENTERED, the week is open', async () => {
    const r = await scenario('2026-10-24', 'none');
    expect(lineOf(r, 'expense_category', CAT)).toMatchObject({ v1: 50000, v2: 0, class: 'NOT_DOUBLE_ENTERED' });
    expect(lineOf(r, 'cash_bank', '1110')).toMatchObject({ class: 'NOT_DOUBLE_ENTERED', delta: 50000 });
    expect(r.verdict).toBe('open');
  });

  // Mutants: the v1 expense matched against a posted doc; the age rule dropped.
  it('a v2 draft with the same category, date and amount: PENDING_V2 on both lines; 1 day before through the week is explained, 3 days it is open', async () => {
    const near = await scenario('2026-10-24', 'draft');
    expect(lineOf(near, 'expense_category', CAT)).toMatchObject({ class: 'PENDING_V2', paired: false });
    expect(lineOf(near, 'cash_bank', '1110')).toMatchObject({ class: 'PENDING_V2', paired: false });
    expect(near.comparedDays).toEqual(['2026-10-20']);
    expect(near.verdict).toBe('explained');
    const far = await scenario('2026-10-22', 'draft');
    expect(lineOf(far, 'expense_category', CAT).class).toBe('PENDING_V2');
    expect(far.verdict).toBe('open');
  });
});

// ======================================================================================================
describe('inv 40 - an expense on Sunday 25 Oct against a v2 expense on Monday 26 Oct is DATE_SHIFT in BOTH weeks', () => {
  const v2DocsAll = (receipt?: string): Any[] => [
    ...v2Sale(['2026-10-20', '2026-10-27']),
    cd('v2:exp', 'expense_category', CAT, '2026-10-26', 50000, receipt ? { receiptId: receipt } : {}),
    cd('v2:cash', 'cash_bank', '1110', '2026-10-26', -50000),
  ];
  const inWindow = (docsAll: Any[], w: { weekStart: string; through: string }): Any[] => {
    const lo = new Date(Date.parse(w.weekStart) - 7 * 86_400_000).toISOString().slice(0, 10);
    const hi = new Date(Date.parse(w.through) + 7 * 86_400_000).toISOString().slice(0, 10);
    return docsAll.filter((d) => d.date >= lo && d.date <= hi);
  };
  const snapshot = (receiptNo?: string): Any =>
    snap({
      through: '2026-11-01',
      journal: [saleLeg('2026-10-20'), saleLeg('2026-10-27'), leg({ businessDate: '2026-10-25', sourceType: 'expense_payment', sourceId: 'ex1', amount: 500, direction: 'out' })],
      expenses: [exp('ex1', { totalAmount: 500, dayKey: '2026-10-25', ...(receiptNo ? { receiptId: 'rc1' } : {}) })],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000), v1SalesDay(L, '2026-10-27', 1000)],
      receipts: receiptNo ? [{ id: 'rc1', storeId: L, receiptNo }] : [],
    });
  async function both(receiptNo: string | undefined, v2Receipt: string | undefined): Promise<[Any, Any]> {
    const s = snapshot(receiptNo);
    const docsAll = v2DocsAll(v2Receipt);
    const w19 = await compareWeek(s, W19, {
      lines: [mkLine('cash_bank', '1110', { '2026-10-20': 100000 }), mkLine('sales_tender', '1110', { '2026-10-20': 100000 })],
      tradingDays: ['2026-10-20'], docs: inWindow(docsAll, W19),
    }, { ...KEYS, 'expense_category|ent-ex1': CAT });
    const w26 = await compareWeek(s, W26, {
      lines: [
        mkLine('cash_bank', '1110', { '2026-10-26': -50000, '2026-10-27': 100000 }),
        mkLine('sales_tender', '1110', { '2026-10-27': 100000 }),
        mkLine('expense_category', CAT, { '2026-10-26': 50000 }),
      ],
      tradingDays: ['2026-10-27'], docs: inWindow(docsAll, W26),
    }, { ...KEYS, 'expense_category|ent-ex1': CAT });
    return [w19, w26];
  }

  // Mutant: doc window = the week only (Sunday's doc is invisible to the Monday week and vice versa).
  it('v1Documents for the week of 26 Oct holds the 25 Oct expense and its cash leg (the window reaches back 7 days)', async () => {
    const all: Any[] = await v1Docs(snapshot(), W26);
    expect(all.find((d) => d.id === 'v1:exp:ex1')).toMatchObject({ date: '2026-10-25', amount: 50000 });
    expect(all.find((d) => d.id === 'v1:leg:expense_payment:ex1:cash__cashier:2026-10-25')).toMatchObject({ amount: -50000 });
  });

  it('no receipt on the v1 expense: both weeks have DATE_SHIFT paired lines and are explained', async () => {
    const [a, b] = await both(undefined, undefined);
    for (const r of [a, b]) {
      expect(lineOf(r, 'expense_category', CAT)).toMatchObject({ class: 'DATE_SHIFT', paired: true });
      expect(lineOf(r, 'cash_bank', '1110')).toMatchObject({ class: 'DATE_SHIFT', paired: true });
      expect(r.verdict).toBe('explained');
    }
  });

  it('the same normalised receipt number on both sides pairs; two different numbers never do (that week is open)', async () => {
    const [a, b] = await both('SI-00200', 'rn:SI00200');
    for (const r of [a, b]) {
      expect(lineOf(r, 'expense_category', CAT)).toMatchObject({ class: 'DATE_SHIFT', paired: true });
      expect(r.verdict).toBe('explained');
    }
    const [c, d] = await both('SI-00201', 'rn:SI00200');
    for (const r of [c, d]) {
      expect(lineOf(r, 'expense_category', CAT).class, 'different numbers never pair').not.toBe('DATE_SHIFT');
      expect(r.verdict).toBe('open');
    }
  });
});

// ======================================================================================================
describe('inv 41 - AP_AT_INVOICE pairs a v1 credit expense with the v2 invoice by receipt number', () => {
  async function ap(v1Receipt: string, v2Receipt: string | undefined): Promise<Any> {
    const snapshot = snap({
      journal: [saleLeg('2026-10-20'), leg({ businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex41', accountId: 'ap__sup1', amount: 8000, supplierId: 'sup1' })],
      expenses: [exp('ex41', { totalAmount: 8000, dayKey: '2026-10-21', expenseEntryGroup: 'COGS', receiptId: 'rc41' })],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000)],
      receipts: [{ id: 'rc41', storeId: L, receiptNo: v1Receipt }],
    });
    return compareWeek(
      snapshot, W19,
      {
        lines: [mkLine('cash_bank', '1110', { '2026-10-20': 100000 }), mkLine('sales_tender', '1110', { '2026-10-20': 100000 })],
        tradingDays: ['2026-10-20'],
        docs: [...v2Sale(['2026-10-20']), cd('v2:inv', 'ap_supplier', SUP, '2026-10-27', 800000, v2Receipt ? { receiptId: v2Receipt } : {})],
      },
      { ...KEYS, 'ap_supplier|ap__sup1': SUP, 'inventory_basis|COGS': 'COGS' },
    );
  }

  // Mutants: receiptId ignored (falls to DATE_SHIFT); no normalisation ('SI-00123' never meets 'si00123').
  it('v1 credit expense 8,000.00 on 21 Oct with receipt "SI-00123", v2 invoice "si00123" on 27 Oct: the week of 19 Oct has AP_AT_INVOICE, paired, and is explained', async () => {
    const r = await ap('SI-00123', 'rn:SI00123');
    expect(lineOf(r, 'ap_supplier', SUP)).toMatchObject({ v1: 800000, v2: 0, delta: -800000, class: 'AP_AT_INVOICE', paired: true });
    expect(r.verdict).toBe('explained');
  });

  it('invoice "SI-00124" does not pair as AP_AT_INVOICE (the line is NOT_DOUBLE_ENTERED and the week open)', async () => {
    const r = await ap('SI-00124', 'rn:SI00123');
    const l = lineOf(r, 'ap_supplier', SUP);
    expect(l.class).not.toBe('AP_AT_INVOICE');
    expect(l.class).toBe('NOT_DOUBLE_ENTERED');
    expect(r.verdict).toBe('open');
  });
});

// ======================================================================================================
describe('inv 43 - docs outside the week never turn a no-data week into data (compare.ts `empty`)', () => {
  // Hand-built docs on purpose: this one is red on the BEHAVIOUR of compare.ts (docs are read by `empty` today).
  // Mutant: docs counted in `empty`.
  it('a week with no figures on either side whose only docs fall at week-2 / through+2 stays no_data with no lines', () => {
    const r = compareStoreWeek({
      orgId: 'org-1', storeId: 'LIPA', ...W19,
      v1: { lines: [], tradingDays: [], cashResidual: {}, scope: [], flags: [] },
      v2: { lines: [], tradingDays: [] },
      keyMap: {},
      v1Docs: [cd('v1:exp:old', 'expense_category', 'ent-old', '2026-10-17', 12300)],
      v2Docs: [cd('v2:late', 'cash_bank', '1110', '2026-10-27', 5000), cd('v2:draft', 'expense_category', CAT, '2026-10-27', 700, { state: 'unposted' })],
      dispositions: [],
    });
    expect(r.verdict).toBe('no_data');
    expect(r.lines).toEqual([]);
    expect(r.comparedDays).toEqual([]);
  });

  it('through v1Documents: a v1 expense at week-2 alone gives docs but the week is still no_data', async () => {
    const snapshot = snap({ expenses: [exp('exOld', { totalAmount: 123, dayKey: '2026-10-17' })] });
    expect((await v1Docs(snapshot, W19)).length).toBe(1);
    const r = await compareWeek(snapshot, W19, { lines: [], tradingDays: [], docs: [] }, {});
    expect(r.verdict).toBe('no_data');
  });
});

// ======================================================================================================
describe('inv 44 - documents are part of the identity, and their order is not', () => {
  const base = (): Any => ({
    snapshot: snap({
      journal: [saleLeg('2026-10-20'), leg({ businessDate: '2026-10-24', sourceType: 'expense_payment', sourceId: 'ex1', amount: 500, direction: 'out' })],
      expenses: [exp('ex1', { totalAmount: 500, dayKey: '2026-10-24' })],
      salesDays: [v1SalesDay(L, '2026-10-20', 1000)],
    }),
    v2: (docs: Any[]): Any => ({
      lines: [mkLine('cash_bank', '1110', { '2026-10-20': 100000 }), mkLine('sales_tender', '1110', { '2026-10-20': 100000 })],
      tradingDays: ['2026-10-20'], docs,
    }),
    keyMap: { ...KEYS, 'expense_category|ent-ex1': CAT },
    drafts: [
      cd('v2:draft:exp', 'expense_category', CAT, '2026-10-24', 50000, { state: 'unposted' }),
      cd('v2:draft:cash', 'cash_bank', '1110', '2026-10-24', -50000, { state: 'unposted' }),
    ],
  });

  // Mutant: insertion-order docs. NOTE: the v2-order half is already true on HEAD (compare sorts) - it guards the wiring; the v1 half needs docs.ts.
  it('shuffled v2 docs and a shuffled snapshot give identical lines and identical fingerprints', async () => {
    const b = base();
    const docsA = [...v2Sale(['2026-10-20']), ...b.drafts];
    const docsB = [...docsA].reverse();
    const r1 = await compareWeek(b.snapshot, W19, b.v2(docsA), b.keyMap);
    const shuffled = { ...b.snapshot, journal: [...b.snapshot.journal].reverse(), expenses: [...b.snapshot.expenses].reverse(), salesDays: [...b.snapshot.salesDays].reverse() };
    const r2 = await compareWeek(shuffled, W19, b.v2(docsB), b.keyMap);
    expect(r2.lines).toEqual(r1.lines);
    expect(r2.v1Fingerprint).toBe(r1.v1Fingerprint);
    expect(r2.v2Fingerprint).toBe(r1.v2Fingerprint);
  });

  it('a v2 draft changes only the documents, and the v2 fingerprint moves; a v1 receipt link changes only v1 documents, and the v1 fingerprint moves', async () => {
    const b = base();
    const without = await compareWeek(b.snapshot, W19, b.v2(v2Sale(['2026-10-20'])), b.keyMap);
    const withDrafts = await compareWeek(b.snapshot, W19, b.v2([...v2Sale(['2026-10-20']), ...b.drafts]), b.keyMap);
    expect(withDrafts.v2Fingerprint).not.toBe(without.v2Fingerprint);
    expect(withDrafts.v1Fingerprint).toBe(without.v1Fingerprint);
    const linked = {
      ...b.snapshot,
      expenses: [{ ...b.snapshot.expenses[0], receiptId: 'rc1' }],
      receipts: [{ id: 'rc1', storeId: L, receiptNo: 'SI-00500' }],
    };
    const r3 = await compareWeek(linked, W19, b.v2(v2Sale(['2026-10-20'])), b.keyMap);
    expect(r3.v1Fingerprint, 'the receipt link is in the v1 documents, so in the identity').not.toBe(without.v1Fingerprint);
    expect(r3.v2Fingerprint).toBe(without.v2Fingerprint);
  });
});
