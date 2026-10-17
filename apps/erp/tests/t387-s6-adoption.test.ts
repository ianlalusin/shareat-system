/**
 * T-387 S6 - adoption pins (source) on the detail pages and the lists.
 * Findings at write time: trade/orders/[id]/page.tsx EXISTS (so it adopts StatusHero, not a Badge); the deliveries,
 * transfers and trade-order lists already render <Badge status=...>; the commissary/orders list still prints
 * BRANCH_ORDER_STAGE_LABEL as plain text (the one list that must change).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'src', 'app');
const read = (p: string) => readFileSync(path.join(APP, ...p.split('/')), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('commissary/orders/[id]', () => {
  const src = strip(read('commissary/orders/[id]/page.tsx'));
  it('renders StatusHero fed by branchOrderStage via the steps module', () => {
    expect(src).toMatch(/<StatusHero\b/);
    expect(src).toMatch(/branchOrderSteps/);
    expect(src).toMatch(/stepIndexFor\(\s*stage\s*\)/);
    expect(src).toMatch(/nextLineFor\(\s*stage\s*,/);
  });
  it('the side passed to nextLineFor comes from branchSide / commissarySide', () => {
    expect(src).toMatch(/['"]commissary['"]/);
    expect(src).toMatch(/['"]branch['"]/);
  });
  it('the old inline stage label is gone from the header', () => {
    expect(src).not.toMatch(/<strong>\{BRANCH_ORDER_STAGE_LABEL\[stage\]\}<\/strong>/);
  });
  it('L10: no submittedAt / submittedBy (the stage is derived from the columns that exist)', () => {
    expect(src).not.toMatch(/submittedAt|submittedBy/);
  });
});

describe('inventory/deliveries/[id]', () => {
  const src = strip(read('inventory/deliveries/[id]/page.tsx'));
  it('renders StatusHero with deliverySteps (draft -> received)', () => {
    expect(src).toMatch(/<StatusHero\b/);
    expect(src).toMatch(/deliverySteps/);
    expect(src).toMatch(/simpleStepIndexFor\(\s*['"]delivery['"]/);
  });
  it('the inline status header is gone', () => {
    expect(src).not.toMatch(/<strong>\{statusLabel\(doc\.status\)\}<\/strong>/);
  });
});

describe('trade/orders/[id] (the page exists)', () => {
  const src = strip(read('trade/orders/[id]/page.tsx'));
  it('renders StatusHero with tradeOrderSteps', () => {
    expect(src).toMatch(/<StatusHero\b/);
    expect(src).toMatch(/tradeOrderSteps/);
    expect(src).toMatch(/simpleStepIndexFor\(\s*['"]trade['"]/);
  });
  it('L10: no submittedAt / submittedBy anywhere on the page', () => {
    expect(src).not.toMatch(/submittedAt|submittedBy/);
  });
  it('the inline status header is gone', () => {
    expect(src).not.toMatch(/<strong>\{statusLabel\(order\.status\)\}<\/strong>/);
  });
});

describe('lists render the Badge for status', () => {
  it.each([['commissary/orders/page.tsx'], ['inventory/deliveries/page.tsx'], ['inventory/transfers/page.tsx'], ['trade/orders/page.tsx']])(
    '%s has <Badge and imports it from @/components/ui',
    (file) => {
      const src = strip(read(file));
      expect(src).toMatch(/<Badge\b/);
      expect(src).toMatch(/import\s*\{[^}]*\bBadge\b[^}]*\}\s*from\s*['"]@\/components\/ui['"]/);
    },
  );
  it('commissary list badges the derived stage, with its word', () => {
    const src = strip(read('commissary/orders/page.tsx'));
    expect(src).toMatch(/<Badge\b[^>]*(?:status=\{stage\}|label=\{BRANCH_ORDER_STAGE_LABEL\[stage\]\})/);
  });
  it('L9: transfers no longer print raw {t.status} as text', () => {
    const src = strip(read('inventory/transfers/page.tsx'));
    expect(src).not.toMatch(/>\s*\{t\.status\}\s*</);
    expect(src).toMatch(/<Badge\s+status=\{t\.status\}/);
  });
});

/** T-440 S1 (A3): how many forms carry this id - a native `<form` or a `<CheckedForm` (an add form converted to live checks). */
const formsWithId = (src: string, id: string): number =>
  src.match(new RegExp(`<(?:form|CheckedForm)\\b[^>]*id="${id}"`, 'g'))?.length ?? 0;

describe('T-S1-16 (T-440 A3): the form-id pin counts a <CheckedForm> (mutant: the search reverted to <form only)', () => {
  it('a native form, a CheckedForm, none, and two are each counted correctly', () => {
    expect(formsWithId('<form id="receive-x" action={a}>', 'receive-x')).toBe(1);
    expect(formsWithId('<CheckedForm rules={R} id="receive-x" action={a}>', 'receive-x')).toBe(1);
    expect(formsWithId('<form id="other">', 'receive-x')).toBe(0);
    expect(formsWithId('<form id="receive-x"></form><CheckedForm id="receive-x">', 'receive-x')).toBe(2);
  });
});

describe('S6 audit: the moved Receive / Dispatch controls still submit what they did', () => {
  // The Receive buttons now sit in the hero, outside their form, linked by form="…". A button that
  // loses that link renders fine and submits nothing; the source-level pins below are what catch it.
  it.each([
    ['commissary/orders/[id]/page.tsx', 'receive-order-form'],
    ['inventory/deliveries/[id]/page.tsx', 'receive-delivery-form'],
    ['trade/orders/[id]/page.tsx', 'receive-trade-order-form'],
  ])('%s: a submit button carries form="%s" and exactly one form has that id', (file, id) => {
    const src = strip(read(file));
    expect(src).toMatch(new RegExp(`<(?:Button|SubmitButton|button)\\b[^>]*form="${id}"`));
    expect(formsWithId(src, id)).toBe(1);
  });
  it('trade Dispatch keeps its creditOverrideReason field inside the moved form', () => {
    const src = strip(read('trade/orders/[id]/page.tsx'));
    expect(src).toMatch(/name="creditOverrideReason"/);
  });
  it('commissary Receive is shown to the branch side only, as before', () => {
    const src = strip(read('commissary/orders/[id]/page.tsx'));
    expect(src).toMatch(/const receiving\s*=\s*[^;]*dispatched[^;]*branchSide|const receiving\s*=\s*[^;]*branchSide[^;]*dispatched/);
  });
});
