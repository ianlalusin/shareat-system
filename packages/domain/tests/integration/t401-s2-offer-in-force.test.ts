/**
 * T-401 S2, I2 (+ I1b through the domain). docs/tasks/401-erp-menu-catalog-master.md R5, section 4.
 * TESTER, not BUILDER. Real Postgres, every write through the domain under test, every read through the repo under test.
 *
 * ## Assumed contract (the builder must match; each name is in the report)
 *   domain  setMenuOffer(actor, { storeId, variantId, channel, amount, effectiveFrom?: Date }, tx?)     -> { id }
 *           withdrawMenuOffer(actor, { storeId, variantId, channel, effectiveFrom?: Date }, tx?)         -> { id }
 *           setOptionOffer(actor, { storeId, optionValueId, channel, priceDelta, effectiveFrom?: Date }, tx?) -> { id }
 *   repo    menuRepo.offersInForce(tx, storeId, at: Date)        -> rows [{ variantId, channel, amount: string }] of what is OFFERED at `at`
 *                                                                   (a withdrawn row in force may be returned with withdrawn=true, or be absent: these tests ignore withdrawn rows either way)
 *           menuRepo.optionOffersInForce(tx, storeId, at: Date)  -> rows [{ optionValueId, channel, priceDelta: string }], same rule
 *           menuRepo.offerHistory(tx, storeId, variantId)        -> every row for the variant at the store, any order
 *   `effectiveFrom` omitted = the database now() default (a JS clock is always a little in the past and the DB refuses that, I1b).
 *
 * ## Red today
 * packages/domain/src/menu does not exist: `setMenuOffer is not a function`. The assertions below are what must hold after.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { businessDayRange, parseBusinessDate } from '@shareat/core/datetime';
import { menuRepo } from '@shareat/db';
import { setMenuOffer, withdrawMenuOffer, setOptionOffer } from '@shareat/domain';

import { asOrg, attempt, cast, rawItem, rawOption, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const HOUR = 3_600_000;
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

/** Re-reads effective_from as the database stored it (the ONLY honest source for an instant). */
async function fromOf(id: string, table: 'menu_offers' | 'menu_option_offers'): Promise<Date> {
  const [r] = await sql.unsafe<{ t: Date }[]>(`select effective_from as t from ${table} where id = '${id}'`);
  return r!.t;
}

async function offeredAt(c: Cast, at: Date) {
  return asOrg(c.orgId, (tx) => menuRepo.offersInForce(tx, c.storeA, at));
}

describe('I2 -- the offer in force at t is the row with the greatest effective_from <= t; withdrawn or no row = not offered', () => {
  it('past/now/future rows queried at five instants (mutant: `<` instead of `<=` in offersInForce)', async () => {
    const c = await cast('i2a');
    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);

    const now = await asOrg(c.orgId, (tx) => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' }, tx));
    const later = await asOrg(c.orgId, (tx) =>
      setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '120.00', effectiveFrom: new Date(Date.now() + 2 * HOUR) }, tx));
    const gone = await asOrg(c.orgId, (tx) =>
      withdrawMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', effectiveFrom: new Date(Date.now() + 4 * HOUR) }, tx));

    const t1 = await fromOf(now.id, 'menu_offers');
    const t2 = await fromOf(later.id, 'menu_offers');
    const t3 = await fromOf(gone.id, 'menu_offers');

    const amountAt = async (at: Date) => (await offeredAt(c, at)).find((r) => r.variantId === variantId && r.channel === 'store' && !r.withdrawn)?.amount;
    expect(await amountAt(ms(t1, -1)), 'before the first row: not offered').toBeUndefined();
    expect(await amountAt(t1), 'exactly at effective_from the row IS in force (<=, not <)').toBe('100.00');
    expect(await amountAt(ms(t2, -1)), 'one ms before the scheduled change the old price holds').toBe('100.00');
    expect(await amountAt(t2), 'exactly at the scheduled change the new price holds').toBe('120.00');
    expect(await amountAt(t3), 'a withdrawn row in force: not offered').toBeUndefined();
    expect(await amountAt(ms(t3, 3 * HOUR)), 'and it stays withdrawn').toBeUndefined();

    // K2: the repo and the one SQL function agree on every instant (two writings of "in force" would drift).
    for (const at of [ms(t1, -1), t1, ms(t2, -1), t2, t3]) {
      const [fn] = await sql<{ amount: string | null; withdrawn: boolean }[]>`
        select amount, withdrawn from menu_offer_in_force(${c.storeA}, ${variantId}, 'store', ${at})`;
      expect(await amountAt(at)).toBe(fn && !fn.withdrawn ? fn.amount : undefined);
    }

    const history = await asOrg(c.orgId, (tx) => menuRepo.offerHistory(tx, c.storeA, variantId));
    expect(history).toHaveLength(3);
  });

  it('channels resolve separately: a store price does not make the item offered online (mutant: channel ignored in the lookup)', async () => {
    const c = await cast('i2b');
    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);
    const s = await asOrg(c.orgId, (tx) => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' }, tx));
    const t = await fromOf(s.id, 'menu_offers');
    const rows = (await offeredAt(c, ms(t, 1000))).filter((r) => !r.withdrawn);
    expect(rows.filter((r) => r.variantId === variantId).map((r) => r.channel)).toEqual(['store']);
    await asOrg(c.orgId, (tx) => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'online', amount: '110.00' }, tx));
    const both = (await offeredAt(c, new Date(Date.now() + 5000))).filter((r) => r.variantId === variantId && !r.withdrawn);
    expect(Object.fromEntries(both.map((r) => [r.channel, r.amount]))).toEqual({ store: '100.00', online: '110.00' });
  });

  it('prices are per store: an offer at store A says nothing about store B', async () => {
    const c = await cast('i2c');
    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);
    const s = await asOrg(c.orgId, (tx) => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' }, tx));
    const at = ms(await fromOf(s.id, 'menu_offers'), 1000);
    const atB = await asOrg(c.orgId, (tx) => menuRepo.offersInForce(tx, c.storeB, at));
    expect(atB.filter((r) => r.variantId === variantId)).toEqual([]);
  });

  it('option offers resolve per channel: store-only value is absent online; online delta differs from store and each channel reads its own', async () => {
    const c = await cast('i2d');
    const a = await rawOption(c);
    const b = await rawOption(c);
    const sA = await asOrg(c.orgId, (tx) => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: a.valueId, channel: 'store', priceDelta: '5.00' }, tx));
    await asOrg(c.orgId, (tx) => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: a.valueId, channel: 'online', priceDelta: '8.00' }, tx));
    await asOrg(c.orgId, (tx) => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: b.valueId, channel: 'store', priceDelta: '-10.00' }, tx));
    const at = ms(await fromOf(sA.id, 'menu_option_offers'), 5000);
    const rows = await asOrg(c.orgId, (tx) => menuRepo.optionOffersInForce(tx, c.storeA, at));
    const key = (r: { optionValueId: string; channel: string }) => `${r.optionValueId}/${r.channel}`;
    const got = Object.fromEntries(rows.map((r) => [key(r), r.priceDelta]));
    expect(got[`${a.valueId}/store`]).toBe('5.00');
    expect(got[`${a.valueId}/online`]).toBe('8.00');
    expect(got[`${b.valueId}/store`], 'signed delta kept (R4: "no rice, -10" is real)').toBe('-10.00');
    expect(got[`${b.valueId}/online`], 'offered at the counter, withheld online').toBeUndefined();
  });

  it('DATETIME: "from 2026-12-01 00:00" Asia/Manila is stored as the instant 2026-11-30T16:00:00Z, never a business date (mutant: the form parses the time as UTC)', async () => {
    const c = await cast('i2e');
    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);
    // What the S4 price form hands the domain: the Manila midnight, from @shareat/core/datetime, as an instant.
    const manilaMidnight = businessDayRange(parseBusinessDate('2026-12-01')).start;
    expect(manilaMidnight.toISOString()).toBe('2026-11-30T16:00:00.000Z');

    const o = await asOrg(c.orgId, (tx) =>
      setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '150.00', effectiveFrom: manilaMidnight }, tx));
    const [stored] = await sql<{ iso: string }[]>`
      select to_char(effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as iso from menu_offers where id = ${o.id}`;
    expect(stored!.iso).toBe('2026-11-30T16:00:00Z');

    const amountAt = async (at: Date) => (await offeredAt(c, at)).find((r) => r.variantId === variantId && !r.withdrawn)?.amount;
    expect(await amountAt(new Date('2026-11-30T15:59:59.999Z')), '23:59:59.999 Manila on 30 Nov: not yet').toBeUndefined();
    expect(await amountAt(new Date('2026-11-30T16:00:00.000Z')), '00:00 Manila on 1 Dec: in force').toBe('150.00');
    expect(await amountAt(new Date('2026-12-01T00:00:00.000Z')), '08:00 Manila on 1 Dec: still in force').toBe('150.00');
  });
});

describe('I1b through the domain -- the past is never rewritten', () => {
  it('setMenuOffer with an effectiveFrom in the past is refused and writes no row (mutant: the domain clamps or ignores effectiveFrom)', async () => {
    const c = await cast('i1b');
    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);
    const out = await asOrg(c.orgId, (tx) =>
      attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00', effectiveFrom: new Date(Date.now() - 60_000) }, tx)));
    expect(out.failed, 'a back-dated offer was accepted').toBe(true);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${c.orgId}`;
    expect(n!.n, 'no menu_offers row may exist').toBe(0);
    // Control: the refusal above is about the past, not about this call being broken - a scheduled change goes through.
    await asOrg(c.orgId, (tx) => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00', effectiveFrom: new Date(Date.now() + HOUR) }, tx));
    const [m] = await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${c.orgId}`;
    expect(m!.n).toBe(1);
  });
});

