/**
 * T-586 - `Page`/`PageHeader` take an optional `crumb` rendered ABOVE the <h1>, and `description` accepts a ReactNode (a link).
 * Named `.test.ts` (createElement, no JSX): the unit project's include glob is `apps/**\/*.test.ts`, so a `.test.tsx` would never run.
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Page } from '../src/components/shell/Page';

const crumb = h('a', { href: '/settings' }, 'Settings');

describe('T-586 Page crumb', () => {
  it('renders the crumb above the <h1>, before the title/actions row', () => {
    const html = renderToStaticMarkup(h(Page, { density: 'table', crumb, title: 'Organisation', actions: h('button', null, 'Go'), children: 'body' }));
    expect(html).toContain('href="/settings"');
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf('<h1'));
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('<button'));
  });

  it('accepts a ReactNode description (a link) and keeps it under the title', () => {
    const html = renderToStaticMarkup(
      h(Page, { density: 'table', title: 'T', description: h('span', null, 'see ', h('a', { href: '/admin/stores' }, 'its store')), children: 'body' }),
    );
    expect(html).toContain('href="/admin/stores"');
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('href="/admin/stores"'));
  });

  it('renders no crumb element when none is passed, and none without a title', () => {
    expect(renderToStaticMarkup(h(Page, { density: 'table', title: 'T', children: 'x' }))).not.toContain('<p');
    expect(renderToStaticMarkup(h(Page, { density: 'table', crumb, children: 'x' }))).not.toContain('href="/settings"');
  });
});
