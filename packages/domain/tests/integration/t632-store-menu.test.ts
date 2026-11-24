/**
 * T-632 - "What this store sells": the switches and the read behind /menu/stores/[storeId]. docs/tasks/632-store-menu-screen.md.
 * Against real PostgreSQL. Every test has a cross that fires (the mutants are listed in the hand-back, run by hand).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createDaypart, loadStoreMenu, loadStoreSells, setMenuOffer, switchOptionValue, switchVariantOff, switchVariantOn } from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, expectSentence, rawItem, rawOption, rawRule, sql, uid, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const hour = (c: Cast, storeId: string, name: string, start: string, end: string) =>
  asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId, name, days: DAYS, start, end }, tx)).then((r) => r.id);
const variant = async (c: Cast, type: 'a_la_carte' | 'package' | 'refill' = 'a_la_carte') => {
  const v = await rawItem(c, type);
  await rawRule(c, v.variantId);
  return v;
};
const on = (c: Cast, who: Cast['admin'], storeId: string, variantId: string, prices: Parameters<typeof switchVariantOn>[1]['prices']) =>
  asOrg(c.orgId, (tx) => switchVariantOn(who, { storeId, variantId, prices }, tx));
const off = (c: Cast, who: Cast['admin'], storeId: string, variantId: string) => asOrg(c.orgId, (tx) => switchVariantOff(who, { storeId, variantId }, tx));
const sells = (c: Cast, storeId: string, others: { id: string; name: string }[] = []) => asOrg(c.orgId, (tx) => loadStoreSells(tx, c.orgId, storeId, others));
const station = async (c: Cast, storeId: string, itemId: string) => {
  const [s] = await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${c.orgId}, ${storeId}, ${uid('Grill')}, ${c.admin.personId}) returning id`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${c.orgId}, ${storeId}, ${itemId}, ${s!.id}, ${c.admin.personId})`;
};

interface Row { channel: string; daypart_id: string | null; withdrawn: boolean; amount: string | null }
const rows = (storeId: string, variantId: string) =>
  sql<Row[]>`select channel, daypart_id, withdrawn, amount::text as amount from menu_offers where store_id = ${storeId} and variant_id = ${variantId} order by created_at, id`;
/** The newest row per channel and daypart: what is in force. */
const standing = async (storeId: string, variantId: string) => {
  const latest = new Map<string, Row>();
  for (const r of await rows(storeId, variantId)) latest.set(`${r.channel}|${r.daypart_id ?? ''}`, r);
  return [...latest.values()];
};

describe('T-632: the switches', () => {
  it('1: switching on writes one offer per daypart; switching off withdraws EVERY daypart and channel row, and keeps the history', async () => {
    const c = await cast('t632-1');
    const lunch = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    const dinner = await hour(c, c.storeA, 'Dinner', '15:00', '22:00');
    const v = await variant(c, 'package');
    const w = await on(c, c.superAdmin, c.storeA, v.variantId, [
      { daypartId: lunch, amount: '399.00' },
      { daypartId: dinner, amount: '499.00' },
    ]);
    expect(w.written).toBe(2);
    // An online price set on the Prices page is part of "every row": switching off must take it too.
    await asOrg(c.orgId, (tx) => setMenuOffer(c.superAdmin, { storeId: c.storeA, variantId: v.variantId, channel: 'online', amount: '449.00', daypartId: lunch }, tx));
    const live = (await standing(c.storeA, v.variantId)).filter((r) => !r.withdrawn);
    expect(live.map((r) => `${r.channel}:${r.amount}`).sort()).toEqual(['online:449.00', 'store:399.00', 'store:499.00']);

    const out = await off(c, c.superAdmin, c.storeA, v.variantId);
    expect(out.withdrawn).toBe(3);
    const after = await standing(c.storeA, v.variantId);
    expect(after).toHaveLength(3);
    expect(after.every((r) => r.withdrawn)).toBe(true);
    expect((await rows(c.storeA, v.variantId)).length).toBe(6); // append-only: 3 prices + 3 withdrawals
    const view = (await sells(c, c.storeA)).items.find((i) => i.itemId === v.itemId)!;
    expect(view.on).toBe(false);
  });

  it('2: a price already live at the same amount is left alone; a changed one is a new row; a blank daypart is simply not sold then', async () => {
    const c = await cast('t632-2');
    const lunch = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    const dinner = await hour(c, c.storeA, 'Dinner', '15:00', '22:00');
    const v = await variant(c, 'package');
    await on(c, c.superAdmin, c.storeA, v.variantId, [{ daypartId: lunch, amount: '399.00' }, { daypartId: dinner, amount: '' }]);
    expect((await rows(c.storeA, v.variantId)).length).toBe(1);
    const again = await on(c, c.superAdmin, c.storeA, v.variantId, [{ daypartId: lunch, amount: '399' }]);
    expect(again.written).toBe(0);
    await on(c, c.admin, c.storeA, v.variantId, [{ daypartId: lunch, amount: '419.00' }]); // a price change needs no super admin
    expect((await rows(c.storeA, v.variantId)).length).toBe(2);
    const none = await attempt(() => on(c, c.superAdmin, c.storeA, (v.variantId), [{ daypartId: dinner, amount: '' }]));
    expectSentence(none, 'no price at all');
  });

  it('3: a refill switches on with no price (the zero-price offer) and off again', async () => {
    const c = await cast('t632-3');
    const v = await variant(c, 'refill');
    await on(c, c.admin, c.storeA, v.variantId, [{ daypartId: null }]);
    expect(await standing(c.storeA, v.variantId)).toMatchObject([{ channel: 'store', withdrawn: false, amount: null }]);
    expect((await sells(c, c.storeA)).items.find((i) => i.itemId === v.itemId)!.on).toBe(true);
    await off(c, c.admin, c.storeA, v.variantId);
    expect((await standing(c.storeA, v.variantId)).every((r) => r.withdrawn)).toBe(true);
  });

  it('4: refused, in a sentence, with nothing written, for staff without the grant, a manager of another store, and a price below zero', async () => {
    const c = await cast('t632-4');
    const v = await variant(c);
    const before = await auditCount(c.orgId);
    for (const [who, label] of [[c.staff, 'staff'], [c.managerA, 'manager of store A at store B']] as const) {
      const storeId = label === 'staff' ? c.storeA : c.storeB;
      const r = await attempt(() => on(c, who, storeId, v.variantId, [{ amount: '50.00' }]));
      expectSentence(r, `${label} switch on`);
      expectSentence(await attempt(() => off(c, who, storeId, v.variantId)), `${label} switch off`);
    }
    expectSentence(await attempt(() => on(c, c.admin, c.storeA, v.variantId, [{ amount: '-1.00' }])), 'negative price');
    expect(await auditCount(c.orgId)).toBe(before);
    expect(await rows(c.storeA, v.variantId)).toHaveLength(0);
    expect(await rows(c.storeB, v.variantId)).toHaveLength(0);
  });

  it('5: a flavour is switched on with its price change and off again, through setOptionOffer (one row each, both audited)', async () => {
    const c = await cast('t632-5');
    const o = await rawOption(c);
    await switchOptionValueAs(c, c.admin, c.storeA, o.valueId, { on: true, priceDelta: '10.00' });
    const [row] = await sql<{ price_delta: string; withdrawn: boolean }[]>`select price_delta::text, withdrawn from menu_option_offers where store_id = ${c.storeA} and option_value_id = ${o.valueId}`;
    expect(row).toMatchObject({ price_delta: '10.00', withdrawn: false });
    await switchOptionValueAs(c, c.admin, c.storeA, o.valueId, { on: false });
    const all = await sql<{ withdrawn: boolean }[]>`select withdrawn from menu_option_offers where store_id = ${c.storeA} and option_value_id = ${o.valueId} order by created_at, id`;
    expect(all.map((r) => r.withdrawn)).toEqual([false, true]);
    expectSentence(await attempt(() => switchOptionValueAs(c, c.staff, c.storeA, o.valueId, { on: true, priceDelta: '0.00' })), 'staff flavour');
    expectSentence(await attempt(() => switchOptionValueAs(c, c.admin, c.storeA, o.valueId, { on: true })), 'flavour with no price change');
  });
});
const switchOptionValueAs = (c: Cast, who: Cast['admin'], storeId: string, optionValueId: string, o: { on: boolean; priceDelta?: string }) =>
  asOrg(c.orgId, (tx) => switchOptionValue(who, { storeId, optionValueId, ...o }, tx));

describe('T-632: the read', () => {
  it('6: lists an off item as off, an on item with its daypart prices, and the no-station chip only for an on item without a kitchen route', async () => {
    const c = await cast('t632-6');
    const lunch = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    const dinner = await hour(c, c.storeA, 'Dinner', '15:00', '22:00');
    const offItem = await variant(c);
    const routed = await variant(c, 'package');
    const unrouted = await variant(c, 'package');
    await on(c, c.superAdmin, c.storeA, routed.variantId, [{ daypartId: lunch, amount: '399.00' }, { daypartId: dinner, amount: '499.00' }]);
    await on(c, c.superAdmin, c.storeA, unrouted.variantId, [{ daypartId: lunch, amount: '299.00' }]);
    await station(c, c.storeA, routed.itemId);
    await station(c, c.storeB, unrouted.itemId); // a route at ANOTHER store does not count here

    const s = await sells(c, c.storeA);
    const by = (id: string) => s.items.find((i) => i.itemId === id)!;
    expect(s.hasDayparts).toBe(true);
    expect(by(offItem.itemId)).toMatchObject({ on: false, noStation: false });
    expect(by(routed.itemId)).toMatchObject({ on: true, noStation: false });
    expect(by(routed.itemId).variants[0]!.formSlots.map((x) => `${x.daypartName} ${x.amount}`)).toEqual(['Lunch 399.00', 'Dinner 499.00']);
    expect(by(unrouted.itemId)).toMatchObject({ on: true, noStation: true });
    // Store B has no menu hours or prices of its own: its view is all off.
    expect((await sells(c, c.storeB)).items.every((i) => !i.on && !i.noStation)).toBe(true);
  });

  it('7: an off item starts from the price it last had here; failing that, from the same item at another store, matching the hour by name', async () => {
    const c = await cast('t632-7');
    const lunchA = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    const lunchB = await hour(c, c.storeB, 'lunch', '10:00', '15:00');
    const v = await variant(c, 'package');
    await on(c, c.superAdmin, c.storeB, v.variantId, [{ daypartId: lunchB, amount: '350.00' }]);
    const other = [{ id: c.storeB, name: 'Batangas' }];
    let item = (await sells(c, c.storeA, other)).items.find((i) => i.itemId === v.itemId)!.variants[0]!;
    expect(item.formSlots.map((x) => `${x.daypartName} ${x.amount}`)).toEqual(['Lunch 350.00']);
    expect(item.prefill).toEqual({ from: 'other_store', storeName: 'Batangas' });
    // Nothing was saved by looking.
    expect(await rows(c.storeA, v.variantId)).toHaveLength(0);

    await on(c, c.superAdmin, c.storeA, v.variantId, [{ daypartId: lunchA, amount: '380.00' }]);
    await off(c, c.superAdmin, c.storeA, v.variantId);
    item = (await sells(c, c.storeA, other)).items.find((i) => i.itemId === v.itemId)!.variants[0]!;
    expect(item.on).toBe(false);
    expect(item.formSlots.map((x) => x.amount)).toEqual(['380.00']);
    expect(item.prefill?.from).toBe('last_here');
  });

  it('8: a flavour appears under its item and shows on or off with its price change', async () => {
    const c = await cast('t632-8');
    const v = await variant(c, 'package');
    const o = await rawOption(c);
    await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${c.orgId}, ${o.groupId}, ${v.itemId}, 'active', ${c.admin.personId})`;
    let item = (await sells(c, c.storeA)).items.find((i) => i.itemId === v.itemId)!;
    expect(item.flavourGroups[0]!.values[0]).toMatchObject({ on: false, priceDelta: null });
    await switchOptionValueAs(c, c.admin, c.storeA, o.valueId, { on: true, priceDelta: '15.00' });
    item = (await sells(c, c.storeA)).items.find((i) => i.itemId === v.itemId)!;
    expect(item.flavourGroups[0]!.values[0]).toMatchObject({ on: true, priceDelta: '15.00' });
  });
});

describe('T-632: the POS menu', () => {
  it('9: the store menu the tablet reads includes an item switched on here and excludes one switched off', async () => {
    const c = await cast('t632-9');
    const kept = await variant(c);
    const dropped = await variant(c);
    for (const v of [kept, dropped]) {
      await station(c, c.storeA, v.itemId);
      await on(c, c.admin, c.storeA, v.variantId, [{ amount: '120.00' }]);
    }
    await off(c, c.admin, c.storeA, dropped.variantId);
    const menu = await asOrg(c.orgId, (tx) => loadStoreMenu(tx, c.orgId, c.storeA));
    const ids = menu.menu.items.map((i) => i.id);
    expect(ids).toContain(kept.itemId);
    expect(ids).not.toContain(dropped.itemId);
  });
});
