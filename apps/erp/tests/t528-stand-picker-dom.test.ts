// @vitest-environment happy-dom
/**
 * T-528 Addendum 2 (TESTER) - Ian, 7 Nov 2026: the stand chooser is ONE sliding row, never a wrapped grid, whatever the number of stands.
 * Rendered for real in happy-dom with 30 stands, through the seat panel (`OrderDialog`, mode 'seat').
 *
 * ASSUMED API: the seat panel keeps `OrderDialog` from apps/erp/src/app/pos/_orders/OrderDialogs.tsx with its present props. If the builder extracts a
 * `StandPicker` component it must still render inside that panel. The picker's contract this file reads:
 *   - one container whose DIRECT children are the stand buttons (aria-label "Stand N" / "Stand N, in use"), inside <section aria-label="Stand">;
 *   - selection shows as aria-pressed="true" on the chosen button (as today);
 *   - Tailwind classes OR inline style carry the layout, because happy-dom computes no stylesheet:
 *       container: no flex-wrap / grid, overflow-x-auto (or style overflow-x: auto), snap-x + snap-mandatory (or style scroll-snap-type: x mandatory)
 *       button:    snap-start (or style scroll-snap-align: start), min-h-12 and min-w-12 (48 px) or larger;
 *   - choosing a stand, and each arrow-key move, calls scrollIntoView({ inline: 'nearest' }) on the newly selected button.
 *
 * RED NOW FOR THE RIGHT REASON: today the chooser is `flex flex-wrap gap-2` with no overflow, no snap, no scrollIntoView and no arrow keys.
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MENU, id } from './helpers/t527-menu';

vi.mock('next/link', () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => createElement('a', { href, ...r }, children) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

import { OrderDialog } from '@/app/pos/_orders/OrderDialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STANDS = Array.from({ length: 30 }, (_, i) => ({ id: id(100 + i + 1), number: i + 1 }));
const USED = [5, 12, 28];
const TILES = USED.map((n) => ({ sessionId: id(500 + n), standId: id(100 + n), standNumber: n, mode: 'dine_in', headsCashier: 2, headsServer: null, openedAtDevice: '2026-11-07T09:00:00.000Z', packageName: null, needsHeads: false, headsMismatch: false, pending: false }));

let host: HTMLDivElement;
let root: Root;
let spy: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  spy = vi.fn();
  (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy; // happy-dom has no layout: the spy records WHO was scrolled to
  await act(async () => {
    root.render(createElement(OrderDialog, { mode: { kind: 'seat' }, menu: MENU, stands: STANDS, tiles: TILES as never, onClose: () => undefined, onSend: async () => null }));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('section[aria-label="Stand"] button')].filter((b) => /^Stand \d+/.test(b.getAttribute('aria-label') ?? ''));
const stand = (n: number) => buttons().find((b) => new RegExp(`^Stand ${n}(,|$)`).test(b.getAttribute('aria-label') ?? ''))!;
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const pressed = () => buttons().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const key = async (el: Element, k: string) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  await act(async () => undefined);
};
const click = async (el: Element) => act(async () => (el as HTMLElement).click());

describe('the stand chooser with 30 stands (Addendum 2)', () => {
  it('renders all 30 stands, as direct children of ONE container', () => {
    expect(buttons()).toHaveLength(30);
    expect(new Set(buttons().map((b) => b.parentElement)).size).toBe(1);
  });

  it('is a single row: no wrap, no grid, every stand button at the same offsetTop', () => {
    const container = buttons()[0]!.parentElement!;
    const t = tokens(container);
    expect(t).toContain('flex');
    for (const bad of ['flex-wrap', 'flex-wrap-reverse', 'flex-col', 'grid']) expect(t, bad).not.toContain(bad);
    expect(container.style.flexWrap === '' || container.style.flexWrap === 'nowrap').toBe(true);
    expect(new Set(buttons().map((b) => b.offsetTop)).size).toBe(1);
  });

  it('slides sideways: overflow-x auto on the container', () => {
    const container = buttons()[0]!.parentElement!;
    expect(tokens(container).includes('overflow-x-auto') || container.style.overflowX === 'auto').toBe(true);
  });

  it('snaps: scroll-snap-type x mandatory on the container, scroll-snap-align start on every stand', () => {
    const container = buttons()[0]!.parentElement!;
    const t = tokens(container);
    expect((t.includes('snap-x') && t.includes('snap-mandatory')) || /x\s+mandatory/.test(container.style.getPropertyValue('scroll-snap-type'))).toBe(true);
    for (const b of buttons()) expect(tokens(b).includes('snap-start') || b.style.getPropertyValue('scroll-snap-align') === 'start', b.getAttribute('aria-label')!).toBe(true);
  });

  it('every stand is a 48 px target (min-h-12 and min-w-12 or larger)', () => {
    for (const b of buttons()) {
      expect(tokens(b).some((c) => /^min-h-(12|14|16|20|24)$/.test(c)), `${b.getAttribute('aria-label')} height`).toBe(true);
      expect(tokens(b).some((c) => /^min-w-(12|14|16|20|24)$/.test(c)), `${b.getAttribute('aria-label')} width`).toBe(true);
    }
  });

  it('choosing stand 27 selects it and scrolls THAT button into view with inline: nearest', async () => {
    await click(stand(27));
    expect(pressed()).toEqual(['27']);
    const at = spy.mock.contexts.findIndex((c) => c === stand(27));
    expect(at, 'scrollIntoView was called on the stand 27 button').toBeGreaterThan(-1);
    expect(spy.mock.calls[at]![0]).toMatchObject({ inline: 'nearest' });
  });

  it('the arrow keys move the selection along the row, and each move scrolls the new stand into view', async () => {
    await click(stand(3));
    await key(stand(3), 'ArrowRight');
    expect(pressed()).toEqual(['4']);
    expect(spy.mock.contexts.includes(stand(4))).toBe(true);
    await key(stand(4), 'ArrowLeft');
    expect(pressed()).toEqual(['3']);
  });

  it('the arrow keys stop at both ends of the row', async () => {
    await click(stand(30));
    await key(stand(30), 'ArrowRight');
    expect(pressed()).toEqual(['30']);
    await click(stand(1));
    await key(stand(1), 'ArrowLeft');
    expect(pressed()).toEqual(['1']);
  });

  it('a stand in use is disabled and greyed, cannot be tapped, and the arrow keys never land on it', async () => {
    for (const n of USED) {
      expect(stand(n).disabled, `stand ${n} disabled`).toBe(true);
      expect(stand(n).getAttribute('aria-label')).toBe(`Stand ${n}, in use`);
    }
    for (const n of [1, 4, 6, 27, 30]) expect(stand(n).disabled, `stand ${n} free`).toBe(false);
    spy.mockClear();
    await click(stand(12));
    expect(pressed()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    await click(stand(4));
    await key(stand(4), 'ArrowRight'); // 5 is in use
    expect(pressed()).not.toContain('5');
    expect(['4', '6']).toContain(pressed()[0]);
  });
});
