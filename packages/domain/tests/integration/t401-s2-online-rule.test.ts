/**
 * T-401 S2, I18, I19, I13b (rule figures), I20 (domain half). docs/tasks/401-erp-menu-catalog-master.md R15 (Ian, Q4: "items with
 * volatile price adjust automatically"), section 4. TESTER, not BUILDER. Real Postgres; money is exact decimal text.
 *
 * ## Assumed contract
 *   setMenuOffer(actor, { storeId, variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '7.5', effectiveFrom? }, tx?)
 *   setMenuOffer(actor, { ..., channel: 'online', pricingMode: 'fixed_markup', fixedMarkupAmount: '-5.00' }, tx?)
 *   setMenuOffer(actor, { ..., channel: 'online', amount: '110.00' }, tx?)          pricingMode omitted = 'fixed' (today's behaviour)
 *     -> { id }; columns pricing_mode / markup_percent / fixed_markup_amount on menu_offers (R15); the rule is NEVER stored as a price.
 *   menuRepo.offersInForce(tx, storeId, at) -> rows { variantId, channel, withdrawn, pricingMode, amount, extraHeadAmount, bundleHeads,
 *       markupPercent, fixedMarkupAmount, basis }  - the row in force per (variant, channel); an ONLINE row carries `basis`, the STORE row in
 *       force at the SAME `at` (or null when there is none); a withdrawn row is returned with withdrawn = true.
 *   resolveOfferPrice(row)  (pure, @shareat/domain) -> { amount, extraHeadAmount, bundleHeads } (strings, 2 dp, extra and heads null when not a bundle)
 *                                                     | { notOffered: 'no_basis' | 'withdrawn' | 'rule_below_zero' }
 *   Rounding: exact decimal arithmetic, ONCE, half-up on the absolute value, to the centavo (computeBranchPrice's rule).
 *
 * ## Red today
 * `resolveOfferPrice is not a function` / `setMenuOffer is not a function`, and migration 0196 has no pricing_mode column yet (S1 revision).
 * Mutants: the basis is read at the online row's effective_from (the online price never follows); rounding per step or float arithmetic;
 * a negative result clamped to 0.00; the domain lets a 5th percent decimal reach numeric(8,4).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { menuRepo } from '@shareat/db';
import { resolveOfferPrice, setMenuOffer, withdrawMenuOffer } from '@shareat/domain';

import { asOrg, attempt, cast, rawItem, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const HOUR = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * HOUR);
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

type Rule = { pricingMode: 'percent_markup'; markupPercent: string } | { pricingMode: 'fixed_markup'; fixedMarkupAmount: string };

interface World {
  c: Cast;
  variantId: string;
}
async function world(hint: string, type: 'a_la_carte' | 'package' = 'a_la_carte'): Promise<World> {
  const c = await cast(hint);
  const { variantId } = await rawItem(c, type);
  await rawRule(c, variantId);
  return { c, variantId };
}
const putStore = (w: World, amount: string, extra: Record<string, unknown> = {}) =>
  asOrg(w.c.orgId, (tx) => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'store', amount, ...extra } as never, tx));
const putOnline = (w: World, rule: Rule, effectiveFrom?: Date) =>
  asOrg(w.c.orgId, (tx) =>
    setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'online', ...rule, ...(effectiveFrom ? { effectiveFrom } : {}) } as never, tx));

/** The online price at `at`, exactly as a reader would get it: the repo's row (with its basis) through the pure resolver. */
async function onlineAt(w: World, at: Date) {
  const rows = await asOrg(w.c.orgId, (tx) => menuRepo.offersInForce(tx, w.c.storeA, at));
  const row = rows.find((r) => r.variantId === w.variantId && r.channel === 'online');
  expect(row, 'no online row in force').toBeDefined();
  return resolveOfferPrice(row!);
}
const fromOf = async (id: string): Promise<Date> => (await sql<{ t: Date }[]>`select effective_from as t from menu_offers where id = ${id}`)[0]!.t;

describe('I18 -- an online rule is computed from the store price in force at the queried instant, rounded once half-up to the centavo', () => {
  it.each([
    ['85.50', { pricingMode: 'percent_markup', markupPercent: '7.5' }, '91.91', '91.9125 rounds up'],
    ['10.10', { pricingMode: 'percent_markup', markupPercent: '5' }, '10.61', '10.605 is a tie: half-up (a float gives 10.60)'],
    ['99.00', { pricingMode: 'percent_markup', markupPercent: '-10' }, '89.10', 'a negative percent is a discount'],
    ['10.10', { pricingMode: 'percent_markup', markupPercent: '-5' }, '9.60', '9.595 once; rounding the markup first gives 9.59'],
    ['99.00', { pricingMode: 'fixed_markup', fixedMarkupAmount: '-5.00' }, '94.00', 'a signed peso amount'],
    ['10.00', { pricingMode: 'fixed_markup', fixedMarkupAmount: '0.01' }, '10.01', 'a centavo markup'],
  ] as [string, Rule, string, string][])('store %s with %j -> online %s (%s)', async (store, rule, want) => {
    const w = await world('i18-ex');
    await putStore(w, store);
    await putOnline(w, rule);
    const price = await onlineAt(w, new Date(Date.now() + 5000));
    expect(price).toMatchObject({ amount: want });
  });

  it('the rule is stored as a rule, never as a price: pricing_mode set, markup_percent kept, amount NULL (mutant: the resolved price is written into amount)', async () => {
    const w = await world('i18-shape');
    await putStore(w, '85.50');
    const o = await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '7.5' });
    const [row] = await sql<{ pricing_mode: string; markup_percent: string; amount: string | null; fixed_markup_amount: string | null }[]>`
      select pricing_mode, markup_percent::text, amount::text, fixed_markup_amount::text from menu_offers where id = ${o.id}`;
    expect(row).toEqual({ pricing_mode: 'percent_markup', markup_percent: '7.5000', amount: null, fixed_markup_amount: null });
  });

  it('a fixed online price is unchanged behaviour: pricing_mode fixed, amount as typed, the store price does not move it', async () => {
    const w = await world('i18-fixed');
    await putStore(w, '100.00');
    const o = await asOrg(w.c.orgId, (tx) => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'online', amount: '120.00' } as never, tx));
    const [row] = await sql<{ pricing_mode: string }[]>`select pricing_mode from menu_offers where id = ${o.id}`;
    expect(row!.pricing_mode).toBe('fixed');
    expect(await onlineAt(w, new Date(Date.now() + 5000))).toMatchObject({ amount: '120.00' });
  });

  it('the store price changes at T: the online price follows from T with NO new online row (mutant: the basis is read at the online row\'s effective_from)', async () => {
    const w = await world('i18-follow');
    await putStore(w, '50.00');
    await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '10' });
    const change = await asOrg(w.c.orgId, (tx) =>
      setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'store', amount: '100.00', effectiveFrom: soon(1) } as never, tx));
    const T = await fromOf(change.id);
    expect(await onlineAt(w, ms(T, -1))).toMatchObject({ amount: '55.00' });
    expect(await onlineAt(w, ms(T, 1000))).toMatchObject({ amount: '110.00' });
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${w.c.orgId} and channel = 'online'`;
    expect(n!.n, 'one online row, written once').toBe(1);
  });

  it('a bundle store offer: the rule applies to amount AND extra_head_amount, bundle_heads is inherited', async () => {
    const w = await world('i18-bundle', 'package');
    await putStore(w, '999.00', { bundleHeads: 4, extraHeadAmount: '199.00' });
    await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '10' });
    expect(await onlineAt(w, new Date(Date.now() + 5000))).toMatchObject({ amount: '1098.90', extraHeadAmount: '218.90', bundleHeads: 4 });
    const v = await world('i18-bundle2', 'package');
    await putStore(v, '999.00', { bundleHeads: 4, extraHeadAmount: '199.00' });
    await putOnline(v, { pricingMode: 'fixed_markup', fixedMarkupAmount: '-10.00' });
    expect(await onlineAt(v, new Date(Date.now() + 5000))).toMatchObject({ amount: '989.00', extraHeadAmount: '189.00', bundleHeads: 4 });
  });
});

describe('I19 -- no basis or a withdrawn basis is not offered online; below zero is not offered, never clamped to 0.00', () => {
  it('no store offer in force: notOffered no_basis', async () => {
    const w = await world('i19-nb');
    await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '10' });
    expect(await onlineAt(w, new Date(Date.now() + 5000))).toEqual({ notOffered: 'no_basis' });
  });

  it('store offer withdrawn from T: offered before T, notOffered withdrawn from T', async () => {
    const w = await world('i19-wd');
    await putStore(w, '50.00');
    await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '10' });
    const gone = await asOrg(w.c.orgId, (tx) =>
      withdrawMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'store', effectiveFrom: soon(1) }, tx));
    const T = await fromOf(gone.id);
    expect(await onlineAt(w, ms(T, -1))).toMatchObject({ amount: '55.00' });
    expect(await onlineAt(w, ms(T, 1000))).toEqual({ notOffered: 'withdrawn' });
  });

  it('3.00 + (-5.00) is notOffered rule_below_zero, not 0.00 (mutant: clamp to 0.00); 5.00 + (-5.00) is exactly 0.00 and offered', async () => {
    const w = await world('i19-neg');
    await putStore(w, '3.00');
    await putOnline(w, { pricingMode: 'fixed_markup', fixedMarkupAmount: '-5.00' });
    expect(await onlineAt(w, new Date(Date.now() + 5000))).toEqual({ notOffered: 'rule_below_zero' });
    const z = await world('i19-zero');
    await putStore(z, '5.00');
    await putOnline(z, { pricingMode: 'fixed_markup', fixedMarkupAmount: '-5.00' });
    expect(await onlineAt(z, new Date(Date.now() + 5000))).toMatchObject({ amount: '0.00' });
  });
});

describe('I13b / I20 (domain half) -- rule figures: percent at most 4 decimals, markup at most 2, shape enforced before the DB', () => {
  const rows = async (w: World) => Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${w.c.orgId} and channel = 'online'`)[0]!.n);

  it("percent_markup '7.12345' is refused naming the decimals, no row; '7.1234' is accepted and stored exactly", async () => {
    const w = await world('i13b-pct');
    await putStore(w, '50.00');
    const bad = await asOrg(w.c.orgId, (tx) => attempt(() => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '7.12345' } as never, tx)));
    expect(bad.failed, 'a 5th decimal reached numeric(8,4)').toBe(true);
    expect(bad.message).toMatch(/decimal/i);
    expect(await rows(w)).toBe(0);
    const o = await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '7.1234' });
    const [r] = await sql<{ p: string }[]>`select markup_percent::text as p from menu_offers where id = ${o.id}`;
    expect(r!.p).toBe('7.1234');
  });

  it("fixed_markup '-5.005' is refused naming the decimals, no row", async () => {
    const w = await world('i13b-fm');
    await putStore(w, '50.00');
    const bad = await asOrg(w.c.orgId, (tx) => attempt(() => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'online', pricingMode: 'fixed_markup', fixedMarkupAmount: '-5.005' } as never, tx)));
    expect(bad.failed).toBe(true);
    expect(bad.message).toMatch(/decimal/i);
    expect(await rows(w)).toBe(0);
  });

  it("markup_percent -100 is refused (a price of nothing); -99.9999 is accepted", async () => {
    const w = await world('i20-100');
    await putStore(w, '50.00');
    const bad = await asOrg(w.c.orgId, (tx) => attempt(() => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '-100' } as never, tx)));
    expect(bad.failed).toBe(true);
    expect(await rows(w)).toBe(0);
    await putOnline(w, { pricingMode: 'percent_markup', markupPercent: '-99.9999' });
    expect(await rows(w)).toBe(1);
  });

  it('a rule on the STORE channel is refused; a rule row that also carries an amount is refused; a rule with its figure missing is refused', async () => {
    const w = await world('i20-shape');
    const base = { storeId: w.c.storeA, variantId: w.variantId };
    const bad = [
      { ...base, channel: 'store', pricingMode: 'percent_markup', markupPercent: '5' },
      { ...base, channel: 'online', pricingMode: 'percent_markup', markupPercent: '5', amount: '10.00' },
      { ...base, channel: 'online', pricingMode: 'percent_markup' },
      { ...base, channel: 'online', pricingMode: 'fixed_markup' },
    ];
    for (const input of bad) {
      const r = await asOrg(w.c.orgId, (tx) => attempt(() => setMenuOffer(w.c.admin, input as never, tx)));
      expect(r.failed, `accepted: ${JSON.stringify(input)}`).toBe(true);
    }
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${w.c.orgId}`;
    expect(n!.n).toBe(0);
  });

  it('a refill carries no rule (it carries no price at all)', async () => {
    const c = await cast('i20-refill');
    const { variantId } = await rawItem(c, 'refill');
    await rawRule(c, variantId);
    const r = await asOrg(c.orgId, (tx) =>
      attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '5' } as never, tx)));
    expect(r.failed, 'a rule on a refill was accepted').toBe(true);
  });
});
