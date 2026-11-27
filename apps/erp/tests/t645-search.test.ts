/**
 * T-645 - a search box on every long list. Spec: shareat-coord/specs/645-search-on-long-lists.md.
 *
 * `.ts`, not `.tsx` (the unit project globs `apps/**\/*.test.ts` only), so `createElement` stands in for JSX.
 * Page-level checks read the page SOURCE (the data layer needs a database; the shape does not): the box must sit in the
 * page's FilterRow with the other filters, and every param the page already uses must ride along. Each check has a
 * mutant (the source with the keep removed) that must go red, so a guard that cannot fail cannot pass.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clearSearchHref, matchesQuery } from '../src/lib/search';
import { KeepParams, NoMatches, SearchBox, SearchCount } from '../src/components/SearchBox';

const APP = resolve(__dirname, '..', 'src', 'app');
const src = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

describe('matchesQuery', () => {
  it('requires every word, in any order and across fields', () => {
    expect(matchesQuery('pork belly', 'Belly, Pork')).toBe(true);
    expect(matchesQuery('pork 001', 'Pork belly', 'PORK-001')).toBe(true);
    expect(matchesQuery('pork chicken', 'Pork belly', 'PORK-001')).toBe(false);
  });
  it('ignores case and extra spaces', () => {
    expect(matchesQuery('  PORK   belly ', 'pork belly')).toBe(true);
  });
  it('an empty or blank query matches everything', () => {
    expect(matchesQuery('', 'x')).toBe(true);
    expect(matchesQuery('   ', null)).toBe(true);
  });
  it('null and undefined fields are safe, and a word found nowhere does not match', () => {
    expect(matchesQuery('abc', null, undefined, 'xabcx')).toBe(true);
    expect(matchesQuery('abc', null, undefined)).toBe(false);
  });
});

describe('clearSearchHref', () => {
  it('drops q and empty params, keeps the rest', () => {
    expect(clearSearchHref('/items', { q: 'pork', kind: 'raw_material', status: undefined })).toBe('/items?kind=raw_material');
    expect(clearSearchHref('/items', { q: 'pork' })).toBe('/items');
  });
});

describe('SearchBox parts', () => {
  it('renders a named, labelled, prefilled search input without a literal maxLength or autofocus', () => {
    const html = renderToStaticMarkup(createElement(SearchBox, { q: 'pork', placeholder: 'Name…' }));
    expect(html).toContain('type="search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="pork"');
    expect(html).toContain('aria-label="Search"');
    expect(html).not.toMatch(/maxlength/i);
    expect(html).not.toMatch(/autofocus/i);
  });
  it('KeepParams emits hidden inputs for the non-empty params only', () => {
    const html = renderToStaticMarkup(createElement(KeepParams, { params: { kind: 'raw_material', store: undefined, tab: '' } }));
    expect(html).toContain('name="kind"');
    expect(html).toContain('value="raw_material"');
    expect(html).not.toContain('name="store"');
    expect(html).not.toContain('name="tab"');
  });
  it('SearchCount shows "shown of total" only while a search is active', () => {
    expect(renderToStaticMarkup(createElement(SearchCount, { q: '', shown: 3, total: 9 }))).toBe('');
    expect(renderToStaticMarkup(createElement(SearchCount, { q: 'x', shown: 3, total: 9 }))).toContain('3 of 9');
  });
  it('NoMatches names the search and offers Clear search', () => {
    const html = renderToStaticMarkup(createElement(NoMatches, { q: 'zzz', clearHref: '/items?kind=a' }));
    expect(html).toContain('Nothing matches');
    expect(html).toContain('zzz');
    expect(html).toContain('href="/items?kind=a"');
    expect(html).toContain('Clear search');
  });
});

/** The text of the FilterRow that holds the SearchBox, or null when there is none. */
function searchRow(source: string): string | null {
  for (const m of source.matchAll(/<FilterRow[\s\S]*?<\/FilterRow>/g)) if (m[0].includes('<SearchBox')) return m[0];
  return null;
}
/** True when `param` is a field of that row (a control named so) or rides along via KeepParams. */
function rowKeeps(row: string | null, param: string): boolean {
  if (!row) return false;
  const kept = [...row.matchAll(/<KeepParams params=\{\{([^}]*)\}\}/g)].some((m) => new RegExp(`\\b${param}\\b`).test(m[1] ?? ''));
  return kept || row.includes(`name="${param}"`);
}

describe('pages keep their params while searching', () => {
  it('/items keeps the kind chip (kind is a link filter, so it must ride as a hidden field)', () => {
    const s = src('items/page.tsx');
    expect(rowKeeps(searchRow(s), 'kind')).toBe(true);
    // mutant: the hidden field dropped -> a search would silently reset the kind filter
    expect(rowKeeps(searchRow(s.replace('<KeepParams params={{ kind }} />', '')), 'kind')).toBe(false);
  });

  it('/inventory keeps the store (the select is a field of the same FilterRow as the box)', () => {
    const s = src('inventory/page.tsx');
    expect(rowKeeps(searchRow(s), 'store')).toBe(true);
    // mutant: the box moved out into its own row -> q and store no longer submit together
    const box = '<SearchBox q={q} placeholder="Item name or code…" />';
    expect(s).toContain(box);
    expect(rowKeeps(searchRow(s.replace(box, `</FilterRow><FilterRow>${box}`)), 'store')).toBe(false);
  });

  it.each([
    ['ap/page.tsx', ['status', 'selfVerified']],
    ['menu/page.tsx', ['type', 'status', 'filter', 'store']],
    ['menu/prices/page.tsx', ['store']],
    ['menu/usage-source/page.tsx', ['store', 'compare']],
    ['inventory/low-stock/page.tsx', ['store']],
    ['commissary/catalogue/page.tsx', ['commissary', 'branch']],
    ['commissary/orders/page.tsx', ['store']],
    ['trade/orders/page.tsx', ['store']],
    ['staff/page.tsx', ['store', 'view']],
  ] as const)('%s: the search row carries %j', (file, params) => {
    const row = searchRow(src(file));
    for (const p of params) expect(rowKeeps(row, p), `${file} loses ${p}`).toBe(true);
  });

  it.each([
    'items/page.tsx',
    'menu/page.tsx',
    'menu/prices/page.tsx',
    'menu/usage-source/page.tsx',
    'customers/page.tsx',
    'inventory/page.tsx',
    'inventory/low-stock/page.tsx',
    'ap/page.tsx',
    'staff/page.tsx',
    'commissary/catalogue/page.tsx',
    'commissary/orders/page.tsx',
    'trade/orders/page.tsx',
    'money-transfers/page.tsx',
  ])('%s: has a SearchBox inside a FilterRow, reads q, and filters with matchesQuery', (file) => {
    const s = src(file);
    expect(searchRow(s), `${file} has no SearchBox inside a FilterRow`).not.toBeNull();
    expect(s).toMatch(/\bq\??: string/);
    expect(s).toContain('matchesQuery(');
    expect(s).toContain('<NoMatches');
  });
});
