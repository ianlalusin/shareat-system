/**
 * T-510 S1a (migration 0233) - menu_dayparts and menu_offers.daypart_id, against a real PostgreSQL.
 * docs/tasks/510-menu-dayparts.md R1 (table), R2 (daypart on an offer), R3 (guards).
 *
 * Raw SQL as the owner, so the DATABASE is what is proven (no repo exists in this slice).
 * The SQL overlap rule is also checked against the pure TypeScript rule (packages/domain daypartsOverlap): the two must agree.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { daypartsOverlap } from '../../../domain/src/menu/daypart';
import { insRule, menuFixture, newItem, refusal, sql, uid, type MenuFx } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const DAY = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** An org with two stores and a variant that already has a depletion rule (a live offer needs one). */
async function fx(hint: string): Promise<MenuFx> {
  const f = await menuFixture(hint);
  await insRule(f, f.variantId);
  return f;
}

type DpOpts = { storeId?: string; name?: string; days?: readonly number[]; start?: string; end?: string };
const dpRaw = (f: MenuFx, o: DpOpts = {}) => {
  const days = `{${(o.days ?? ALL_DAYS).join(',')}}`;
  return sql<{ id: string }[]>`
    insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
    values (${f.orgId}, ${o.storeId ?? f.storeId}, ${o.name ?? uid('DP')}, ${days}::smallint[], ${o.start ?? '08:00'}::time, ${o.end ?? '17:00'}::time, ${f.personId})
    returning id`;
};
const dp = async (f: MenuFx, o: DpOpts = {}) => (await dpRaw(f, o))[0]!.id;

type OfferOpts = { daypartId?: string | null; amount?: number; from?: string; channel?: string; withdrawn?: boolean; variantId?: string; storeId?: string };
const offer = (f: MenuFx, o: OfferOpts = {}) => sql<{ id: string }[]>`
  insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, daypart_id, amount, withdrawn, created_by)
  values (${f.orgId}, ${o.storeId ?? f.storeId}, ${o.variantId ?? f.variantId}, ${o.channel ?? 'store'}, coalesce(${o.from ?? null}::timestamptz, now()),
          ${o.daypartId ?? null}, ${o.withdrawn ? null : (o.amount ?? 100)}, ${!!o.withdrawn}, ${f.personId})
  returning id`;
const withdraw = (f: MenuFx, daypartId: string | null, o: Omit<OfferOpts, 'daypartId' | 'withdrawn'> = {}) => offer(f, { ...o, daypartId, withdrawn: true });

const retire = (id: string) => sql`update menu_dayparts set status = 'retired' where id = ${id}`;
const status = async (id: string) => (await sql<{ status: string }[]>`select status from menu_dayparts where id = ${id}`)[0]!.status;
const offerCount = async (f: MenuFx) => (await sql<{ n: number }[]>`select count(*)::int n from menu_offers where org_id = ${f.orgId}`)[0]!.n;

// =================================================================================================
describe('R1 - a daypart is well formed (CHECKs)', () => {
  it('empty days, day 7, day -1, duplicate days, end = start and a blank name are each refused (23514)', async () => {
    const f = await fx('ck');
    for (const [label, o] of [
      ['empty days', { days: [] }],
      ['day 7', { days: [1, 7] }],
      ['day -1', { days: [-1, 2] }],
      ['duplicate days', { days: [1, 1] }],
      ['end = start', { start: '09:00', end: '09:00' }],
      ['blank name', { name: '   ' }],
    ] as const) {
      const err = await refusal(() => dpRaw(f, o));
      expect(err?.code, `${label} was accepted`).toBe('23514');
    }
    expect(await refusal(() => dpRaw(f, { days: [0, 6], start: '17:00', end: '08:00' }))).toBeUndefined();
  });

  it('a time with seconds is refused (23514): the TypeScript rule only knows HH:MM', async () => {
    const f = await fx('ck2');
    const err = await refusal(() => sql`
      insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
      values (${f.orgId}, ${f.storeId}, ${uid('DP')}, '{1}'::smallint[], '08:00:30'::time, '17:00'::time, ${f.personId})`);
    expect(err?.code).toBe('23514');
  });

  it('a NULL days array is refused (23502): it must not slip past the array checks', async () => {
    const f = await fx('ck3');
    const err = await refusal(() => sql`
      insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
      values (${f.orgId}, ${f.storeId}, ${uid('DP')}, null, '08:00'::time, '17:00'::time, ${f.personId})`);
    expect(err?.code).toBe('23502');
  });
});

// =================================================================================================
describe('R1 - an active daypart name is unique per store, case-insensitive', () => {
  it('Lunch then LUNCH at one store -> 23505; the same name at another store is fine; a retired daypart frees its name', async () => {
    const f = await fx('nm');
    const first = await dp(f, { name: 'Lunch' });
    expect((await refusal(() => dpRaw(f, { name: 'LUNCH', start: '20:00', end: '21:00' })))?.code).toBe('23505');
    expect(await refusal(() => dpRaw(f, { name: 'Lunch', storeId: f.store2Id }))).toBeUndefined();
    await retire(first);
    expect(await refusal(() => dpRaw(f, { name: 'lunch' }))).toBeUndefined();
  });
});

// =================================================================================================
describe('R2 - a daypart belongs to an offer, in the same store', () => {
  it('a daypart of store A on an offer of store B is refused by the composite FK (23503)', async () => {
    const f = await fx('fk');
    const a = await dp(f, { storeId: f.storeId });
    const err = await refusal(() => offer(f, { storeId: f.store2Id, daypartId: a }));
    expect(err?.code).toBe('23503');
    expect(await offerCount(f)).toBe(0);
  });

  it('a daypart of another organisation is refused (23503)', async () => {
    const f = await fx('fk2');
    const other = await fx('fk2-other');
    const foreign = await dp(other);
    expect((await refusal(() => offer(f, { daypartId: foreign })))?.code).toBe('23503');
  });

  it('a daypart that is in use cannot be deleted (23001, ON DELETE RESTRICT): offers are history', async () => {
    const f = await fx('fk3');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    expect((await refusal(() => sql`delete from menu_dayparts where id = ${d}`))?.code).toBe('23001');
  });

  it('existing all-day offers are unchanged: daypart_id is NULL and two rows in one slot still collide (23505)', async () => {
    const f = await fx('nulls');
    const t = future(1);
    const [row] = await offer(f, { from: t, amount: 100 });
    const [saved] = await sql<{ daypart_id: string | null }[]>`select daypart_id from menu_offers where id = ${row!.id}`;
    expect(saved!.daypart_id).toBeNull();
    const dup = await refusal(() => offer(f, { from: t, amount: 120 }));
    expect(dup?.code, 'two NULL-daypart rows with one slot were both accepted (NULLS NOT DISTINCT is missing)').toBe('23505');
  });

  it('two offers of one variant at one instant are fine when their dayparts differ, and collide when it is the same daypart', async () => {
    const f = await fx('slot');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    const t = future(1);
    await offer(f, { daypartId: lunch, from: t });
    await offer(f, { daypartId: dinner, from: t });
    expect((await refusal(() => offer(f, { daypartId: lunch, from: t, amount: 5 })))?.code).toBe('23505');
  });
});

// =================================================================================================
describe('R3 - a live offer needs an active daypart', () => {
  it('a live offer on a retired daypart is refused; a withdrawn row on it is allowed', async () => {
    const f = await fx('ret0');
    const d = await dp(f);
    await retire(d);
    const err = await refusal(() => offer(f, { daypartId: d }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/retired daypart/);
    expect(await refusal(() => withdraw(f, d))).toBeUndefined();
  });
});

// =================================================================================================
describe('R3 - dayparted offers of one variant and channel may not overlap in time', () => {
  const setup = async (hint: string, a: DpOpts, b: DpOpts) => {
    const f = await fx(hint);
    const da = await dp(f, { name: 'A', ...a });
    const db = await dp(f, { name: 'B', ...b });
    return { f, da, db };
  };

  it('same-day overlap is refused', async () => {
    const { f, da, db } = await setup('ov1', { start: '08:00', end: '12:00' }, { start: '11:00', end: '14:00' });
    await offer(f, { daypartId: da });
    const err = await refusal(() => offer(f, { daypartId: db }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/overlap/);
  });

  it('a one-minute overlap is refused', async () => {
    const { f, da, db } = await setup('ov2', { start: '08:00', end: '17:00' }, { start: '16:59', end: '20:00' });
    await offer(f, { daypartId: da });
    expect((await refusal(() => offer(f, { daypartId: db })))?.code).toBe('23514');
  });

  it('an overnight window spilling into the next day overlaps that day\'s window', async () => {
    // Monday 22:00-02:00 covers Tuesday 00:00-01:59; Tuesday 01:00-03:00 overlaps it.
    const { f, da, db } = await setup('ov3', { days: [1], start: '22:00', end: '02:00' }, { days: [2], start: '01:00', end: '03:00' });
    await offer(f, { daypartId: da });
    expect((await refusal(() => offer(f, { daypartId: db })))?.code).toBe('23514');
  });

  it('the overnight window belongs to the day it STARTS: Monday 22:00-02:00 does not overlap Monday 01:00-03:00', async () => {
    const { f, da, db } = await setup('ov4', { days: [1], start: '22:00', end: '02:00' }, { days: [1], start: '01:00', end: '03:00' });
    await offer(f, { daypartId: da });
    expect(await refusal(() => offer(f, { daypartId: db }))).toBeUndefined();
  });

  it('a Saturday-night window wraps into Sunday morning (week wrap)', async () => {
    const { f, da, db } = await setup('ov5', { days: [6], start: '22:00', end: '04:00' }, { days: [0], start: '03:00', end: '05:00' });
    await offer(f, { daypartId: da });
    expect((await refusal(() => offer(f, { daypartId: db })))?.code).toBe('23514');
  });

  it('adjacent windows (one ends where the next starts) are accepted; so are disjoint days', async () => {
    const { f, da, db } = await setup('ov6', { start: '08:00', end: '17:00' }, { start: '17:00', end: '20:00' });
    await offer(f, { daypartId: da });
    expect(await refusal(() => offer(f, { daypartId: db }))).toBeUndefined();

    const g = await setup('ov7', { days: [1, 2], start: '08:00', end: '17:00' }, { days: [3], start: '08:00', end: '17:00' });
    await offer(g.f, { daypartId: g.da });
    expect(await refusal(() => offer(g.f, { daypartId: g.db }))).toBeUndefined();
  });

  it('only the same store, variant and channel count', async () => {
    const f = await fx('ov8');
    const da = await dp(f, { name: 'A', start: '08:00', end: '12:00' });
    const db = await dp(f, { name: 'B', start: '11:00', end: '14:00' });
    const other = await newItem(f, 'a_la_carte');
    await insRule(f, other.variantId);
    await offer(f, { daypartId: da });
    expect(await refusal(() => offer(f, { daypartId: db, channel: 'online' })), 'another channel counted').toBeUndefined();
    expect(await refusal(() => offer(f, { daypartId: db, variantId: other.variantId })), 'another variant counted').toBeUndefined();
  });

  it('a withdrawn offer does not count: after withdrawing A, the overlapping B is accepted', async () => {
    const { f, da, db } = await setup('ov9', { start: '08:00', end: '12:00' }, { start: '11:00', end: '14:00' });
    await offer(f, { daypartId: da });
    expect((await refusal(() => offer(f, { daypartId: db })))?.code).toBe('23514');
    await withdraw(f, da);
    expect(await refusal(() => offer(f, { daypartId: db }))).toBeUndefined();
  });

  it('a price change on the same daypart is not an overlap with itself', async () => {
    const f = await fx('ov10');
    const d = await dp(f);
    await offer(f, { daypartId: d, amount: 100 });
    expect(await refusal(() => offer(f, { daypartId: d, amount: 110 }))).toBeUndefined();
  });

  it('Lipa shape: Lunch 08:00-17:00 and Dinner 17:00-08:00, every day, two offers for one variant at 338 and 358', async () => {
    const f = await fx('lipa');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch, amount: 338 });
    await offer(f, { daypartId: dinner, amount: 358 });
    expect(await offerCount(f)).toBe(2);
  });

  it('a future-dated overlapping offer is refused when both are in force at its start', async () => {
    const { f, da, db } = await setup('ov11', { start: '08:00', end: '12:00' }, { start: '11:00', end: '14:00' });
    await offer(f, { daypartId: da });
    expect((await refusal(() => offer(f, { daypartId: db, from: future(2) })))?.code).toBe('23514');
  });
});

// =================================================================================================
describe('R3 - a variant may not have a live all-day offer and a live dayparted offer at once', () => {
  it('dayparted live, then an all-day offer: refused', async () => {
    const f = await fx('mx1');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    const err = await refusal(() => offer(f, { daypartId: null }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/all-day/);
  });

  it('all-day live, then a dayparted offer: refused', async () => {
    const f = await fx('mx2');
    const d = await dp(f);
    await offer(f, { daypartId: null });
    expect((await refusal(() => offer(f, { daypartId: d })))?.code).toBe('23514');
  });

  it('dayparted to all-day: withdraw each dayparted offer first, then the all-day offer is accepted; the reverse order is refused', async () => {
    const f = await fx('mx3');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });
    // reverse order: the all-day offer first, while both dayparted offers are live
    expect((await refusal(() => offer(f, { daypartId: null })))?.code).toBe('23514');
    // one still live: still refused
    await withdraw(f, lunch);
    expect((await refusal(() => offer(f, { daypartId: null })))?.code).toBe('23514');
    await withdraw(f, dinner);
    expect(await refusal(() => offer(f, { daypartId: null, amount: 300 }))).toBeUndefined();
  });

  it('all-day to dayparted: withdraw the all-day offer, then the dayparted offer is accepted', async () => {
    const f = await fx('mx4');
    const d = await dp(f);
    await offer(f, { daypartId: null });
    await withdraw(f, null);
    expect(await refusal(() => offer(f, { daypartId: d }))).toBeUndefined();
  });

  it('is judged at the new row\'s effective_from: an all-day offer live now blocks a dayparted offer scheduled for tomorrow', async () => {
    const f = await fx('mx5');
    const d = await dp(f);
    await offer(f, { daypartId: null });
    expect((await refusal(() => offer(f, { daypartId: d, from: future(1) })))?.code).toBe('23514');
  });

  it('a scheduled switch is accepted: withdraw the all-day offer tomorrow, then start the dayparted offer tomorrow', async () => {
    const f = await fx('mx6');
    const d = await dp(f);
    const t = future(1);
    await offer(f, { daypartId: null });
    await withdraw(f, null, { from: t });
    expect(await refusal(() => offer(f, { daypartId: d, from: t }))).toBeUndefined();
  });

  it('a dayparted offer scheduled while another channel or store has an all-day offer is fine', async () => {
    const f = await fx('mx7');
    const d = await dp(f);
    await offer(f, { daypartId: null, channel: 'online' });
    await offer(f, { daypartId: null, storeId: f.store2Id });
    expect(await refusal(() => offer(f, { daypartId: d }))).toBeUndefined();
  });
});

// =================================================================================================
describe('R3 - offers stay history (the 0196 guards still hold for dayparted rows)', () => {
  it('back-dating is refused (23514)', async () => {
    const f = await fx('bd');
    const d = await dp(f);
    const err = await refusal(() => offer(f, { daypartId: d, from: future(-1) }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/back-dated/);
  });

  it('monotonic: a row earlier than a later row of the same store, variant and channel is refused', async () => {
    const f = await fx('mono');
    const d = await dp(f);
    await offer(f, { daypartId: d, from: future(3) });
    const err = await refusal(() => offer(f, { daypartId: d, from: future(2) }));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/monotonic/);
  });

  it('a dayparted offer is still an offer: it is never updated', async () => {
    const f = await fx('upd');
    const d = await dp(f);
    const [o] = await offer(f, { daypartId: d });
    expect((await refusal(() => sql`update menu_offers set amount = 1 where id = ${o!.id}`))?.code).toBe('23514');
  });
});

// =================================================================================================
describe('menu_variant_has_live_offer and menu_offer_in_force see dayparted slots', () => {
  it('a variant with only a dayparted live offer has a live offer; after withdrawing it, none', async () => {
    const f = await fx('live');
    const d = await dp(f);
    const has = async () => (await sql<{ r: boolean }[]>`select menu_variant_has_live_offer(${f.variantId}) r`)[0]!.r;
    expect(await has()).toBe(false);
    await offer(f, { daypartId: d });
    expect(await has(), 'a live dayparted offer was invisible to the depletion-rule guard').toBe(true);
    await withdraw(f, d);
    expect(await has()).toBe(false);
  });

  it('true when ANY of several dayparted slots is live', async () => {
    const f = await fx('live2');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });
    await withdraw(f, lunch);
    expect((await sql<{ r: boolean }[]>`select menu_variant_has_live_offer(${f.variantId}) r`)[0]!.r).toBe(true);
  });

  it('a scheduled (future) dayparted offer counts as live', async () => {
    const f = await fx('live3');
    const d = await dp(f);
    await offer(f, { daypartId: d, from: future(2) });
    expect((await sql<{ r: boolean }[]>`select menu_variant_has_live_offer(${f.variantId}) r`)[0]!.r).toBe(true);
  });

  it('the item retire guard sees it: an item whose only live offer is dayparted cannot retire; after withdrawing every slot it can', async () => {
    const f = await fx('live4');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });
    const err = await refusal(() => sql`update menu_items set status = 'retired' where id = ${f.itemId}`);
    expect(err?.code, 'an item with live dayparted offers retired').toBe('23514');
    await withdraw(f, lunch);
    await withdraw(f, dinner);
    expect(await refusal(() => sql`update menu_items set status = 'retired' where id = ${f.itemId}`)).toBeUndefined();
  });

  it('menu_offer_in_force returns the newest row per daypart slot, and one row for an all-day variant', async () => {
    const f = await fx('inforce');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch, amount: 338 });
    await offer(f, { daypartId: dinner, amount: 358 });
    await offer(f, { daypartId: lunch, amount: 340 });
    const rows = await sql<{ amount: string; daypart_id: string }[]>`
      select amount, daypart_id from menu_offer_in_force(${f.storeId}, ${f.variantId}, 'store', now() + interval '1 minute') order by amount`;
    expect(rows.map((r) => [r.daypart_id, r.amount])).toEqual([
      [lunch, '340.00'],
      [dinner, '358.00'],
    ]);

    const g = await fx('inforce2');
    await offer(g, { amount: 10 });
    await offer(g, { amount: 11 });
    const one = await sql<{ amount: string }[]>`select amount from menu_offer_in_force(${g.storeId}, ${g.variantId}, 'store', now() + interval '1 minute')`;
    expect(one.map((r) => r.amount)).toEqual(['11.00']);
  });
});

// =================================================================================================
describe('R3 - retiring a daypart', () => {
  it('is refused while a live offer uses it, with the count in the message; allowed once they are withdrawn', async () => {
    const f = await fx('rt1');
    const other = await newItem(f, 'a_la_carte');
    await insRule(f, other.variantId);
    const d = await dp(f);
    await offer(f, { daypartId: d });
    await offer(f, { daypartId: d, variantId: other.variantId });
    await offer(f, { daypartId: d, amount: 105 }); // a price change in the same slot is still ONE live offer
    const err = await refusal(() => retire(d));
    expect(err?.code).toBe('23514');
    expect(err?.message).toMatch(/2 live offer/);
    expect(await status(d)).toBe('active');

    await withdraw(f, d);
    expect((await refusal(() => retire(d)))?.message).toMatch(/1 live offer/);
    await withdraw(f, d, { variantId: other.variantId });
    expect(await refusal(() => retire(d))).toBeUndefined();
    expect(await status(d)).toBe('retired');
  });

  it('a scheduled (future) offer counts as live', async () => {
    const f = await fx('rt2');
    const d = await dp(f);
    await offer(f, { daypartId: d, from: future(3) });
    expect((await refusal(() => retire(d)))?.code).toBe('23514');
  });

  it('an unused daypart retires, and renaming or editing an unused daypart is free', async () => {
    const f = await fx('rt3');
    const d = await dp(f);
    expect(await refusal(() => sql`update menu_dayparts set name = 'Brunch', days = '{1,2}', start_time = '09:00', end_time = '11:00', updated_at = now() where id = ${d}`)).toBeUndefined();
    expect(await refusal(() => retire(d))).toBeUndefined();
  });

  it('a retire racing a live offer insert cannot both succeed: one of them is refused', async () => {
    const f = await fx('rt4');
    const d = await dp(f);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let inserted: () => void = () => {};
    const insertedP = new Promise<void>((r) => (inserted = r));
    const tx1 = sql.begin(async (tx) => {
      await tx`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
               values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${d}, 100, false, ${f.personId})`;
      inserted();
      await gate;
    });
    await insertedP;
    const tx2 = refusal(() => retire(d));
    await new Promise((r) => setTimeout(r, 400)); // the retire is now waiting on the daypart row
    release();
    await tx1;
    const err = await tx2;
    expect(err?.code, 'the retire committed over an uncommitted live offer').toBe('23514');
    expect(await status(d)).toBe('active');
  });
});

// =================================================================================================
describe('R3 - changing a daypart window', () => {
  it('is refused when it would make two live offers of one variant overlap; allowed when it would not', async () => {
    const f = await fx('ed1');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });

    const longer = await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`);
    expect(longer?.code).toBe('23514');
    expect(longer?.message).toMatch(/overlap/);
    const earlier = await refusal(() => sql`update menu_dayparts set start_time = '16:00' where id = ${dinner}`);
    expect(earlier?.code).toBe('23514');
    // days: lunch every day is fine; making dinner start at 17:00 on fewer days is fine
    expect(await refusal(() => sql`update menu_dayparts set days = '{1,2,3}' where id = ${dinner}`)).toBeUndefined();
    expect(await refusal(() => sql`update menu_dayparts set end_time = '16:00' where id = ${lunch}`)).toBeUndefined();
    const [saved] = await sql<{ end_time: string }[]>`select end_time::text from menu_dayparts where id = ${lunch}`;
    expect(saved!.end_time).toBe('16:00:00');
  });

  it('is refused for an overnight stretch into the other daypart', async () => {
    const f = await fx('ed2');
    const a = await dp(f, { name: 'A', days: [1], start: '22:00', end: '23:00' });
    const b = await dp(f, { name: 'B', days: [2], start: '01:00', end: '03:00' });
    await offer(f, { daypartId: a });
    await offer(f, { daypartId: b });
    expect((await refusal(() => sql`update menu_dayparts set end_time = '02:00' where id = ${a}`))?.code).toBe('23514');
  });

  it('only live offers count: with the other daypart\'s offer withdrawn, the same edit is allowed', async () => {
    const f = await fx('ed3');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });
    await withdraw(f, dinner);
    expect(await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`)).toBeUndefined();
  });

  it('an edit that overlaps another daypart is fine when no variant has live offers on both', async () => {
    const f = await fx('ed4');
    const other = await newItem(f, 'a_la_carte');
    await insRule(f, other.variantId);
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner, variantId: other.variantId });
    expect(await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`)).toBeUndefined();
  });

  it('an edit is judged over time too: an overlap that would only start tomorrow is refused', async () => {
    const f = await fx('ed5');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner, from: future(1) });
    expect((await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`))?.code).toBe('23514');
  });
});

// =================================================================================================
describe('R1 - a daypart never changes identity', () => {
  it('id, org_id and store_id are immutable, even for the owner (23514)', async () => {
    const f = await fx('imm');
    const d = await dp(f);
    const other = await fx('imm-other');
    for (const stmt of [
      sql`update menu_dayparts set store_id = ${f.store2Id} where id = ${d}`,
      sql`update menu_dayparts set org_id = ${other.orgId} where id = ${d}`,
      sql`update menu_dayparts set id = uuidv7() where id = ${d}`,
    ]) {
      expect((await refusal(() => stmt))?.code).toBe('23514');
    }
  });

  it('shareat_app may change name, days, times, status and updated_at only (column grants)', async () => {
    const f = await fx('grant');
    const d = await dp(f);
    const as = async (stmt: string) => {
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe('set local role shareat_app');
          await tx`select set_config('app.principal_kind', 'staff', true)`;
          await tx`select set_config('app.org_id', ${f.orgId}, true)`;
          await tx.unsafe(stmt, [d]);
          throw new Error('rollback');
        });
      } catch (e) {
        return (e as { code?: string; message: string }).code ?? (e as Error).message;
      }
      return 'ok';
    };
    expect(await as(`update menu_dayparts set name = 'x', days = '{1}', start_time = '09:00', end_time = '10:00', status = 'active', updated_at = now() where id = $1`)).toBe('rollback');
    expect(await as(`update menu_dayparts set store_id = store_id where id = $1`)).toBe('42501');
    expect(await as(`update menu_dayparts set created_by = created_by where id = $1`)).toBe('42501');
    expect(await as(`delete from menu_dayparts where id = $1`)).toBe('42501');
  });
});

// =================================================================================================
describe('the SQL overlap rule agrees with the TypeScript rule (daypartsOverlap)', () => {
  const win = (days: number[], start: string, end: string, id = 'x') => ({ id, days, start, end });
  const hand: Array<[string, ReturnType<typeof win>, ReturnType<typeof win>]> = [
    ['lipa lunch vs dinner, every day (adjacent both ends)', win(ALL_DAYS, '08:00', '17:00'), win(ALL_DAYS, '17:00', '08:00')],
    ['same window', win([1], '08:00', '12:00'), win([1], '08:00', '12:00')],
    ['one-minute overlap', win([1], '08:00', '17:00'), win([1], '16:59', '18:00')],
    ['adjacent', win([1], '08:00', '17:00'), win([1], '17:00', '18:00')],
    ['disjoint days', win([1, 2], '08:00', '17:00'), win([3], '08:00', '17:00')],
    ['contained', win([1], '08:00', '17:00'), win([1], '10:00', '11:00')],
    ['overnight spill into next day overlaps', win([1], '22:00', '02:00'), win([2], '01:00', '03:00')],
    ['overnight spill, next day just after', win([1], '22:00', '02:00'), win([2], '02:00', '03:00')],
    ['overnight belongs to day it starts', win([1], '22:00', '02:00'), win([1], '01:00', '03:00')],
    ['overnight vs overnight same day', win([1], '22:00', '02:00'), win([1], '23:00', '03:00')],
    ['overnight vs overnight consecutive days', win([1], '22:00', '06:00'), win([2], '23:00', '03:00')],
    ['saturday wraps to sunday', win([6], '22:00', '04:00'), win([0], '03:00', '05:00')],
    ['saturday wraps, sunday just after', win([6], '22:00', '04:00'), win([0], '04:00', '05:00')],
    ['sunday window vs saturday overnight, reversed', win([0], '03:00', '05:00'), win([6], '22:00', '04:00')],
    ['all days overnight vs all days day', win(ALL_DAYS, '20:00', '06:00'), win(ALL_DAYS, '05:00', '07:00')],
    ['all days overnight vs all days day, clear', win(ALL_DAYS, '20:00', '06:00'), win(ALL_DAYS, '06:00', '20:00')],
    ['midnight start', win([2], '00:00', '01:00'), win([1], '23:00', '00:30')],
    ['midnight start, adjacent', win([2], '00:00', '01:00'), win([1], '23:00', '00:00')],
    ['end 23:59', win([3], '12:00', '23:59'), win([3], '23:59', '02:00')],
    ['end 23:59 overlap', win([3], '12:00', '23:59'), win([3], '23:58', '02:00')],
    ['overnight 23:00-22:59 nearly a full day', win([1], '23:00', '22:59'), win([2], '22:00', '23:30')],
    ['nearly full day vs its own gap minute', win([1], '23:00', '22:59'), win([2], '22:59', '23:00')],
    ['multi-day vs spill from the day before', win([1, 3, 5], '08:00', '10:00'), win([0, 2, 4], '23:00', '09:00')],
    ['multi-day, spill ends before start', win([1, 3, 5], '08:00', '10:00'), win([0, 2, 4], '23:00', '08:00')],
    ['full week long overnight vs anything', win(ALL_DAYS, '00:01', '00:00'), win([4], '12:00', '13:00')],
    ['start equals other end, overnight', win([0], '17:00', '08:00'), win([1], '08:00', '12:00')],
    ['start before other end by a minute, overnight', win([0], '17:00', '08:01'), win([1], '08:00', '12:00')],
  ];
  const sqlOverlap = async (a: ReturnType<typeof win>, b: ReturnType<typeof win>) =>
    (await sql<{ r: boolean }[]>`
      select menu_daypart_windows_overlap(${`{${a.days.join(',')}}`}::smallint[], ${a.start}::time, ${a.end}::time,
                                          ${`{${b.days.join(',')}}`}::smallint[], ${b.start}::time, ${b.end}::time) r`)[0]!.r;

  it('agrees on 27 hand-picked cases, in both argument orders', async () => {
    expect(hand.length).toBeGreaterThanOrEqual(25);
    const bad: string[] = [];
    for (const [label, a, b] of hand) {
      const ts = daypartsOverlap(a, b);
      if ((await sqlOverlap(a, b)) !== ts) bad.push(`${label}: TS=${ts}`);
      if ((await sqlOverlap(b, a)) !== ts) bad.push(`${label} (swapped): TS=${ts}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
    // the table is not all one answer
    expect(hand.some(([, a, b]) => daypartsOverlap(a, b))).toBe(true);
    expect(hand.some(([, a, b]) => !daypartsOverlap(a, b))).toBe(true);
  });

  it('agrees on 250 pseudo-random windows (fixed seed)', async () => {
    let seed = 510;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const hhmm = () => {
      const m = rnd(48) * 30 + (rnd(4) === 0 ? 1 : 0); // half-hours, sometimes one minute off
      return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const days = () => ALL_DAYS.filter(() => rnd(3) === 0).concat(rnd(7)).filter((d, i, all) => all.indexOf(d) === i);
    const bad: string[] = [];
    let overlapping = 0;
    for (let i = 0; i < 250; i++) {
      const mk = () => {
        const s = hhmm();
        let e = hhmm();
        if (e === s) e = '23:59' === s ? '00:00' : '23:59';
        return win(days(), s, e);
      };
      const a = mk();
      const b = mk();
      const ts = daypartsOverlap(a, b);
      if (ts) overlapping++;
      if ((await sqlOverlap(a, b)) !== ts) bad.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: TS=${ts}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
    expect(overlapping).toBeGreaterThan(20);
    expect(overlapping).toBeLessThan(230);
  });
});
