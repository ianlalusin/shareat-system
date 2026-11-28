import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/shell/Page';
import { ASK_ERP_CLEARANCE, DEFAULT_DOCK, DRAG_THRESHOLD_PX, isDrag, parseDock, snapDock } from '../src/components/ask-erp/dock';

const read = (p: string) => readFileSync(`apps/erp/src/${p}`, 'utf8').split('\r\n').join('\n');

describe('T-652 rule 1 - the header row sticks only when the page has actions', () => {
  const withActions = renderToStaticMarkup(createElement(PageHeader, { title: 'Menu', description: 'D', actions: createElement('a', { href: '/x' }, 'Go') }));
  const without = renderToStaticMarkup(createElement(PageHeader, { title: 'Menu', description: 'D' }));
  it('has sticky classes under the TopBar, below it in z-order', () => {
    expect(withActions).toMatch(/class="[^"]*\bsticky\b/);
    expect(withActions).toContain('top-14');
    expect(withActions).toContain('md:top-0');
    expect(withActions).toContain('z-20');
    // TopBar is z-30; dialogs and toasts are z-50
    expect(read('components/shell/TopBar.tsx')).toContain('z-30');
    expect(withActions).not.toMatch(/z-(30|40|50)/);
  });
  it('keeps the title on one line and the description out of the sticky row', () => {
    expect(withActions).toContain('truncate');
    const row = withActions.slice(withActions.indexOf('data-sticky-header'), withActions.indexOf('</div></div>'));
    expect(row).not.toContain('>D<');
  });
  it('a header without actions is not sticky', () => {
    expect(without).not.toContain('sticky');
  });
  it('the rail and sticky panels sit under the header', () => {
    expect(read('components/shell/DetailLayout.tsx')).toContain('min-[1440px]:top-20');
  });
});

describe('T-652 rule 3 - item page: Prices by store in the wide column, before Variants', () => {
  const page = read('app/menu/items/[id]/page.tsx');
  const h2 = (t: string) => page.indexOf('>' + t + '</h2>');
  const prices = h2('Prices by store');
  const variants = h2('Variants and stock use');
  const wrapperOf = (i: number) => page.slice(page.lastIndexOf('<div className=', i), i);
  it('DOM order is the phone order: details, prices, variants, refills, option groups', () => {
    const order = ['Item details', 'Prices by store', 'Variants and stock use', 'Refills this package allows'].map(h2).concat(page.indexOf('<OptionGroups '));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('Prices by store sits in a wide (col-span-2, right) cell, first row, and Item details in the narrow left cell', () => {
    expect(prices).toBeLessThan(variants);
    expect(wrapperOf(prices)).toContain('lg:col-span-2 lg:col-start-2 lg:row-start-1');
    expect(wrapperOf(h2('Item details'))).toContain('lg:col-start-1');
    expect(wrapperOf(h2('Item details'))).not.toContain('lg:col-span-2');
  });
});

describe('T-652 rule 4 - Ask ERP tab', () => {
  const input = { viewportWidth: 1000, viewportHeight: 800, topInset: 64, bottomInset: 16, tabHeight: 44 };
  it('snaps to the nearer side', () => {
    expect(snapDock({ ...input, x: 100, y: 400 }).side).toBe('left');
    expect(snapDock({ ...input, x: 900, y: 400 }).side).toBe('right');
  });
  it('clamps the top clear of the TopBar and the bottom inset', () => {
    expect(snapDock({ ...input, x: 900, y: -50 }).topPct).toBeCloseTo((64 / 800) * 100);
    expect(snapDock({ ...input, x: 900, y: 5000 }).topPct).toBeCloseTo(((800 - 16 - 44) / 800) * 100);
  });
  it('reads a stored position defensively', () => {
    expect(parseDock(null)).toEqual(DEFAULT_DOCK);
    expect(parseDock('not json')).toEqual(DEFAULT_DOCK);
    expect(parseDock('{"side":"up","topPct":3}')).toEqual(DEFAULT_DOCK);
    expect(parseDock('{"side":"left","topPct":40}')).toEqual({ side: 'left', topPct: 40 });
  });
  it('a movement under the threshold is a press, over it a drag, and a drag never opens the panel', () => {
    expect(isDrag(DRAG_THRESHOLD_PX - 1, 0)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD_PX + 1, 0)).toBe(true);
    const src = read('components/ask-erp/AskErpLauncher.tsx');
    const click = src.slice(src.indexOf('onClick={() => {\n          if (dragged.current)'));
    expect(click.indexOf('return;')).toBeLessThan(click.indexOf('setOpen(true)'));
    expect(src).toContain('aria-label="Ask ERP"');
  });
  it('main gets the clearance exactly when the launcher renders', () => {
    const shell = read('components/shell/AppShell.tsx');
    expect(ASK_ERP_CLEARANCE).toBe('pb-24');
    expect(shell).toContain('askErp ? ` ${ASK_ERP_CLEARANCE}` : ""');
    expect(shell).toContain('{askErp ? <AskErpLauncher /> : null}');
  });
});
