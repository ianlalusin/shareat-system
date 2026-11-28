import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckAllButtons } from '../src/components/forms/CheckAllButtons';
import { capabilitiesForRoute } from '../src/lib/route-capability';
import { flavoursLedBy } from '../src/app/pos/_refills/meats';
import { refillTables } from '../src/app/pos/_refills/tables';

/**
 * T-653 screens. Select all / Clear on the refills form and on both flavour cards (named for what they tick), the one flavour list's page is gated by manage_menu,
 * and the refill pills lead with the table's seating flavours by VALUE ID (one list: the same row) with the name as the fallback (old per-item groups).
 * MUTANTS (each red): CheckAllButtons removed from the refills form / the flavour card; the aria names changed; the id match dropped from flavoursLedBy (id test);
 * the name fallback dropped (fallback test); seatFlavourIds not carried by refillTables; the route's capability removed.
 */
const APP = path.resolve(__dirname, '../src/app/menu');
const read = (rel: string) => readFileSync(path.join(APP, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('T-653 Select all / Clear', () => {
  it('the buttons are named for what they tick and are real buttons (not submit)', () => {
    const html = renderToStaticMarkup(createElement(CheckAllButtons, { name: 'refillItemIds', subject: 'refills for Unli Pork' }));
    expect(html).toContain('aria-label="Select all refills for Unli Pork"');
    expect(html).toContain('aria-label="Clear refills for Unli Pork"');
    expect(html.match(/type="button"/g)).toHaveLength(2);
    expect(html).not.toContain('type="submit"');
    expect(html).toContain('min-h-11'); // 44px tall, never below the 24px floor
  });

  it('the package page puts them on the refills form and on both flavour cards; Save stays a separate step', () => {
    const page = read('items/[id]/page.tsx');
    expect(page).toContain('<CheckAllButtons name="refillItemIds" subject={`refills for ${v.label ?? \'Default\'}`} />');
    expect(page).toContain('<CheckAllButtons name="optionValueIds" subject={`flavours for ${heading}`} />');
    expect(page).toContain('Flavours this package allows');
    expect(page).toContain('Flavours this refill allows');
    expect(page).toContain('Guests pick at least');
    // a refill's one flavour is fixed: the refill card has no min / max boxes
    expect(page).toMatch(/variantId !== null && \(\s*<FormGrid>/);
    expect(page).toContain('name="kind" value="refill"');
  });

  it('the action sends 1 and 1 for a refill whatever the form says, and reads min / max only for a package', () => {
    const actions = read('items/[id]/actions.ts');
    expect(actions).toContain("isRefill ? REFILL_FLAVOUR_LIMITS.min : wholeNumber(fd, 'min'");
    expect(actions).toContain("isRefill ? REFILL_FLAVOUR_LIMITS.max : wholeNumber(fd, 'max'");
  });
});

describe('T-653 the Flavours page', () => {
  it('is gated by manage_menu, has the preview before the merge, and starts the list on request', () => {
    expect(capabilitiesForRoute('/menu/flavours')).toEqual(['manage_menu']);
    const page = read('flavours/page.tsx');
    expect(page).toContain("requirePageAccess('/menu/flavours')");
    expect(page).toContain('Start your flavour list');
    expect(page).toContain('Use these flavours');
    expect(page).toContain('previewFlavourMerge');
    expect(page.indexOf('previewFlavourMerge')).toBeLessThan(page.indexOf('mergeFlavoursAction'));
    expect(page).toContain('ArrangeList');
    const menu = read('page.tsx');
    expect(menu).toContain('href="/menu/flavours"');
  });
});

describe('T-653 the refill pills lead with the table\'s pick', () => {
  const pills = [
    { id: 'a', name: 'Spicy' },
    { id: 'b', name: 'Garlic' },
    { id: 'c', name: 'Sweet' },
  ];
  it('by value id when both come from the one list, even when the names differ in spelling', () => {
    const out = flavoursLedBy([{ id: 'a', name: 'Spicy' }, { id: 'b', name: 'Garlic' }, { id: 'c', name: 'Sweet' }], ['spicy hot'], ['c']);
    expect(out.map((o) => `${o.flavour.name}:${o.seat}`)).toEqual(['Sweet:true', 'Spicy:false', 'Garlic:false']);
  });
  it('by name (case and spaces ignored) when there is no id match: old per-item groups', () => {
    const out = flavoursLedBy(pills, [' garlic '], []);
    expect(out.map((o) => `${o.flavour.name}:${o.seat}`)).toEqual(['Garlic:true', 'Spicy:false', 'Sweet:false']);
    expect(flavoursLedBy(pills, [], []).map((o) => o.seat)).toEqual([false, false, false]); // nothing chosen: order unchanged, nothing removed
  });
  it('the table row carries the ids the server listed', () => {
    const [t] = refillTables([{ sessionId: 's', standNumber: 3, packageVariantId: 'pv', seatFlavours: ['Sweet'], seatFlavourIds: ['c'] }]);
    expect(t).toMatchObject({ seatFlavours: ['Sweet'], seatFlavourIds: ['c'] });
    const [u] = refillTables([{ sessionId: 's', standNumber: 3, packageVariantId: 'pv' }]);
    expect(u).toMatchObject({ seatFlavours: [], seatFlavourIds: [] });
  });
});
