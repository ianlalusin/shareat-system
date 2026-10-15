/**
 * T-401 S2, I13 and I13b. docs/tasks/401-erp-menu-catalog-master.md R5 ("numeric(14,2) silently rounds '10.005', so the domain refuses
 * any input with more than 2 decimal places through @shareat/core/money before it reaches the cast"), R4 (deltas signed), section 4.
 * TESTER, not BUILDER. Real Postgres. A refusal here is only meaningful beside a control that SUCCEEDS, so every refusal test has one.
 *
 * ## Assumed contract
 *   setMenuOffer(actor, { storeId, variantId, channel, amount: string, bundleHeads?, extraHeadAmount?: string, effectiveFrom? }, tx?) -> { id }
 *   setOptionOffer(actor, { storeId, optionValueId, channel, priceDelta: string, effectiveFrom? }, tx?)                                  -> { id }
 *   setDepletionRule(actor, { variantId, mode: 'direct', itemId, quantityPerSale: string, effectiveFrom? }, tx?)                         -> { id }
 *   Money arrives as a STRING (bible section 6). A refusal is a throw (or { ok:false }) whose message names the decimal places; no row is written.
 *   Extension beyond the spec text, flagged in the report: quantityPerSale is numeric(14,6) and rounds silently the same way, so 7+ places is refused too.
 *
 * ## Red today
 * packages/domain/src/menu does not exist (`setMenuOffer is not a function`). Mutants: the domain lets the cast round ('10.005' stored as 10.01 or 10.00),
 * the domain parses with Number().
 */
import { afterAll, describe, expect, it } from 'vitest';

import { setDepletionRule, setMenuOffer, setOptionOffer } from '@shareat/domain';

import { asOrg, attempt, cast, rawItem, rawOption, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function offerFx(hint: string) {
  const c = await cast(hint);
  const { variantId } = await rawItem(c);
  await rawRule(c, variantId);
  return { c, variantId };
}
const offerRows = async (c: Cast) => Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${c.orgId}`)[0]!.n);
const optionRows = async (c: Cast) => Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_option_offers where org_id = ${c.orgId}`)[0]!.n);
const ruleRows = async (c: Cast) => Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_depletion_rules where org_id = ${c.orgId}`)[0]!.n);

describe('I13b -- more than 2 decimal places is refused, never rounded (mutant: the domain lets the cast round)', () => {
  it.each(['10.005', '10.004', '0.001', '99.999', '0.30000000000000004'])('setMenuOffer amount %s: refused naming the decimals, no row written', async (amount) => {
    const { c, variantId } = await offerFx('i13b-a');
    const r = await asOrg(c.orgId, (tx) => attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount }, tx)));
    expect(r.failed, `'${amount}' was accepted (the cast would have rounded it)`).toBe(true);
    expect(r.message).toMatch(/decimal/i);
    expect(await offerRows(c), 'a row was written').toBe(0);
  });

  it('control: 10.5, 10.00 and 0.00 are accepted and stored exactly (2-decimal canonical text)', async () => {
    const { c, variantId } = await offerFx('i13b-ok');
    const stored: string[] = [];
    for (const [i, amount] of ['10.5', '10.00', '0.00'].entries()) {
      const o = await asOrg(c.orgId, (tx) =>
        setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount, effectiveFrom: new Date(Date.now() + (i + 1) * 3_600_000) }, tx));
      const [row] = await sql<{ amount: string }[]>`select amount::text as amount from menu_offers where id = ${o.id}`;
      stored.push(row!.amount);
    }
    expect(stored).toEqual(['10.50', '10.00', '0.00']);
  });

  it('a JavaScript number is not money: 0.1 + 0.2 is refused, not stored as 0.30 (mutant: domain uses Number())', async () => {
    const { c, variantId } = await offerFx('i13b-f');
    const r = await asOrg(c.orgId, (tx) =>
      attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: (0.1 + 0.2) as never }, tx)));
    expect(r.failed, 'a float amount was accepted').toBe(true);
    expect(await offerRows(c)).toBe(0);
    const ok = await asOrg(c.orgId, (tx) => attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '0.30' }, tx)));
    expect(ok.failed, `'0.30' refused: ${ok.message}`).toBe(false);
  });

  it('extraHeadAmount follows the same rule on a bundle offer', async () => {
    const c = await cast('i13b-x');
    const { variantId } = await rawItem(c, 'package');
    await rawRule(c, variantId);
    const bad = await asOrg(c.orgId, (tx) =>
      attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '999.00', bundleHeads: 4, extraHeadAmount: '199.995' }, tx)));
    expect(bad.failed).toBe(true);
    expect(bad.message).toMatch(/decimal/i);
    expect(await offerRows(c)).toBe(0);
    const ok = await asOrg(c.orgId, (tx) =>
      attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '999.00', bundleHeads: 4, extraHeadAmount: '199.99' }, tx)));
    expect(ok.failed, `control refused: ${ok.message}`).toBe(false);
  });

  it('setOptionOffer priceDelta: 3 decimals refused (positive and negative), no row', async () => {
    const c = await cast('i13b-o');
    const { valueId } = await rawOption(c);
    for (const priceDelta of ['1.005', '-10.005']) {
      const r = await asOrg(c.orgId, (tx) => attempt(() => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: valueId, channel: 'store', priceDelta }, tx)));
      expect(r.failed, `'${priceDelta}' accepted`).toBe(true);
      expect(r.message).toMatch(/decimal/i);
    }
    expect(await optionRows(c)).toBe(0);
  });

  it('setDepletionRule quantityPerSale: 7 decimal places refused (numeric(14,6) would round); 6 accepted', async () => {
    const c = await cast('i13b-q');
    const { variantId } = await rawItem(c);
    const bad = await asOrg(c.orgId, (tx) =>
      attempt(() => setDepletionRule(c.admin, { variantId, mode: 'direct', itemId: c.stockItemId, quantityPerSale: '0.1234567' }, tx)));
    expect(bad.failed, 'seven decimals accepted').toBe(true);
    expect(bad.message).toMatch(/decimal/i);
    expect(await ruleRows(c)).toBe(0);
    const ok = await asOrg(c.orgId, (tx) =>
      attempt(() => setDepletionRule(c.admin, { variantId, mode: 'direct', itemId: c.stockItemId, quantityPerSale: '0.123456' }, tx)));
    expect(ok.failed, `control refused: ${ok.message}`).toBe(false);
  });
});

describe('I13 -- offer amounts >= 0, deltas signed, everything finite', () => {
  it.each(['-1.00', '-0.01', 'Infinity', 'NaN', '', 'abc'])('setMenuOffer amount %j is refused, no row', async (amount) => {
    const { c, variantId } = await offerFx('i13-bad');
    const r = await asOrg(c.orgId, (tx) => attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount }, tx)));
    expect(r.failed, `'${amount}' was accepted as a price`).toBe(true);
    expect(await offerRows(c)).toBe(0);
  });

  it('a negative option delta is ACCEPTED and kept signed ("no rice, -10" is real, R4); an offer amount of 0.00 is accepted', async () => {
    const c = await cast('i13-neg');
    const { valueId } = await rawOption(c);
    const o = await asOrg(c.orgId, (tx) => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: valueId, channel: 'store', priceDelta: '-10.00' }, tx));
    const [row] = await sql<{ d: string }[]>`select price_delta::text as d from menu_option_offers where id = ${o.id}`;
    expect(row!.d).toBe('-10.00');
  });

  it('non-finite option deltas are refused', async () => {
    const c = await cast('i13-inf');
    const { valueId } = await rawOption(c);
    for (const priceDelta of ['Infinity', '-Infinity', 'NaN']) {
      const r = await asOrg(c.orgId, (tx) => attempt(() => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: valueId, channel: 'store', priceDelta }, tx)));
      expect(r.failed, `'${priceDelta}' accepted`).toBe(true);
    }
    expect(await optionRows(c)).toBe(0);
  });

  it('a depletion quantity of 0 or below is refused', async () => {
    const c = await cast('i13-q');
    const { variantId } = await rawItem(c);
    for (const quantityPerSale of ['0', '-1', '-0.5']) {
      const r = await asOrg(c.orgId, (tx) => attempt(() => setDepletionRule(c.admin, { variantId, mode: 'direct', itemId: c.stockItemId, quantityPerSale }, tx)));
      expect(r.failed, `'${quantityPerSale}' accepted`).toBe(true);
    }
    expect(await ruleRows(c)).toBe(0);
  });
});
