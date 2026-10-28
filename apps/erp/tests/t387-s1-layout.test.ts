/**
 * T-387 slice S1 — the root layout: both font variables and `data-theme` on `<html>`, plus the
 * brand metadata. Vitest runs `.test.ts` in a node environment with no jsdom (task L6), so this
 * renders with `renderToStaticMarkup` and mocks the three things a node test cannot supply:
 * `next/headers` (the theme cookie), `next/font/local` (font loader) and `AppShell`.
 *
 * Font export names are the real ones: `Baloo 2` -> `Baloo_2`, `Plus Jakarta Sans` ->
 * `Plus_Jakarta_Sans` (both present in next/dist/compiled/@next/font/dist/google/font-data.json).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'shareat_theme' && state.cookie !== undefined ? { name, value: state.cookie } : undefined,
  }),
}));
// T-496 - fonts now load via next/font/local; return a per-call value keyed on the CSS variable.
vi.mock('next/font/local', () => ({
  default: (opts: { variable: string }) =>
    opts.variable === '--font-display'
      ? { variable: '__baloo', className: 'baloo-class' }
      : { variable: '__jakarta', className: 'jakarta-class' },
}));

vi.mock('../src/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: unknown }) => children,
}));

import RootLayout, { metadata } from '../src/app/layout';

async function renderLayout(): Promise<string> {
  const tree = await RootLayout({ children: createElement('main', null, 'child') });
  return renderToStaticMarkup(tree);
}

function htmlTag(markup: string): string {
  return markup.match(/<html[^>]*>/)?.[0] ?? '';
}

describe('T-387 S1 — root layout', () => {
  beforeEach(() => {
    state.cookie = undefined;
  });

  it('carries both font variable classes on <html>', async () => {
    const tag = htmlTag(await renderLayout());
    expect(tag).toContain('__baloo');
    expect(tag).toContain('__jakarta');
  });

  it('data-theme is "dark" when the cookie is dark', async () => {
    state.cookie = 'dark';
    expect(htmlTag(await renderLayout())).toContain('data-theme="dark"');
  });

  it('data-theme is "light" with no cookie', async () => {
    expect(htmlTag(await renderLayout())).toContain('data-theme="light"');
  });

  it('still renders its children', async () => {
    expect(await renderLayout()).toContain('child');
  });

  it('metadata title is "SharEat ERP"', () => {
    expect(metadata.title).toBe('SharEat ERP');
  });

  it('metadata icons reference the three brand assets', () => {
    const icons = JSON.stringify(metadata.icons ?? null);
    expect(icons).toContain('/brand/favicon.ico');
    expect(icons).toContain('/brand/favicon-32.png');
    expect(icons).toContain('/brand/apple-touch-icon.png');
  });
});
