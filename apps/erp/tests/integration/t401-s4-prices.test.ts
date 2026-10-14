import { afterAll, describe, expect, it, vi } from 'vitest';

import { setMenuOffer } from '@shareat/domain';
import { asOrg, cast, expectSentenceError, fd, plain, rawItem, rawOption, rawRule, render, run, sql, uid, type Cast } from './t401-s4-common';

/**
 * T-401 S4 (TESTER) - /menu/prices: the price form round trip, the Manila-midnight case, the online % rule, the store picker.
 * Contract: header of t401-s4-common.ts. Red today: `apps/erp/src/app/menu/prices/{actions.ts,page.tsx}` do not exist.
 *
 * Mutants these kill (S2 audit ruling, task doc "S4 note"):
 *   - a scheduled time parsed as UTC instead of Asia/Manila  -> "Manila midnight" test (2030-12-01T00:00 must store 2030-11-30T16:00Z)
 *   - the action sends the client clock for "now"            -> "now" test runs the action with the JS clock set to 2020: the domain
 *     would call that a back-dated price and refuse; the contract is that no clock is sent
 *   - a store price typed into the redirect URL              -> "round trip" asserts the redirect carries neither the amount nor `amount=`
 *   - the picker lists every store of the org                -> picker tests
 *   - the online column shows the rule but not its resolved price, or resolves at the rule's own date -> "follows the store price" test
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/menu/prices/actions');
const PAGE = () => import('../../src/app/menu/prices/page');

interface OfferRow {
  id: string;
  channel: string;
  effective_from: Date;
  amount: string | null;
  pricing_mode: string;
  markup_percent: string | null;
  fixed_markup_amount: string | null;
  withdrawn: boolean;
}
const offers = (storeId: string, variantId: string) =>
  sql<OfferRow[]>`
    select id, channel, effective_from, amount::text as amount, pricing_mode, markup_percent::text as markup_percent,
           fixed_markup_amount::text as fixed_markup_amount, withdrawn
      from menu_offers where store_id = ${storeId} and variant_id = ${variantId} order by effective_from, created_at`;

/** A fresh org with one item that has a rule in force (a price may only be live once a recipe exists). */
async function world(hint: string, itemType: 'a_la_carte' | 'package' | 'refill' = 'a_la_carte') {
  const c = await cast(`s4pr-${hint}`);
  const it = await rawItem(c, itemType, uid('Pork Belly'));
  await rawRule(c, it.variantId);
  return { c, ...it };
}

const PRICE = (c: Cast, variantId: string, extra: Record<string, string> = {}) =>
  fd({ storeId: c.storeA, variantId, channel: 'store', amount: '85.50', ...extra });

describe('price form round trip', () => {
  it('a manager scoped to store A prices store A: row stored, "Price saved.", back on /menu/prices?store=A, and the amount is NOT in the URL', async () => {
    const w = await world('rt');
    const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId));
    expect(out.flash.error).toBeUndefined();
    expect(out.flash.ok).toBe('Price saved.');
    expect(out.path).toBe('/menu/prices');
    expect(out.nav.get('store')).toBe(w.c.storeA);
    expect(out.url, 'T-380: nothing typed rides in the address').not.toMatch(/85\.50|amount=/);
    const rows = await offers(w.c.storeA, w.variantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'store', amount: '85.50', pricing_mode: 'fixed', withdrawn: false });
  });

  it('the page then shows that price in force', async () => {
    const w = await world('show');
    const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId));
    const html = await render(PAGE, w.c.managerA, { search: { store: w.c.storeA }, flashFrom: out.url });
    expect(plain(html)).toContain('Price saved.');
    expect(plain(html)).toContain('85.50');
  });

  it('more than two decimals is refused in a sentence and writes nothing (never rounded); so is text that is not an amount', async () => {
    const w = await world('dec');
    for (const bad of ['10.005', 'abc', '-5.00']) {
      const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: bad }));
      expectSentenceError(out.flash.error, `amount "${bad}"`);
      expect(out.flash.ok).toBeUndefined();
    }
    expect(await offers(w.c.storeA, w.variantId)).toHaveLength(0);
  });

  it('a blank amount is not zero: refused, nothing written', async () => {
    const w = await world('blank');
    const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '' }));
    expect(out.flash.error).toBeTruthy();
    expect(await offers(w.c.storeA, w.variantId)).toHaveLength(0);
  });

  it('a variant with no depletion rule cannot be priced: a sentence that mentions the stock rule, not a database error', async () => {
    const c = await cast('s4pr-norule');
    const it = await rawItem(c, 'a_la_carte', uid('Tea'));
    const out = await run(ACTIONS, 'setPriceAction', c.managerA, PRICE(c, it.variantId));
    expectSentenceError(out.flash.error, 'no rule');
    expect(out.flash.error).toMatch(/depletion|stock|recipe|rule/i);
    expect(await offers(c.storeA, it.variantId)).toHaveLength(0);
  });
});

describe('Manila time (a scheduled price is read as Asia/Manila and stored as an instant)', () => {
  it('00:00 on 1 Dec 2030 Manila is 2030-11-30T16:00:00Z (kills "parsed as UTC"); 23:30 is 15:30Z; "Price scheduled."', async () => {
    const w = await world('mnl');
    const midnight = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '120.00', effectiveFrom: '2030-12-01T00:00' }));
    expect(midnight.flash.error).toBeUndefined();
    expect(midnight.flash.ok).toBe('Price scheduled.');
    const late = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '130.00', effectiveFrom: '2030-12-01T23:30' }));
    expect(late.flash.error).toBeUndefined();
    const rows = await offers(w.c.storeA, w.variantId);
    expect(rows.map((r) => r.effective_from.toISOString())).toEqual(['2030-11-30T16:00:00.000Z', '2030-12-01T15:30:00.000Z']);
    expect(rows.map((r) => r.amount)).toEqual(['120.00', '130.00']);
  });

  it('seconds are accepted (YYYY-MM-DDTHH:mm:ss) and still Manila', async () => {
    const w = await world('mnl-s');
    const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { effectiveFrom: '2030-06-15T08:00:30' }));
    expect(out.flash.error).toBeUndefined();
    expect((await offers(w.c.storeA, w.variantId))[0]!.effective_from.toISOString()).toBe('2030-06-15T00:00:30.000Z');
  });

  it('an unreadable date and a date already passed are refused in sentences; nothing written', async () => {
    const w = await world('mnl-bad');
    for (const bad of ['next tuesday', '2030-13-45T00:00', '2020-01-01T00:00']) {
      const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { effectiveFrom: bad }));
      expectSentenceError(out.flash.error, `effectiveFrom "${bad}"`);
    }
    expect(await offers(w.c.storeA, w.variantId)).toHaveLength(0);
  });

  it('"from now" (no effectiveFrom) never sends the client clock: with the JS clock set to 2020 the price is still saved, at the database time', async () => {
    const w = await world('now');
    await ACTIONS(); // load the module first, so only the action itself runs under the faked clock
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    try {
      await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId));
    } finally {
      vi.useRealTimers();
    }
    const rows = await offers(w.c.storeA, w.variantId);
    expect(rows, 'the price was saved (a client-clock "now" would be refused as back-dated)').toHaveLength(1);
    const ageMs = Date.now() - rows[0]!.effective_from.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(-2000);
    expect(ageMs, 'effective_from is the database now(), within a minute of the real clock').toBeLessThan(60_000);
  });

  it('a blank effectiveFrom field is the same as none (the form always posts the box)', async () => {
    const w = await world('now-blank');
    const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { effectiveFrom: '' }));
    expect(out.flash.ok).toBe('Price saved.');
    expect(await offers(w.c.storeA, w.variantId)).toHaveLength(1);
  });

  it('an option price scheduled from the same box also reads Manila', async () => {
    const w = await world('mnl-opt');
    const opt = await rawOption(w.c);
    const out = await run(ACTIONS, 'setOptionPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, optionValueId: opt.valueId, channel: 'store', priceDelta: '-10.00', effectiveFrom: '2030-12-01T00:00' }));
    expect(out.flash.error).toBeUndefined();
    const [row] = await sql<{ effective_from: Date; price_delta: string }[]>`select effective_from, price_delta::text from menu_option_offers where option_value_id = ${opt.valueId}`;
    expect(row!.effective_from.toISOString()).toBe('2030-11-30T16:00:00.000Z');
    expect(row!.price_delta).toBe('-10.00');
  });
});

describe('online price rule (Q4)', () => {
  it('store 85.50 + online "% over store" 7.5: the rule row is stored with no amount; the page shows the rule AND the resolved 91.91', async () => {
    const w = await world('rule');
    expect((await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId))).flash.ok).toBe('Price saved.');
    const rule = await run(
      ACTIONS, 'setPriceAction', w.c.managerA,
      fd({ storeId: w.c.storeA, variantId: w.variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '7.5', amount: '' }),
    );
    expect(rule.flash.error).toBeUndefined();
    expect(rule.url, 'no rule figure in the address').not.toMatch(/7\.5|markupPercent/);
    const online = (await offers(w.c.storeA, w.variantId)).filter((r) => r.channel === 'online');
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({ pricing_mode: 'percent_markup', markup_percent: '7.5000', amount: null, withdrawn: false });

    const t = plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }));
    expect(t).toContain('85.50');
    expect(t).toContain('91.91'); // 85.50 x 1.075 = 91.9125, rounded once, half up
    expect(t).toContain('7.5');
  });

  it('the online price FOLLOWS the store price with no new online row (kills "resolved at the rule\'s own date")', async () => {
    const w = await world('follow');
    await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '80.00' }));
    await run(ACTIONS, 'setPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, variantId: w.variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '10' }));
    expect(plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }))).toContain('88.00');
    await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '100.00' }));
    const t = plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }));
    expect(t, 'the online price moved with the store price').toContain('110.00');
    expect((await offers(w.c.storeA, w.variantId)).filter((r) => r.channel === 'online'), 'still the one online row').toHaveLength(1);
  });

  it('a peso rule ("fixed_markup") is stored with its figure; a rule that goes below zero shows a "below zero" warning (never 0.00); a rule with no store row shows "no counter price"', async () => {
    const w = await world('peso');
    await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '3.00' }));
    const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, variantId: w.variantId, channel: 'online', pricingMode: 'fixed_markup', fixedMarkupAmount: '-5.00' }));
    expect(out.flash.error).toBeUndefined();
    const online = (await offers(w.c.storeA, w.variantId)).filter((r) => r.channel === 'online');
    expect(online[0]).toMatchObject({ pricing_mode: 'fixed_markup', fixed_markup_amount: '-5.00', amount: null });
    expect(plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }))).toMatch(/below zero/i);

    const lone = await rawItem(w.c, 'a_la_carte', uid('Lone'));
    await rawRule(w.c, lone.variantId);
    await run(ACTIONS, 'setPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, variantId: lone.variantId, channel: 'online', pricingMode: 'percent_markup', markupPercent: '5' }));
    expect(plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }))).toMatch(/no counter price/i);
  });

  it('a rule on the STORE channel, a rule with an amount, a percent of -100 or four-plus decimals are refused in sentences; nothing written', async () => {
    const w = await world('badrule');
    const tries: Array<[string, Record<string, string>]> = [
      ['store channel', { channel: 'store', pricingMode: 'percent_markup', markupPercent: '5', amount: '' }],
      ['rule with an amount', { channel: 'online', pricingMode: 'percent_markup', markupPercent: '5', amount: '90.00' }],
      ['-100 percent', { channel: 'online', pricingMode: 'percent_markup', markupPercent: '-100', amount: '' }],
      ['5 decimals', { channel: 'online', pricingMode: 'percent_markup', markupPercent: '7.12345', amount: '' }],
    ];
    for (const [label, extra] of tries) {
      const out = await run(ACTIONS, 'setPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, variantId: w.variantId, ...extra }));
      expectSentenceError(out.flash.error, label);
    }
    expect(await offers(w.c.storeA, w.variantId)).toHaveLength(0);
  });
});

describe('withdraw and cancel', () => {
  it('withdrawPriceAction appends a withdrawal ("Price withdrawn."); the page shows "withdrawn"', async () => {
    const w = await world('wd');
    await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId));
    const out = await run(ACTIONS, 'withdrawPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, variantId: w.variantId, channel: 'store' }));
    expect(out.flash.ok).toBe('Price withdrawn.');
    const rows = await offers(w.c.storeA, w.variantId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ withdrawn: true, amount: null });
    expect(plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }))).toMatch(/withdrawn/i);
  });

  it('a scheduled price shows on the page and cancelScheduledPriceAction removes it ("Scheduled price cancelled."); one already in force cannot be cancelled', async () => {
    const w = await world('cx');
    await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '85.50' }));
    await run(ACTIONS, 'setPriceAction', w.c.managerA, PRICE(w.c, w.variantId, { amount: '99.00', effectiveFrom: '2031-01-01T00:00' }));
    const [now, later] = await offers(w.c.storeA, w.variantId);
    expect(plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }))).toContain('99.00');

    const inForce = await run(ACTIONS, 'cancelScheduledPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, offerId: now!.id }));
    expectSentenceError(inForce.flash.error, 'cancel a price already in force');
    expect(await offers(w.c.storeA, w.variantId)).toHaveLength(2);

    const ok = await run(ACTIONS, 'cancelScheduledPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, offerId: later!.id }));
    expect(ok.flash.ok).toBe('Scheduled price cancelled.');
    expect((await offers(w.c.storeA, w.variantId)).map((r) => r.amount)).toEqual(['85.50']);
  });

  it('an offer id from ANOTHER store cannot be cancelled by naming your own store', async () => {
    const w = await world('cx-x');
    await asOrg(w.c.orgId, (tx) => setMenuOffer(w.c.admin, { storeId: w.c.storeB, variantId: w.variantId, channel: 'store', amount: '70.00', effectiveFrom: new Date('2031-02-01T00:00:00Z') }, tx));
    const [bRow] = await offers(w.c.storeB, w.variantId);
    const out = await run(ACTIONS, 'cancelScheduledPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, offerId: bRow!.id }));
    expect(out.flash.error).toBeTruthy();
    expect(await offers(w.c.storeB, w.variantId)).toHaveLength(1);
  });
});

describe('option-value prices (deltas)', () => {
  it('a signed delta is saved and shown; a blank delta without withdraw=1 is an error (never a silent withdrawal); withdraw=1 appends a withdrawal', async () => {
    const w = await world('opt');
    const opt = await rawOption(w.c);
    const base = { storeId: w.c.storeA, optionValueId: opt.valueId, channel: 'store' };
    const set = await run(ACTIONS, 'setOptionPriceAction', w.c.managerA, fd({ ...base, priceDelta: '-10.00' }));
    expect(set.flash.ok).toBe('Option price saved.');
    expect(plain(await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } }))).toContain('-10.00');

    const blank = await run(ACTIONS, 'setOptionPriceAction', w.c.managerA, fd({ ...base, priceDelta: '' }));
    expect(blank.flash.error).toBeTruthy();
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_option_offers where option_value_id = ${opt.valueId}`)[0]!.n)).toBe(1);

    const wd = await run(ACTIONS, 'setOptionPriceAction', w.c.managerA, fd({ ...base, withdraw: '1' }));
    expect(wd.flash.ok).toBe('Option price withdrawn.');
    const rows = await sql<{ withdrawn: boolean }[]>`select withdrawn from menu_option_offers where option_value_id = ${opt.valueId} order by effective_from, created_at`;
    expect(rows.map((r) => r.withdrawn)).toEqual([false, true]);
  });

  it('a scheduled option price can be cancelled (cancelScheduledOptionPriceAction)', async () => {
    const w = await world('opt-cx');
    const opt = await rawOption(w.c);
    await run(ACTIONS, 'setOptionPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, optionValueId: opt.valueId, channel: 'online', priceDelta: '5.00', effectiveFrom: '2031-03-01T00:00' }));
    const [row] = await sql<{ id: string }[]>`select id from menu_option_offers where option_value_id = ${opt.valueId}`;
    const out = await run(ACTIONS, 'cancelScheduledOptionPriceAction', w.c.managerA, fd({ storeId: w.c.storeA, optionOfferId: row!.id }));
    expect(out.flash.ok).toBe('Scheduled price cancelled.');
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_option_offers where option_value_id = ${opt.valueId}`)[0]!.n)).toBe(0);
  });
});

describe("a manager's store picker lists only their stores (Q1)", () => {
  const options = (html: string): string[] => {
    const m = /<select\b[^>]*\sname="store"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    expect(m, 'a <select name="store"> is drawn').not.toBeNull();
    return [...m![1]!.matchAll(/<option\b[^>]*\svalue="([^"]*)"/g)].map((x) => x[1]!);
  };

  it('a manager scoped to store A sees A and not B; an admin sees both', async () => {
    const w = await world('pick');
    const mgr = await render(PAGE, w.c.managerA, {});
    expect(options(mgr)).toEqual([w.c.storeA]);
    expect(plain(mgr)).toContain('Lipa');
    expect(plain(mgr)).not.toContain('Batangas');
    const adm = await render(PAGE, w.c.admin, {});
    expect([...options(adm)].sort()).toEqual([w.c.storeA, w.c.storeB].sort());
  });

  it('?store= another store: nothing of store B is drawn to a manager scoped to A (a redirect or not-found is also fine)', async () => {
    const w = await world('pick-x');
    await asOrg(w.c.orgId, (tx) => setMenuOffer(w.c.admin, { storeId: w.c.storeB, variantId: w.variantId, channel: 'store', amount: '77.77' }, tx));
    let html = '';
    try {
      html = await render(PAGE, w.c.managerA, { search: { store: w.c.storeB } });
    } catch (e) {
      expect(String((e as Error).message), 'only a redirect / not-found is acceptable').toMatch(/NEXT_REDIRECT|NEXT_NOT_FOUND/);
      return;
    }
    expect(html).not.toContain(w.c.storeB);
    expect(plain(html)).not.toContain('Batangas');
    expect(plain(html)).not.toContain('77.77');
  });

  it('a manager scoped to A gets set-price forms for A and none naming B', async () => {
    const w = await world('pick-form');
    const html = await render(PAGE, w.c.managerA, { search: { store: w.c.storeA } });
    expect(html).toMatch(new RegExp(`name="storeId"[^>]*value="${w.c.storeA}"|value="${w.c.storeA}"[^>]*name="storeId"`));
    expect(html).toMatch(new RegExp(`name="variantId"[^>]*value="${w.variantId}"|value="${w.variantId}"[^>]*name="variantId"`));
    expect(html).not.toContain(w.c.storeB);
  });
});
