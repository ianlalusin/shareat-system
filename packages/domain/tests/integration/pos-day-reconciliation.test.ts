import { config } from 'dotenv';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-210, converted by T-375 S6 - `docs/tasks/210-sales-reporting-over-the-ledger.md`,
 * `docs/tasks/375-pos-v1-day-feed.md` S6 ("At import" beside "Latest check", no HTTP at render; `pos/sales-pull.ts`
 * deleted).
 *
 * `getPosDayReconciliation` no longer takes a fetcher: it reads the day's STORED feeds. Every old outcome is still a
 * named, non-throwing result state, except the two that only existed because render called POS (`not_configured`,
 * `unreachable`): they are gone, and a global `fetch` that throws proves nothing is called at all.
 *
 * ## The converted shape (pinned by the tester; the spec says only "At import (basis) beside Latest check (stored),
 *    the delta"). `getPosDayReconciliation(tx, { orgId, storeId, businessDate })` returns
 *      { atImport: Side, latest: Side, ledger, delta, matches, basis }
 *    with Side = { status: 'ok', paidTotal, receiptCount } | { status: 'not_found' } | { status: 'none' };
 *    `atImport` is the day's BASIS feed (R10), `latest` the latest stored `sales` feed; `paidTotal` is POS's paid total;
 *    `delta` = latest - atImport (null unless both are 'ok'); `matches` = the two paid totals are equal (null unless
 *    both are 'ok'). `ledger` is unchanged: `{ exists: true, status, totalSales, posSourced, source } | { exists: false }`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, type Tx } from '@shareat/db';
import * as D from '@shareat/domain';
import { D1_FIGURES, importTestDay } from './_fixtures/pos-day';
import { asOrgOn, DAY, insertSalesRecheck, R1_FIGURES, s6Fixture, type S6F } from './_fixtures/pos-s6';

type Side = { status: 'ok'; paidTotal: string; receiptCount: number } | { status: 'not_found' } | { status: 'none' };
interface Recon {
  atImport: Side;
  latest: Side;
  ledger: { exists: true; status: string; totalSales: string; posSourced: boolean; source: string } | { exists: false };
  delta: string | null;
  matches: boolean | null;
  basis: { orgId: string; storeId: string; businessDate: string };
}
const getRecon = D.getPosDayReconciliation as unknown as (tx: Tx, input: { orgId: string; storeId: string; businessDate: string }) => Promise<Recon>;

const sql = postgres(url, { max: 5 });
const fetchSpy = vi.fn(async (..._a: unknown[]) => {
  throw new Error('LIVE POS FETCH: the reconciliation reads stored feeds, never POS');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const reconcile = (f: S6F, date = DAY) => asOrgOn(f.orgId, (tx) => getRecon(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: date }));
async function importVerified(f: S6F, date = DAY): Promise<string> {
  const { id } = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date }));
  await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, id));
  return id;
}
const recheck = (f: S6F, figures: Parameters<typeof insertSalesRecheck>[1]['figures']) =>
  asOrgOn(f.orgId, (tx) =>
    insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: DAY, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures }),
  );

describe('getPosDayReconciliation', () => {
  it('matches when the latest check agrees with the day as imported (no POS call)', async () => {
    const f = await s6Fixture(sql, 'match');
    await importVerified(f);

    const result = await reconcile(f);

    expect(result.atImport).toMatchObject({ status: 'ok', paidTotal: '1050.00', receiptCount: 20 });
    expect(result.latest).toMatchObject({ status: 'ok', paidTotal: '1050.00', receiptCount: 20 });
    expect(result.ledger).toMatchObject({ exists: true, status: 'verified', totalSales: '1100.00', posSourced: true, source: 'pos_v1_day_feed' });
    expect(result.matches).toBe(true);
    expect(result.delta).toBe('0.00');
    expect(fetchSpy, 'rendering never calls POS').toHaveBeenCalledTimes(0);
  });

  it('reports a mismatch with a signed delta (latest minus at import) when a recheck found a different paid total', async () => {
    const f = await s6Fixture(sql, 'mismatch');
    await importVerified(f);
    await recheck(f, R1_FIGURES);

    const result = await reconcile(f);

    expect(result.atImport).toMatchObject({ status: 'ok', paidTotal: '1050.00' });
    expect(result.latest).toMatchObject({ status: 'ok', paidTotal: '1000.00' });
    expect(result.matches).toBe(false);
    expect(result.delta).toBe('-50.00');
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('a stored POS "found: false" check becomes not_found, never a crash', async () => {
    const f = await s6Fixture(sql, 'not-found');
    await importVerified(f);
    await recheck(f, { found: false });

    const result = await reconcile(f);

    expect(result.atImport).toMatchObject({ status: 'ok', paidTotal: '1050.00' });
    expect(result.latest).toEqual({ status: 'not_found' });
    expect(result.matches).toBeNull();
    expect(result.delta).toBeNull();
  });

  it('a date with no sales day and no stored feed is "none" on both sides, the ledger side absent', async () => {
    const f = await s6Fixture(sql, 'no-ledger-row');

    const result = await reconcile(f, '2027-01-15');

    expect(result.atImport).toEqual({ status: 'none' });
    expect(result.latest).toEqual({ status: 'none' });
    expect(result.ledger).toEqual({ exists: false });
    expect(result.matches).toBeNull();
    expect(result.delta).toBeNull();
  });

  it('a TYPED day on a store that was never linked has no stored feed: "none" on both sides, the ledger side present and typed', async () => {
    const f = await s6Fixture(sql, 'typed');
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${`ty-${Date.now()}`}, 'Batangas') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.managerId}, ${store!.id})`;
    const [ch] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${store!.id}, 'Walk-in', true) returning id`;
    const day = await asOrgOn(f.orgId, (tx) =>
      D.createSalesDay(tx, f.manager, {
        storeId: store!.id, businessDate: DAY, totalSales: '1000.00', unliSales: '0.00', alaCarteSales: '1000.00',
        cashCollected: '1000.00', channels: [{ channelId: ch!.id, amount: '1000.00' }],
      }),
    );
    await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, day.id));

    const result = await asOrgOn(f.orgId, (tx) => getRecon(tx, { orgId: f.orgId, storeId: store!.id, businessDate: DAY }));

    expect(result.atImport).toEqual({ status: 'none' });
    expect(result.latest).toEqual({ status: 'none' });
    expect(result.ledger).toMatchObject({ exists: true, status: 'verified', totalSales: '1000.00', source: 'legacy_typed' });
    expect(result.matches).toBeNull();
    expect(result.delta).toBeNull();
  });
});
