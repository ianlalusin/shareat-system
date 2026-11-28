import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/shell/Page';
import { ASK_ERP_CLEARANCE, DEFAULT_DOCK, clampDock, dockInsets, DRAG_THRESHOLD_PX, isDrag, parseDock, snapDock } from '../src/components/ask-erp/dock';

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
  it('F3: the title clamps to two lines below md (not always ellipsized), whole from md, with a title attribute', () => {
    expect(withActions).toContain('line-clamp-2');
    expect(withActions).toContain('md:line-clamp-none');
    expect(withActions.includes('truncate')).toBe(false);
    expect(withActions).toContain('title="Menu"');
  });
  it('F2: below md the row and the actions strip do not wrap (swipe); md+ wrap', () => {
    expect(withActions).toContain('flex-nowrap');
    expect(withActions).toContain('md:flex-wrap');
    expect(withActions).toContain('flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto md:flex-wrap md:overflow-visible" data-sticky-actions');
    expect(withActions).toContain('min-w-0');
    expect(read('app/globals.css')).toContain('[data-sticky-actions] > :is(div, nav, form, span) { flex-wrap: nowrap; flex-shrink: 0; }');
    expect(read('app/inventory/page.tsx')).toContain('aria-label="Inventory sections" className="flex min-w-0 max-w-full flex-nowrap');
  });
  it('F4: the description sits close under the sticky row (mt-1, as in the old look)', () => {
    expect(withActions).toContain('mt-1">D</p>');
    expect(withActions.includes('mt-2">D</p>')).toBe(false);
  });
  it('keeps the description out of the sticky row', () => {
    const row = withActions.slice(withActions.indexOf('data-sticky-header'), withActions.indexOf('</div></div>'));
    expect(row).not.toContain('>D<');
  });
  it('F1: in the >=1440px sectioned detail grid the header children span the full width, so the row and description are not half-width side-by-side grid items', () => {
    expect(withActions).toContain('<div class="contents" data-page-header="true">');
    const css = read('app/globals.css');
    const at = css.indexOf('@media (min-width: 1440px) {' + String.fromCharCode(10) + '  .erp-page[data-view="detail"][data-sectioned] {');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf(String.fromCharCode(10) + '}', at));
    expect(block).toContain('.erp-page[data-view="detail"][data-sectioned] > [data-page-header] > * { grid-column: 1 / -1;');
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
    expect(wrapperOf(prices)).toContain('lg:col-span-2 lg:col-start-2 lg:row-span-2 lg:row-start-1');
    expect(wrapperOf(h2('Item details'))).toContain('lg:col-start-1');
    expect(wrapperOf(h2('Item details'))).not.toContain('lg:col-span-2');
  });
});

describe('T-652 F5 - item page grid has no gap under Item details and no empty-cell gap on phones', () => {
  const page = read('app/menu/items/[id]/page.tsx');
  it('rows are auto / 1fr / auto / auto, Prices spans rows 1-2 (flexible row absorbs its height), Refills sits in row 2 under Item details', () => {
    expect(page).toContain('lg:grid-cols-3 lg:grid-rows-[auto_1fr_auto_auto]');
    expect(page).toMatch(/empty:hidden lg:col-start-1 lg:row-start-1/);
    expect(page).toMatch(/empty:hidden lg:col-start-1 lg:row-start-2/);
    expect(page).toContain('lg:col-span-2 lg:col-start-2 lg:row-start-3');
    expect(page).toContain('lg:col-span-2 lg:col-start-2 lg:row-start-4');
  });
});

describe('T-652 F8 - the Ask ERP tab stays in view', () => {
  const v = { viewportHeight: 800, topInset: 64, bottomInset: 16, tabHeight: 44 };
  it('clampDock pulls a stored position back inside the band and keeps the side', () => {
    expect(clampDock({ side: 'left', topPct: 95 }, v)).toEqual({ side: 'left', topPct: ((800 - 16 - 44) / 800) * 100 });
    expect(clampDock({ side: 'right', topPct: 0 }, v).topPct).toBeCloseTo((64 / 800) * 100);
    expect(clampDock({ side: 'right', topPct: 50 }, v)).toEqual({ side: 'right', topPct: 50 });
    expect(dockInsets(390).topInset).toBe(64);
    expect(dockInsets(1200).topInset).toBe(8);
  });
  it('the launcher clamps at read time, on resize and orientation change, and is hidden until placed', () => {
    const src = read('components/ask-erp/AskErpLauncher.tsx');
    expect(src).toContain('useLayoutEffect');
    expect(src).toContain('setDock(fit(readDock()))');
    expect(src).toContain("addEventListener('resize'");
    expect(src).toContain("addEventListener('orientationchange'");
    expect(src).toContain("visibility: 'hidden'");
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
