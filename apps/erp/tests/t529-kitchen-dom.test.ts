// @vitest-environment happy-dom
/**
 * T-529 (TESTER) - R1 / R2 rendered for real in happy-dom (this file only): the Kitchen board, its station chips, and the refill stand row.
 *
 * ASSUMED API (presentational components, no hooks that need the shell; the page wires them to usePosState and the Server Actions):
 *   apps/erp/src/app/pos/_kitchen/KitchenBoard.tsx    KitchenBoard({ cards: KitchenCard[]; canServe: boolean; onServe(lineId: string): void; onAllOut(lineIds: string[]): void })
 *     per card: an element with data-session="<sessionId>" and data-late="true" | "false" holding the title ("Stand 12"), the age ("14 min"), and one <li data-line="<lineId>">
 *     per line showing its qty, its name, its note (when there is one) and the text "Refill" when line.tag is 'Refill'.
 *     With canServe: each line has ONE button whose text is "Served" (a button inside its <li data-line>), and each card has ONE button whose text contains "All out".
 *     Without canServe (read-only): NO button of either kind anywhere.
 *   apps/erp/src/app/pos/_kitchen/StationChips.tsx    StationChips({ chips: { id: string | null; label: string }[]; selected: string | null; onSelect(id: string | null): void })
 *     one <button> per chip, text = label, aria-pressed="true" on the selected one only.
 *   apps/erp/src/app/pos/_refills/RefillStandRow.tsx   RefillStandRow({ tables: RefillTable[]; selectedSessionId: string | null; onSelect(sessionId: string): void })
 *     the SAME contract as t528-stand-picker-dom.test.ts (row 448): <section aria-label="Stand"> whose container's DIRECT children are the stand buttons (aria-label "Stand N"),
 *     one row (flex, no wrap/grid), overflow-x-auto, snap-x + snap-mandatory, buttons snap-start + min-h-12 + min-w-12, aria-pressed on the chosen one,
 *     scrollIntoView({ inline: 'nearest' }) on the chosen / arrow-moved button, arrow keys stop at both ends.
 *
 * RED NOW FOR THE RIGHT REASON: the components do not exist (lazy import: "MISSING MODULE ... not built").
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id } from './helpers/t529-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function load(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
  try {
    return await import(/* @vite-ignore */ `../src/app/pos/${path}`);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/${path} cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

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
const render = async (el: unknown) => act(async () => root.render(el as never));
const click = async (el: Element) => act(async () => (el as HTMLElement).click());
const key = async (el: Element, k: string) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  await act(async () => undefined);
};
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

const L = (n: number) => id(8000 + n);
const CARDS = [
  {
    sessionId: id(8101), title: 'Stand 12', standNumber: 12, takeOut: false, ageMinutes: 14, ageLabel: '14 min', late: true,
    lines: [
      { lineId: L(1), name: 'Pork belly', qty: 2, note: null, tag: 'Refill', stationId: null },
      { lineId: L(2), name: 'Beef brisket', qty: 1, note: null, tag: null, stationId: null },
    ],
  },
  {
    sessionId: id(8102), title: 'Stand 5', standNumber: 5, takeOut: false, ageMinutes: 8, ageLabel: '8 min', late: false,
    lines: [{ lineId: L(3), name: 'Kimchi fried rice', qty: 1, note: 'No egg on the rice', tag: null, stationId: null }],
  },
];
const card = (sessionId: string) => host.querySelector(`[data-session="${sessionId}"]`) as HTMLElement;
const lineEl = (lineId: string) => host.querySelector(`[data-line="${lineId}"]`) as HTMLElement;
const buttonsIn = (el: ParentNode) => [...el.querySelectorAll('button')];

describe('KitchenBoard', () => {
  async function board(canServe: boolean, onServe = vi.fn(), onAllOut = vi.fn()) {
    const { KitchenBoard } = await load('_kitchen/KitchenBoard');
    await render(createElement(KitchenBoard, { cards: CARDS, canServe, onServe, onAllOut }));
    return { onServe, onAllOut };
  }

  it('draws one card per table with its title, age and lines; the note and the Refill tag show', async () => {
    await board(true);
    expect(host.querySelectorAll('[data-session]')).toHaveLength(2);
    expect(card(CARDS[0]!.sessionId).textContent).toContain('Stand 12');
    expect(card(CARDS[0]!.sessionId).textContent).toContain('14 min');
    expect(lineEl(L(1)).textContent).toContain('Pork belly');
    expect(lineEl(L(1)).textContent).toContain('Refill');
    expect(lineEl(L(2)).textContent).not.toContain('Refill');
    expect(lineEl(L(3)).textContent).toContain('No egg on the rice');
  });

  it('a late card is marked data-late="true" and an on-time card "false"', async () => {
    await board(true);
    expect(card(CARDS[0]!.sessionId).getAttribute('data-late')).toBe('true');
    expect(card(CARDS[1]!.sessionId).getAttribute('data-late')).toBe('false');
  });

  it('with canServe: every line has one Served button and every card has one All out button', async () => {
    await board(true);
    for (const l of [L(1), L(2), L(3)]) expect(buttonsIn(lineEl(l)).map((b) => b.textContent?.trim())).toEqual(['Served']);
    for (const c of CARDS) expect(buttonsIn(card(c.sessionId)).filter((b) => /All out/.test(b.textContent ?? ''))).toHaveLength(1);
  });

  it('tapping Served on a line calls onServe with THAT line id only', async () => {
    const { onServe, onAllOut } = await board(true);
    await click(buttonsIn(lineEl(L(2)))[0]!);
    expect(onServe).toHaveBeenCalledTimes(1);
    expect(onServe).toHaveBeenCalledWith(L(2));
    expect(onAllOut).not.toHaveBeenCalled();
  });

  it('tapping All out calls onAllOut with every line id of that card, in card order, and no other card', async () => {
    const { onServe, onAllOut } = await board(true);
    const allOut = buttonsIn(card(CARDS[0]!.sessionId)).find((b) => /All out/.test(b.textContent ?? ''))!;
    await click(allOut);
    expect(onAllOut).toHaveBeenCalledTimes(1);
    expect(onAllOut).toHaveBeenCalledWith([L(1), L(2)]);
    expect(onServe).not.toHaveBeenCalled();
  });

  it('READ-ONLY (canServe false): no Served button and no All out button anywhere, but the tickets still show', async () => {
    await board(false);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).toContain('Pork belly');
    expect(host.textContent).toContain('Kimchi fried rice');
  });

  it('no cards draws no card (the page shows its own empty sentence)', async () => {
    const { KitchenBoard } = await load('_kitchen/KitchenBoard');
    await render(createElement(KitchenBoard, { cards: [], canServe: true, onServe: vi.fn(), onAllOut: vi.fn() }));
    expect(host.querySelectorAll('[data-session]')).toHaveLength(0);
  });
});

describe('StationChips', () => {
  const CHIPS = [{ id: null, label: 'All' }, { id: id(900), label: 'Grill' }, { id: id(902), label: 'Drinks' }];
  async function chips(selected: string | null, onSelect = vi.fn()) {
    const { StationChips } = await load('_kitchen/StationChips');
    await render(createElement(StationChips, { chips: CHIPS, selected, onSelect }));
    return onSelect;
  }
  const btn = (label: string) => buttonsIn(host).find((b) => b.textContent?.trim() === label)!;

  it('one button per chip, with the chosen one pressed and only that one', async () => {
    await chips(id(900));
    expect(buttonsIn(host).map((b) => b.textContent?.trim())).toEqual(['All', 'Grill', 'Drinks']);
    expect(buttonsIn(host).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });
  it('All is pressed when nothing is chosen', async () => {
    await chips(null);
    expect(btn('All').getAttribute('aria-pressed')).toBe('true');
  });
  it('tapping Drinks calls onSelect with its id; tapping All calls it with null', async () => {
    const onSelect = await chips(id(900));
    await click(btn('Drinks'));
    expect(onSelect).toHaveBeenLastCalledWith(id(902));
    await click(btn('All'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});

describe('RefillStandRow (row 448: one sliding row, any number of stands)', () => {
  const TABLES = Array.from({ length: 30 }, (_, i) => ({ sessionId: id(8200 + i + 1), standNumber: i + 1, label: `Stand ${i + 1}`, packageVariantId: id(930) }));
  let spy: ReturnType<typeof vi.fn>;
  let picked: string[];
  beforeEach(async () => {
    spy = vi.fn();
    picked = [];
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
    const { RefillStandRow } = await load('_refills/RefillStandRow');
    await render(createElement(RefillStandRow, { tables: TABLES, selectedSessionId: null, onSelect: (s: string) => picked.push(s) }));
  });
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('section[aria-label="Stand"] button')].filter((b) => /^Stand \d+/.test(b.getAttribute('aria-label') ?? ''));
  const stand = (n: number) => buttons().find((b) => new RegExp(`^Stand ${n}(,|$)`).test(b.getAttribute('aria-label') ?? ''))!;

  it('renders all 30 as direct children of ONE container, in one row (no wrap, no grid)', () => {
    expect(buttons()).toHaveLength(30);
    const container = buttons()[0]!.parentElement!;
    expect(new Set(buttons().map((b) => b.parentElement)).size).toBe(1);
    const t = tokens(container);
    expect(t).toContain('flex');
    for (const bad of ['flex-wrap', 'flex-wrap-reverse', 'flex-col', 'grid']) expect(t, bad).not.toContain(bad);
    expect(new Set(buttons().map((b) => b.offsetTop)).size).toBe(1);
  });
  it('slides and snaps: overflow-x-auto, snap-x snap-mandatory on the row; snap-start and 48 px targets on every stand', () => {
    const container = buttons()[0]!.parentElement!;
    const t = tokens(container);
    expect(t.includes('overflow-x-auto') || container.style.overflowX === 'auto').toBe(true);
    expect((t.includes('snap-x') && t.includes('snap-mandatory')) || /x\s+mandatory/.test(container.style.getPropertyValue('scroll-snap-type'))).toBe(true);
    for (const b of buttons()) {
      expect(tokens(b).includes('snap-start') || b.style.getPropertyValue('scroll-snap-align') === 'start', b.getAttribute('aria-label')!).toBe(true);
      expect(tokens(b).some((c) => /^min-h-(12|14|16|20|24)$/.test(c)), `${b.getAttribute('aria-label')} height`).toBe(true);
      expect(tokens(b).some((c) => /^min-w-(12|14|16|20|24)$/.test(c)), `${b.getAttribute('aria-label')} width`).toBe(true);
    }
  });
  it('choosing stand 27 reports THAT table and scrolls that button into view with inline: nearest', async () => {
    await click(stand(27));
    expect(picked).toEqual([TABLES[26]!.sessionId]);
    const at = spy.mock.contexts.findIndex((c) => c === stand(27));
    expect(at, 'scrollIntoView was called on the stand 27 button').toBeGreaterThan(-1);
    expect(spy.mock.calls[at]![0]).toMatchObject({ inline: 'nearest' });
  });
  it('arrow keys move along the row and stop at both ends', async () => {
    await click(stand(3));
    await key(stand(3), 'ArrowRight');
    expect(picked.at(-1)).toBe(TABLES[3]!.sessionId); // stand 4
    await click(stand(30));
    const before = picked.length;
    await key(stand(30), 'ArrowRight');
    expect(picked.slice(before).every((s) => s === TABLES[29]!.sessionId)).toBe(true);
    await click(stand(1));
    const before2 = picked.length;
    await key(stand(1), 'ArrowLeft');
    expect(picked.slice(before2).every((s) => s === TABLES[0]!.sessionId)).toBe(true);
  });
  it('the chosen stand shows aria-pressed="true" (selection comes from the prop)', async () => {
    const { RefillStandRow } = await load('_refills/RefillStandRow');
    await render(createElement(RefillStandRow, { tables: TABLES, selectedSessionId: TABLES[11]!.sessionId, onSelect: () => undefined }));
    expect(buttons().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent)).toEqual(['12']);
  });
});
