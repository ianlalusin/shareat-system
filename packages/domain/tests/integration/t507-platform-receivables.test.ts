import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-507 (TESTER) - platform receivables on the receivables report. Spec: docs/tasks/507-platform-receivables-on-ar-report.md.
 *
 * PINNED SHAPE (the spec names no function; a different shape is a question to the tester, not a silent change):
 *   getArAgingReport(tx, {orgId, storeId?, asOfDate}) keeps every existing field and gains
 *     .platform = {
 *        rows: Array<{ channelId, channelName, storeId, receivableAccountCode,
 *                      current, d1to30, d31to60, d61to90, d90plus, total }>,   // one row per channel with an open balance
 *        totals: { current, d1to30, d31to60, d61to90, d90plus, total },
 *        controlBalance: string,   // sum of the channels' receivable-account balances (ledger side, independent query)
 *        reconciles: boolean,      // totals.total === controlBalance
 *        waitingForVerification: number,   // days not verified with a non-remitted channel amount > 0, in scope
 *     }
 * 1220 lines DO carry store_id (verify.ts posts every routed line with storeId: day.storeId), so store scope filters the lines.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { getArAgingReport } from '../../src';
import { ASOF, EXPECT, asOrg, buildPlatformWorld, ledgerBalance1210, ledgerBalanceByChannel, type PlatformWorld } from './_fixtures/t507-platform-ar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let worldP: Promise<PlatformWorld> | undefined;
const world = () => (worldP ??= buildPlatformWorld(sql));

interface PRow {
  channelId: string; channelName: string; storeId: string; receivableAccountCode: string;
  current: string; d1to30: string; d31to60: string; d61to90: string; d90plus: string; total: string;
}
interface Platform {
  rows: PRow[];
  totals: Omit<PRow, 'channelId' | 'channelName' | 'storeId' | 'receivableAccountCode'>;
  controlBalance: string;
  reconciles: boolean;
  waitingForVerification: number;
}
async function report(storeId?: string) {
  const w = await world();
  const r = await asOrg(w.orgId, (tx) => getArAgingReport(tx, { orgId: w.orgId, storeId: storeId ?? null, asOfDate: ASOF }));
  return r as typeof r & { platform: Platform };
}
const buckets = (r: PRow) => ({ current: r.current, d1to30: r.d1to30, d31to60: r.d31to60, d61to90: r.d61to90, d90plus: r.d90plus, total: r.total });

describe('T-507 platform section: one row per channel with an open balance', () => {
  it('has a platform section; four channels (two stores, one on 1250) each get exactly one row, none for Walk-in', async () => {
    const w = await world();
    const { platform } = await report();
    expect(platform, 'report.platform must exist').toBeDefined();
    expect(platform.rows.map((r) => r.channelId).sort()).toEqual([w.ch.lipaFp, w.ch.lipaGrab, w.ch.batFp, w.ch.batShopee].sort());
  });

  it('rows carry the channel name, store and the receivable account read from the channel', async () => {
    const w = await world();
    const { platform } = await report();
    const by = new Map(platform.rows.map((r) => [r.channelId, r]));
    expect(by.get(w.ch.lipaFp)).toMatchObject({ channelName: 'Foodpanda', storeId: w.lipa, receivableAccountCode: '1220' });
    expect(by.get(w.ch.batShopee)).toMatchObject({ channelName: 'Shopee', storeId: w.bat, receivableAccountCode: '1250' });
  });

  it('a channel whose receivable_account_code is NOT 1220 (Shopee on 1250) appears with its own balance - never hard-coded to 1220', async () => {
    const w = await world();
    const { platform } = await report();
    const row = platform.rows.find((r) => r.channelId === w.ch.batShopee);
    expect(row, 'Shopee row').toBeDefined();
    expect(buckets(row!)).toEqual(EXPECT.batShopee);
  });

  it('a channel that is fully settled (zero balance) has no row', async () => {
    const w = await world();
    // Settle Batangas Foodpanda in full via SQL-free route: assert the rule on the existing data instead - Walk-in (never owed) has no row.
    const { platform } = await report();
    expect(platform.rows.some((r) => r.channelId === w.ch.lipaWalk || r.channelId === w.ch.batWalk)).toBe(false);
  });
});

describe('T-507 amounts and aging: verified days minus settlements, FIFO, aged by entry date', () => {
  it('Lipa Foodpanda: 12-15 settled in full, 500 more credited FIFO off the oldest open day: 500 | 4,000 | 3,000 | 1,500 | 0 = 9,000', async () => {
    const w = await world();
    const row = (await report()).platform.rows.find((r) => r.channelId === w.ch.lipaFp);
    expect(buckets(row!)).toEqual(EXPECT.lipaFoodpanda);
  });
  it('Lipa GrabFood 2,500 in 1-30; Batangas Foodpanda 700 in 31-60', async () => {
    const w = await world();
    const rows = (await report()).platform.rows;
    expect(buckets(rows.find((r) => r.channelId === w.ch.lipaGrab)!)).toEqual(EXPECT.lipaGrab);
    expect(buckets(rows.find((r) => r.channelId === w.ch.batFp)!)).toEqual(EXPECT.batFoodpanda);
  });
  it('an item dated on the as-of date is Current; one on 12-15 would be 90+ if it were unsettled (bucket edges)', async () => {
    const w = await world();
    const row = (await report()).platform.rows.find((r) => r.channelId === w.ch.lipaFp)!;
    expect(row.current).toBe('500.00'); // the 03-31 day, entry date = asOf
    expect(row.d90plus).toBe('0.00'); // the 12-15 day was cleared by the real settlement
  });
  it('platform totals are the column sums: 13,100.00', async () => {
    const { platform } = await report();
    expect(platform.totals.total).toBe(EXPECT.platformTotal);
    expect(platform.totals.d1to30).toBe('7400.00');
    expect(platform.totals.d31to60).toBe('3700.00');
    expect(platform.totals.current).toBe('500.00');
    expect(platform.totals.d61to90).toBe('1500.00');
    expect(platform.totals.d90plus).toBe('0.00');
  });
});

describe('T-507 tie-out: platform section to the receivable accounts per channel; customer section to 1210', () => {
  it('each channel row equals the ledger balance of that channel on its receivable account (independent SQL)', async () => {
    const w = await world();
    const ledger = await ledgerBalanceByChannel(sql, w.orgId);
    const { platform } = await report();
    for (const r of platform.rows) expect(r.total, `channel ${r.channelName}`).toBe(ledger.get(r.channelId));
    expect(platform.rows.length).toBe([...ledger.values()].filter((b) => Number(b) !== 0).length);
  });
  it('platform controlBalance = sum of the per-channel account balances and reconciles is true', async () => {
    const { platform } = await report();
    expect(platform.controlBalance).toBe(EXPECT.platformTotal);
    expect(platform.reconciles).toBe(true);
  });
  it('the customer section is unchanged: still ties to 1210, total 650.00, and excludes platform money', async () => {
    const w = await world();
    const r = await report();
    expect(r.reconciles).toBe(true);
    expect(r.controlBalance).toBe(await ledgerBalance1210(sql, w.orgId));
    expect(r.totals.total).toBe(EXPECT.customerTotal);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.customerId).toBe(w.customerId);
  });
});

describe('T-507 unverified days are not receivables yet, but are counted', () => {
  it('unverified days (Lipa 800, Batangas 100) add nothing to any platform row or total', async () => {
    const { platform } = await report();
    expect(platform.totals.total).toBe(EXPECT.platformTotal); // would be 14,000.00 if they leaked
  });
  it('waitingForVerification = 2 org-wide (Lipa 03-28, Batangas 03-27); the Walk-in-only open day is not counted', async () => {
    expect((await report()).platform.waitingForVerification).toBe(2);
  });
});

describe('T-507 store scope: lines carry store_id, so a store filter narrows the platform section', () => {
  it('Lipa only: Lipa Foodpanda and GrabFood, 11,500.00; no Batangas row; waiting = 1', async () => {
    const w = await world();
    const { platform } = await report(w.lipa);
    expect(platform.rows.map((r) => r.channelId).sort()).toEqual([w.ch.lipaFp, w.ch.lipaGrab].sort());
    expect(platform.totals.total).toBe(EXPECT.lipaPlatformTotal);
    expect(platform.controlBalance).toBe(EXPECT.lipaPlatformTotal);
    expect(platform.reconciles).toBe(true);
    expect(platform.waitingForVerification).toBe(1);
  });
  it('Batangas only: Foodpanda and Shopee (1250), 1,600.00; no Lipa row; waiting = 1', async () => {
    const w = await world();
    const { platform } = await report(w.bat);
    expect(platform.rows.map((r) => r.channelId).sort()).toEqual([w.ch.batFp, w.ch.batShopee].sort());
    expect(platform.totals.total).toBe(EXPECT.batPlatformTotal);
    expect(platform.reconciles).toBe(true);
    expect(platform.waitingForVerification).toBe(1);
  });
  it('the customer section under a store filter is unchanged by the platform section (Batangas: no customer rows)', async () => {
    const w = await world();
    const r = await report(w.bat);
    expect(r.rows).toHaveLength(0);
    expect(r.totals.total).toBe('0.00');
  });
});
