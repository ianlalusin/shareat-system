/**
 * T-510 S1a (migration 0233) - menu_dayparts and menu_offers.daypart_id, against a real PostgreSQL.
 * docs/tasks/510-menu-dayparts.md R1 (table), R2 (daypart on an offer), R3 (guards).
 *
 * Raw SQL as the owner, so the DATABASE is what is proven (no repo exists in this slice).
 * The SQL overlap rule is also checked against the pure TypeScript rule (packages/domain daypartsOverlap): the two must agree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { daypartsOverlap } from '../../../domain/src/menu/daypart';
import { asApp, insRule, menuFixture, newItem, refusal, sql, uid, type MenuFx } from './_fixtures/t401-menu';

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
// Audit round 1 (F1-F4). Each block names the finding it pins.
// =================================================================================================
describe('F1 - deleting a SCHEDULED offer must not recreate a forbidden state', () => {
  const del = (id: string) => sql`delete from menu_offers where id = ${id}`;

  it('all-day live now, all-day withdrawn +5d, Lunch live +5d: deleting the withdrawal would mix all-day and dayparted -> refused', async () => {
    const f = await fx('f1a');
    const lunch = await dp(f, { name: 'Lunch' });
    await offer(f, { daypartId: null });
    const [w] = await withdraw(f, null, { from: future(5) });
    expect(await refusal(() => offer(f, { daypartId: lunch, from: future(5) }))).toBeUndefined();
    const err = await refusal(() => del(w!.id));
    expect(err?.code, 'the delete was accepted and left an all-day and a dayparted offer live together').toBe('23514');
    expect(err?.message).toMatch(/all-day/);
    expect(await offerCount(f)).toBe(3);
  });

  it('A live now, A withdrawn +5d, overlapping B live +5d: deleting the withdrawal would overlap A and B -> refused', async () => {
    const f = await fx('f1b');
    const a = await dp(f, { name: 'A', start: '08:00', end: '12:00' });
    const b = await dp(f, { name: 'B', start: '11:00', end: '14:00' });
    await offer(f, { daypartId: a });
    const [w] = await withdraw(f, a, { from: future(5) });
    expect(await refusal(() => offer(f, { daypartId: b, from: future(5) }))).toBeUndefined();
    const err = await refusal(() => del(w!.id));
    expect(err?.code, 'the delete was accepted and left two overlapping dayparted offers live').toBe('23514');
    expect(err?.message).toMatch(/overlap/);
    expect(await offerCount(f)).toBe(3);
  });

  it('a delete that recreates nothing still succeeds (cancelling a scheduled change stays possible)', async () => {
    // all-day only
    const f = await fx('f1c');
    await offer(f, { daypartId: null });
    const [w] = await withdraw(f, null, { from: future(5) });
    expect(await refusal(() => del(w!.id))).toBeUndefined();
    // adjacent dayparts: Lunch withdrawn +5d, Dinner live +5d does not overlap Lunch, so the withdrawal can go
    const g = await fx('f1d');
    const lunch = await dp(g, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(g, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(g, { daypartId: lunch });
    const [gw] = await withdraw(g, lunch, { from: future(5) });
    await offer(g, { daypartId: dinner, from: future(5) });
    expect(await refusal(() => del(gw!.id))).toBeUndefined();
    // a scheduled live price change
    const h = await fx('f1e');
    const d = await dp(h);
    await offer(h, { daypartId: d });
    const [change] = await offer(h, { daypartId: d, amount: 120, from: future(3) });
    expect(await refusal(() => del(change!.id))).toBeUndefined();
    expect(await offerCount(h)).toBe(1);
  });

  it('a row already in effect is still never deleted (0196)', async () => {
    const f = await fx('f1f');
    const [o] = await offer(f, { daypartId: null });
    expect((await refusal(() => del(o!.id)))?.code).toBe('23514');
  });
});

// =================================================================================================
describe('F2 - a daypart with a scheduled withdrawal (or a future live row) is still live', () => {
  it('Lunch live now + withdrawal at +5d: retire is refused (it is in force right now)', async () => {
    const f = await fx('f2a');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    await withdraw(f, d, { from: future(5) });
    const err = await refusal(() => retire(d));
    expect(err?.code, 'retired a daypart whose offer is still live now').toBe('23514');
    expect(err?.message).toMatch(/1 live offer/);
    expect(await status(d)).toBe('active');
  });

  it('a live row at +3d with a withdrawal at +6d: retire is refused (it will be live from +3d)', async () => {
    const f = await fx('f2b');
    const d = await dp(f);
    await offer(f, { daypartId: d, from: future(3) });
    await withdraw(f, d, { from: future(6) });
    expect((await refusal(() => retire(d)))?.message).toMatch(/1 live offer/);
  });

  it('retire is allowed once the slot is withdrawn with no later live row; the count is per variant and channel', async () => {
    const f = await fx('f2c');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    await offer(f, { daypartId: d, channel: 'online' });
    expect((await refusal(() => retire(d)))?.message).toMatch(/2 live offer/);
    await withdraw(f, d);
    await withdraw(f, d, { channel: 'online' });
    expect(await refusal(() => retire(d))).toBeUndefined();
  });

  it('withdrawn now but live again at +4d: retire is refused', async () => {
    const f = await fx('f2d');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    await withdraw(f, d); // in force now
    await offer(f, { daypartId: d, from: future(4) }); // live again at +4d: counts
    expect((await refusal(() => retire(d)))?.message).toMatch(/1 live offer/);
  });

  it('the window-edit check uses the same moments: Lunch +3d live, Dinner +4d live, Lunch withdrawn +6d: stretching Lunch is refused', async () => {
    const f = await fx('f2e');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch, from: future(3) });
    await offer(f, { daypartId: dinner, from: future(4) });
    await withdraw(f, lunch, { from: future(6) });
    const err = await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`);
    expect(err?.code).toBe('23514');
    // and a stretch that overlaps nothing at any moment is fine: Lunch live now, withdrawn +5d, Dinner live +5d
    const g = await fx('f2f');
    const gl = await dp(g, { name: 'Lunch', start: '08:00', end: '17:00' });
    const gd = await dp(g, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(g, { daypartId: gl });
    await withdraw(g, gl, { from: future(5) });
    await offer(g, { daypartId: gd, from: future(5) });
    expect(await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${gl}`), 'the two are never live together').toBeUndefined();
  });
});

// =================================================================================================
describe('F3 - one lock order: the daypart row first, then the variant keys (no deadlock, 40P01)', () => {
  it('a live offer insert and a window edit of its daypart, interleaved, both complete', async () => {
    const f = await fx('f3');
    const d = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    await offer(f, { daypartId: d }); // the edit below must find a variant to lock

    const url = process.env.TEST_DATABASE_URL!;
    const conn = (app: string) => postgres(url, { max: 1, connection: { application_name: app } });
    const c0 = conn('t510-f3-holder');
    const c1 = conn('t510-f3-insert');
    const c2 = conn('t510-f3-edit');
    const blocked = async (app: string) => {
      for (let i = 0; i < 100; i++) {
        const [r] = await sql<{ n: number }[]>`select count(*)::int n from pg_stat_activity where application_name = ${app} and wait_event_type = 'Lock'`;
        if (r!.n > 0) return;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`${app} never blocked`);
    };
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let locked: () => void = () => {};
      const lockedP = new Promise<void>((r) => (locked = r));
      // The holder parks the insert guard AFTER its first locks and BEFORE it reaches the daypart row: for a live offer the guard reads menu_depletion_rules.
      const tx0 = c0.begin(async (tx) => {
        await tx`lock table menu_depletion_rules in access exclusive mode`;
        locked();
        await gate;
      });
      await lockedP;
      const p1 = refusal(
        () => c1`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
                 values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${d}, 105, false, ${f.personId})`,
      );
      await blocked('t510-f3-insert');
      const p2 = refusal(() => c2`update menu_dayparts set end_time = '16:00' where id = ${d}`);
      await blocked('t510-f3-edit');
      release();
      await tx0;
      const [e1, e2] = await Promise.all([p1, p2]);
      expect(e1?.code, `the offer insert failed: ${e1?.message}`).toBeUndefined();
      expect(e2?.code, `the window edit failed: ${e2?.message}`).toBeUndefined();
      expect(await offerCount(f)).toBe(2);
    } finally {
      await Promise.all([c0.end({ timeout: 5 }), c1.end({ timeout: 5 }), c2.end({ timeout: 5 })]);
    }
  });

  it('an offer insert and an offer delete wait for the daypart row while holding NO variant key (the order itself, not just one interleaving)', async () => {
    const f = await fx('f3b');
    const d = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    await offer(f, { daypartId: d });
    const [scheduled] = await offer(f, { daypartId: d, amount: 120, from: future(3) });

    const url = process.env.TEST_DATABASE_URL!;
    const conn = (app: string) => postgres(url, { max: 1, connection: { application_name: app } });
    const holder = conn('t510-f3b-holder');
    const waiter = conn('t510-f3b-waiter');
    const waitsAndHoldsNoKey = async () => {
      for (let i = 0; i < 100; i++) {
        const [r] = await sql<{ waiting: number; keys: number }[]>`
          select count(*) filter (where a.wait_event_type = 'Lock')::int waiting,
                 (select count(*) from pg_locks l where l.pid = a.pid and l.locktype = 'advisory' and l.granted)::int keys
            from pg_stat_activity a where a.application_name = 't510-f3b-waiter' group by a.pid`;
        if (r && r.waiting > 0) return r.keys;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error('the waiter never blocked');
    };
    try {
      for (const [label, run] of [
        // dated after the scheduled row: the monotonic rule would refuse an earlier date
        ['insert', () => waiter`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, daypart_id, amount, withdrawn, created_by)
                                values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${future(4)}::timestamptz, ${d}, 105, false, ${f.personId})`],
        ['delete', () => waiter`delete from menu_offers where id = ${scheduled!.id}`],
      ] as const) {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => (release = r));
        let locked: () => void = () => {};
        const lockedP = new Promise<void>((r) => (locked = r));
        const tx = holder.begin(async (t) => {
          await t`select 1 from menu_dayparts where id = ${d} for no key update`;
          locked();
          await gate;
        });
        await lockedP;
        const pending = refusal(run);
        const keysHeld = await waitsAndHoldsNoKey();
        release();
        await tx;
        const err = await pending;
        expect(keysHeld, `the ${label} guard held a variant key while it waited for the daypart row (lock order is variant key first)`).toBe(0);
        expect(err, `the ${label} failed: ${err?.message}`).toBeUndefined();
      }
    } finally {
      await Promise.all([holder.end({ timeout: 5 }), waiter.end({ timeout: 5 })]);
    }
  });
});

// =================================================================================================
describe('F4 - menu_offer_in_force returns the live slot rows, or exactly one withdrawn row', () => {
  const inForce = (f: MenuFx) => sql<{ id: string; daypart_id: string | null; withdrawn: boolean; amount: string | null }[]>`
    select id, daypart_id, withdrawn, amount from menu_offer_in_force(${f.storeId}, ${f.variantId}, 'store', now())`;

  it('a variant that never had a daypart returns exactly one row, live or withdrawn, as before 0233', async () => {
    const f = await fx('f4a');
    expect(await inForce(f)).toHaveLength(0);
    const [o1] = await offer(f, { amount: 10 });
    const [o2] = await offer(f, { amount: 11 });
    const live = await inForce(f);
    expect(live.map((r) => r.id)).toEqual([o2!.id]);
    expect(o1!.id).not.toBe(o2!.id);
    const [w] = await withdraw(f, null);
    const gone = await inForce(f);
    expect(gone.map((r) => [r.id, r.withdrawn])).toEqual([[w!.id, true]]);
  });

  it('all-day then Lunch and Dinner: exactly the two live rows, the withdrawn all-day row is not returned', async () => {
    const f = await fx('f4b');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: null });
    await withdraw(f, null);
    await offer(f, { daypartId: lunch, amount: 338 });
    await offer(f, { daypartId: dinner, amount: 358 });
    const rows = await inForce(f);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.withdrawn)).toBe(true);
    expect(rows.map((r) => `${r.daypart_id}:${r.amount}`).sort()).toEqual([`${lunch}:338.00`, `${dinner}:358.00`].sort());
  });

  it('Lunch and Dinner then all-day (withdraw first): exactly one live row, the all-day one', async () => {
    const f = await fx('f4c');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });
    await withdraw(f, lunch);
    await withdraw(f, dinner);
    const [all] = await offer(f, { daypartId: null, amount: 300 });
    expect((await inForce(f)).map((r) => r.id)).toEqual([all!.id]);
  });

  it('everything withdrawn: exactly one row, the newest withdrawal', async () => {
    const f = await fx('f4d');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    await offer(f, { daypartId: dinner });
    await withdraw(f, lunch);
    const [last] = await withdraw(f, dinner);
    const rows = await inForce(f);
    expect(rows.map((r) => [r.id, r.withdrawn])).toEqual([[last!.id, true]]);
  });

  it('a live slot beside a withdrawn slot returns only the live one', async () => {
    const f = await fx('f4e');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch });
    const [dn] = await offer(f, { daypartId: dinner });
    await withdraw(f, lunch);
    expect((await inForce(f)).map((r) => r.id)).toEqual([dn!.id]);
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

// =================================================================================================
// Audit round 2: the online channel, tie-breaks, interleavings, the application role.
// =================================================================================================
describe('A2.1 - the delete guard covers the online channel, not only store', () => {
  const del = (id: string) => sql`delete from menu_offers where id = ${id}`;

  it('online: all-day live, all-day withdrawn +5d, Lunch live +5d: deleting the withdrawal would mix all-day and dayparted -> refused', async () => {
    const f = await fx('a21a');
    const lunch = await dp(f, { name: 'Lunch' });
    await offer(f, { daypartId: null, channel: 'online' });
    const [w] = await withdraw(f, null, { from: future(5), channel: 'online' });
    expect(await refusal(() => offer(f, { daypartId: lunch, from: future(5), channel: 'online' }))).toBeUndefined();
    const err = await refusal(() => del(w!.id));
    expect(err?.code, 'the online delete was accepted and left an all-day and a dayparted online offer live together').toBe('23514');
    expect(err?.message).toMatch(/all-day/);
    expect(await offerCount(f)).toBe(3);
  });

  it('online: A live, A withdrawn +5d, overlapping B live +5d: deleting the withdrawal would overlap A and B -> refused', async () => {
    const f = await fx('a21b');
    const a = await dp(f, { name: 'A', start: '08:00', end: '12:00' });
    const b = await dp(f, { name: 'B', start: '11:00', end: '14:00' });
    await offer(f, { daypartId: a, channel: 'online' });
    const [w] = await withdraw(f, a, { from: future(5), channel: 'online' });
    expect(await refusal(() => offer(f, { daypartId: b, from: future(5), channel: 'online' }))).toBeUndefined();
    const err = await refusal(() => del(w!.id));
    expect(err?.code, 'the online delete was accepted and left two overlapping dayparted online offers live').toBe('23514');
    expect(err?.message).toMatch(/overlap/);
  });

  it('a delete that recreates nothing still succeeds online; and a store-channel delete is not refused because of the other channel', async () => {
    const f = await fx('a21c');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch, channel: 'online' });
    const [gw] = await withdraw(f, lunch, { from: future(5), channel: 'online' });
    await offer(f, { daypartId: dinner, from: future(5), channel: 'online' });
    expect(await refusal(() => del(gw!.id))).toBeUndefined();

    const g = await fx('a21d');
    const d = await dp(g, { name: 'Lunch' });
    await offer(g, { daypartId: d, channel: 'online' });
    await offer(g, { daypartId: null, channel: 'store' });
    const [sw] = await withdraw(g, null, { from: future(5), channel: 'store' });
    expect(await refusal(() => del(sw!.id))).toBeUndefined();
  });
});

describe('A2.2 - the daypart window edit and the retire cover the online channel', () => {
  it('online: Lunch and Dinner live, stretching Lunch into Dinner is refused (overlap); shrinking it is allowed', async () => {
    const f = await fx('a22a');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch, channel: 'online' });
    await offer(f, { daypartId: dinner, channel: 'online' });
    const err = await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`);
    expect(err?.code, 'an online window edit overlapped two live online offers').toBe('23514');
    expect(err?.message).toMatch(/overlap/);
    expect(await refusal(() => sql`update menu_dayparts set end_time = '16:00' where id = ${lunch}`)).toBeUndefined();
  });

  it('online: a daypart whose only live offer is online cannot retire (count in the message); allowed after the online withdrawal', async () => {
    const f = await fx('a22b');
    const d = await dp(f);
    await offer(f, { daypartId: d, channel: 'online' });
    const err = await refusal(() => retire(d));
    expect(err?.code, 'retired a daypart with a live online offer').toBe('23514');
    expect(err?.message).toMatch(/1 live offer/);
    await withdraw(f, d, { channel: 'online' });
    expect(await refusal(() => retire(d))).toBeUndefined();
  });

  it('online: the edit is judged over time too (an online overlap that starts tomorrow is refused)', async () => {
    const f = await fx('a22c');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await offer(f, { daypartId: lunch, channel: 'online' });
    await offer(f, { daypartId: dinner, channel: 'online', from: future(1) });
    expect((await refusal(() => sql`update menu_dayparts set end_time = '18:00' where id = ${lunch}`))?.code).toBe('23514');
  });
});

describe('A2.3 - menu_offer_in_force: same-instant ties and past instants', () => {
  type Row = { daypartId: string | null; from: string; withdrawn?: boolean; amount?: number };
  /** The insert guard forbids back-dating, so rows at past instants are written by the owner with triggers off (replica role), in one transaction. Returns the ids in input order. */
  const seed = (f: MenuFx, variantId: string, rows: Row[]) =>
    sql.begin(async (tx) => {
      await tx.unsafe('set local session_replication_role = replica');
      const out: string[] = [];
      for (const r of rows) {
        const [o] = await tx<{ id: string }[]>`
          insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, daypart_id, amount, withdrawn, created_by)
          values (${f.orgId}, ${f.storeId}, ${variantId}, 'store', ${r.from}::timestamptz, ${r.daypartId}, ${r.withdrawn ? null : (r.amount ?? 100)}, ${!!r.withdrawn}, ${f.personId})
          returning id`;
        out.push(o!.id);
      }
      return out;
    });
  const at = (f: MenuFx, variantId: string, instant: string) =>
    sql<{ id: string }[]>`select id from menu_offer_in_force(${f.storeId}, ${variantId}, 'store', ${instant}::timestamptz)`.then((r) => r.map((x) => x.id).sort());
  const ids = (...x: string[]) => [...x].sort();

  it('asked at PAST instants (not only now): the state at each moment of a history, inclusive at the exact effective_from', async () => {
    const f = await fx('a23a');
    const base = Date.now();
    const d = (days: number) => new Date(base + days * DAY).toISOString(); // one fixed clock, so two rows meant to share an instant do
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    const [r1, r2, r3, r4, r5] = await seed(f, f.variantId, [
      { daypartId: null, from: d(-10), amount: 100 },
      { daypartId: null, from: d(-6), withdrawn: true },
      { daypartId: lunch, from: d(-4), amount: 338 },
      { daypartId: dinner, from: d(-4), amount: 358 },
      { daypartId: lunch, from: d(-2), amount: 340 },
    ]);
    expect(await at(f, f.variantId, d(-11)), 'before any row').toEqual([]);
    expect(await at(f, f.variantId, d(-8))).toEqual(ids(r1!));
    expect(await at(f, f.variantId, d(-5)), 'all-day withdrawn: one withdrawn row').toEqual(ids(r2!));
    expect(await at(f, f.variantId, d(-4)), 'inclusive at the exact instant').toEqual(ids(r3!, r4!));
    expect(await at(f, f.variantId, d(-3))).toEqual(ids(r3!, r4!));
    expect(await at(f, f.variantId, d(-1))).toEqual(ids(r5!, r4!));
    expect(await at(f, f.variantId, new Date().toISOString())).toEqual(ids(r5!, r4!));
  });

  it('two withdrawn rows at the SAME instant, one all-day and one dayparted: the dayparted row is returned (all-day sorts last), in every insert order, 20 times, at a past instant', async () => {
    const f = await fx('a23b');
    const lunch = await dp(f, { name: 'Lunch' });
    const wrong: string[] = [];
    for (let i = 0; i < 20; i++) {
      const other = await newItem(f, 'a_la_carte');
      const tie = future(-1);
      const rows: Row[] = [
        { daypartId: null, from: tie, withdrawn: true },
        { daypartId: lunch, from: tie, withdrawn: true },
      ];
      const order = i % 2 === 0 ? [0, 1] : [1, 0]; // alternate, so both insert orders are covered every run
      const placed = await seed(f, other.variantId, [{ daypartId: null, from: future(-10), amount: 100 }, ...order.map((k) => rows[k]!)]);
      const lunchRowId = placed[1 + order.indexOf(1)]!;
      const got = await at(f, other.variantId, future(-0.5));
      if (got.length !== 1 || got[0] !== lunchRowId) wrong.push(`rep ${i} order ${order.join('')}: got ${got.join(',')} want ${lunchRowId}`);
      expect(await at(f, other.variantId, future(-5))).toEqual(ids(placed[0]!));
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('the same tie through the normal (future-dated, trigger-guarded) path: all-day and dayparted withdrawals at one future instant', async () => {
    const f = await fx('a23c');
    const lunch = await dp(f, { name: 'Lunch' });
    await offer(f, { daypartId: null });
    const t = future(2);
    const [wAll] = await withdraw(f, null, { from: t });
    const [wLunch] = await withdraw(f, lunch, { from: t });
    expect(wAll!.id).not.toBe(wLunch!.id);
    expect(await at(f, f.variantId, future(3))).toEqual(ids(wLunch!.id));
  });
});

describe('A2.4 - real two-connection interleavings: each ends or refuses cleanly, never 40P01', () => {
  const mk = (app: string) => postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection: { application_name: app } });
  const blockedOn = async (app: string) => {
    for (let i = 0; i < 200; i++) {
      const [r] = await sql<{ n: number }[]>`select count(*)::int n from pg_stat_activity where application_name = ${app} and wait_event_type = 'Lock'`;
      if (r!.n > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`${app} never blocked`);
  };
  /** `hold` runs in an OPEN transaction on its own connection (it keeps its locks); `wait` then starts on another connection and must block; then hold commits. */
  async function interleave(hold: (tx: postgres.TransactionSql) => PromiseLike<unknown>, wait: (c: postgres.Sql) => PromiseLike<unknown>) {
    const tag = uid('t510il');
    const c1 = mk(`${tag}-hold`);
    const c2 = mk(`${tag}-wait`);
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let ready: () => void = () => {};
      const readyP = new Promise<void>((r) => (ready = r));
      const holdDone = refusal(() =>
        c1.begin(async (tx) => {
          try {
            await hold(tx);
          } finally {
            ready();
          }
          await gate;
        }),
      );
      await readyP;
      const waitDone = refusal(() => wait(c2));
      await blockedOn(`${tag}-wait`);
      release();
      const [held, waited] = await Promise.all([holdDone, waitDone]);
      return { held, waited };
    } finally {
      await Promise.all([c1.end({ timeout: 5 }), c2.end({ timeout: 5 })]);
    }
  }
  const codes = (r: { held?: { code?: string }; waited?: { code?: string } }) => `held=${r.held?.code ?? 'ok'} waited=${r.waited?.code ?? 'ok'}`;

  /** Lunch live now, Lunch withdrawn +5d (W), Dinner live +5d. Stretching Lunch is fine alone; deleting W is fine alone; both together overlap at +5d. */
  async function scene(hint: string) {
    const f = await fx(hint);
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    const t = future(5);
    await offer(f, { daypartId: lunch });
    const [w] = await withdraw(f, lunch, { from: t });
    await offer(f, { daypartId: dinner, from: t });
    return { f, lunch, dinner, wId: w!.id };
  }
  const lunchEnd = async (id: string) => (await sql<{ e: string }[]>`select end_time::text e from menu_dayparts where id = ${id}`)[0]!.e;
  const exists = async (id: string) => (await sql<{ n: number }[]>`select count(*)::int n from menu_offers where id = ${id}`)[0]!.n === 1;

  it('delete of a scheduled withdrawal (held) vs window edit of its daypart (waiting): exactly one wins, the other is refused 23514', async () => {
    const { lunch, wId } = await scene('a24a');
    const r = await interleave(
      (tx) => tx`delete from menu_offers where id = ${wId}`,
      (c) => c`update menu_dayparts set end_time = '18:00' where id = ${lunch}`,
    );
    expect(r.held, codes(r)).toBeUndefined();
    expect(r.waited?.code, codes(r)).toBe('23514');
    expect(await exists(wId)).toBe(false);
    expect(await lunchEnd(lunch)).toBe('17:00:00');
  });

  it('window edit (held) vs delete of the scheduled withdrawal (waiting): exactly one wins, the other is refused 23514', async () => {
    const { lunch, wId } = await scene('a24b');
    const r = await interleave(
      (tx) => tx`update menu_dayparts set end_time = '18:00' where id = ${lunch}`,
      (c) => c`delete from menu_offers where id = ${wId}`,
    );
    expect(r.held, codes(r)).toBeUndefined();
    expect(r.waited?.code, codes(r)).toBe('23514');
    expect(await exists(wId)).toBe(true);
    expect(await lunchEnd(lunch)).toBe('18:00:00');
  });

  it('two concurrent deletes of different future rows of one variant both complete; two deletes of the SAME row: one deletes it, the other finds it gone', async () => {
    const f = await fx('a24c');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    const [p1] = await offer(f, { daypartId: d, amount: 120, from: future(3) });
    const [p2] = await offer(f, { daypartId: d, amount: 130, from: future(4) });
    const r = await interleave(
      (tx) => tx`delete from menu_offers where id = ${p1!.id}`,
      (c) => c`delete from menu_offers where id = ${p2!.id}`,
    );
    expect(r.held, codes(r)).toBeUndefined();
    expect(r.waited, codes(r)).toBeUndefined();
    expect(await offerCount(f)).toBe(1);

    const g = await fx('a24c2');
    const gd = await dp(g);
    await offer(g, { daypartId: gd });
    const [same] = await offer(g, { daypartId: gd, amount: 120, from: future(3) });
    const s = await interleave(
      (tx) => tx`delete from menu_offers where id = ${same!.id}`,
      (c) => c`delete from menu_offers where id = ${same!.id}`,
    );
    expect(s.held, codes(s)).toBeUndefined();
    expect(s.waited, codes(s)).toBeUndefined();
    expect(await offerCount(g)).toBe(1);
  });

  it('insert of two overlapping dayparts of one variant, interleaved (either order): exactly one is accepted, the other refused 23514', async () => {
    for (const first of ['a', 'b'] as const) {
      const f = await fx(`a24d${first}`);
      const a = await dp(f, { name: 'A', start: '08:00', end: '12:00' });
      const b = await dp(f, { name: 'B', start: '11:00', end: '14:00' });
      const [mine, theirs] = first === 'a' ? [a, b] : [b, a];
      const r = await interleave(
        (tx) => tx`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
                   values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${mine!}, 100, false, ${f.personId})`,
        (c) => c`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
                 values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${theirs!}, 100, false, ${f.personId})`,
      );
      expect(r.held, codes(r)).toBeUndefined();
      expect(r.waited?.code, codes(r)).toBe('23514');
      expect(r.waited?.message).toMatch(/overlap/);
      expect(await offerCount(f)).toBe(1);
    }
  });

  it('the same pair raced WITHOUT parking (15 fresh variants, both submitted at once): one accepted, one 23514, never 40P01', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 15; i++) {
      const f = await fx(`a24e${i}`);
      const a = await dp(f, { name: 'A', start: '08:00', end: '12:00' });
      const b = await dp(f, { name: 'B', start: '11:00', end: '14:00' });
      const [ra, rb] = await Promise.all([refusal(() => offer(f, { daypartId: a })), refusal(() => offer(f, { daypartId: b }))]);
      const got = [ra?.code ?? 'ok', rb?.code ?? 'ok'].sort().join('+');
      outcomes.push(got);
      expect(await offerCount(f), `rep ${i}: ${got}`).toBe(1);
    }
    expect([...new Set(outcomes)]).toEqual(['23514+ok']);
  });

  it('a delete racing an insert in the same slot, and a window edit racing a retire of the same daypart, end cleanly', async () => {
    const f = await fx('a24f');
    const d = await dp(f);
    await offer(f, { daypartId: d });
    const [sched] = await offer(f, { daypartId: d, amount: 120, from: future(3) });
    const r = await interleave(
      (tx) => tx`delete from menu_offers where id = ${sched!.id}`,
      (c) => c`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, daypart_id, amount, withdrawn, created_by)
               values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${future(4)}::timestamptz, ${d}, 105, false, ${f.personId})`,
    );
    expect(r.held, codes(r)).toBeUndefined();
    expect(r.waited, codes(r)).toBeUndefined();

    const g = await fx('a24g');
    const gd = await dp(g);
    const s = await interleave(
      (tx) => tx`update menu_dayparts set start_time = '09:00' where id = ${gd}`,
      (c) => c`update menu_dayparts set status = 'retired' where id = ${gd}`,
    );
    expect(s.held, codes(s)).toBeUndefined();
    expect(s.waited, codes(s)).toBeUndefined();
    expect(await status(gd)).toBe('retired');
  });
});

describe('A2.5 - the offer guards run as the application role shareat_app (org context set)', () => {
  type Tx = postgres.TransactionSql;
  const appOffer = async (tx: Tx, f: MenuFx, o: OfferOpts = {}) => {
    const [r] = await tx<{ id: string }[]>`
      insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, daypart_id, amount, withdrawn, created_by)
      values (${f.orgId}, ${f.storeId}, ${o.variantId ?? f.variantId}, ${o.channel ?? 'store'}, coalesce(${o.from ?? null}::timestamptz, now()),
              ${o.daypartId ?? null}, ${o.withdrawn ? null : (o.amount ?? 100)}, ${!!o.withdrawn}, ${f.personId})
      returning id`;
    return r!.id;
  };
  /** Runs fn in its own savepoint and resolves with the error it raised, or undefined. */
  const sp = (tx: Tx, fn: (s: Tx) => PromiseLike<unknown>) =>
    refusal(() =>
      tx.savepoint(async (s) => {
        await fn(s as unknown as Tx);
      }),
    );

  it('insert guard as shareat_app: overlap, all-day-next-to-dayparted and a retired daypart are refused; an adjacent daypart is accepted', async () => {
    const f = await fx('a25a');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    const b = await dp(f, { name: 'B', start: '16:00', end: '18:00' });
    const gone = await dp(f, { name: 'Gone', start: '01:00', end: '02:00' });
    await retire(gone);
    const { err, value } = await asApp(f.orgId, async (tx) => {
      await appOffer(tx, f, { daypartId: lunch });
      return {
        overlap: (await sp(tx, (s) => appOffer(s, f, { daypartId: b })))?.code,
        mixed: (await sp(tx, (s) => appOffer(s, f, { daypartId: null })))?.code,
        retiredDp: (await sp(tx, (s) => appOffer(s, f, { daypartId: gone, channel: 'online' })))?.code,
        adjacent: (await sp(tx, (s) => appOffer(s, f, { daypartId: dinner })))?.code,
        online: (await sp(tx, (s) => appOffer(s, f, { daypartId: b, channel: 'online' })))?.code,
      };
    });
    expect(err?.message).toBeUndefined();
    expect(value).toEqual({ overlap: '23514', mixed: '23514', retiredDp: '23514', adjacent: undefined, online: undefined });
  });

  it('delete guard as shareat_app (store and online): a delete that would recreate a forbidden state is refused, a harmless one succeeds', async () => {
    const f = await fx('a25b');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const a = await dp(f, { name: 'A', start: '08:00', end: '12:00' });
    const b = await dp(f, { name: 'B', start: '11:00', end: '14:00' });
    const variants: Record<string, string> = {};
    for (const k of ['store-1', 'store-2', 'online-1', 'online-2']) {
      variants[k] = (await newItem(f, 'a_la_carte')).variantId;
      await insRule(f, variants[k]);
    }
    const { err, value } = await asApp(f.orgId, async (tx) => {
      const out: Record<string, string | undefined> = {};
      for (const channel of ['store', 'online']) {
        // all-day live, withdrawn +5d, Lunch live +5d
        const v = variants[`${channel}-1`]!;
        await appOffer(tx, f, { variantId: v, channel });
        const w = await appOffer(tx, f, { variantId: v, channel, withdrawn: true, from: future(5) });
        await appOffer(tx, f, { variantId: v, channel, daypartId: lunch, from: future(5) });
        out[`${channel}-mixed`] = (await sp(tx, (s) => s`delete from menu_offers where id = ${w}`))?.code;
        // overlapping dayparts: A live, A withdrawn +5d, B live +5d
        const v2 = variants[`${channel}-2`]!;
        await appOffer(tx, f, { variantId: v2, channel, daypartId: a });
        const w2 = await appOffer(tx, f, { variantId: v2, channel, daypartId: a, withdrawn: true, from: future(5) });
        await appOffer(tx, f, { variantId: v2, channel, daypartId: b, from: future(5) });
        out[`${channel}-overlap`] = (await sp(tx, (s) => s`delete from menu_offers where id = ${w2}`))?.code;
        // harmless: a scheduled price change
        const change = await appOffer(tx, f, { variantId: v2, channel, daypartId: b, amount: 120, from: future(6) });
        out[`${channel}-harmless`] = (await sp(tx, (s) => s`delete from menu_offers where id = ${change}`))?.code;
      }
      return out;
    });
    expect(err?.message).toBeUndefined();
    expect(value).toEqual({
      'store-mixed': '23514',
      'store-overlap': '23514',
      'store-harmless': undefined,
      'online-mixed': '23514',
      'online-overlap': '23514',
      'online-harmless': undefined,
    });
  });

  it('retire and window edit as shareat_app go through the same guards', async () => {
    const f = await fx('a25c');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    const { err, value } = await asApp(f.orgId, async (tx) => {
      await appOffer(tx, f, { daypartId: lunch, channel: 'online' });
      await appOffer(tx, f, { daypartId: dinner, channel: 'online' });
      return {
        retire: (await sp(tx, (s) => s`update menu_dayparts set status = 'retired', updated_at = now() where id = ${lunch}`))?.code,
        stretch: (await sp(tx, (s) => s`update menu_dayparts set end_time = '18:00', updated_at = now() where id = ${lunch}`))?.code,
        shrink: (await sp(tx, (s) => s`update menu_dayparts set end_time = '16:00', updated_at = now() where id = ${lunch}`))?.code,
        rename: (await sp(tx, (s) => s`update menu_dayparts set name = 'Brunch', updated_at = now() where id = ${lunch}`))?.code,
      };
    });
    expect(err?.message).toBeUndefined();
    expect(value).toEqual({ retire: '23514', stretch: '23514', shrink: undefined, rename: undefined });
  });
});

describe('A2.6 - known limit: a multi-statement transaction can deadlock (40P01) across the guards, and the database stays consistent', () => {
  // The lock order (daypart row, item key, variant keys) is enforced INSIDE each guard, not across the statements of one transaction.
  // tx1 inserts (V1, Lunch) and holds V1's keys; a window edit of Dinner holds Dinner's row and waits for V1; tx1 then inserts (V1, Dinner)
  // and waits for the Dinner row: a cycle. PostgreSQL aborts exactly one side. S1b/S3 writers that touch several offers in one transaction retry once on 40P01.
  // Not fixed in S1a (docs/tasks/510-menu-dayparts.md S1b). If this test ever fails because NOBODY deadlocks, the lock order was changed: update the test AND that spec line.
  it('known limit: tx1 (insert Lunch, then insert Dinner) vs a Dinner window edit that overlaps Lunch -> exactly one side gets 40P01, nothing is corrupted', async () => {
    const f = await fx('a26');
    const lunch = await dp(f, { name: 'Lunch', start: '08:00', end: '17:00' });
    const dinner = await dp(f, { name: 'Dinner', start: '17:00', end: '08:00' });
    await withdraw(f, dinner); // Dinner already has a (withdrawn) row, so the edit must lock this variant
    const mk = (app: string) => postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection: { application_name: app } });
    const tag = uid('t510ll');
    const c1 = mk(`${tag}-tx1`);
    const c2 = mk(`${tag}-edit`);
    const blockedOn = async (app: string) => {
      for (let i = 0; i < 200; i++) {
        const [r] = await sql<{ n: number }[]>`select count(*)::int n from pg_stat_activity where application_name = ${app} and wait_event_type = 'Lock'`;
        if (r!.n > 0) return;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`${app} never blocked`);
    };
    const insertLive = (tx: postgres.TransactionSql, daypart: string) =>
      tx`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
         values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', ${daypart}, 100, false, ${f.personId})`;
    try {
      let step3: () => void = () => {};
      const gate = new Promise<void>((r) => (step3 = r));
      let step1: () => void = () => {};
      const step1P = new Promise<void>((r) => (step1 = r));
      const p1 = refusal(() =>
        c1.begin(async (tx) => {
          try {
            await insertLive(tx, lunch);
          } finally {
            step1();
          }
          await gate;
          await insertLive(tx, dinner);
        }),
      );
      await step1P;
      const p2 = refusal(() => c2`update menu_dayparts set start_time = '16:00' where id = ${dinner}`);
      await blockedOn(`${tag}-edit`); // the edit holds Dinner's row and waits for V1's key
      step3();
      const [e1, e2] = await Promise.all([p1, p2]);

      const victims = [e1, e2].filter((e) => e?.code === '40P01');
      expect(victims, `expected exactly one 40P01, got tx1=${e1?.code ?? 'ok'} edit=${e2?.code ?? 'ok'}`).toHaveLength(1);
      const survivor = e1?.code === '40P01' ? e2 : e1;
      expect(survivor, `the survivor must finish cleanly: ${survivor?.message}`).toBeUndefined();

      const rows = await sql<{ n: number }[]>`select count(*)::int n from menu_offers where variant_id = ${f.variantId}`;
      const [d] = await sql<{ s: string }[]>`select start_time::text s from menu_dayparts where id = ${dinner}`;
      if (e1?.code === '40P01') {
        // tx1 was the victim: its Lunch insert rolled back too; the edit applied
        expect(rows[0]!.n, 'tx1 aborted but left rows behind').toBe(1);
        expect(d!.s).toBe('16:00:00');
      } else {
        // the edit was the victim: tx1 committed both offers; Dinner is unchanged
        expect(rows[0]!.n, 'tx1 committed but its rows are missing').toBe(3);
        expect(d!.s).toBe('17:00:00');
      }
      const [c] = await sql<{ c: string | null }[]>`
        select menu_offer_slot_conflict(${f.storeId}, ${f.variantId}, 'store', false, null, null, null, null, null, null, null, null) c`;
      expect(c!.c, 'a forbidden state was committed').toBeNull();
    } finally {
      await Promise.all([c1.end({ timeout: 5 }), c2.end({ timeout: 5 })]);
    }
  }, 60_000);
});
