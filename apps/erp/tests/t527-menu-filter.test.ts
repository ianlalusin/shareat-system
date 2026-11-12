/**
 * T-527 (TESTER) - R4: what the menu picker shows. docs/tasks/527-pos-orders-screen.md.
 *
 * ASSUMED API (the builder matches these or says why not) - all in apps/erp/src/app/pos/_orders/menu-filter.ts:
 *   pickerCatalog(menu: StoreMenuV2, ctx: { packageOpen: boolean }): { id: string; name: string; items: PickerItem[] }[]
 *     categories by sortOrder, items by sortOrder; a category with nothing to show may be left out (not asserted).
 *     PickerItem = { id, name, itemType: 'package' | 'a_la_carte', orderable: boolean, label: string | null, variants: ProjectedVariant[] }
 *       shown: itemType package or a_la_carte (NEVER refill), AND soldALaCarte (or soldInPackageSession while `packageOpen`), AND a store offer exists:
 *              orderable, or withdrawn (sold out), or outside_hours. An item that is simply not offered here (no_offer) is not shown.
 *       orderable = some variant has channels.store.orderable.
 *       label = 'Sold out' when not orderable (any reason), or `From HH:MM` when the reason is outside_hours WITH availableFrom (row 307); null when orderable.
 *   displayUnitPrice(variant: ProjectedVariant, optionValueIds: string[]): string     "Money" decimal string: store amount + the chosen options' store priceDelta
 *   needsChoiceSheet(item: PickerItem): boolean     true when it has more than one variant or its variant has option groups; false = one tap adds 1
 *   isOptionChoiceValid(group: ProjectedOptionGroup, chosenValueIds: string[]): boolean     obeys minSelections and maxSelections (single = radio, multi = toggles)
 *
 * RED NOW FOR THE RIGHT REASON: the module does not exist (lazy import: "MISSING MODULE ... not built").
 */
import { describe, expect, it } from 'vitest';
import { IDS, MENU } from './helpers/t527-menu';

const MOD = '../src/app/pos/_orders/menu-filter';
// biome-ignore lint/suspicious/noExplicitAny: the module under test does not exist yet; its types are the builder's
async function load(): Promise<any> {
  try {
    return await import(/* @vite-ignore */ MOD);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_orders/menu-filter.ts cannot be loaded (T-527 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

type Cat = { id: string; name: string; items: { id: string; name: string; orderable: boolean; label: string | null; itemType: string }[] };
const flat = (cats: Cat[]) => cats.flatMap((c) => c.items.map((i) => i.id));
const find = (cats: Cat[], itemId: string) => cats.flatMap((c) => c.items).find((i) => i.id === itemId);
const porkVariant = () => MENU.items.find((i) => i.id === IDS.pork)!.variants[0]!;
const itemOf = (cats: Cat[], itemId: string) => find(cats, itemId)!;

describe('pickerCatalog - what is listed', () => {
  it('refill items are never shown, with or without a package open, even when they say soldALaCarte', async () => {
    const { pickerCatalog } = await load();
    expect(MENU.items.find((i) => i.id === IDS.rice)).toMatchObject({ itemType: 'refill', soldALaCarte: true });
    expect(flat(pickerCatalog(MENU, { packageOpen: false }))).not.toContain(IDS.rice);
    expect(flat(pickerCatalog(MENU, { packageOpen: true }))).not.toContain(IDS.rice);
  });

  it('with no package open: packages and a la carte items that are sold a la carte, and nothing else', async () => {
    const { pickerCatalog } = await load();
    const ids = flat(pickerCatalog(MENU, { packageOpen: false }));
    expect([...ids].sort()).toEqual([IDS.unli, IDS.pork, IDS.cola, IDS.samgyup, IDS.soda, IDS.plain, IDS.addOns].sort());
    expect(ids).not.toContain(IDS.extraRice); // soldInPackageSession only
    expect(ids).not.toContain(IDS.dessert); // sold nowhere in the picker
    expect(ids).not.toContain(IDS.notHere); // not offered in this store at all
  });

  it('soldInPackageSession items appear only while a package session is open', async () => {
    const { pickerCatalog } = await load();
    expect(flat(pickerCatalog(MENU, { packageOpen: false }))).not.toContain(IDS.extraRice);
    const open = pickerCatalog(MENU, { packageOpen: true });
    expect(flat(open)).toContain(IDS.extraRice);
    expect(flat(open)).not.toContain(IDS.dessert); // neither flag: still hidden
    expect(itemOf(open, IDS.extraRice)).toMatchObject({ name: 'Extra rice', orderable: true, label: null });
  });

  it('categories run in sortOrder and items in sortOrder inside each; names are the menu\'s own', async () => {
    const { pickerCatalog } = await load();
    const cats: Cat[] = pickerCatalog(MENU, { packageOpen: true });
    expect(cats.filter((c) => c.items.length > 0).map((c) => c.name)).toEqual(['Packages', 'Grill', 'Drinks']);
    expect(cats.find((c) => c.name === 'Grill')!.items.map((i) => i.name)).toEqual(['Pork belly', 'Samgyup set', 'Extra rice', 'Plain rice', 'Add-on plate']);
    expect(cats.find((c) => c.name === 'Drinks')!.items.map((i) => i.name)).toEqual(['Cola', 'Soda']);
  });
});

describe('pickerCatalog - packages (audit: a package is not sold a la carte, and must still show)', () => {
  it('the fixture package is realistic: soldALaCarte is false', () => {
    expect(MENU.items.find((i) => i.id === IDS.unli)).toMatchObject({ itemType: 'package', soldALaCarte: false });
  });

  it('seating a dine-in party: the package shows, orderable, whatever its soldALaCarte', async () => {
    const { pickerCatalog } = await load();
    expect(itemOf(pickerCatalog(MENU, { packageOpen: false }), IDS.unli)).toMatchObject({ itemType: 'package', orderable: true, label: null });
    expect(itemOf(pickerCatalog(MENU, { packageOpen: false, takeOut: false }), IDS.unli)).toMatchObject({ orderable: true });
  });

  it('adding to a dine-in table (a package already open, or none yet): the package shows', async () => {
    const { pickerCatalog } = await load();
    expect(flat(pickerCatalog(MENU, { packageOpen: true, takeOut: false }))).toContain(IDS.unli);
    expect(flat(pickerCatalog(MENU, { packageOpen: false, takeOut: false }))).toContain(IDS.unli);
  });

  it('take-out never shows a package, open package or not; a la carte items are untouched', async () => {
    const { pickerCatalog } = await load();
    for (const packageOpen of [false, true]) {
      const ids = flat(pickerCatalog(MENU, { packageOpen, takeOut: true }));
      expect(ids, `packageOpen=${packageOpen}`).not.toContain(IDS.unli);
      expect(ids).toContain(IDS.pork);
    }
  });

  it('a sold-out package still shows greyed on a dine-in table, and an unsellable one stays hidden', async () => {
    const { pickerCatalog } = await load();
    const menu = structuredClone(MENU);
    const unli = menu.items.find((i) => i.id === IDS.unli)!;
    unli.variants[0]!.channels.store = { orderable: false, notOffered: 'withdrawn' };
    expect(itemOf(pickerCatalog(menu, { packageOpen: false }), IDS.unli)).toMatchObject({ orderable: false, label: 'Sold out' });
    unli.variants[0]!.channels.store = { orderable: false, notOffered: 'no_basis' };
    expect(flat(pickerCatalog(menu, { packageOpen: false }))).not.toContain(IDS.unli);
  });
});

describe('pickerCatalog - greyed items and their words (row 307)', () => {
  it('a withdrawn offer is shown, cannot be ordered, and says "Sold out"', async () => {
    const { pickerCatalog } = await load();
    expect(itemOf(pickerCatalog(MENU, { packageOpen: false }), IDS.cola)).toMatchObject({ name: 'Cola', orderable: false, label: 'Sold out' });
  });

  it('outside hours with a known opening time says "From 17:00"; an orderable item has no label', async () => {
    const { pickerCatalog } = await load();
    const cats = pickerCatalog(MENU, { packageOpen: false });
    expect(itemOf(cats, IDS.samgyup)).toMatchObject({ orderable: false, label: 'From 17:00' });
    expect(itemOf(cats, IDS.pork)).toMatchObject({ orderable: true, label: null });
    expect(itemOf(cats, IDS.unli)).toMatchObject({ itemType: 'package', orderable: true, label: null });
  });

  it('outside hours with NO opening time falls back to "Sold out"', async () => {
    const { pickerCatalog } = await load();
    const menu = structuredClone(MENU);
    const samgyup = menu.items.find((i) => i.id === IDS.samgyup)!;
    samgyup.variants[0]!.channels.store = { orderable: false, notOffered: 'outside_hours', availableFrom: null };
    expect(itemOf(pickerCatalog(menu, { packageOpen: false }), IDS.samgyup)).toMatchObject({ orderable: false, label: 'Sold out' });
  });

  it('an item that is not sellable now (no price basis, or a rule that would price it below zero) is HIDDEN, not greyed: that is different from sold out (planner ruling 2)', async () => {
    const { pickerCatalog } = await load();
    for (const notOffered of ['no_basis', 'rule_below_zero', 'no_offer'] as const) {
      const menu = structuredClone(MENU);
      menu.items.find((i) => i.id === IDS.cola)!.variants[0]!.channels.store = { orderable: false, notOffered };
      expect(flat(pickerCatalog(menu, { packageOpen: false })), notOffered).not.toContain(IDS.cola);
    }
    // control: the same item withdrawn (sold out) is shown greyed
    expect(flat(pickerCatalog(MENU, { packageOpen: false }))).toContain(IDS.cola);
  });

  it('an item with one orderable variant and one withdrawn variant is orderable (the sold-out size is not the item)', async () => {
    const { pickerCatalog } = await load();
    const menu = structuredClone(MENU);
    menu.items.find((i) => i.id === IDS.soda)!.variants[1]!.channels.store = { orderable: false, notOffered: 'withdrawn' };
    expect(itemOf(pickerCatalog(menu, { packageOpen: false }), IDS.soda)).toMatchObject({ orderable: true, label: null });
  });
});

describe('the display price, the choice sheet and the option limits', () => {
  it('the unit price shown is the store amount plus the chosen options\' deltas (display only; the server prices it)', async () => {
    const { displayUnitPrice } = await load();
    expect(displayUnitPrice(porkVariant(), [])).toBe('250.00');
    expect(displayUnitPrice(porkVariant(), [IDS.spicy])).toBe('260.00');
    expect(displayUnitPrice(porkVariant(), [IDS.garlic])).toBe('250.00');
    const addOns = MENU.items.find((i) => i.id === IDS.addOns)!.variants[0]!;
    expect(displayUnitPrice(addOns, [IDS.addA, IDS.addB])).toBe('110.00');
  });

  it('one variant and no option groups adds with one tap; several variants or any option group opens the sheet', async () => {
    const { pickerCatalog, needsChoiceSheet } = await load();
    const cats = pickerCatalog(MENU, { packageOpen: false });
    expect(needsChoiceSheet(itemOf(cats, IDS.plain))).toBe(false);
    expect(needsChoiceSheet(itemOf(cats, IDS.unli))).toBe(false);
    expect(needsChoiceSheet(itemOf(cats, IDS.soda))).toBe(true); // Small / Large
    expect(needsChoiceSheet(itemOf(cats, IDS.pork))).toBe(true); // Sauce group
  });

  it('a single group needs exactly one value (min 1, max 1); a multi group allows none up to its maximum', async () => {
    const { isOptionChoiceValid } = await load();
    const sauce = porkVariant().optionGroups[0]!;
    expect(isOptionChoiceValid(sauce, [])).toBe(false);
    expect(isOptionChoiceValid(sauce, [IDS.spicy])).toBe(true);
    expect(isOptionChoiceValid(sauce, [IDS.spicy, IDS.garlic])).toBe(false);
    const extras = MENU.items.find((i) => i.id === IDS.addOns)!.variants[0]!.optionGroups[0]!;
    expect(isOptionChoiceValid(extras, [])).toBe(true);
    expect(isOptionChoiceValid(extras, [IDS.addA, IDS.addB])).toBe(true);
    expect(isOptionChoiceValid(extras, [IDS.addA, IDS.addB, IDS.addC])).toBe(false);
  });
});
