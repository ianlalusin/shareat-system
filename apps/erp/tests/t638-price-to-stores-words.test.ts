/**
 * T-638 - the price to stores in plain words, and where it is edited. Node, no database: the read model is a fake.
 *
 * T1  every pricing mode, the manual-cost tier and "Needs a cost" are worded as the spec words them.
 *     MUTANTS: fixed worded as a markup; the percent or the peso figure dropped; "Needs a cost" priced as ₱0.00.
 * T1b the margin-alert chip shows only when the alert fires. MUTANT: chip always on / never on.
 * T1c the catalogue column is READ-ONLY and links to the item page. MUTANT: a form or action in the cell; no link.
 * T1d the item page edits it on the Wholesale row only when wholesale, with the "applies once" hint otherwise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PriceToStores } from '@shareat/domain';
import { PriceToStoresText, priceToStoresWords } from '../src/app/items/price-to-stores';

const SRC = join(__dirname, '..', 'src', 'app');
const read = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');

const view = (o: Partial<PriceToStores>): PriceToStores => ({
  price: null, from: null, rule: null, basis: null, basisFrom: null, marginAlert: false, ...o,
});
const rule = (r: Partial<NonNullable<PriceToStores['rule']>>): NonNullable<PriceToStores['rule']> => ({
  itemId: 'i', pricingMode: 'percent_markup', fixedAmount: null, markupPercent: null, fixedMarkupAmount: null, marginAlertThresholdPct: null, ...r,
});

describe('T-638 T1 - the worked-out words', () => {
  it('percent markup: price = last delivery + percent', () => {
    const w = priceToStoresWords(view({ price: '245.00', from: 'branch_price', basis: '213.0400', basisFrom: 'own', rule: rule({ pricingMode: 'percent_markup', markupPercent: '15.0000' }) }));
    expect(w.how).toBe('₱245.00 = last delivery ₱213.04 + 15%');
  });
  it('peso markup: price = last delivery + amount', () => {
    const w = priceToStoresWords(view({ price: '245.00', from: 'branch_price', basis: '213.0000', basisFrom: 'own', rule: rule({ pricingMode: 'fixed_markup', fixedMarkupAmount: '32.00' }) }));
    expect(w.how).toBe('₱245.00 = last delivery ₱213.00 + ₱32.00');
  });
  it('a slab-linked basis says so', () => {
    const w = priceToStoresWords(view({ price: '115.00', from: 'branch_price', basis: '100.0000', basisFrom: 'linked', rule: rule({ pricingMode: 'percent_markup', markupPercent: '15' }) }));
    expect(w.how).toBe('₱115.00 = slab delivery ₱100.00 + 15%');
  });
  it('fixed: just "fixed", never a basis', () => {
    const w = priceToStoresWords(view({ price: '180.00', from: 'branch_price', basis: '0.0000', basisFrom: 'own', rule: rule({ pricingMode: 'fixed', fixedAmount: '180.00' }) }));
    expect(w.how).toBe('₱180.00 fixed');
  });
  it('manual cost tier', () => {
    expect(priceToStoresWords(view({ price: '95.00', from: 'manual_cost' })).how).toBe('₱95.00 = manual cost (no deliveries yet)');
  });
  it('nothing can cost it: "Needs a cost", and never a peso figure', () => {
    for (const v of [view({}), view({ rule: rule({ pricingMode: 'percent_markup', markupPercent: '15' }) })]) {
      const w = priceToStoresWords(v);
      expect(w.headline).toBe('Needs a cost');
      expect(w.how).not.toMatch(/₱0\.00/);
    }
    expect(renderToStaticMarkup(createElement(PriceToStoresText, { view: view({}) }))).toContain('Needs a cost');
  });
  it('T1b the margin chip shows only when the alert fires', () => {
    const base = { price: '120.00', from: 'branch_price' as const, basis: '100.0000', basisFrom: 'own' as const, rule: rule({ pricingMode: 'fixed_markup', fixedMarkupAmount: '20.00', marginAlertThresholdPct: '25.0000' }) };
    expect(priceToStoresWords(view({ ...base, marginAlert: true })).alert).toBe('below your 25% margin alert');
    expect(priceToStoresWords(view({ ...base, marginAlert: false })).alert).toBeNull();
    expect(renderToStaticMarkup(createElement(PriceToStoresText, { view: view({ ...base, marginAlert: true }) }))).toContain('below your 25% margin alert');
  });
});

describe('T-638 T1c/T1d - where it is edited', () => {
  it('the catalogue column is read-only and links to the item page', () => {
    const page = read('commissary/catalogue/page.tsx');
    expect(page).toContain('Price to stores');
    expect(page).toContain('/items/${o.itemId}#price-to-stores');
    expect(page).not.toMatch(/setItemPricing|ItemPricingFields|ITEMS_PRICING_RULES/);
  });
  it('the item page edits it on the Wholesale row, gated on wholesale, with the hint otherwise', () => {
    const page = read('items/[id]/page.tsx');
    expect(page).toContain('setItemPricingAction');
    expect(page).toContain('soldWholesale ?');
    expect(page).toContain('Applies once');
    expect(page).toContain('Diner (retail) prices are set under Menu');
  });
});
