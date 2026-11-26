import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-639 - expense alerts. docs/tasks/639-expense-alerts.md.
 *
 * Every detector gets a test that makes its condition true and proves it fires, and tests that prove it stays quiet on normal data. Each
 * `[kills: ...]` names the wrong implementation that turns the test red. Today is pinned with `asOf` (a Wednesday), so the weeks are fixed:
 * this week is Monday 2026-11-16 to Sunday 2026-11-22, and the eight full weeks before it start on the Mondays in HISTORY_MONDAYS.
 * The last describe uses real dates (the acknowledge flow reads the real clock).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, expenseAlertsRepo, manilaToday, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { money } from '@shareat/core/money';
import { acknowledgeFinding, expenseAlertThresholds, listFindings, readinessOf, recordFindingObservations } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const ASOF = '2026-11-18';
const THIS_MONDAY = '2026-11-16';
const HISTORY_MONDAYS = ['2026-11-09', '2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21'];

function dayOf(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const T: expenseAlertsRepo.ExpenseAlertThresholds = { spikeX100: 150n, minAmount: money('5000.00'), outlierX100: 500n, frequencyX100: 200n, frequencyMinCount: 4 };

async function fixture(hint: string) {
  const code = uid(`ea-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${`Store ${name}`}) returning id`;
    return s!.id;
  };
  const mkPerson = async (name: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    return p!.id;
  };
  const storeId = await mkStore('A');
  const store2Id = await mkStore('B');
  const creatorId = await mkPerson('Recorder');
  const checkerId = await mkPerson('Checker');
  const approverId = await mkPerson('Approver');
  return { orgId, storeId, store2Id, creatorId, checkerId, approverId, suppliers: new Map<string, string>(), invoices: new Map<string, string>() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function category(f: Fixture, name: string, group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL' = 'COGS'): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code) values (${f.orgId}, ${group}, ${`${name}-${uid('c')}`}, '6200') returning id`;
  return c!.id;
}

async function supplierOf(f: Fixture, name: string): Promise<string> {
  const known = f.suppliers.get(name);
  if (known) return known;
  const [s] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${`${name} ${uid('s')}`}, ${f.checkerId}) returning id`;
  f.suppliers.set(name, s!.id);
  return s!.id;
}

/** One verified invoice per store and supplier, big enough to hold every expense a test records against it. */
async function invoiceOf(f: Fixture, storeId: string, supplierId: string): Promise<string> {
  const key = `${storeId}:${supplierId}`;
  const known = f.invoices.get(key);
  if (known) return known;
  const [i] = await sql<{ id: string }[]>`
    insert into supplier_invoices
      (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
       attested_supplier, attested_invoice, attested_items, attested_price, created_by)
    values (${f.orgId}, ${storeId}, ${supplierId}, '2026-01-01', '9999999.00', 'verified', ${f.checkerId}, now(), true, true, true, true, ${f.creatorId})
    returning id`;
  f.invoices.set(key, i!.id);
  return i!.id;
}

interface ExpenseOpts {
  categoryId: string;
  date: string;
  amount: string;
  storeId?: string;
  supplier?: string;
  status?: 'draft' | 'posted' | 'voided';
  approvedBy?: string | null;
}

/** Inserted directly: these tests are about the DETECTORS, not about the create/approve workflow (same reasoning as budgets.test.ts). */
async function exp(f: Fixture, o: ExpenseOpts): Promise<string> {
  const storeId = o.storeId ?? f.storeId;
  const supplierId = await supplierOf(f, o.supplier ?? 'Supplier');
  const invoiceId = await invoiceOf(f, storeId, supplierId);
  const [e] = await sql<{ id: string }[]>`
    insert into expenses
      (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by, approved_by)
    values (${f.orgId}, ${storeId}, ${o.date}, ${o.amount}, ${o.categoryId}, ${supplierId}, ${invoiceId}, 'alert fixture', ${o.status ?? 'posted'}, ${f.creatorId}, ${o.approvedBy ?? null})
    returning id`;
  return e!.id;
}

/** One expense on the Tuesday of each of the first `weeks` history weeks. */
async function history(f: Fixture, categoryId: string, weeks: number, amount: string, extra: Partial<ExpenseOpts> = {}): Promise<void> {
  for (let i = 0; i < weeks; i++) await exp(f, { categoryId, date: dayOf(HISTORY_MONDAYS[i]!, 1), amount, ...extra });
}

const spikes = (f: Fixture, t = T) => asOrg(f.orgId, (tx) => expenseAlertsRepo.categorySpendAlerts(tx, f.orgId, () => t, ASOF));
const outliers = (f: Fixture, t = T) => asOrg(f.orgId, (tx) => expenseAlertsRepo.singleExpenseOutliers(tx, f.orgId, () => t, ASOF));
const duplicates = (f: Fixture, t = T) => asOrg(f.orgId, (tx) => expenseAlertsRepo.possibleDuplicateExpenses(tx, f.orgId, () => t, ASOF));
const selfApproved = (f: Fixture, t = T) => asOrg(f.orgId, (tx) => expenseAlertsRepo.selfApprovedExpenses(tx, f.orgId, () => t, ASOF));
const overBudget = (f: Fixture) => asOrg(f.orgId, (tx) => expenseAlertsRepo.expenseOverBudget(tx, f.orgId, ASOF));
const kindsOf = (found: { kind: string }[]) => found.map((x) => x.kind);

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// -------------------------------------------------------------------------------------
describe('T-639 category spend spike', () => {
  it('fires on a crafted spike: 200,000 this week against a usual 100,000, with the amounts and the ratio in the words [kills: a detector that never fires; a ratio or amount missing from the text]', async () => {
    const f = await fixture('spike-fire');
    const meat = await category(f, 'Meat');
    await history(f, meat, 5, '100000.00');
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '120000.00' });
    await exp(f, { categoryId: meat, date: '2026-11-18', amount: '80000.00' });
    const found = await spikes(f);
    expect(kindsOf(found)).toEqual(['expenseCategorySpike']);
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.storeId).toBe(f.storeId);
    expect(found[0]!.key).toContain(THIS_MONDAY);
    expect(found[0]!.detail).toContain('₱200,000.00');
    expect(found[0]!.detail).toContain('₱100,000.00');
    expect(found[0]!.detail).toContain('2.0×');
    expect(found[0]!.detail).toContain('this week');
  });

  it('last week is judged too, against the eight weeks before it: a Friday spike with nothing since still shows on the Monday after, keyed by last week [kills: judging only the current week]', async () => {
    const f = await fixture('spike-lastweek');
    const meat = await category(f, 'Meat');
    for (const m of HISTORY_MONDAYS.slice(1, 5)) await exp(f, { categoryId: meat, date: dayOf(m, 1), amount: '100000.00' });
    await exp(f, { categoryId: meat, date: dayOf(HISTORY_MONDAYS[0]!, 4), amount: '200000.00' });
    const found = await spikes(f);
    expect(kindsOf(found)).toEqual(['expenseCategorySpike']);
    expect(found[0]!.key).toContain(HISTORY_MONDAYS[0]!);
    expect(found[0]!.detail).toContain('last week');
    expect(found[0]!.detail).not.toContain('this week');
  });

  it('stays quiet on a normal week: 100,000 against a usual 100,000 [kills: flagging every week]', async () => {
    const f = await fixture('spike-quiet');
    const meat = await category(f, 'Meat');
    await history(f, meat, 5, '100000.00');
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '100000.00' });
    expect(await spikes(f)).toEqual([]);
  });

  it('an empty history raises no false alarm: a store whose only spending is this week, and one with only two earlier weeks [kills: judging against zero or against a thin history]', async () => {
    const f = await fixture('spike-empty');
    const meat = await category(f, 'Meat');
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '200000.00' });
    expect(await spikes(f)).toEqual([]);
    const g = await fixture('spike-thin');
    const rice = await category(g, 'Rice');
    await history(g, rice, 2, '100000.00');
    await exp(g, { categoryId: rice, date: '2026-11-17', amount: '300000.00' });
    expect(await spikes(g)).toEqual([]);
  });

  it('the usual week is the median of the weeks that HAD spending: three weeks of 100,000 among eight, 120,000 this week is quiet [kills: counting zero weeks, whose median is 0 and flags 120,000]', async () => {
    const f = await fixture('spike-zeros');
    const meat = await category(f, 'Meat');
    for (const i of [0, 2, 4]) await exp(f, { categoryId: meat, date: dayOf(HISTORY_MONDAYS[i]!, 1), amount: '100000.00' });
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '120000.00' });
    expect(await spikes(f)).toEqual([]);
    await exp(f, { categoryId: meat, date: '2026-11-18', amount: '60000.00' });
    expect(kindsOf(await spikes(f))).toEqual(['expenseCategorySpike']);
  });

  it('weeks run Monday to Sunday: a Sunday expense belongs to the week that is ending, not the next [kills: Sunday-start weeks]', async () => {
    const f = await fixture('spike-week');
    const meat = await category(f, 'Meat');
    await exp(f, { categoryId: meat, date: '2026-11-10', amount: '100000.00' });
    await exp(f, { categoryId: meat, date: '2026-11-15', amount: '150000.00' }); // Sunday: the 11-09 week, usual becomes the median of 250k, 100k, 100k
    await exp(f, { categoryId: meat, date: '2026-11-03', amount: '100000.00' });
    await exp(f, { categoryId: meat, date: '2026-10-27', amount: '100000.00' });
    await exp(f, { categoryId: meat, date: '2026-11-16', amount: '100000.00' }); // Monday: this week
    expect(await spikes(f)).toEqual([]);
  });

  it('only operating spend counts, and a voided expense never does: a CAPEX purchase and a voided 100,000 raise nothing [kills: counting CAPEX or voided rows]', async () => {
    const f = await fixture('spike-groups');
    const oven = await category(f, 'Oven', 'CAPEX');
    await history(f, oven, 5, '100000.00');
    await exp(f, { categoryId: oven, date: '2026-11-17', amount: '300000.00' });
    const meat = await category(f, 'Meat');
    await history(f, meat, 5, '100000.00');
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '100000.00' });
    await exp(f, { categoryId: meat, date: '2026-11-18', amount: '100000.00', status: 'voided', supplier: 'Other' });
    expect(await spikes(f)).toEqual([]);
  });

  it('each store on its own: a spike at store A names A and leaves store B alone [kills: pooling stores]', async () => {
    const f = await fixture('spike-stores');
    const meat = await category(f, 'Meat');
    await history(f, meat, 5, '100000.00');
    await history(f, meat, 5, '100000.00', { storeId: f.store2Id });
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '250000.00' });
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '100000.00', storeId: f.store2Id });
    const found = await spikes(f);
    expect(found.map((x) => x.storeId)).toEqual([f.storeId]);
  });

  it('the thresholds are respected, and a per-category resolver wins over the default: at 3 times 200k is quiet; a 150k floor is quiet; two categories with different resolved thresholds flag only the one that crosses its own [kills: 1.5 or 5,000 hard-coded; one threshold for every category]', async () => {
    const f = await fixture('spike-thr');
    const meat = await category(f, 'Meat');
    await history(f, meat, 5, '100000.00');
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '200000.00' });
    expect(await spikes(f, { ...T, spikeX100: 300n })).toEqual([]);
    expect(await spikes(f, { ...T, minAmount: money('150000.00') })).toEqual([]);
    expect(kindsOf(await spikes(f, { ...T, spikeX100: 150n }))).toEqual(['expenseCategorySpike']);

    const rice = await category(f, 'Rice');
    await history(f, rice, 5, '100000.00');
    await exp(f, { categoryId: rice, date: '2026-11-17', amount: '200000.00' });
    const found = await asOrg(f.orgId, (tx) =>
      expenseAlertsRepo.categorySpendAlerts(tx, f.orgId, (categoryId) => (categoryId === meat ? { ...T, spikeX100: 300n } : T), ASOF),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toContain(rice);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 expense frequency spike', () => {
  const small = '100.00';

  it('fires on a jump: about 2 a week for 8 weeks, then 5 this week [kills: a detector that never fires]', async () => {
    const f = await fixture('freq-fire');
    const supplies = await category(f, 'Supplies');
    for (let w = 0; w < 8; w++) for (const d of [1, 2]) await exp(f, { categoryId: supplies, date: dayOf(HISTORY_MONDAYS[w]!, d), amount: small, supplier: `S${w}${d}` });
    for (let d = 0; d < 3; d++) await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, d), amount: small, supplier: `T${d}` });
    for (let d = 0; d < 2; d++) await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, d), amount: '101.00', supplier: `U${d}` });
    const found = await spikes(f);
    expect(kindsOf(found)).toEqual(['expenseFrequencySpike']);
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.detail).toMatch(/5 expenses this week/);
    expect(found[0]!.detail).toMatch(/about 2\.0 a week/);
  });

  it('last week is judged too for a jump in count: 5 expenses last week against about 2 a week before it [kills: judging only the current week]', async () => {
    const f = await fixture('freq-lastweek');
    const supplies = await category(f, 'Supplies');
    for (let w = 1; w < 8; w++) for (const d of [1, 2]) await exp(f, { categoryId: supplies, date: dayOf(HISTORY_MONDAYS[w]!, d), amount: small, supplier: `S${w}${d}` });
    for (let d = 0; d < 5; d++) await exp(f, { categoryId: supplies, date: dayOf(HISTORY_MONDAYS[0]!, d), amount: small, supplier: `L${d}` });
    const found = await spikes(f);
    expect(kindsOf(found)).toEqual(['expenseFrequencySpike']);
    expect(found[0]!.key).toContain(HISTORY_MONDAYS[0]!);
    expect(found[0]!.detail).toMatch(/5 expenses last week/);
  });

  it('exactly double the usual is not a jump: 4 this week against about 2 a week [kills: >= instead of >]', async () => {
    const f = await fixture('freq-edge');
    const supplies = await category(f, 'Supplies');
    for (let w = 0; w < 8; w++) for (const d of [1, 2]) await exp(f, { categoryId: supplies, date: dayOf(HISTORY_MONDAYS[w]!, d), amount: small, supplier: `S${w}${d}` });
    for (let d = 0; d < 3; d++) await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, d), amount: small, supplier: `T${d}` });
    await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, 1), amount: '101.00', supplier: 'U' });
    expect(await spikes(f)).toEqual([]);
  });

  it('the minimum count holds: a category that normally has one a month does not flag on three, and does on four [kills: ignoring the minimum]', async () => {
    const f = await fixture('freq-min');
    const supplies = await category(f, 'Supplies');
    await history(f, supplies, 4, small);
    for (let d = 0; d < 3; d++) await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, d), amount: small, supplier: `T${d}` });
    expect(await spikes(f)).toEqual([]);
    await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, 1), amount: small, supplier: 'T3' });
    expect(kindsOf(await spikes(f))).toEqual(['expenseFrequencySpike']);
  });

  it('a thin history (two weeks) never flags, and the multiplier is a threshold: 3 times makes 5 against about 2 quiet [kills: judging on two weeks; 2 hard-coded]', async () => {
    const f = await fixture('freq-thin');
    const supplies = await category(f, 'Supplies');
    for (let w = 0; w < 2; w++) for (const d of [1, 2, 3, 4]) await exp(f, { categoryId: supplies, date: dayOf(HISTORY_MONDAYS[w]!, d), amount: small, supplier: `S${w}${d}` });
    for (let d = 0; d < 6; d++) await exp(f, { categoryId: supplies, date: dayOf(THIS_MONDAY, d % 3), amount: small, supplier: `T${d}` });
    expect(await spikes(f)).toEqual([]);

    const g = await fixture('freq-thr');
    const cat = await category(g, 'Supplies');
    for (let w = 0; w < 8; w++) for (const d of [1, 2]) await exp(g, { categoryId: cat, date: dayOf(HISTORY_MONDAYS[w]!, d), amount: small, supplier: `S${w}${d}` });
    for (let d = 0; d < 5; d++) await exp(g, { categoryId: cat, date: dayOf(THIS_MONDAY, d % 3), amount: small, supplier: `T${d}` });
    expect(await spikes(g, { ...T, frequencyX100: 300n })).toEqual([]);
    expect(kindsOf(await spikes(g, T))).toEqual(['expenseFrequencySpike']);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 single expense outlier', () => {
  const NORMAL = ['10000.00', '10200.00', '9800.00', '10100.00', '9900.00', '10000.00', '10300.00', '9700.00', '10000.00', '10000.00', '10100.00'];

  async function normals(f: Fixture, categoryId: string, firstBack: number, step: number, count = NORMAL.length): Promise<void> {
    for (let i = 0; i < count; i++) await exp(f, { categoryId, date: dayOf(ASOF, -(firstBack + step * i)), amount: NORMAL[i]! });
  }

  it('fires on one expense far above the usual, and only that one [kills: a detector that never fires; flagging the normal ones]', async () => {
    const f = await fixture('out-fire');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 20, 5);
    const big = await exp(f, { categoryId: supplies, date: dayOf(ASOF, -1), amount: '40000.00', supplier: 'Big' });
    const found = await outliers(f);
    expect(found.map((x) => x.key)).toEqual([`expenseOutlier:${big}`]);
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.detail).toContain('₱40,000.00');
    expect(found[0]!.detail).toContain('₱10,000.00');
  });

  it('stays quiet on normal data: a 10,300 expense against a 10,000 usual with a spread of 100 [kills: flagging anything above the median]', async () => {
    const f = await fixture('out-quiet');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 20, 5);
    await exp(f, { categoryId: supplies, date: dayOf(ASOF, -1), amount: '10300.00', supplier: 'Slightly more' });
    expect(await outliers(f)).toEqual([]);
  });

  it('needs ten earlier expenses: five normal ones and a huge one raise nothing [kills: judging a thin history]', async () => {
    const f = await fixture('out-thin');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 20, 5, 5);
    await exp(f, { categoryId: supplies, date: dayOf(ASOF, -1), amount: '90000.00', supplier: 'Big' });
    expect(await outliers(f)).toEqual([]);
  });

  it('the history is the last 90 days: eleven normal expenses 100 days back count for nothing [kills: an unbounded history]', async () => {
    const f = await fixture('out-window');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 100, 4);
    await exp(f, { categoryId: supplies, date: dayOf(ASOF, -1), amount: '90000.00', supplier: 'Big' });
    expect(await outliers(f)).toEqual([]);
  });

  it('only the last 30 days are judged: a big expense 45 days ago is no longer a finding [kills: no recency]', async () => {
    const f = await fixture('out-recent');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 50, 3);
    await exp(f, { categoryId: supplies, date: dayOf(ASOF, -45), amount: '90000.00', supplier: 'Big' });
    expect(await outliers(f)).toEqual([]);
  });

  it('the peso floor and k are respected: 10,600 is over the limit but under the floor; at k=10 the limit moves up [kills: ignoring the floor; k hard-coded]', async () => {
    const f = await fixture('out-thr');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 20, 5);
    await exp(f, { categoryId: supplies, date: dayOf(ASOF, -1), amount: '10600.00', supplier: 'Bit more' });
    expect(await outliers(f)).toEqual([]);
    expect(kindsOf(await outliers(f, { ...T, minAmount: money('0.00') }))).toEqual(['expenseOutlier']);
    expect(await outliers(f, { ...T, minAmount: money('0.00'), outlierX100: 1000n })).toEqual([]);
  });

  it('a different store has its own usual: store B is judged on its own history, not store A [kills: pooling stores]', async () => {
    const f = await fixture('out-store');
    const supplies = await category(f, 'Supplies', 'OPEX');
    await normals(f, supplies, 20, 5);
    await exp(f, { categoryId: supplies, date: dayOf(ASOF, -1), amount: '40000.00', supplier: 'Big', storeId: f.store2Id });
    expect(await outliers(f)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 possible duplicate', () => {
  it('fires on the same store, supplier and amount two days apart: one finding for the pair, naming both days [kills: a detector that never fires; one finding per side]', async () => {
    const f = await fixture('dup-fire');
    const rent = await category(f, 'Repairs', 'OPEX');
    const a = await exp(f, { categoryId: rent, date: '2026-11-10', amount: '8000.00' });
    const b = await exp(f, { categoryId: rent, date: '2026-11-12', amount: '8000.00' });
    const found = await duplicates(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('expenseDuplicate');
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.key).toBe(`expenseDuplicate:${a}`); // keyed by the earlier of the two
    expect(found[0]!.detail).toContain('₱8,000.00');
    expect(b).not.toBe(a);
  });

  it('three equal expenses are ONE finding listing all three, keyed by the earliest; a far-away pair of the same shape is its own finding [kills: per-pair keys (three findings); merging clusters that are not within 3 days]', async () => {
    const f = await fixture('dup-cluster');
    const cat = await category(f, 'Repairs', 'OPEX');
    const first = await exp(f, { categoryId: cat, date: '2026-11-10', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-12', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-17', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-17', amount: '8000.00' });
    const found = await duplicates(f);
    expect(found).toHaveLength(2);
    const trio = found.find((x) => x.key === `expenseDuplicate:${first}`)!;
    expect(trio.detail).toContain('3 ₱8,000.00 expenses');
    expect(found.some((x) => x.key.startsWith('expenseDuplicate:') && x.key !== trio.key && x.detail.includes('both on'))).toBe(true);
  });

  it('three days apart is still a duplicate, four is not [kills: < 3 or <= 4]', async () => {
    const f = await fixture('dup-edge');
    const cat = await category(f, 'Repairs', 'OPEX');
    await exp(f, { categoryId: cat, date: '2026-11-09', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-12', amount: '8000.00' });
    expect(await duplicates(f)).toHaveLength(1);
    const g = await fixture('dup-edge4');
    const c2 = await category(g, 'Repairs', 'OPEX');
    await exp(g, { categoryId: c2, date: '2026-11-08', amount: '8000.00' });
    await exp(g, { categoryId: c2, date: '2026-11-12', amount: '8000.00' });
    expect(await duplicates(g)).toEqual([]);
  });

  it('stays quiet when anything differs: one centavo, another supplier, another store, a voided twin, or an amount under the floor [kills: loosening any one of the four matches or the floor]', async () => {
    const f = await fixture('dup-quiet');
    const cat = await category(f, 'Repairs', 'OPEX');
    await exp(f, { categoryId: cat, date: '2026-11-10', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '8000.01' });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '8000.00', supplier: 'Another' });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '8000.00', storeId: f.store2Id });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '8000.00', status: 'voided', supplier: 'Another' });
    await exp(f, { categoryId: cat, date: '2026-11-10', amount: '300.00', supplier: 'Small' });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '300.00', supplier: 'Small' });
    expect(await duplicates(f)).toEqual([]);
  });

  it('an old pair is no longer news: two matching expenses in September raise nothing in mid November [kills: no recency]', async () => {
    const f = await fixture('dup-old');
    const cat = await category(f, 'Repairs', 'OPEX');
    await exp(f, { categoryId: cat, date: '2026-09-01', amount: '8000.00' });
    await exp(f, { categoryId: cat, date: '2026-09-02', amount: '8000.00' });
    expect(await duplicates(f)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 self-approved', () => {
  it('fires when the recorder is the approver, and names them [kills: a detector that never fires]', async () => {
    const f = await fixture('self-fire');
    const cat = await category(f, 'Repairs', 'OPEX');
    const id = await exp(f, { categoryId: cat, date: '2026-11-10', amount: '8000.00', approvedBy: f.creatorId });
    const found = await selfApproved(f);
    expect(found.map((x) => x.key)).toEqual([`expenseSelfApproved:${id}`]);
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.detail).toContain('Recorder');
    expect(found[0]!.detail).toContain('₱8,000.00');
  });

  it('stays quiet when someone else approved, when it is still a draft, under the floor, or older than 30 days [kills: matching on approved_by alone; ignoring status, floor or recency]', async () => {
    const f = await fixture('self-quiet');
    const cat = await category(f, 'Repairs', 'OPEX');
    await exp(f, { categoryId: cat, date: '2026-11-10', amount: '8000.00', approvedBy: f.approverId });
    await exp(f, { categoryId: cat, date: '2026-11-10', amount: '8000.00', status: 'draft', supplier: 'Draft' });
    await exp(f, { categoryId: cat, date: '2026-11-10', amount: '300.00', approvedBy: f.creatorId, supplier: 'Small' });
    await exp(f, { categoryId: cat, date: '2026-09-01', amount: '8000.00', approvedBy: f.creatorId, supplier: 'Old' });
    expect(await selfApproved(f)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 over budget', () => {
  async function budget(f: Fixture, categoryId: string, periodKey: string, amount: string, reset?: { at: string }): Promise<string> {
    const [b] = await sql<{ id: string }[]>`
      insert into expense_budgets (org_id, store_id, category_id, period_key, amount, auto_reissue, reissue_interval, last_reset_at)
      values (${f.orgId}, ${f.storeId}, ${categoryId}, ${periodKey}, ${amount}, ${reset ? true : false}, ${reset ? 'weekly' : null}, ${reset ? reset.at : null})
      returning id`;
    return b!.id;
  }

  it('fires when posted spending passes the cap, with the overage in the words [kills: a detector that never fires; a wrong overage]', async () => {
    const f = await fixture('bud-fire');
    const cat = await category(f, 'Repairs', 'OPEX');
    const id = await budget(f, cat, '202611', '10000.00');
    await exp(f, { categoryId: cat, date: '2026-11-05', amount: '12000.00' });
    const found = await overBudget(f);
    expect(found.map((x) => x.key)).toEqual([`expenseOverBudget:${id}`]);
    expect(found[0]!.severity).toBe('soft');
    expect(found[0]!.detail).toContain('₱2,000.00 over');
  });

  it('reaching the cap exactly is not over it; a draft is not spending; another month budget is not this month [kills: >= instead of >; counting drafts; ignoring the period]', async () => {
    const f = await fixture('bud-quiet');
    const cat = await category(f, 'Repairs', 'OPEX');
    await budget(f, cat, '202611', '10000.00');
    await exp(f, { categoryId: cat, date: '2026-11-05', amount: '10000.00' });
    await exp(f, { categoryId: cat, date: '2026-11-06', amount: '9000.00', status: 'draft', supplier: 'Draft' });
    const other = await category(f, 'Fuel', 'OPEX');
    await budget(f, other, '202610', '1000.00');
    await exp(f, { categoryId: other, date: '2026-10-05', amount: '5000.00' });
    expect(await overBudget(f)).toEqual([]);
  });

  it('a weekly cap is measured from its last reset, not the month: a reset on 16 November counts the 17th and not the 5th [kills: bounding a reset budget by its period key]', async () => {
    const f = await fixture('bud-reset');
    const cat = await category(f, 'Repairs', 'OPEX');
    const id = await budget(f, cat, '202610', '10000.00', { at: '2026-11-16T12:00:00Z' });
    await exp(f, { categoryId: cat, date: '2026-11-05', amount: '50000.00' });
    expect(await overBudget(f)).toEqual([]);
    await exp(f, { categoryId: cat, date: '2026-11-17', amount: '12000.00', supplier: 'Later' });
    expect((await overBudget(f)).map((x) => x.key)).toEqual([`expenseOverBudget:${id}`]);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 thresholds come from the business rules, and the findings feed carries the alerts', () => {
  it('with no row set the registry defaults apply: 1.5 times, 5,000 pesos, 5, 2, 4; a stored row for the day wins [kills: defaults dropped; a stored rule ignored]', async () => {
    const f = await fixture('thr-rules');
    const defaults = await asOrg(f.orgId, (tx) => expenseAlertThresholds(tx, f.orgId, ASOF));
    expect(defaults).toEqual({ spikeX100: 150n, minAmount: '5000.00', outlierX100: 500n, frequencyX100: 200n, frequencyMinCount: 4 });
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${f.orgId}, 'expenses.alert_spike_multiplier', '3.000000', '2026-01-01', null, 'test')`;
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${f.orgId}, 'expenses.alert_min_amount', '250000.00', '2026-12-01', null, 'later')`;
    const set = await asOrg(f.orgId, (tx) => expenseAlertThresholds(tx, f.orgId, ASOF));
    expect(set.spikeX100).toBe(300n);
    expect(set.minAmount).toBe('5000.00'); // starts 1 December, not yet
  });

  it('a threshold an admin set reaches the feed: the same 200k spike is a finding for one organisation and not for the one that set 3 times [kills: thresholds hard-coded in the domain]', async () => {
    const make = async (hint: string) => {
      const f = await fixture(hint);
      const meat = await category(f, 'Meat');
      await history(f, meat, 5, '100000.00');
      await exp(f, { categoryId: meat, date: '2026-11-17', amount: '200000.00' });
      return f;
    };
    const feed = (f: Fixture) => asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-10', asOf: ASOF }));
    const plain = await make('thr-feed-default');
    expect((await feed(plain)).findings.map((x) => x.kind)).toContain('expenseCategorySpike');
    const tuned = await make('thr-feed-tuned');
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${tuned.orgId}, 'expenses.alert_spike_multiplier', '3.000000', '2026-01-01', null, 'test')`;
    expect((await feed(tuned)).findings.map((x) => x.kind)).not.toContain('expenseCategorySpike');
  });

  it('every alert is soft, so none holds a close: the close verdict lists none of them [kills: a hard severity]', async () => {
    const f = await fixture('thr-soft');
    const meat = await category(f, 'Meat');
    await history(f, meat, 5, '100000.00');
    await exp(f, { categoryId: meat, date: '2026-11-17', amount: '200000.00', approvedBy: f.creatorId });
    const cat = await category(f, 'Repairs', 'OPEX');
    await exp(f, { categoryId: cat, date: '2026-11-10', amount: '8000.00', supplier: 'Twin' });
    await exp(f, { categoryId: cat, date: '2026-11-11', amount: '8000.00', supplier: 'Twin' });
    const result = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-10', asOf: ASOF }));
    const ours = result.findings.filter((x) => x.kind.startsWith('expense') && /^expense(CategorySpike|FrequencySpike|Outlier|Duplicate|SelfApproved|OverBudget)$/.test(x.kind));
    expect(ours.map((x) => x.kind).sort()).toEqual(['expenseCategorySpike', 'expenseDuplicate', 'expenseSelfApproved']);
    expect(ours.every((x) => x.severity === 'soft')).toBe(true);
    expect(readinessOf(result, true).blocking.filter((x) => ours.includes(x))).toEqual([]);
  });

  it('a quiet organisation with no expenses raises none of them, and the feed still works [kills: a detector that errors on an empty store]', async () => {
    const f = await fixture('thr-empty');
    const result = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-10', asOf: ASOF }));
    expect(result.findings.filter((x) => /^expense(CategorySpike|FrequencySpike|Outlier|Duplicate|SelfApproved|OverBudget)$/.test(x.kind))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------
describe('T-639 the acknowledge flow (real dates, because acknowledgeFinding reads the real clock)', () => {
  it('a spike is accepted for now like any other finding: it turns acknowledged and stays counted; a person without the right is refused [kills: an alert outside the acknowledge flow]', async () => {
    const f = await fixture('ack');
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${f.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${admin!.id}, ${f.storeId}, 'manual')`;
    const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Staff') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${f.storeId}, 'manual')`;
    const adminActor: Actor = { personId: admin!.id, orgId: f.orgId };
    const staffActor: Actor = { personId: staff!.id, orgId: f.orgId };

    const today = await asOrg(f.orgId, (tx) => manilaToday(tx));
    const meat = await category(f, 'Meat');
    for (const back of [7, 14, 21]) await exp(f, { categoryId: meat, date: dayOf(today, -back), amount: '100000.00' });
    await exp(f, { categoryId: meat, date: today, amount: '120000.00' });
    await exp(f, { categoryId: meat, date: today, amount: '80000.00' });

    const feed = () => asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-10' }));
    const before = (await feed()).findings.find((x) => x.kind === 'expenseCategorySpike')!;
    expect(before.status).toBe('open');

    await expect(asOrg(f.orgId, (tx) => acknowledgeFinding(tx, staffActor, { findingKey: before.key, period: '2026-10' }))).rejects.toThrow();
    await asOrg(f.orgId, (tx) => acknowledgeFinding(tx, adminActor, { findingKey: before.key, note: 'Event week, extra meat bought.', period: '2026-10' }));

    const after = await feed();
    const accepted = after.findings.find((x) => x.key === before.key)!;
    expect(accepted.status).toBe('acknowledged');
    expect(accepted.acknowledgedBy).toBe(admin!.id);
    expect(after.acknowledgedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('T-639 expense alerts are advice, not scorecard tasks', () => {
  it('an expense alert is in the feed but never becomes a finding occurrence, so the manager scorecard cannot count it (real dates, the job reads the real clock) [kills: recording every finding kind as an occurrence]', async () => {
    const f = await fixture('no-occurrence');
    const today = await asOrg(f.orgId, (tx) => manilaToday(tx));
    const meat = await category(f, 'Meat');
    for (const back of [7, 14, 21]) await exp(f, { categoryId: meat, date: dayOf(today, -back), amount: '100000.00' });
    await exp(f, { categoryId: meat, date: today, amount: '120000.00' });
    await exp(f, { categoryId: meat, date: today, amount: '80000.00' });
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-10' }));
    expect(feed.findings.some((x) => x.kind === 'expenseCategorySpike')).toBe(true);
    await asOrg(f.orgId, (tx) => recordFindingObservations(tx, f.orgId));
    const rows = await sql<{ n: string }[]>`select count(*)::text n from finding_occurrences where org_id = ${f.orgId} and kind in ('expenseCategorySpike', 'expenseOutlier', 'expenseFrequencySpike', 'expenseDuplicate', 'expenseSelfApproved', 'expenseOverBudget')`;
    expect(rows[0]!.n).toBe('0');
  });
});
