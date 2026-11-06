import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-511 S5b FIXER (2026-11-05), the "days with sales and no file yet" list of the review page (`review/lib.ts`):
 *  P3-7  it is gated by the REVIEW right (record_ar_collection, per store), not the upload right: a reviewer without the upload right still sees the missing days, a
 *        store the viewer cannot review is left out whole, and `dayBlockers` is never asked about it (it would throw).
 *  P3-8  the cap of 40 is shared round-robin across channels, oldest first in each, so one channel with a long gap cannot hide the others; "N more" stays exact.
 */
const can = vi.fn();
const dayBlockers = vi.fn();
const listPlatformChannels = vi.fn();
const daysWithRecordedSalesAndNoLine = vi.fn();

vi.mock('@shareat/auth', async (orig) => ({ ...(await orig<typeof import('@shareat/auth')>()), can: (...a: unknown[]) => can(...a) }));
vi.mock('@shareat/domain', async (orig) => ({ ...(await orig<typeof import('@shareat/domain')>()), dayBlockers: (...a: unknown[]) => dayBlockers(...a) }));
vi.mock('@shareat/db', async (orig) => {
  const real = await orig<typeof import('@shareat/db')>();
  return {
    ...real,
    settlementIntakeRepo: { ...real.settlementIntakeRepo, listPlatformChannels: (...a: unknown[]) => listPlatformChannels(...a), daysWithRecordedSalesAndNoLine: (...a: unknown[]) => daysWithRecordedSalesAndNoLine(...a) },
  };
});
vi.mock('../src/app/channel-settlements/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({}) }));

const ACTOR = { orgId: 'org-1', personId: 'p1' };
const ch = (id: string, storeId: string, storeName: string) => ({ id, storeId, storeName, name: 'Grab' });
const dates = (n: number, from = 1): string[] => Array.from({ length: n }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);

let listMissingFileDays: typeof import('../src/app/channel-settlements/review/lib').listMissingFileDays;
beforeAll(async () => {
  ({ listMissingFileDays } = await import('../src/app/channel-settlements/review/lib'));
}, 60_000);
beforeEach(() => {
  for (const f of [can, dayBlockers, listPlatformChannels, daysWithRecordedSalesAndNoLine]) f.mockReset();
  dayBlockers.mockImplementation(async () => ({ blockers: [{ code: 'no_file', sentence: 'There is no file for this day yet, but staff recorded sales for it.' }] }));
});

describe('P3-7 the missing-file list follows the review right', () => {
  it('a reviewer with record_ar_collection and WITHOUT upload_settlement_files sees the missing days [kills: gated by the upload right]', async () => {
    listPlatformChannels.mockResolvedValue([ch('c1', 's1', 'Lipa')]);
    daysWithRecordedSalesAndNoLine.mockResolvedValue(dates(2));
    can.mockImplementation(async (_tx: unknown, _a: unknown, cap: string) => cap === 'record_ar_collection');
    const out = await listMissingFileDays(ACTOR);
    expect(out.days.map((d) => [d.storeName, d.salesDate])).toEqual([['Lipa', '2026-10-01'], ['Lipa', '2026-10-02']]);
    expect(out.more).toBe(0);
    expect(can.mock.calls.every((c) => c[2] === 'record_ar_collection')).toBe(true);
  });

  it('a store the viewer cannot review is left out and dayBlockers is never called for it, even if the viewer may upload there [kills: dayBlockers throwing for a store without review rights]', async () => {
    listPlatformChannels.mockResolvedValue([ch('c1', 's1', 'Lipa'), ch('c2', 's2', 'Malvar')]);
    daysWithRecordedSalesAndNoLine.mockImplementation(async (_tx: unknown, _o: string, channelId: string) => (channelId === 'c1' ? dates(1) : dates(3)));
    can.mockImplementation(async (_tx: unknown, _a: unknown, cap: string, scope: { storeId: string }) => cap === 'record_ar_collection' && scope.storeId === 's1');
    dayBlockers.mockImplementation(async (_tx: unknown, _a: unknown, target: { channelId: string }) => {
      if (target.channelId === 'c2') throw new Error('not allowed');
      return { blockers: [{ code: 'no_file', sentence: 'x' }] };
    });
    const out = await listMissingFileDays(ACTOR);
    expect(out.days.map((d) => d.storeName)).toEqual(['Lipa']);
    expect(dayBlockers.mock.calls.every((c) => (c[2] as { channelId: string }).channelId === 'c1')).toBe(true);
    expect(out.more).toBe(0);
  });

  it('no channel the viewer can review: an empty list, no error [kills: a crash for a viewer with no stores]', async () => {
    listPlatformChannels.mockResolvedValue([ch('c1', 's1', 'Lipa')]);
    can.mockResolvedValue(false);
    expect(await listMissingFileDays(ACTOR)).toEqual({ days: [], more: 0 });
  });
});

describe('P3-8 one channel with a long gap cannot hide the others', () => {
  it('60 + 3 + 2 missing days: all 40 places shared, the short channels shown in full, the long one fills the rest oldest first, "25 more" exact [kills: oldest-first fill by channel]', async () => {
    listPlatformChannels.mockResolvedValue([ch('c1', 's1', 'Lipa'), ch('c2', 's2', 'Malvar'), ch('c3', 's3', 'Banay')]);
    const by: Record<string, string[]> = { c1: dates(30).concat(dates(30, 1).map((d) => d.replace('2026-10', '2026-11'))), c2: dates(3), c3: dates(2) };
    daysWithRecordedSalesAndNoLine.mockImplementation(async (_tx: unknown, _o: string, channelId: string) => by[channelId]);
    can.mockResolvedValue(true);
    const out = await listMissingFileDays(ACTOR);
    expect(out.days.length).toBe(40);
    const of = (store: string) => out.days.filter((d) => d.storeName === store).map((d) => d.salesDate);
    expect(of('Malvar')).toEqual(dates(3));
    expect(of('Banay')).toEqual(dates(2));
    expect(of('Lipa')).toEqual(by.c1!.slice(0, 35));
    expect(out.more).toBe(65 - 40);
  });

  it('three channels with 50 days each: every channel shows, 13-14 days each, and the total shown is exactly 40 [kills: a channel with nothing shown]', async () => {
    listPlatformChannels.mockResolvedValue([ch('c1', 's1', 'A'), ch('c2', 's2', 'B'), ch('c3', 's3', 'C')]);
    daysWithRecordedSalesAndNoLine.mockImplementation(async () => dates(28).concat(dates(22, 1).map((d) => d.replace('2026-10', '2026-11'))));
    can.mockResolvedValue(true);
    const out = await listMissingFileDays(ACTOR);
    expect(out.days.length).toBe(40);
    for (const s of ['A', 'B', 'C']) expect(out.days.filter((d) => d.storeName === s).length).toBeGreaterThanOrEqual(13);
    expect(out.more).toBe(150 - 40);
  });

  it('a day the domain no longer blocks is left out and is not counted as "more" [kills: a vanished day reported as still missing]', async () => {
    listPlatformChannels.mockResolvedValue([ch('c1', 's1', 'Lipa')]);
    daysWithRecordedSalesAndNoLine.mockResolvedValue(dates(3));
    can.mockResolvedValue(true);
    dayBlockers.mockImplementation(async (_tx: unknown, _a: unknown, t: { salesDate: string }) => ({ blockers: t.salesDate === '2026-10-02' ? [] : [{ code: 'no_file', sentence: 'x' }] }));
    const out = await listMissingFileDays(ACTOR);
    expect(out.days.map((d) => d.salesDate)).toEqual(['2026-10-01', '2026-10-03']);
    expect(out.more).toBe(0);
  });
});
