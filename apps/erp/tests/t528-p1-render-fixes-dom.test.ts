// @vitest-environment happy-dom
/**
 * T-528 Addendum (TESTER) - the two P1 fixes from the T-527 render, round 2. docs/tasks/528-pos-payment-screen.md Addendum.
 *   1. In the seat/add panel the "Items so far" total and the Start/Send button stay pinned in view when the list is long (a sticky footer). Tested with 10 items.
 *   2. "Heads not checked" on a tile must not wrap: the visible text is "Heads: not checked" on ONE line (truncating if still too long); the full sentence is the accessible label.
 *
 * ASSUMED API: no new component. `OrderDialog` (add mode) and `OrdersView` keep their props. happy-dom has no layout, so the pin is proven by structure:
 *   the element that holds the Send button AND the "Items so far" total is `sticky` + `bottom-0`, and the 10-line list is NOT inside it;
 *   the tile's one-line text is a leaf element carrying `truncate` (or `whitespace-nowrap`), and an element in the tile has an aria-label matching /heads not checked/i.
 *
 * RED NOW FOR THE RIGHT REASON: today the summary aside is a plain column (nothing sticky), and the tile says "Heads not checked" inside a wrapping span.
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, MENU, id } from './helpers/t527-menu';

vi.mock('next/link', () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => createElement('a', { href, ...r }, children) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

import { OrderDialog } from '@/app/pos/_orders/OrderDialogs';
import { OrdersView } from '@/app/pos/_orders/OrdersView';

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

const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const NAMES = ['Dish A', 'Dish B', 'Dish C', 'Dish D', 'Dish E', 'Dish F', 'Dish G', 'Dish H', 'Dish I', 'Dish J'];
/** A menu with ten plain a la carte dishes at 40.00 each, cloned from the helper menu's "Plain rice" (no sizes, no options: one tap adds one line). */
const TEN_DISHES = (() => {
  const plain = MENU.items.find((i) => i.id === IDS.plain)!;
  return {
    ...MENU,
    items: NAMES.map((name, n) => ({ ...plain, id: id(700 + n), name, sortOrder: n + 1, variants: plain.variants.map((v) => ({ ...v, id: id(800 + n) })) })),
  };
})();

describe('P1-1: the items-so-far total and the Send button stay pinned', () => {
  it('with 10 picked lines, the footer holding the total and "Send to kitchen" is sticky to the bottom and the list is outside it', async () => {
    await act(async () => {
      root.render(createElement(OrderDialog, { mode: { kind: 'add', sessionId: id(1), label: 'Stand 5', heads: 2, packageOpen: false, takeOut: false }, menu: TEN_DISHES as never, stands: [], tiles: [], onClose: () => undefined, onSend: async () => null }));
    });
    for (const name of NAMES) {
      const tile = [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith(name));
      expect(tile, name).toBeTruthy();
      await act(async () => tile!.click());
    }
    const aside = host.querySelector('aside[aria-label="New order summary"]')!;
    const rows = aside.querySelectorAll('section[aria-label="Items so far"] ul > li');
    expect(rows).toHaveLength(10);
    const send = [...aside.querySelectorAll('button')].find((b) => b.textContent === 'Send to kitchen')!;
    expect(send).toBeTruthy();
    // the nearest ancestor of the Send button that is sticky to the bottom
    let footer: Element | null = send.parentElement;
    while (footer && footer !== aside.parentElement && !(tokens(footer).includes('sticky') && tokens(footer).includes('bottom-0'))) footer = footer.parentElement;
    expect(footer && tokens(footer).includes('sticky'), 'the Send button sits inside a sticky bottom-0 footer').toBe(true);
    expect(footer!.textContent, 'the pinned footer shows the running total (10 x 40.00)').toMatch(/Items so far[\s\S]*400\.00/);
    expect(footer!.querySelector('ul'), 'the 10 lines are not inside the pinned footer').toBeNull();
    for (const li of rows) expect(footer!.contains(li)).toBe(false);
  });
});

describe('P1-2: "Heads: not checked" on a tile is one line, with the full sentence for assistive technology', () => {
  const tile = { sessionId: id(600), standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 4, headsServer: null, openedAtDevice: '2026-11-07T09:00:00.000Z', packageName: 'Unli Grill', needsHeads: true, headsMismatch: false, pending: false };
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(OrdersView, {
          readOnly: false, tiles: [tile] as never, sessions: { [tile.sessionId]: { headsCashier: 4, headsServer: null, loaded: true, lines: [] } } as never, selectedSessionId: null, nowMs: Date.parse('2026-11-07T09:30:00.000Z'),
          onSeat: () => undefined, onTakeOut: () => undefined, onSelect: () => undefined, onHeads: () => undefined, onAddItems: () => undefined, onCancelLine: () => undefined,
        }),
      );
    });
    return host.querySelector('ul li')!;
  };

  it('the visible text is exactly "Heads: not checked", in a leaf that cannot wrap, and the old wrapping text is gone', async () => {
    const li = await render();
    const leaf = [...li.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() === 'Heads: not checked');
    expect(leaf, 'a single element whose text is "Heads: not checked"').toBeTruthy();
    expect(tokens(leaf!).includes('truncate') || tokens(leaf!).includes('whitespace-nowrap')).toBe(true);
    expect(li.textContent).not.toContain('Heads not checked');
  });

  it('the full sentence is the accessible label', async () => {
    const li = await render();
    const labelled = [li, ...li.querySelectorAll('*')].map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`);
    expect(labelled.some((l) => /heads not checked/i.test(l))).toBe(true);
  });

  it('control: a table whose heads are checked shows no such text', async () => {
    tile.needsHeads = false;
    const li = await render();
    expect(li.textContent).not.toMatch(/not checked/i);
    tile.needsHeads = true;
  });
});
