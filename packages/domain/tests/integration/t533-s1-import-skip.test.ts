/**
 * T-533 S1 (TESTER, written FIRST) - the 06:00 v1 day import and the store POS mode. docs/tasks/533-pos-lipa-switch.md R1; plan finding 2.
 *
 * Migration 0247's trigger refuses a v1 feed day for a store that is live from a date on or after it (the double-book guard, row 436). That stays as the backstop,
 * but alone it makes the morning job log a red failure line for Lipa every day once it is live. So `posDayImportSweep` must SKIP those dates (counted as skipped,
 * never failed, and POS is not even asked), and a roll-back (R1) must let the same dates import again.
 *
 *   packages/domain/src/pos/day-import-job.ts: a store with pos_stores.mode = 'live' skips every date >= live_from.
 *
 * The clock is the t396 one: 06:00 Manila on 2026-12-13, so the window is 12-06 .. 12-12 and yesterday is 12-12. The store's link is dated 12-06 (no older gap to report).
 * Made-up data; the t531 world is the T-525 fixture with the v1 tender names set. Runs on any `_test` database.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { closeAll, sql, world, type World } from './_fixtures/t531-day-close';
import { stubFetchers } from './_fixtures/pos-day';
import { asOrg } from './_fixtures/t525-pos';
import { posDayImportSweep } from '../../src/pos/day-import-job';
import { setStorePosMode } from '../../src/pos/store-mode';

afterAll(closeAll);

const NOW = new Date('2026-12-12T22:00:00.000Z');
const WINDOW = ['2026-12-06', '2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12'];
const FAR = '2027-06-01';

/** A store in `mode` whose live date is `liveFrom`, linked to v1 since 12-06. */
async function store(mode: 'off' | 'test' | 'live', liveFrom: string = '2026-12-09'): Promise<World> {
  const w = await world(mode === 'live' ? 'live' : 'test', liveFrom);
  if (mode === 'off') await sql`update pos_stores set mode = 'off' where store_id = ${w.storeId}`;
  await sql`update pos_v1_store_links set created_at = '2026-12-06T04:00:00.000Z'::timestamptz where store_id = ${w.storeId}`;
  return w;
}

const sweep = async (w: World, feed = stubFetchers()) => {
  const result = await posDayImportSweep({ orgId: w.orgId, now: NOW, trigger: 'cron', fetchers: feed.fetchers });
  return { outcome: result.outcomes[0]!, feed, hadFailures: result.hadFailures };
};
const dayDates = async (w: World) =>
  (await sql<{ d: string }[]>`select business_date::text d from sales_days where store_id = ${w.storeId} order by business_date`).map((r) => r.d);
const realFailures = (o: { failures?: readonly { kind?: string }[] }) => (o.failures ?? []).filter((l) => l.kind !== 'notice');

describe('the morning import skips the dates a live store owns', () => {
  it('live from 9 Dec: 6, 7 and 8 Dec import; 9 to 12 Dec are skipped (4), none fail, and POS is not asked for them', async () => {
    const w = await store('live', '2026-12-09');
    const { outcome, feed, hadFailures } = await sweep(w);
    expect(realFailures(outcome), JSON.stringify(outcome.failures)).toEqual([]);
    expect(outcome).toMatchObject({ posted: 3, skipped: 4, failed: 0 });
    expect(hadFailures).toBe(false);
    expect(await dayDates(w)).toEqual(['2026-12-06', '2026-12-07', '2026-12-08']);
    const asked = feed.calls.filter((c) => c.kind === 'sales').map((c) => c.businessDate);
    expect(asked.filter((d) => d >= '2026-12-09'), 'POS must not be asked for a date the new POS owns').toEqual([]);
  });

  it('live from before the whole window: every date is skipped, none fail, nothing imported, POS never asked', async () => {
    const w = await store('live', '2026-12-01');
    const { outcome, feed } = await sweep(w);
    expect(outcome).toMatchObject({ posted: 0, skipped: 7, failed: 0 });
    expect(realFailures(outcome)).toEqual([]);
    expect(await dayDates(w)).toEqual([]);
    expect(feed.calls).toEqual([]);
  });

  it('control: live from far in the future, TEST mode and OFF all import the whole window as before', async () => {
    for (const w of [await store('live', FAR), await store('test'), await store('off')]) {
      const { outcome } = await sweep(w);
      expect(outcome, `mode ${w.mode}`).toMatchObject({ posted: 7, skipped: 0, failed: 0 });
      expect(await dayDates(w)).toEqual(WINDOW);
    }
  });
});

describe('the roll-back lets the v1 import accept those dates again', () => {
  it('live from 9 Dec -> a morning import skips 9 to 12 Dec -> an admin rolls back to off (no Z yet) -> the next import takes 9 to 12 Dec', async () => {
    const w = await store('live', '2026-12-09');
    const first = await sweep(w);
    expect(first.outcome).toMatchObject({ posted: 3, skipped: 4, failed: 0 });
    expect(await dayDates(w)).toEqual(['2026-12-06', '2026-12-07', '2026-12-08']);

    await asOrg(w.orgId, (tx) =>
      setStorePosMode(tx, w.admin, { storeId: w.storeId, mode: 'off', reason: 'rolled back before the first Z' }, { keyFilePresent: () => true, today: '2026-12-08' }),
    );

    const second = await sweep(w);
    expect(realFailures(second.outcome), JSON.stringify(second.outcome.failures)).toEqual([]);
    expect(second.outcome).toMatchObject({ posted: 4, skipped: 3, failed: 0 });
    expect(await dayDates(w)).toEqual(WINDOW);
  });
});
