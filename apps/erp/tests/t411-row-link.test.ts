/**
 * T-411 S1 — the shared whole-row link: `LinkRow`, `RowLink`, `RowAction` and `ROW_LINK_STRETCH`
 * in `components/ui/Table.tsx` (docs/tasks/411-row-link-sweep.md).
 *
 * `.ts`, not `.tsx`, for the same reason as `filter-row.test.ts`: the unit project's include glob
 * is `apps/**\/*.test.ts`. `createElement` stands in for JSX.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LinkRow, ROW_LINK_STRETCH, RowAction, RowLink } from '../src/components/ui/Table';
import * as ui from '../src/components/ui';

/** renderToStaticMarkup escapes quotes; undo the escapes so class tokens compare literally. */
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The class tokens of the first `<tag ...>` in the markup. */
function classTokens(html: string, tag: string): string[] {
  const m = new RegExp(`<${tag}\\b[^>]*\\bclass="([^"]*)"`).exec(html);
  if (!m || m[1] === undefined) throw new Error(`no <${tag} class=…> in: ${html}`);
  return decode(m[1]).split(/\s+/).filter(Boolean);
}

describe('T-411 — RowLink', () => {
  it('renders an <a> with the href, its text, and every class in ROW_LINK_STRETCH', () => {
    const html = renderToStaticMarkup(createElement(RowLink, { href: '/loans/42' }, 'Loan 42'));
    expect(html).toMatch(/^<a\b/);
    expect(html).toContain('href="/loans/42"');
    expect(html).toContain('>Loan 42</a>');
    const tokens = classTokens(html, 'a');
    for (const token of ROW_LINK_STRETCH.split(/\s+/).filter(Boolean)) {
      expect(tokens).toContain(token);
    }
  });

  it('appends a caller className and keeps the stretch classes', () => {
    const html = renderToStaticMarkup(
      createElement(RowLink, { href: '/x', className: 'text-ink' }, 'X'),
    );
    const tokens = classTokens(html, 'a');
    expect(tokens).toContain('text-ink');
    expect(tokens).toContain('after:inset-0');
    expect(tokens).toContain('after:absolute');
  });
});

describe('T-411 — LinkRow', () => {
  it('renders a <tr> that is the containing block (relative) with a 44px height (h-11)', () => {
    const html = renderToStaticMarkup(
      createElement(
        'table',
        null,
        createElement('tbody', null, createElement(LinkRow, null, createElement('td', null, 'x'))),
      ),
    );
    const tokens = classTokens(html, 'tr');
    expect(tokens).toContain('relative');
    expect(tokens).toContain('h-11');
  });

  it('appends a caller className rather than replacing the base classes', () => {
    const html = renderToStaticMarkup(
      createElement(
        'table',
        null,
        createElement(
          'tbody',
          null,
          createElement(LinkRow, { className: 'extra-row' }, createElement('td', null, 'x')),
        ),
      ),
    );
    const tokens = classTokens(html, 'tr');
    expect(tokens).toContain('extra-row');
    expect(tokens).toContain('relative');
    expect(tokens).toContain('h-11');
  });
});

describe('T-411 — RowAction', () => {
  it('renders with relative and z-10, so a control in a linked row sits above the stretched link', () => {
    const html = renderToStaticMarkup(createElement(RowAction, null, 'void'));
    expect(html).toMatch(/^<div\b/);
    const tokens = classTokens(html, 'div');
    expect(tokens).toContain('relative');
    expect(tokens).toContain('z-10');
  });

  it('appends a caller className rather than replacing the base classes', () => {
    const html = renderToStaticMarkup(createElement(RowAction, { className: 'ml-2' }, 'void'));
    const tokens = classTokens(html, 'div');
    expect(tokens).toContain('ml-2');
    expect(tokens).toContain('z-10');
  });
});

describe('T-411 — components/ui index', () => {
  it('re-exports LinkRow, RowLink and RowAction', () => {
    expect(typeof ui.LinkRow).toBe('function');
    expect(typeof ui.RowLink).toBe('function');
    expect(typeof ui.RowAction).toBe('function');
  });
});
