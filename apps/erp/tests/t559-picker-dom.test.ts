// @vitest-environment happy-dom
/**
 * T-559 R2 / R4 (TESTER, written before the code) - the real MenuPicker, rendered, with an injected clock (`at`):
 *   - a tile shows the price of the slot at `at`, and flips when `at` moves past 17:00 with no new menu;
 *   - a package whose window closed is one muted line under the picker, not a tile;
 *   - a selected package whose window closes while the panel is open is taken off the order, with a note.
 * ASSUMED API: MenuPicker gains an optional `at?: Date` (default: now). docs/tasks/559-pos-offline-daypart-switch.md R2.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuPicker } from '@/app/pos/_orders/MenuPicker';
import { POS_NOTICE_DISMISS_MS } from '@/app/pos/_shell/constants';
import type { CartLine } from '@/app/pos/_orders/payloads';
import { DAYPARTED_MENU, DP, manila } from './helpers/t559-menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (at: Date, cart: CartLine[] = [], onChange: (c: CartLine[]) => void = () => undefined) => {
  await act(async () => root.render(createElement(MenuPicker, { menu: DAYPARTED_MENU, packageOpen: false, heads: 2, cart, onChange, at })));
};
const text = () => host.textContent ?? '';
const clickCategory = async (name: string) => {
  const btn = [...host.querySelectorAll('nav button')].find((b) => b.textContent === name) as HTMLButtonElement;
  await act(async () => btn.click());
};

describe('MenuPicker with an injected clock', () => {
  it('Packages at 16:59: the lunch price on the Dinner Grill tile and the Lunch Set tile; no closed line', async () => {
    await render(manila('16:59'));
    await clickCategory('Packages');
    expect(text()).toContain('Dinner Grill');
    expect(text()).toContain('449.00');
    expect(text()).toContain('Lunch Set');
    expect(text()).not.toContain('Not available now');
  });

  it('the SAME menu one render later at 17:01: the dinner price, no Lunch Set tile, ONE muted line naming it', async () => {
    await render(manila('17:01'));
    await clickCategory('Packages');
    expect(text()).toContain('549.00');
    expect(text()).not.toContain('449.00');
    const tiles = [...host.querySelectorAll('ul button')].map((b) => b.textContent ?? '');
    expect(tiles.some((t) => t.includes('Lunch Set'))).toBe(false);
    const lines = [...host.querySelectorAll('p')].filter((p) => (p.textContent ?? '').startsWith('Not available now'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe('Not available now: Lunch Set from 08:00');
    expect(lines[0]!.className).toContain('text-muted');
  });

  it('re-rendering the same picker with a later `at` flips the price in place (the shell tick does exactly this)', async () => {
    await render(manila('16:59'));
    await clickCategory('Grill');
    expect(text()).toContain('100.00');
    await render(manila('17:01'));
    expect(text()).toContain('150.00');
    expect(text()).not.toContain('100.00');
  });

  it('a selected package whose window closes while the panel is open is cleared, with a note; the rest of the order stays', async () => {
    const lunchSet: CartLine = { itemId: DP.pkgLunchOnly, variantId: DP.pkgLunchOnlyV, qty: 1 };
    const dish: CartLine = { itemId: DP.dish, variantId: DP.dishV, qty: 1 };
    const onChange = vi.fn();
    await render(manila('16:59'), [lunchSet, dish], onChange);
    expect(onChange).not.toHaveBeenCalled();
    expect(text()).not.toContain('no longer offered');
    await render(manila('17:01'), [lunchSet, dish], onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([dish]);
    expect(text()).toContain('Lunch Set is no longer offered, so it was taken off the order.');
  });

  it('the cleared-package note dismisses itself after POS_NOTICE_DISMISS_MS, and a panel opened afterwards does not show it', async () => {
    vi.useFakeTimers();
    try {
      const lunchSet: CartLine = { itemId: DP.pkgLunchOnly, variantId: DP.pkgLunchOnlyV, qty: 1 };
      expect(POS_NOTICE_DISMISS_MS).toBeGreaterThan(0);
      await render(manila('16:59'), [lunchSet]);
      await render(manila('17:01'), [lunchSet]);
      expect(text()).toContain('no longer offered');
      await act(async () => void vi.advanceTimersByTime(POS_NOTICE_DISMISS_MS - 1));
      expect(text()).toContain('no longer offered');
      await act(async () => void vi.advanceTimersByTime(1));
      expect(text()).not.toContain('no longer offered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing the panel (unmounting the picker) drops the note: a new panel starts clean', async () => {
    const lunchSet: CartLine = { itemId: DP.pkgLunchOnly, variantId: DP.pkgLunchOnlyV, qty: 1 };
    await render(manila('16:59'), [lunchSet]);
    await render(manila('17:01'), [lunchSet]);
    expect(text()).toContain('no longer offered');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(manila('17:02'), []);
    expect(text()).not.toContain('no longer offered');
  });

  it('no `at` given: it still renders (the clock defaults to now) and a menu with no dayparts is unaffected', async () => {
    await act(async () => root.render(createElement(MenuPicker, { menu: { ...DAYPARTED_MENU, hours: undefined, items: [] }, packageOpen: false, heads: 2, cart: [], onChange: () => undefined })));
    expect(text()).toContain('There is nothing to order yet');
  });
});
