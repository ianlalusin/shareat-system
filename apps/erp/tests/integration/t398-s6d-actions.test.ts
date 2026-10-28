import { afterAll, describe, expect, it, vi } from 'vitest';

import { franchiseWorld, addDays, D0, SENTINEL_BANK, SENTINEL_COST, SENTINEL_EXPENSE, logCount, totalLogCount, sql as ownerSql, type FranchiseWorld } from '../../../../packages/db/tests/integration/_fixtures/t398-s6-franchise';
import { RAW_SQL, submit, type Seen } from './t398-s6d-fixture';

/**
 * T-398 S6d (TESTER) - the two reading buttons, through the app's OWN server actions (not a test helper). docs/tasks/398-s6/{S6-REFRESH s6, TESTS S6d, QUESTIONS}.md.
 * Fixture: S6b's world (PG sales D0..D0+5: v0/v1/v2 verified, D0+3 submitted, D0+4 open, D0+5 voided; sentinels on cost, bank, expense, service charge).
 *
 *   A1  Ian (admin + grant) asks for D0..D0+6: all five non-voided days listed, the two unchecked days labelled "not checked", totals of the THREE checked days only
 *       (gross 4500.50, net 4261.00), cash/online/credit shown, channel names shown, the voided day absent.                              (QI-1 default)
 *   A2  nothing about cost, value, accounts, bank, supplier, expense, service charge or other charges is anywhere in what he is shown (QI-2 default; sentinels).
 *   A3  exactly ONE access-log row per press, naming Ian, the range and rows_returned 5; the reason typed is kept.
 *   A4  refused ranges: before sales_visible_from, a span over 366 days, end before start -> the database's sentence, no raw SQL text, ZERO log rows.
 *   A5  who is refused (L's admin / manager / staff, PG's own people, X's reader and X's Ian-shaped person asking for PG, W): words, no figures, ZERO log rows. superL is allowed.
 *   B1  stock, all stores: on hand + low-stock flag for the right items, inactive and zero-without-line items absent, no item code, no cost; one log row (store null).
 *   B2  stock, one store: only that store's item; one log row carrying the store.
 *   B3  stock refused for the same people and for a store that is not PG's; zero rows.
 * Mutants: totals count every day -> A1; payment split by account name -> A2; log on render/twice per press -> A3; clipped instead of refused range -> A4; screen gate
 *   weaker than the database (or the reverse) -> A5/B3; cost column rendered -> A2/B1.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await ownerSql.end({ timeout: 5 });
});

const actorOf = (orgId: string, p: { id: string }) => ({ orgId, personId: p.id });
const SALES = 'viewFranchiseSalesAction' as const;
const STOCK = 'viewFranchiseStockAction' as const;
const FORBIDDEN = /\b(cost|costs|value|valuation|supplier|payroll|wage|wages|expense|expenses|bank|account|accounts)\b/i;
const FIGURES_LEAK = /1,?000\.00|1,?900\.00|4,?500\.50|4,?261\.00|12\.5/;

async function salesAs(W: FranchiseWorld, who: { id: string }, org: string, over: Record<string, string | undefined> = {}): Promise<Seen> {
  return submit(actorOf(org, who), SALES, { franchiseeOrgId: W.pg.orgId, from: D0, to: addDays(D0, 6), reason: '', ...over });
}
/** A money figure as a person reads it: 4500.50 or 4,500.50 (not part of a longer number). */
const amt = (s: string): RegExp => {
  const [whole, frac] = s.split('.');
  const w = whole!.length > 3 ? `${whole!.slice(0, -3)},?${whole!.slice(-3)}` : whole!;
  return new RegExp(`(?<![\\d.,])${w}\\.${frac}(?!\\d)`);
};

describe('A1-A3 Ian looks at Padre Garcia\'s sales', () => {
  it('A1: the five non-voided days, unchecked ones labelled, totals of the three checked days only, payment by kind, channels, no voided day', async () => {
    const W = await franchiseWorld();
    const r = await salesAs(W, W.ianL, W.l.orgId);
    expect(r.text, `Ian was shown: ${r.text.slice(0, 400)}`).toMatch(amt('1000.00'));
    for (const n of ['1000.00', '900.00', '2000.00', '1900.00', '1500.50', '1461.00', '800.00', '300.00', '700.00', '250.00', '50.00']) expect(r.text, `figure ${n}`).toMatch(amt(n));
    expect(r.text, 'unchecked days labelled').toMatch(/not (yet )?checked/i);
    expect((r.text.match(/not (yet )?checked/gi) ?? []).length, 'the two unchecked days carry the label').toBeGreaterThanOrEqual(2);
    expect(r.text, 'checked totals: gross').toMatch(amt('4500.50'));
    expect(r.text, 'checked totals: net').toMatch(amt('4261.00'));
    expect(r.text, 'a total that counted the unchecked days (gross 5600.50)').not.toMatch(amt('5600.50'));
    expect(r.text, 'a total that counted the unchecked days (net 5361.00)').not.toMatch(amt('5361.00'));
    expect(r.text).not.toMatch(amt('9999.00'));
    expect(r.text, 'the voided day\'s reason').not.toContain('entered twice');
    expect(r.text).toMatch(/cash/i);
    expect(r.text).toMatch(/online/i);
    expect(r.text).toMatch(/credit/i);
    expect(r.text, 'a channel breakdown').toContain('Foodpanda');
    expect(r.text).toContain('Walk-in');
  });

  it('A2: no cost, value, account, bank, supplier or expense text, and none of the sentinels, anywhere in what Ian is shown', async () => {
    const W = await franchiseWorld();
    const r = await salesAs(W, W.ianL, W.l.orgId);
    for (const s of [SENTINEL_COST, SENTINEL_EXPENSE, SENTINEL_BANK, 'SENTINEL', '123.45', '67.89', 'journal']) expect(r.text, `"${s}" must not be shown`).not.toContain(s);
    expect(r.text, 'forbidden vocabulary').not.toMatch(FORBIDDEN);
    expect(r.text).not.toMatch(RAW_SQL);
  });

  it('A3: ONE press = ONE log row (Ian, the range, 5 day rows seen, the reason); a second press = a second row', async () => {
    const W = await franchiseWorld();
    const before = await logCount(W.pg.orgId, 'sales_daily');
    const total0 = await totalLogCount();
    await salesAs(W, W.ianL, W.l.orgId, { reason: 'royalty check' });
    expect(await logCount(W.pg.orgId, 'sales_daily'), 'exactly one row for one press').toBe(before + 1);
    expect(await totalLogCount(), 'and nowhere else').toBe(total0 + 1);
    const [row] = await ownerSql<{ reader_person_id: string; person_name: string; range_from: string; range_to: string; rows_returned: number; reason: string | null }[]>`
      select reader_person_id, person_name, range_from::text, range_to::text, rows_returned, reason from franchise_access_log
      where org_id = ${W.pg.orgId} and what = 'sales_daily' order by occurred_at desc, id desc limit 1`;
    expect(row).toMatchObject({ reader_person_id: W.ianL.id, person_name: W.ianL.name, range_from: D0, range_to: addDays(D0, 6), rows_returned: 5, reason: 'royalty check' });
    await salesAs(W, W.ianL, W.l.orgId);
    expect(await logCount(W.pg.orgId, 'sales_daily')).toBe(before + 2);
  });

  it('A3b: superL (role super_admin, no grant) may look; the row is written', async () => {
    const W = await franchiseWorld();
    const before = await logCount(W.pg.orgId, 'sales_daily');
    const r = await salesAs(W, W.superL, W.l.orgId);
    expect(r.text).toMatch(amt('1900.00'));
    expect(await logCount(W.pg.orgId, 'sales_daily')).toBe(before + 1);
  });
});

describe('A4 refused ranges say why, in words, and log nothing', () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['before the date PG\'s figures are visible from', { from: addDays(D0, -1), to: addDays(D0, 3) }, /visible from/i],
    ['a span of more than 366 days', { from: D0, to: addDays(D0, 400) }, /at most 366 days/i],
    ['an end date before the start date', { from: addDays(D0, 3), to: D0 }, /comes before/i],
  ];
  it.each(cases)('%s', async (_why, range, sentence) => {
    const W = await franchiseWorld();
    const total0 = await totalLogCount();
    const r = await salesAs(W, W.ianL, W.l.orgId, range);
    expect(r.text, `Ian was told: ${r.text.slice(0, 300)}`).toMatch(sentence);
    expect(r.text, 'raw SQL / database internals').not.toMatch(RAW_SQL);
    expect(r.text, 'no figure slipped out with the refusal').not.toMatch(FIGURES_LEAK);
    expect(await totalLogCount(), 'a refusal logs nothing').toBe(total0);
  });
});

describe('A5 / B3 who is refused', () => {
  /** A thrown AuthorizationError (or 42501) counts as a refusal, and so do returned/flashed words. Never figures, never raw SQL, never a log row. */
  async function expectRefused(who: string, run: () => Promise<Seen>) {
    const before = await totalLogCount();
    let seen = '';
    try {
      const r = await run();
      seen = r.text;
      expect(r.text, `${who}: a refusal in words`).toMatch(/\S/);
      expect(r.text, `${who}: figures reached a refused person`).not.toMatch(FIGURES_LEAK);
    } catch (e) {
      const err = e as { name?: string; code?: string; message?: string };
      expect(err.name === 'AuthorizationError' || err.code === '42501', `${who}: threw ${err.name}: ${err.message}`).toBe(true);
    }
    expect(seen).not.toMatch(RAW_SQL);
    expect(await totalLogCount(), `${who}: a refused look writes no log row`).toBe(before);
  }

  it.each([
    ['adminL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.adminL)],
    ['mgrL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.mgrL)],
    ['staffL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.staffL)],
    ['mgrPG (PG reading PG)', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.mgrPG)],
    ['ianPG (Ian\'s own person inside PG)', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.ianPG)],
    ['superPG (super_admin role in PG)', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.superPG)],
    ['staffPG', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.staffPG)],
    ['readerX (a third org\'s super_admin asking for PG)', (W: FranchiseWorld) => actorOf(W.x.orgId, W.readerX)],
    ['ianX (Ian-shaped person of a third org asking for PG)', (W: FranchiseWorld) => actorOf(W.x.orgId, W.ianX)],
    ['readerW (no agreement at all)', (W: FranchiseWorld) => actorOf(W.w.orgId, W.readerW)],
  ])('sales: %s is refused', async (who, mk) => {
    const W = await franchiseWorld();
    await expectRefused(who, () => submit(mk(W), SALES, { franchiseeOrgId: W.pg.orgId, from: D0, to: addDays(D0, 6) }));
  });

  it.each([
    ['adminL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.adminL)],
    ['staffL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.staffL)],
    ['mgrPG', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.mgrPG)],
    ['readerX', (W: FranchiseWorld) => actorOf(W.x.orgId, W.readerX)],
    ['readerW', (W: FranchiseWorld) => actorOf(W.w.orgId, W.readerW)],
  ])('stock: %s is refused', async (who, mk) => {
    const W = await franchiseWorld();
    await expectRefused(who, () => submit(mk(W), STOCK, { franchiseeOrgId: W.pg.orgId, storeId: '' }));
  });

  it('stock: Ian naming a store that is NOT Padre Garcia\'s (X\'s store) is refused in words, no row', async () => {
    const W = await franchiseWorld();
    await expectRefused('ianL + foreign store', () => submit(actorOf(W.l.orgId, W.ianL), STOCK, { franchiseeOrgId: W.pg.orgId, storeId: W.x.storeId }));
  });

  it('sales: Ian naming an organisation he has no agreement with (Y) is refused, no row', async () => {
    const W = await franchiseWorld();
    await expectRefused('ianL + org Y', () => submit(actorOf(W.l.orgId, W.ianL), SALES, { franchiseeOrgId: W.y.orgId, from: D0, to: D0 }));
  });
});

describe('B1 / B2 stock levels', () => {
  const itemsOf = async (W: FranchiseWorld) => {
    const r = await ownerSql<{ id: string; name: string; code: string }[]>`select id, name, code from items where org_id = ${W.pg.orgId}`;
    const by = (id: string) => r.find((x) => x.id === id)!;
    const i = W.items;
    return { above: by(i.above), at: by(i.at), below: by(i.below), none: by(i.none), inactive: by(i.inactive), zeroWith: by(i.zeroWith), zeroWithout: by(i.zeroWithout), store2: by(i.store2) };
  };

  it('B1: all stores - on hand and the low-stock flag; inactive and zero-without-a-line items absent; no item code, no cost; ONE row, store null', async () => {
    const W = await franchiseWorld();
    const n = await itemsOf(W);
    const before = await logCount(W.pg.orgId, 'stock_levels');
    const total0 = await totalLogCount();
    const r = await submit(actorOf(W.l.orgId, W.ianL), STOCK, { franchiseeOrgId: W.pg.orgId, storeId: '', reason: '' });
    expect(r.text, `Ian was shown: ${r.text.slice(0, 300)}`).toContain(n.above.name);
    for (const i of [n.above, n.at, n.below, n.none, n.zeroWith, n.store2]) expect(r.text, `active item ${i.name}`).toContain(i.name);
    for (const i of [n.inactive, n.zeroWithout]) expect(r.text, `${i.name} must not be listed`).not.toContain(i.name);
    for (const q of ['12.5', '5.0', '2.0', '3.25', '7.0']) expect(r.text, `on hand ${q}`).toContain(q);
    expect(r.text, 'the low-stock flag').toMatch(/low|at or below/i);
    for (const i of Object.values(n)) expect(r.text, `item code ${i.code}`).not.toContain(i.code);
    for (const s of [SENTINEL_COST, SENTINEL_EXPENSE, SENTINEL_BANK, 'SENTINEL']) expect(r.text).not.toContain(s);
    expect(r.text, 'forbidden vocabulary').not.toMatch(FORBIDDEN);
    expect(r.text).not.toMatch(RAW_SQL);
    expect(await logCount(W.pg.orgId, 'stock_levels'), 'one press, one row').toBe(before + 1);
    expect(await totalLogCount()).toBe(total0 + 1);
    const [row] = await ownerSql<{ store_id: string | null; reader_person_id: string }[]>`
      select store_id, reader_person_id from franchise_access_log where org_id = ${W.pg.orgId} and what = 'stock_levels' order by occurred_at desc, id desc limit 1`;
    expect(row).toEqual({ store_id: null, reader_person_id: W.ianL.id });
  });

  it('B2: one store - only that store\'s items; the row carries the store', async () => {
    const W = await franchiseWorld();
    const n = await itemsOf(W);
    const before = await logCount(W.pg.orgId, 'stock_levels');
    const r = await submit(actorOf(W.l.orgId, W.ianL), STOCK, { franchiseeOrgId: W.pg.orgId, storeId: W.pg.store2Id });
    expect(r.text).toContain(n.store2.name);
    expect(r.text, 'store 1 items are not in store 2\'s view').not.toContain(n.above.name);
    expect(await logCount(W.pg.orgId, 'stock_levels')).toBe(before + 1);
    const [row] = await ownerSql<{ store_id: string | null }[]>`select store_id from franchise_access_log where org_id = ${W.pg.orgId} and what = 'stock_levels' order by occurred_at desc, id desc limit 1`;
    expect(row!.store_id).toBe(W.pg.store2Id);
  });
});
