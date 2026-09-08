/**
 * FilterRow — the shared filter-row wrapper (T-241, docs/tasks/241-filter-row-component.md).
 *
 * ⚠️ `.ts`, not `.tsx`, on purpose: the unit project's include glob (`vitest.config.mts`) is
 * `apps/**\/*.test.ts` — no `.tsx` variant. A `.test.tsx` here would match nothing and pass
 * silently, exactly the shape of `reference_vitest_integration_globs_skip_apps`. `createElement`
 * calls stand in for JSX so this file never needs JSX syntax or a `.tsx` extension.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilterRow } from '../src/components/FilterRow';

describe('FilterRow — the shared filter-row wrapper', () => {
  it('renders a GET form carrying its children', () => {
    const html = renderToStaticMarkup(
      createElement(FilterRow, {
        children: createElement('input', { name: 'store', defaultValue: 'x' }),
      }),
    );
    expect(html).toContain('<form method="get"');
    expect(html).toContain('name="store"');
  });

  it('defaults the submit label to "Show" — 24 of 26 rows migrated pass nothing here', () => {
    const html = renderToStaticMarkup(createElement(FilterRow, { children: null }));
    expect(html).toContain('>Show<');
  });

  it('accepts a custom submit label — staff/hire is the one caller passing "Search"', () => {
    const html = renderToStaticMarkup(
      createElement(FilterRow, { submitLabel: 'Search', children: null }),
    );
    expect(html).toContain('>Search<');
    expect(html).not.toContain('>Show<');
  });

  it('appends a passed className to the fixed layout classes rather than replacing them', () => {
    const html = renderToStaticMarkup(
      createElement(FilterRow, { className: 'mt-6', children: null }),
    );
    expect(html).toMatch(/class="flex flex-wrap items-end gap-3 gap-y-2 mt-6"/);
  });

  it('leaves no trailing space in the class attribute when no className is passed', () => {
    const html = renderToStaticMarkup(createElement(FilterRow, { children: null }));
    expect(html).toMatch(/class="flex flex-wrap items-end gap-3 gap-y-2"/);
  });
});
