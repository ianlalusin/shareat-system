/**
 * T-387 S3 — EmptyState (components/ui/EmptyState.tsx) and the reports adapter.
 *
 * SPEC CONFLICT, resolved by the tester (flagged): `components/reports/EmptyState` already exists as
 * `EmptyState({ message })` with TEN callers (app/page.tsx and nine reports pages). The spec's "re-exports it" would
 * break them (the new API wants `title`). Pinned instead: the reports file stays `EmptyState({ message })`, now a thin
 * adapter over the kit one (illustration magnifier, title = message), so the ten callers do not change.
 *
 * Kit API pinned: `EmptyState({ illustration: 'truck'|'flame'|'magnifier', title, body?, action? })`.
 * The svg is inline, aria-hidden, carries `data-illustration="<name>"`, and uses tokens/currentColor only (the
 * Feedback board's hex values are NOT copied: Guard 7 forbids raw hex in components/ui).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../src/components/ui/EmptyState';
import { EmptyState as ReportsEmptyState } from '../src/components/reports/EmptyState';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = (p: Record<string, unknown>) => renderToStaticMarkup(createElement(EmptyState as never, p as never));
const svgOf = (html: string) => /<svg[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';

describe('EmptyState', () => {
  it.each(['truck', 'flame', 'magnifier'])('%s: inline svg (aria-hidden), the title, the body', (illustration) => {
    const html = R({ illustration, title: 'No deliveries yet', body: 'Commissary drops show up here.' });
    const svg = svgOf(html);
    expect(svg.length).toBeGreaterThan(0);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain(`data-illustration="${illustration}"`);
    expect(html).toContain('No deliveries yet');
    expect(html).toContain('Commissary drops show up here.');
  });
  it('the three illustrations are three different drawings', () => {
    const inner = ['truck', 'flame', 'magnifier'].map((i) => svgOf(R({ illustration: i, title: 't' })).replace(/data-illustration="[a-z]+"/, ''));
    expect(new Set(inner).size).toBe(3);
  });
  it('NEGATIVE: tokens only. No raw hex and no stock hue anywhere in the markup', () => {
    for (const i of ['truck', 'flame', 'magnifier']) {
      const html = R({ illustration: i, title: 't', body: 'b' });
      expect(html, i).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, i).not.toMatch(/\b(?:red|green|blue|amber|slate|gray|zinc|neutral|stone)-\d{2,3}\b/);
    }
  });
  it('renders the action node when given, and nothing for it when not', () => {
    const withAction = R({ illustration: 'truck', title: 't', action: createElement('a', { href: '/new' }, 'Add one') });
    expect(withAction).toContain('<a href="/new">Add one</a>');
    expect(R({ illustration: 'truck', title: 't' })).not.toContain('<a ');
  });
  it('no empty paragraph when body is omitted', () => {
    expect(R({ illustration: 'flame', title: 'All caught up' })).not.toMatch(/<p[^>]*><\/p>/);
  });
  it('escapes title and body', () => {
    const html = R({ illustration: 'flame', title: '<b>x</b>', body: '<i>y</i>' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>y</i>');
  });
  it('is not a live region (an empty state is page content, not an announcement)', () => {
    expect(R({ illustration: 'truck', title: 't' })).not.toMatch(/role="(?:alert|status)"/);
  });
});

describe('components/reports/EmptyState keeps its {message} API for the existing callers', () => {
  it('renders the message and a kit illustration', () => {
    const html = renderToStaticMarkup(createElement(ReportsEmptyState, { message: 'No entries for this range' }));
    expect(html).toContain('No entries for this range');
    expect(html).toMatch(/<svg[^>]*data-illustration="/);
  });
  it('is built on the kit component (imports it), not a second copy', () => {
    const src = readFileSync(path.join(here, '..', 'src', 'components', 'reports', 'EmptyState.tsx'), 'utf8');
    expect(src).toMatch(/from '@\/components\/ui(?:\/EmptyState)?'|from '\.\.\/ui(?:\/EmptyState)?'/);
  });
  it('the old dashed-box neutral styling is gone (stock neutral-* hues and dark: variants)', () => {
    const html = renderToStaticMarkup(createElement(ReportsEmptyState, { message: 'm' }));
    expect(html).not.toMatch(/neutral-\d{3}/);
    expect(html).not.toContain('dark:');
  });
});
