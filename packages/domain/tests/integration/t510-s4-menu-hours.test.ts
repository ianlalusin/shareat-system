/**
 * T-510 S4 - the store menu knows about hours, against a real PostgreSQL. docs/tasks/510-menu-dayparts.md R4, R6.
 * Pork and Beef: lunch 08:00-17:00 at 338 and dinner 17:00-08:00 at 358 (Asia/Manila, every day). The instant is always passed in
 * (three Manila days ahead of the offers' effective_from = now()), never read from the clock by the code under test.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { kitchenRepo, withOrgPrincipal } from '@shareat/db';
import { loadStoreMenu } from '@shareat/domain';
import { insDaypart, insDaypartOffer, insRule, menuFixture, sql, type MenuFx } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** Manila wall clock `day` days from now -> the UTC instant (Manila is a fixed +08:00). */
const manila = (hhmm: string, day = 3): Date => {
  const base = new Date(Date.now() + day * 86_400_000);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h! - 8, m!, 0));
};
const asOrg = <T>(f: MenuFx, fn: Parameters<typeof withOrgPrincipal<T>>[1]) => withOrgPrincipal(f.orgId, fn);

async function fx(hint: string) {
  const f = await menuFixture(hint);
  await insRule(f, f.variantId);
  const lunch = (await insDaypart(f, { name: 'Lunch', start: '08:00', end: '17:00' }))[0]!.id;
  const dinner = (await insDaypart(f, { name: 'Dinner', start: '17:00', end: '08:00' }))[0]!.id;
  const st = await asOrg(f, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
  await asOrg(f, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: st.id, createdBy: f.personId }));
  return { f, lunch, dinner };
}
const storeChannel = async (f: MenuFx, at: Date) => {
  const m = await asOrg(f, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, at));
  return { m, ch: m.menu.items.flatMap((i) => i.variants).find((v) => v.id === f.variantId)?.channels.store };
};

describe('loadStoreMenu - dayparts', () => {
  it('lunch at 16:59 with nextChangeAt 17:00; dinner at 17:00 with nextChangeAt the next 08:00', async () => {
    const { f, lunch, dinner } = await fx('s4-boundary');
    await insDaypartOffer(f, f.variantId, lunch, '338.00');
    await insDaypartOffer(f, f.variantId, dinner, '358.00');

    const a = await storeChannel(f, manila('16:59'));
    expect(a.ch).toMatchObject({ orderable: true, amount: '338.00' });
    expect(a.m.nextChangeAt).toBe(manila('17:00').toISOString());

    const b = await storeChannel(f, manila('17:00'));
    expect(b.ch).toMatchObject({ orderable: true, amount: '358.00' });
    expect(b.m.nextChangeAt).toBe(manila('08:00', 4).toISOString());
    expect(b.m.contentHash).not.toBe(a.m.contentHash);

    // Same window, same menu: the hash does not move between 10:00 and 15:00.
    expect((await storeChannel(f, manila('10:00'))).m.contentHash).toBe((await storeChannel(f, manila('15:00'))).m.contentHash);
  });

  it('a lunch-only package at 20:00 is outside_hours and says it opens at 08:00; nextChangeAt is that opening', async () => {
    const { f, lunch } = await fx('s4-closed');
    await insDaypartOffer(f, f.variantId, lunch, '338.00');
    const { m, ch } = await storeChannel(f, manila('20:00'));
    expect(ch).toEqual({ orderable: false, notOffered: 'outside_hours', availableFrom: '08:00' });
    expect(m.menu.items.map((i) => i.id)).toEqual([f.itemId]);
    expect(m.nextChangeAt).toBe(manila('08:00', 4).toISOString());
  });

  it('a store with no dayparts: nextChangeAt stays null when nothing is scheduled', async () => {
    const f = await menuFixture('s4-plain');
    await insRule(f, f.variantId);
    await insDaypartOffer(f, f.variantId, null, '120.00');
    const st = await asOrg(f, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
    await asOrg(f, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: st.id, createdBy: f.personId }));
    const { m, ch } = await storeChannel(f, manila('12:00'));
    expect(ch).toMatchObject({ orderable: true, amount: '120.00' });
    expect(m.nextChangeAt).toBeNull();
  });
});
