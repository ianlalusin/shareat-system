// @vitest-environment happy-dom
/**
 * T-566 - a refill carries ONE flavour, like v1 (audit P-007). docs/tasks/566-refill-flavour.md section 3/4.
 *   The Refills tab lists each meat's flavours from the cached menu; picking one replaces the previous choice, tapping it again clears it; Send is blocked
 *   while a meat that needs a flavour has none; the payload carries `optionValueIds` (one id); the offline refill slip prints "<meat> + <flavour>".
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreMenuV2 } from '@shareat/domain';
import { fakeMeta, id, IT, MENU, STORE, ST, VAR } from './helpers/t529-fixtures';

const ACT = vi.hoisted(() => ({ requestRefill: vi.fn(), confirmHeads: vi.fn() }));
vi.mock('../src/app/pos/kitchen/actions', () => ({ serveLineAction: vi.fn(), serveAllAction: vi.fn() }));
vi.mock('../src/app/pos/refills/actions', () => ({ requestRefillAction: (...a: unknown[]) => ACT.requestRefill(...a), confirmHeadsAction: (...a: unknown[]) => ACT.confirmHeads(...a) }));

import { Refills } from '../src/app/pos/_refills/Refills';
import { refillEvent, refillRequestInput } from '../src/app/pos/_refills/payloads';
import { refillMeats } from '../src/app/pos/_refills/meats';
import { printOutageForEvent } from '../src/app/pos/_kitchen/outage-print';
import { PosContext, type PosContextValue } from '../src/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BULGOGI = id(8001), GARLIC = id(8002), GONE = id(8003);
const delta = (orderable: boolean) => (orderable ? ({ orderable: true, priceDelta: '0.00' } as const) : ({ orderable: false, notOffered: 'no_offer' } as const));
const flavours = (min: number) => [
  {
    id: id(8010), name: 'Flavour', selectionMode: 'single' as const, minSelections: min, maxSelections: 1,
    values: [
      { id: BULGOGI, name: 'Bulgogi', sortOrder: 1, channels: { store: delta(true), online: delta(false) } },
      { id: GARLIC, name: 'Garlic', sortOrder: 2, channels: { store: delta(true), online: delta(false) } },
      { id: GONE, name: 'Sold out sauce', sortOrder: 3, channels: { store: delta(false), online: delta(false) } },
    ],
  },
];
/** Pork belly refill needs a flavour (min 1); Beef brisket has an optional one (min 0); Chicken bulgogi has none. */
const withFlavours = (min: number): StoreMenuV2 => ({
  ...MENU,
  items: MENU.items.map((i) =>
    i.id === IT.rePork ? { ...i, variants: i.variants.map((v) => ({ ...v, optionGroups: flavours(min) })) } : i.id === IT.reBrisket ? { ...i, variants: i.variants.map((v) => ({ ...v, optionGroups: flavours(0) })) } : i,
  ),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  for (const f of Object.values(ACT)) f.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const ctx = (menu: StoreMenuV2): PosContextValue => ({
  storeId: STORE, paired: false, personId: id(1), offlineActorPersonId: null, online: true, openStands: null, kitchenQueue: [], refillQueue: [],
  refillTables: [{ sessionId: id(8101), standNumber: 7, mode: 'dine_in', packageVariantId: VAR.unli, headsCashier: 2, headsServer: null }],
  held: new Set(['request_pos_refill']), stateVersion: 1, pendingEvents: [], ordersSnapshot: { stands: [], menu }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined,
});
const show = (menu: StoreMenuV2) => act(async () => root.render(createElement(PosContext.Provider, { value: ctx(menu) }, createElement(Refills))));
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const by = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;
const sendBtn = () => [...host.querySelectorAll('button')].find((b) => /^Send refill/.test(b.textContent ?? '')) as HTMLButtonElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
const chip = (meat: string, flavour: string) => by(`Flavour ${flavour}, ${meat}`);

describe('the Refills tab shows each meat\'s flavours and keeps one choice', () => {
  it('lists the orderable flavours under the meat that has them; a meat with none shows no chips; a sold-out flavour is not offered', async () => {
    await show(withFlavours(1));
    await click(by('Stand 7'));
    expect(chip('Pork belly', 'Bulgogi')).not.toBeNull();
    expect(chip('Pork belly', 'Garlic')).not.toBeNull();
    expect(chip('Pork belly', 'Sold out sauce')).toBeNull();
    expect(chip('Beef brisket', 'Garlic')).not.toBeNull();
    expect(host.querySelectorAll('[aria-label$=", Chicken bulgogi"]')).toHaveLength(0);
  });

  it('picking a flavour replaces the previous one, and tapping the chosen one again clears it', async () => {
    await show(withFlavours(1));
    await click(by('Stand 7'));
    await click(chip('Pork belly', 'Bulgogi'));
    expect(chip('Pork belly', 'Bulgogi')!.getAttribute('aria-pressed')).toBe('true');
    await click(chip('Pork belly', 'Garlic'));
    expect(chip('Pork belly', 'Bulgogi')!.getAttribute('aria-pressed')).toBe('false');
    expect(chip('Pork belly', 'Garlic')!.getAttribute('aria-pressed')).toBe('true');
    await click(chip('Pork belly', 'Garlic'));
    expect(chip('Pork belly', 'Garlic')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('Send is blocked while a meat that needs a flavour has none; a meat with an optional flavour sends without one', async () => {
    await show(withFlavours(1));
    await click(by('Stand 7'));
    await click(by('More Pork belly'));
    expect(sendBtn().disabled).toBe(true);
    await click(chip('Pork belly', 'Bulgogi'));
    expect(sendBtn().disabled).toBe(false);
    await click(chip('Pork belly', 'Bulgogi')); // cleared again: blocked again
    expect(sendBtn().disabled).toBe(true);
    await click(by('Fewer Pork belly'));
    await click(by('More Beef brisket')); // optional flavour: nothing needed
    expect(sendBtn().disabled).toBe(false);
  });

  it('a required flavour on a meat with qty 0 does not block sending another meat', async () => {
    await show(withFlavours(1));
    await click(by('Stand 7'));
    await click(by('More Chicken bulgogi'));
    expect(sendBtn().disabled).toBe(false);
  });

  it('Send carries the chosen flavour as optionValueIds: [id] for that meat only', async () => {
    ACT.requestRefill.mockResolvedValue({ ok: true, wrote: true });
    await show(withFlavours(1));
    await click(by('Stand 7'));
    await click(by('More Pork belly'));
    await click(chip('Pork belly', 'Bulgogi'));
    await click(chip('Pork belly', 'Garlic'));
    await click(by('More Chicken bulgogi'));
    await click(sendBtn());
    await flush();
    const lines = (ACT.requestRefill.mock.calls[0]![0] as { lines: Record<string, unknown>[] }).lines;
    expect(lines.map((l) => [l.menuItemId, l.qty, l.optionValueIds])).toEqual([
      [IT.rePork, 1, [GARLIC]], // the package lists brisket, pork, bulgogi: cart order
      [IT.reBulgogi, 1, undefined],
    ]);
  });
});

describe('the payload builders', () => {
  const NOW = new Date('2026-11-07T12:00:00.000Z');
  const seq = (...xs: string[]) => () => xs.shift() ?? 'X';
  it('refillEvent and refillRequestInput carry optionValueIds only for a meat with a flavour', () => {
    const cart = [{ itemId: IT.rePork, qty: 2, optionValueId: GARLIC }, { itemId: IT.reBulgogi, qty: 1 }];
    const e = refillEvent({ personId: id(1), sessionId: id(2), cart, now: NOW, newId: seq('L1', 'L2') });
    expect((e.payload as { lines: unknown[] }).lines).toStrictEqual([
      { lineId: 'L1', menuItemId: IT.rePork, qty: 2, optionValueIds: [GARLIC], addedAtDevice: NOW.toISOString() },
      { lineId: 'L2', menuItemId: IT.reBulgogi, qty: 1, addedAtDevice: NOW.toISOString() },
    ]);
    expect(refillRequestInput({ sessionId: id(2), cart, newId: seq('L1', 'L2') }).lines).toStrictEqual([
      { lineId: 'L1', menuItemId: IT.rePork, qty: 2, optionValueIds: [GARLIC] },
      { lineId: 'L2', menuItemId: IT.reBulgogi, qty: 1 },
    ]);
  });
  it('refillMeats lists orderable flavours and says whether one is required', () => {
    const m = refillMeats(withFlavours(1), VAR.unli) as { itemId: string; flavours: { id: string; name: string }[]; flavourRequired: boolean }[];
    const pork = m.find((x) => x.itemId === IT.rePork)!;
    expect(pork.flavours.map((f) => f.name)).toEqual(['Bulgogi', 'Garlic']);
    expect(pork.flavourRequired).toBe(true);
    expect(m.find((x) => x.itemId === IT.reBrisket)!.flavourRequired).toBe(false);
    expect(m.find((x) => x.itemId === IT.reBulgogi)!.flavours).toEqual([]);
  });
});

describe('the offline refill slip prints the flavour', () => {
  it('"2 x Pork belly + Garlic" on the slip', async () => {
    const meta = fakeMeta();
    const printLines = vi.fn(async () => 'printed' as const);
    await printOutageForEvent(
      {
        online: false, menu: withFlavours(1), stands: [], terminalNo: 2, layout: { width: 80, font: 'normal' }, copies: 1, sentAtLocal: '19:59', tableLabels: { [id(8101)]: '7' },
        printLines, getMeta: meta.getMeta, setMeta: meta.setMeta,
      } as never,
      { kind: 'refill.requested', payload: { sessionId: id(8101), lines: [{ lineId: id(8201), menuItemId: IT.rePork, qty: 2, addedAtDevice: '2026-11-07T11:59:00.000Z', optionValueIds: [GARLIC] }] } },
    );
    expect(printLines).toHaveBeenCalledTimes(1);
    expect((printLines.mock.calls[0] as unknown as [string[]])[0].join('\n')).toContain('2 x Pork belly + Garlic');
    expect(ST.grill).toBeTruthy();
  });
});
