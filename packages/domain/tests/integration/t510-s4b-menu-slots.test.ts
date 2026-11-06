/**
 * T-510 S4b - the store menu carries `hours` and per-variant `slots`, against a real PostgreSQL. docs/tasks/510-menu-dayparts.md R4-R6.
 * Pork and Beef: lunch 08:00-17:00 at 338, dinner 17:00-08:00 at 358 (Asia/Manila, every day). The instant is always passed in
 * (Manila days ahead of the offers' effective_from = now()), never read from the clock by the code under test.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { kitchenRepo, withOrgPrincipal } from '@shareat/db';
import { loadStoreMenu } from '@shareat/domain';
import { insDaypart, insDaypartOffer, insRule, menuFixture, sql, type MenuFx } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

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
const load = async (f: MenuFx, at: Date) => {
  const m = await asOrg(f, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, at));
  return { m, v: m.menu.items.flatMap((i) => i.variants).find((x) => x.id === f.variantId) };
};

describe('loadStoreMenu - hours and slots', () => {
  it('both slots priced and the hours, identical at 16:59 and 17:00; channels move, slots and hours do not', async () => {
    const { f, lunch, dinner } = await fx('s4b-slots');
    await insDaypartOffer(f, f.variantId, lunch, '338.00');
    await insDaypartOffer(f, f.variantId, dinner, '358.00');
    const a = await load(f, manila('16:59'));
    const b = await load(f, manila('17:00'));

    const amounts = (v: typeof a.v) => Object.fromEntries((v!.slots ?? []).map((s) => [s.daypartId, s.store.orderable ? s.store.amount : null]));
    expect(amounts(a.v)).toEqual({ [lunch]: '338.00', [dinner]: '358.00' });
    expect(a.v!.slots).toEqual(b.v!.slots);
    expect(a.v!.channels.store).toMatchObject({ amount: '338.00' });
    expect(b.v!.channels.store).toMatchObject({ amount: '358.00' });

    expect(a.m.menu.hours).toEqual(b.m.menu.hours);
    expect(a.m.menu.hours!.timeZone).toBe('Asia/Manila');
    expect(a.m.menu.hours!.dayparts.map((d) => [d.id, d.start, d.end]).sort()).toEqual([[dinner, '17:00', '08:00'], [lunch, '08:00', '17:00']].sort());
    expect(a.m.menu.hours!.dayparts.every((d) => d.days.join() === '0,1,2,3,4,5,6')).toBe(true);
    expect(a.m.menu.hours!.dayparts.map((d) => d.id)).toEqual([...a.m.menu.hours!.dayparts.map((d) => d.id)].sort());
  });

  it('a closed-window package still carries its slots; a withdrawn dinner row is not a slot and its window is not in hours', async () => {
    const { f, lunch, dinner } = await fx('s4b-closed');
    await insDaypartOffer(f, f.variantId, lunch, '338.00');
    await insDaypartOffer(f, f.variantId, dinner, null); // withdrawn
    const { m, v } = await load(f, manila('20:00'));
    expect(v!.channels.store).toMatchObject({ orderable: false, notOffered: 'outside_hours' });
    expect(v!.slots!.map((s) => s.daypartId)).toEqual([lunch]);
    expect(m.menu.hours!.dayparts.map((d) => d.id)).toEqual([lunch]);
  });

  it('a store with no dayparts: no hours key, no slots key', async () => {
    const f = await menuFixture('s4b-plain');
    await insRule(f, f.variantId);
    await insDaypartOffer(f, f.variantId, null, '120.00');
    const st = await asOrg(f, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
    await asOrg(f, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: st.id, createdBy: f.personId }));
    const { m, v } = await load(f, manila('12:00'));
    expect('hours' in m.menu).toBe(false);
    expect('slots' in v!).toBe(false);
  });
});
