import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-565 (audit MC-002) - a queued order is judged by the daypart window in force when the tablet took it. docs/tasks/565-daypart-versions.md s3.
 * Real PostgreSQL on a "_test" database. Offers cannot be back-dated, so "the old window" is a window around NOW. No sleeps: every device time is
 * read back from the database (a version's valid_to / valid_from, an offer's effective_from) and the replay is placed exactly one millisecond
 * before it (the old version / the offer still live) or exactly on it (the new version).
 * Three windows are used across the file (Breakfast, Lunch, Dinner); nothing here depends on how many a store has.
 */
import { daypartsRepo, menuRepo } from '@shareat/db';
import { createDaypart, loadLiveStoreOffers, loadStoreMenu, retireDaypart, updateDaypart } from '../../src/menu';
import { addLines, openStand, requestRefill } from '../../src/pos';
import { insDaypartOffer, insRule, newItem, sql } from '../../../db/tests/integration/_fixtures/t401-menu';
import { asOrg, closeAll, fixture, newStand, uuid, type Fx } from './_fixtures/t525-pos';

afterAll(closeAll);

const TZ = 'Asia/Manila';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const MS = 1;
const before = (d: Date, ms: number) => new Date(d.getTime() - ms);

/** Store-local 'HH:MM' of (pivot + minutes). */
function hm(pivot: Date, minutes: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(pivot.getTime() + minutes * 60_000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('hour')}:${get('minute')}`;
}
const win = (pivot: Date, from: number, to: number) => ({ days: ALL_DAYS, start: hm(pivot, from), end: hm(pivot, to) });
const moveTo = (pivot: Date, from: number, to: number) => ({ start: hm(pivot, from), end: hm(pivot, to) });

async function setup() {
  const f = await fixture('test');
  const pivot = new Date();
  const mkDaypart = (name: string, w: { days: number[]; start: string; end: string }) => createDaypart(f.admin, { storeId: f.storeId, name, ...w });
  /** A dish sold only inside a daypart (null = all day), routed to the grill. */
  const dish = async (name: string, daypartId: string | null, amount: string | null) => {
    const it = await newItem(f, 'a_la_carte', name);
    await insRule(f, it.variantId);
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${it.itemId}, ${f.grill}, ${f.personId})`;
    if (amount !== null) await insDaypartOffer(f, it.variantId, daypartId, amount);
    return it;
  };
  return { f, pivot, mkDaypart, dish };
}

/** The instant an offer of this variant is first in force, exactly (effective_from rounded UP to the millisecond, the grain of a JS Date). */
const offerFrom = async (variantId: string) =>
  (await sql<{ t: Date }[]>`select date_trunc('milliseconds', min(effective_from) + interval '999 microseconds') t from menu_offers where variant_id = ${variantId}`)[0]!.t;

async function orderAt(f: Fx, item: { itemId: string; variantId: string }, at: Date) {
  const stand = await newStand(f);
  const sessionId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  const lineId = uuid();
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: at.toISOString() });
  });
  const add = () =>
    asOrg(f.orgId, (tx) => addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId, menuItemId: item.itemId, variantId: item.variantId, qty: 1, addedAtDevice: at.toISOString() }] }));
  return { sessionId, lineId, add };
}
const lineRow = async (lineId: string) =>
  (await sql<{ unit_price: string; daypart_version_id: string | null }[]>`select unit_price::text, daypart_version_id from table_session_lines where id = ${lineId}`)[0];
const versionsOf = (daypartId: string) =>
  sql<{ id: string; name: string; start_time: string; end_time: string; status: string; valid_from: Date; valid_to: Date | null }[]>`
    select id, name, start_time::text, end_time::text, status, valid_from, valid_to from menu_daypart_versions where daypart_id = ${daypartId} order by valid_from, id`;
const windowsAt = (f: Fx, at: Date) => asOrg(f.orgId, (tx) => daypartsRepo.listDaypartWindowsAsOf(tx, f.orgId, f.storeId, at));

describe('T-565 - an order is judged by the window in force when it was taken', () => {
  it('moved window: replay one millisecond before the edit is accepted at the OLD price and records the OLD version; an all-day line records none', async () => {
    const { f, pivot, mkDaypart, dish } = await setup();
    const { id: lunch } = await mkDaypart('Lunch', win(pivot, -60, 60));
    const plate = await dish('Lunch plate', lunch, '338.00');
    const allDay = await dish('Soda', null, '80.00');
    await updateDaypart(f.admin, { id: lunch, ...moveTo(pivot, 180, 240) });
    const [v1, v2] = await versionsOf(lunch);
    expect(v1!.valid_to).not.toBeNull();
    expect(v2!.valid_to).toBeNull();
    expect(v2!.valid_from.getTime()).toBe(v1!.valid_to!.getTime()); // no gap, no overlap
    const taken = before(v1!.valid_to!, MS);
    expect((await offerFrom(plate.variantId)).getTime()).toBeLessThanOrEqual(taken.getTime()); // the offer was already live

    const o = await orderAt(f, plate, taken);
    expect(await o.add()).toEqual({ wrote: true });
    expect(await lineRow(o.lineId)).toEqual({ unit_price: '338.00', daypart_version_id: v1!.id });

    // An all-day offer has no window: nothing to record.
    const o2 = await orderAt(f, allDay, taken);
    await o2.add();
    expect((await lineRow(o2.lineId))!.daypart_version_id).toBeNull();
  });

  it('the same order taken exactly when the edit took effect, inside the old hours only: refused, outside hours', async () => {
    const { f, pivot, mkDaypart, dish } = await setup();
    const { id: lunch } = await mkDaypart('Lunch', win(pivot, -60, 60));
    const plate = await dish('Lunch plate', lunch, '338.00');
    await updateDaypart(f.admin, { id: lunch, ...moveTo(pivot, 180, 240) });
    const [v1] = await versionsOf(lunch);
    const o = await orderAt(f, plate, v1!.valid_to!); // valid_to is the new version's valid_from: the new window judges
    await expect(o.add()).rejects.toThrow('pos: outside hours');
  });

  it('retire Breakfast after a queued breakfast order: the order is still judged by the version in force then', async () => {
    const { f, pivot, mkDaypart, dish } = await setup();
    const { id: breakfast } = await mkDaypart('Breakfast', win(pivot, -60, 60));
    const eggs = await dish('Eggs', breakfast, '120.00');
    await insDaypartOffer(f, eggs.variantId, breakfast, null); // withdraw, so the daypart may retire
    const withdrawnAt = (await sql<{ t: Date }[]>`select date_trunc('milliseconds', max(effective_from) + interval '999 microseconds') t from menu_offers where variant_id = ${eggs.variantId}`)[0]!.t;
    await retireDaypart(f.admin, { id: breakfast });
    const vs = await versionsOf(breakfast);
    expect(vs.map((v) => v.status)).toEqual(['active', 'retired']);

    const taken = before(withdrawnAt, MS); // the order was taken just before the withdrawal and the retirement
    expect((await offerFrom(eggs.variantId)).getTime()).toBeLessThanOrEqual(taken.getTime());
    expect(vs[0]!.valid_to!.getTime()).toBeGreaterThan(taken.getTime());
    const o = await orderAt(f, eggs, taken);
    expect(await o.add()).toEqual({ wrote: true });
    expect((await lineRow(o.lineId))!.daypart_version_id).toBe(vs[0]!.id);
    // After the retirement the window is still answered, as retired; before it, as active.
    expect((await windowsAt(f, vs[0]!.valid_to!)).map((w) => [w.daypartId, w.status])).toEqual([[breakfast, 'retired']]);
    expect((await windowsAt(f, taken)).map((w) => [w.daypartId, w.status])).toEqual([[breakfast, 'active']]);
  });

  it('a daypart added after the order does not affect it', async () => {
    const { f, pivot, mkDaypart, dish } = await setup();
    const { id: lunch } = await mkDaypart('Lunch', win(pivot, -60, 60));
    const plate = await dish('Lunch plate', lunch, '338.00');
    await dish('Soda', null, '80.00'); // real work between the lunch offer and the new daypart, so the two instants are far apart
    const { id: dinner } = await mkDaypart('Dinner', win(pivot, -90, 90));
    await dish('Dinner plate', dinner, '358.00');
    const [dinnerV1] = await versionsOf(dinner);
    const taken = before(dinnerV1!.valid_from, MS);
    expect((await offerFrom(plate.variantId)).getTime()).toBeLessThanOrEqual(taken.getTime());

    expect((await windowsAt(f, taken)).map((w) => w.name)).toEqual(['Lunch']);
    expect((await windowsAt(f, dinnerV1!.valid_from)).map((w) => w.name).sort()).toEqual(['Dinner', 'Lunch']);
    const o = await orderAt(f, plate, taken);
    expect(await o.add()).toEqual({ wrote: true });
    expect(await lineRow(o.lineId)).toMatchObject({ unit_price: '338.00' });
  });

  it('a refill is judged by the window it was asked in, and records it', async () => {
    const { f, pivot, mkDaypart } = await setup();
    const { id: lunch } = await mkDaypart('Lunch', win(pivot, -60, 60));
    const pkg = await newItem(f, 'package', 'Unli lunch');
    const refill = await newItem(f, 'refill', 'Lunch rice refill');
    for (const it of [pkg, refill]) {
      await insRule(f, it.variantId);
      await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${it.itemId}, ${f.grill}, ${f.personId})`;
    }
    await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by) values (${f.orgId}, ${pkg.variantId}, ${refill.itemId}, ${f.personId})`;
    await insDaypartOffer(f, pkg.variantId, lunch, '449.00');
    // a refill offer carries no amount and is NOT withdrawn (insDaypartOffer would mark a null amount withdrawn)
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
              values (${f.orgId}, ${f.storeId}, ${refill.variantId}, 'store', ${lunch}, null, false, ${f.personId})`;
    const o = await orderAt(f, pkg, await offerFrom(pkg.variantId));
    await o.add();
    await updateDaypart(f.admin, { id: lunch, ...moveTo(pivot, 180, 240) });
    const [v1] = await versionsOf(lunch);
    const asked = before(v1!.valid_to!, MS);
    expect((await offerFrom(refill.variantId)).getTime()).toBeLessThanOrEqual(asked.getTime());
    const refillId = uuid();
    const res = await asOrg(f.orgId, (tx) =>
      requestRefill(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, sessionId: o.sessionId, lines: [{ lineId: refillId, menuItemId: refill.itemId, qty: 1, addedAtDevice: asked.toISOString() }] }),
    );
    expect(res).toEqual({ wrote: true });
    expect((await lineRow(refillId))!.daypart_version_id).toBe(v1!.id);
  });

  it('at "now" the windows, the live offers and the tablet menu equal the current rows (three dayparts)', async () => {
    const { f, mkDaypart } = await setup();
    const w = { days: ALL_DAYS };
    const ids = [
      (await mkDaypart('Breakfast', { ...w, start: '06:00', end: '10:00' })).id,
      (await mkDaypart('Lunch', { ...w, start: '11:00', end: '14:00' })).id,
      (await mkDaypart('Dinner', { ...w, start: '17:00', end: '22:00' })).id,
    ];
    await updateDaypart(f.admin, { id: ids[1]!, start: '12:00', end: '15:00' });
    const it = await newItem(f, 'a_la_carte', 'Set meal');
    await insRule(f, it.variantId);
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${it.itemId}, ${f.grill}, ${f.personId})`;
    for (const [i, a] of [[0, '100.00'], [1, '200.00'], [2, '300.00']] as const) await insDaypartOffer(f, it.variantId, ids[i]!, a);

    const { asOf, current, live } = await asOrg(f.orgId, async (tx) => {
      const now = await menuRepo.dbNow(tx);
      return {
        asOf: await daypartsRepo.listDaypartWindowsAsOf(tx, f.orgId, f.storeId, now),
        current: await daypartsRepo.listDaypartsOfStore(tx, f.orgId, f.storeId),
        live: await loadLiveStoreOffers(tx, f.orgId, f.storeId, now),
      };
    });
    const shape = (r: { daypartId?: string; id?: string; name: string; days: number[]; startTime: string; endTime: string; status: string }) =>
      JSON.stringify([r.daypartId ?? r.id, r.name, [...r.days], r.startTime, r.endTime, r.status]);
    expect(asOf.map(shape)).toEqual(current.map(shape));
    const currentHours = current.map((d) => [d.id, d.startTime.slice(0, 5), d.endTime.slice(0, 5)]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
    expect(live.hours?.dayparts.map((d) => [d.id, d.start, d.end])).toEqual(currentHours);
    const menu = await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId));
    // The tablet menu names the same three windows, as edited (Lunch is 12:00-15:00 now).
    expect(menu.menu.hours?.dayparts.map((d) => [d.id, d.start, d.end])).toEqual(currentHours);
    expect(menu.menu.items.some((i) => i.id === it.itemId)).toBe(true);
  });

  it('createDaypart then an edit then loadStoreMenu(at undefined) in ONE transaction already sees the window', async () => {
    const { f, pivot } = await setup();
    await asOrg(f.orgId, async (tx) => {
      const { id } = await createDaypart(f.admin, { storeId: f.storeId, name: 'Lunch', ...win(pivot, -60, 60) }, tx);
      const now = await menuRepo.dbNow(tx);
      expect((await daypartsRepo.listDaypartWindowsAsOf(tx, f.orgId, f.storeId, now)).map((w) => [w.daypartId, w.startTime.slice(0, 5)])).toEqual([[id, hm(pivot, -60)]]);
      await updateDaypart(f.admin, { id, ...moveTo(pivot, 180, 240) }, tx);
      const edited = await daypartsRepo.listDaypartWindowsAsOf(tx, f.orgId, f.storeId, await menuRepo.dbNow(tx));
      expect(edited.map((w) => [w.daypartId, w.startTime.slice(0, 5), w.endTime.slice(0, 5)])).toEqual([[id, hm(pivot, 180), hm(pivot, 240)]]);
      const live = await loadLiveStoreOffers(tx, f.orgId, f.storeId, await menuRepo.dbNow(tx));
      expect(live.daypartVersionIds.has(id)).toBe(true);
      await loadStoreMenu(tx, f.orgId, f.storeId); // at undefined = dbNow
    });
  });
});
