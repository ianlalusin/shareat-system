// @vitest-environment happy-dom
/**
 * T-643 - flavours chosen at seating (v1), which then lead the refill flavour pills. docs/tasks/643-seating-flavours.md.
 * No schema change: a "Flavours" option group (multi, min 1, max 3, 0.00) on a package variant makes the seat dialog demand 1 to 3, and the refill screen sorts
 * its pills by the table's flavours (a sort, never a limit, never a pre-selection). Each test names its MUTANT, the change that must turn it red.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreMenuV2 } from '@shareat/domain';
import { id, IT, MENU, STORE, VAR } from './helpers/t529-fixtures';

const ACT = vi.hoisted(() => ({ requestRefill: vi.fn(), confirmHeads: vi.fn() }));
vi.mock('../src/app/pos/kitchen/actions', () => ({ serveLineAction: vi.fn(), serveAllAction: vi.fn() }));
vi.mock('../src/app/pos/refills/actions', () => ({ requestRefillAction: (...a: unknown[]) => ACT.requestRefill(...a), confirmHeadsAction: (...a: unknown[]) => ACT.confirmHeads(...a) }));

import { MenuPicker } from '../src/app/pos/_orders/MenuPicker';
import { groupHint, isOptionChoiceValid, needsChoiceSheet, pickerCatalog } from '../src/app/pos/_orders/menu-filter';
import type { CartLine } from '../src/app/pos/_orders/payloads';
import { Refills } from '../src/app/pos/_refills/Refills';
import { flavoursLedBy } from '../src/app/pos/_refills/meats';
import { refillTables } from '../src/app/pos/_refills/tables';
import { PosContext, type PosContextValue } from '../src/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const delta = { store: { orderable: true as const, priceDelta: '0.00' }, online: { orderable: false as const, notOffered: 'no_offer' as const } };
const group = (gid: number, name: string, mode: 'single' | 'multi', min: number, max: number, names: string[], v0: number) => ({
  id: id(gid), name, selectionMode: mode, minSelections: min, maxSelections: max,
  values: names.map((n, i) => ({ id: id(v0 + i), name: n, sortOrder: i + 1, channels: delta })),
});
const SEAT = [id(7101), id(7102), id(7103), id(7104)];
const seatGroup = group(7100, 'Flavours', 'multi', 1, 3, ['Spicy', 'Garlic', 'Sweet', 'Plain'], 7101);
/** The Unli Grill package asks 1 to 3 flavours; the Pork belly refill (needs one) lists Sweet, Spicy, Garlic IN THAT ORDER, so a sort is visible. */
const MENU643: StoreMenuV2 = {
  ...MENU,
  items: MENU.items.map((i) =>
    i.id === IT.unli
      ? { ...i, variants: i.variants.map((v) => ({ ...v, optionGroups: [seatGroup] })) }
      : i.id === IT.rePork
        ? { ...i, variants: i.variants.map((v) => ({ ...v, optionGroups: [group(7200, 'Flavour', 'single', 1, 1, ['Sweet', 'Spicy', 'Garlic'], 7201)] })) }
        : i,
  ),
};

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
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const by = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;

// ---------------------------------------------------------------------------------------------------------------------
// Test 1 - the seat dialog demands 1 to 3 (client side; the server side is packages/domain/tests/integration/t643-seat-flavours.test.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe('the choice sheet for a package with a Flavours group (min 1, max 3)', () => {
  let cart: CartLine[];
  const show = (c: CartLine[] = []) => act(async () => root.render(createElement(MenuPicker, { menu: MENU643, packageOpen: false, heads: 2, cart: c, onChange: (n: CartLine[]) => (cart = n) })));
  const tile = () => [...host.querySelectorAll('ul button')].find((b) => (b.textContent ?? '').includes('Unli Grill')) as HTMLButtonElement;
  const choice = (name: string) => [...host.querySelectorAll('fieldset button')].find((b) => b.textContent === name) as HTMLButtonElement;
  const add = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add to order') as HTMLButtonElement;

  // MUTANT: needsChoiceSheet ignores optionGroups (`variants.length > 1` only) -> the package adds with ONE tap, no sheet, no flavours.
  it('tapping the package OPENS the sheet at once; nothing is added until flavours are picked', async () => {
    cart = [];
    await show();
    const item = pickerCatalog(MENU643, { packageOpen: false }).flatMap((c) => c.items).find((i) => i.id === IT.unli)!;
    expect(needsChoiceSheet(item)).toBe(true);
    await click(tile());
    expect(host.querySelector('section[aria-label="Choose Unli Grill"]')).not.toBeNull();
    expect(cart).toEqual([]);
  });

  // MUTANT: groupHint returns the bare '(choose)' for a multi group.
  it('the legend says how many: "Flavours (choose 1 to 3)", never a bare "(choose)"', async () => {
    await show();
    await click(tile());
    const legend = host.querySelector('fieldset legend')!.textContent;
    expect(legend).toBe('Flavours (choose 1 to 3)');
    expect(legend).not.toMatch(/\(choose\)/);
  });

  // MUTANT: isOptionChoiceValid drops `n >= group.minSelections` (0 flavours would be allowed) or `n <= group.maxSelections`; or the multi toggle's `more` disable is removed (a 4th can be picked and Add is still refused only by the max check).
  it('0 flavours: Add is refused; 1, 2 and 3 are accepted; a 4th cannot be picked', async () => {
    cart = [];
    await show();
    await click(tile());
    expect(add().disabled).toBe(true);
    await click(choice('Spicy'));
    expect(add().disabled).toBe(false);
    await click(choice('Garlic'));
    await click(choice('Sweet'));
    expect(add().disabled).toBe(false);
    expect(choice('Plain').disabled).toBe(true); // the 4th
    expect(isOptionChoiceValid(seatGroup as never, SEAT)).toBe(false); // the screen's own rule: 4 is invalid
    expect(isOptionChoiceValid(seatGroup as never, [])).toBe(false);
    expect(isOptionChoiceValid(seatGroup as never, SEAT.slice(0, 3))).toBe(true);
    await click(choice('Sweet')); // back to 2
    expect(add().disabled).toBe(false);
    await click(choice('Spicy'));
    await click(choice('Garlic')); // back to 0
    expect(add().disabled).toBe(true);
  });

  // MUTANT: onAdd drops `optionValueIds` from the cart line (the flavours would never reach the event / `option_value_ids`).
  it('the chosen flavours travel on the cart line as optionValueIds', async () => {
    cart = [];
    await show();
    await click(tile());
    await click(choice('Garlic'));
    await click(choice('Spicy'));
    await click(add());
    expect(cart).toHaveLength(1);
    expect(cart[0]!.optionValueIds).toEqual([id(7102), id(7101)]); // Garlic, Spicy: the order tapped
  });

  // MUTANT: groupHint's `min === max` branch is removed, or a min-0 multi group loses "up to".
  it('groupHint wording', () => {
    const g = (mode: 'single' | 'multi', min: number, max: number) => ({ selectionMode: mode, minSelections: min, maxSelections: max }) as never;
    expect(groupHint(g('multi', 1, 3))).toBe('(choose 1 to 3)');
    expect(groupHint(g('multi', 2, 2))).toBe('(choose 2)');
    expect(groupHint(g('multi', 0, 2))).toBe('(optional, up to 2)');
    expect(groupHint(g('single', 1, 1))).toBe('(choose)');
    expect(groupHint(g('single', 0, 1))).toBe('(optional)');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Test 2 (client half) - the refill table carries seatFlavours; empty when the package has none
// ---------------------------------------------------------------------------------------------------------------------
describe('refillTables carries seatFlavours', () => {
  // MUTANT: refillTables stops copying `seatFlavours` (always []), or drops the `?? []` (undefined for an old snapshot).
  it('copies the list from the server row; an older snapshot without it, or a package with no group, gives []', () => {
    const rows = [
      { sessionId: id(1), standNumber: 3, mode: 'dine_in', packageVariantId: VAR.unli, seatFlavours: ['Spicy', 'Garlic'] },
      { sessionId: id(2), standNumber: 4, mode: 'dine_in', packageVariantId: VAR.premium, seatFlavours: [] },
      { sessionId: id(3), standNumber: 5, mode: 'dine_in', packageVariantId: VAR.premium },
    ];
    expect(refillTables(rows).map((t) => t.seatFlavours)).toEqual([['Spicy', 'Garlic'], [], []]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Test 3 - the pill sort
// ---------------------------------------------------------------------------------------------------------------------
describe('flavoursLedBy (v1 sorts, never limits)', () => {
  const f = (...names: string[]) => names.map((name) => ({ name }));
  // MUTANT: return the tagged list unsorted (the matches stay where the menu put them).
  it('matching names come first; the rest keep their order', () => {
    expect(flavoursLedBy(f('Sweet', 'Spicy', 'Garlic', 'Plain'), ['Garlic']).map((x) => x.flavour.name)).toEqual(['Garlic', 'Sweet', 'Spicy', 'Plain']);
  });
  // MUTANT: compare without trim().toLowerCase().
  it('matching ignores case and spaces', () => {
    const out = flavoursLedBy(f('Sweet', 'Spicy', 'Garlic'), ['  GARLIC ', 'spicy']);
    expect(out.map((x) => [x.flavour.name, x.seat])).toEqual([['Spicy', true], ['Garlic', true], ['Sweet', false]]);
  });
  // MUTANT: the sort becomes a filter (non-matching pills dropped).
  it('no pill is removed, and with no seating flavours the order is unchanged', () => {
    expect(flavoursLedBy(f('Sweet', 'Spicy', 'Garlic'), []).map((x) => x.flavour.name)).toEqual(['Sweet', 'Spicy', 'Garlic']);
    expect(flavoursLedBy(f('Sweet', 'Spicy'), ['Nothing like it'])).toHaveLength(2);
  });
});

describe('the Refills screen for a table with seating flavours', () => {
  const ctx = (seat: string[]): PosContextValue => ({
    storeId: STORE, paired: false, personId: id(1), offlineActorPersonId: null, online: true, openStands: null, kitchenQueue: [], refillQueue: [],
    refillTables: [{ sessionId: id(8101), standNumber: 7, mode: 'dine_in', packageVariantId: VAR.unli, headsCashier: 2, headsServer: null, seatFlavours: seat }],
    held: new Set(['request_pos_refill']), stateVersion: 1, pendingEvents: [], ordersSnapshot: { stands: [], menu: MENU643 }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined,
  });
  const show = (seat: string[]) => act(async () => root.render(createElement(PosContext.Provider, { value: ctx(seat) }, createElement(Refills))));
  const pills = (meat: string) => [...host.querySelectorAll(`[role="group"][aria-label^="Flavour for ${meat}"] button`)] as HTMLButtonElement[];
  const sendBtn = () => [...host.querySelectorAll('button')].find((b) => /^Send refill/.test(b.textContent ?? '')) as HTMLButtonElement;

  // MUTANT: Refills renders `m.flavours` without flavoursLedBy; or the "Flavours:" line is removed.
  it('shows "Flavours: Spicy, Garlic" under the table, and the matching pills first with a text marker (not colour alone)', async () => {
    await show(['Spicy', 'garlic ']);
    await click(by('Stand 7'));
    expect(host.textContent).toContain('Flavours: Spicy, garlic');
    const p = pills('Pork belly');
    expect(p.map((b) => (b.textContent ?? '').replace(/\s*· Table's pick/, ''))).toEqual(['Spicy', 'Garlic', 'Sweet']);
    expect(p[0]!.textContent).toContain("Table's pick");
    expect(p[1]!.textContent).toContain("Table's pick");
    expect(p[2]!.textContent).not.toContain("Table's pick");
    expect(p[0]!.getAttribute('aria-label')).toBe("Flavour Spicy (table's pick), Pork belly");
  });

  // MUTANT: the sort pre-selects (aria-pressed true on a table's pick), or filters the non-matching pills out.
  it('never pre-selects and never removes a pill; Send is still blocked until the cashier picks one (the T-566 guard)', async () => {
    await show(['Spicy', 'Garlic']);
    await click(by('Stand 7'));
    const p = pills('Pork belly');
    expect(p).toHaveLength(3);
    expect(p.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    await click(by('More Pork belly'));
    expect(sendBtn().disabled).toBe(true); // flavour required, none chosen
    await click(by("Flavour Spicy (table's pick), Pork belly"));
    expect(sendBtn().disabled).toBe(false);
    await click(by("Flavour Spicy (table's pick), Pork belly"));
    expect(sendBtn().disabled).toBe(true);
    await click(by('Flavour Sweet, Pork belly')); // a pill that is NOT the table's pick is still allowed
    expect(sendBtn().disabled).toBe(false);
  });

  // MUTANT: the "Flavours:" line is shown unconditionally (empty "Flavours: ").
  it('a table with no seating flavours shows no line, no marker, and the menu order', async () => {
    await show([]);
    await click(by('Stand 7'));
    expect(host.textContent).not.toContain('Flavours:');
    expect(host.textContent).not.toContain("Table's pick");
    expect(pills('Pork belly').map((b) => b.textContent)).toEqual(['Sweet', 'Spicy', 'Garlic']);
  });
});
