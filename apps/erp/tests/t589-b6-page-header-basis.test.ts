/**
 * T-589 B6 - a phone page header must wrap its actions below the title, not squeeze the title.
 *
 * Without a flex-basis on the title block the row's `flex-wrap` never fires: at 390 px the action
 * buttons stay beside the title and leave it ~110 px.
 * `createElement`, not JSX: the unit glob only matches `.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/shell/Page';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? pageFiles(p) : name === 'page.tsx' ? [p] : [];
  });
}

describe('T-589 B6 - page header basis', () => {
  it('PageHeader gives the title block a basis and lets the row wrap', () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, { title: 'Accounts payable', description: 'd', actions: createElement('a', null, 'x') }),
    );
    // T-652: with actions the row is the STICKY title + buttons row (the description sits under it); it still wraps, and the title still has a basis.
    const row = /<div class="([^"]*)" data-sticky-header/.exec(html)?.[1] ?? '';
    const title = /<h1 class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(row).toContain('flex-wrap');
    expect(title).toContain('min-w-0');
    expect(title).toContain('flex-1');
    expect(title).toContain('basis-[12rem]');
    // without actions the original row (basis-[16rem] title block) is unchanged
    const plain = renderToStaticMarkup(createElement(PageHeader, { title: 'Accounts payable', description: 'd' }));
    expect(/^<div class="([^"]*)"/.exec(plain)?.[1] ?? '').toContain('flex-wrap');
    expect(/<div class="([^"]*)"><h1/.exec(plain)?.[1] ?? '').toContain('basis-[16rem]');
  });

  it('no page.tsx hand-writes a basis-less `min-w-0 flex-1` title block around its <h1', () => {
    const files = pageFiles(appRoot);
    expect(files.length).toBeGreaterThan(50); // the scan must see the pages, never pass vacuously
    // Matches the exact string `className="min-w-0 flex-1"` on a <div> whose very next tag is an <h1 (or a back link then <h1).
    const bad = files.filter((f) => /<div className="min-w-0 flex-1">\s*(?:<Link[\s\S]*?<\/Link>\s*)?<h1/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
