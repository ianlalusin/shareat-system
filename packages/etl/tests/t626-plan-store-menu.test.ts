/**
 * T-626 (TESTER) - the pure plan: what POS v1 says one store sells, as what POS v2 should hold. No database, no Firestore. docs/tasks/626-lipa-pos-setup-from-v1.md.
 * The pairing rules are Ian's (bible rows 441-442): LT-/DT- copies are one package, one price twice is one all-day price, a disabled package is not loaded.
 */
import { describe, expect, it } from 'vitest';

import {
  defaultVariantLabel, EMPTY_REFILL_LIST_MEANS_ALL, pesoText, planGapRows, planStoreMenu, refillLinkStep, unpricedOrderable, type V1MenuSetup, type V1Package,
} from '../src/pos-v2/plan-store-menu';

const K = { id: 'k', name: 'Grill', sortOrder: 1, isActive: true, slaMinutes: null, printOnOutage: false };
const EMPTY: V1MenuSetup = { stations: [K], schedules: [], packages: [], refills: [], flavors: [], items: [], payModes: [], charges: [] };
const SCHEDULES = [
  { id: 'L', name: 'Lunch', isActive: true, isArchived: false, days: [], startTime: '8:00', endTime: '17:00' },
  { id: 'D', name: 'Dinner', isActive: true, isArchived: false, days: ['Monday', 'Tue'], startTime: '17:00', endTime: '08:00' },
];
const pkg = (id: string, name: string, price: number, o: Partial<V1Package> = {}): V1Package => ({
  id, name, isEnabled: true, pricePerHead: price, stationId: 'k', refillIds: [], sortOrder: 1, scheduleId: null, isBundle: false, bundlePrice: null, bundleMaxCap: null, bundleExtraHeadPrice: null, ...o,
});
const plan = (packages: V1Package[]) => planStoreMenu({ ...EMPTY, schedules: SCHEDULES, packages });
const refill = (id: string, name: string, o: Record<string, unknown> = {}) => ({ id, name, isEnabled: true, isOther: false, sortOrder: 1, stationId: 'k', globallyActive: true, requiresFlavor: false, allowedFlavorIds: [] as string[], ...o });

describe('hours', () => {
  it('reads v1 day names, pads the time, and treats no days as every day', () => {
    expect(plan([pkg('a', 'LT-Beef', 399, { scheduleId: 'L' }), pkg('b', 'DT-Beef', 449, { scheduleId: 'D' })]).dayparts).toEqual([
      { name: 'Lunch', days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00' },
      { name: 'Dinner', days: [1, 2], start: '17:00', end: '08:00' },
    ]);
  });
  it('a schedule with no usable times is skipped by name, and its package is priced all day', () => {
    const p = planStoreMenu({ ...EMPTY, schedules: [{ ...SCHEDULES[0]!, startTime: '' }], packages: [pkg('a', 'Solo', 100, { scheduleId: 'L' })] });
    expect(p.dayparts).toEqual([]);
    expect(p.packages[0]!.slots).toEqual([{ daypart: null, amount: '100.00', bundleHeads: null, extraHeadAmount: null }]);
    expect(p.skipped.join('|')).toMatch(/Hours Lunch \(no usable start and end time/);
    expect(p.skipped.join('|')).toMatch(/Package Solo: its hours are not loadable/);
  });
});

describe('packages', () => {
  it('LT- and DT_ copies at different prices are ONE package with a price per window', () => {
    const p = plan([pkg('a', 'LT-Pork and Beef', 399, { scheduleId: 'L' }), pkg('b', 'DT_Pork and Beef', 449, { scheduleId: 'D' })]);
    expect(p.packages.map((x) => x.name)).toEqual(['Pork and Beef']);
    expect(p.packages[0]!.slots.map((s) => [s.daypart, s.amount])).toEqual([['Lunch', '399.00'], ['Dinner', '449.00']]);
  });
  it('two copies at ONE price are one all-day price', () => {
    const p = plan([pkg('a', 'LT-Pork and Chicken', 298, { scheduleId: 'L' }), pkg('b', 'DT-Pork and Chicken', 298, { scheduleId: 'D' })]);
    expect(p.packages[0]!.slots).toEqual([{ daypart: null, amount: '298.00', bundleHeads: null, extraHeadAmount: null }]);
  });
  it('a lone gated copy keeps its window; a disabled package and a package with no price are left out by name', () => {
    const p = plan([pkg('a', 'Pork Premium', 258, { scheduleId: 'L' }), pkg('b', 'Valentine Promo', 499, { isEnabled: false }), pkg('c', 'Free Lunch', 0)]);
    expect(p.packages.map((x) => [x.name, x.slots[0]!.daypart])).toEqual([['Pork Premium', 'Lunch']]);
    expect(p.skipped).toEqual(['Package Valentine Promo (switched off in v1)', 'Package Free Lunch (no usable price in v1)', 'Hours Dinner (no package on sale is priced in them, so they are not set up)']);
  });
  it('copies at different prices that are not one window each are NOT guessed: skipped for a human to pair', () => {
    const p = plan([pkg('a', 'LT-Triple Feast', 599), pkg('b', 'DT-Triple Feast', 649)]);
    expect(p.packages).toEqual([]);
    expect(p.skipped[0]).toMatch(/Package Triple Feast \(its copies have different prices/);
  });
  it('a bundle carries its price, the guests it covers and the extra-guest price (0 when v1 has none)', () => {
    const p = plan([pkg('a', 'Barkada', 0, { pricePerHead: null, isBundle: true, bundlePrice: 1499, bundleMaxCap: 4 })]);
    expect(p.packages[0]!.slots).toEqual([{ daypart: null, amount: '1499.00', bundleHeads: 4, extraHeadAmount: '0.00' }]);
  });
  it('empty refillsAllowed means every enabled refill; a list means exactly those', () => {
    const refills = [refill('r1', 'Pork'), refill('r2', 'Rice'), refill('r3', 'Gone', { globallyActive: false })];
    const p = planStoreMenu({ ...EMPTY, refills, packages: [pkg('a', 'All', 100), pkg('b', 'Some', 100, { refillIds: ['r2', 'r3'] })] });
    expect(p.packages.map((x) => [x.name, x.refillNames])).toEqual([['All', ['Pork', 'Rice']], ['Some', ['Rice']]]);
  });
});

describe('flavours', () => {
  it('a refill that needs a flavour gets the shared group, or its own group when v1 limits it to some flavours; a switched-off flavour stays but is not on', () => {
    const flavors = [
      { id: 'f1', name: 'Garlic', isEnabled: true, sortOrder: 1, globallyActive: true },
      { id: 'f2', name: 'Spicy', isEnabled: false, sortOrder: 2, globallyActive: true },
      { id: 'f3', name: 'Retired', isEnabled: true, sortOrder: 3, globallyActive: false },
    ];
    const p = planStoreMenu({ ...EMPTY, flavors, refills: [refill('a', 'Pork', { requiresFlavor: true }), refill('b', 'Beef', { requiresFlavor: true, allowedFlavorIds: ['f2'] })] });
    expect(p.refills[0]!.flavour).toEqual({ group: 'Flavour', values: [{ name: 'Garlic', onAtStore: true }, { name: 'Spicy', onAtStore: false }] });
    expect(p.refills[1]!.flavour).toEqual({ group: 'Flavour - Beef', values: [{ name: 'Spicy', onAtStore: false }] });
  });
});

describe('a la carte, payment methods, money', () => {
  it('only add-ons are on the menu; a grouped item is one item with variants; the category is the v1 sub-category', () => {
    const item = (name: string, o: Record<string, unknown> = {}) => ({ name, groupName: null, variantLabel: null, kind: 'single', subCategory: 'Drinks', sellingPrice: 50, isActive: true, isArchived: false, isAddon: true, stationId: null, customerEnabled: false, hasModifiers: false, ...o });
    const p = planStoreMenu({ ...EMPTY, items: [item('Charcoal', { isAddon: false }), item('Tea S', { kind: 'variant', groupName: 'Tea', variantLabel: 'S' }), item('Tea L', { kind: 'variant', groupName: 'Tea', variantLabel: 'L', sellingPrice: 80, customerEnabled: true }), item('Pie', { subCategory: null })] });
    expect(p.items.map((i) => [i.name, i.category, i.variants.map((v) => `${v.label}:${v.amount}`), i.dinerOrderable])).toEqual([
      ['Tea', 'Drinks', ['S:50.00', 'L:80.00'], true],
      ['Pie', 'Add-ons', ['null:50.00'], false],
    ]);
  });
  it('cash is cash, everything else is a wallet, keyed by its v1 name; archived ones are left out', () => {
    const p = planStoreMenu({ ...EMPTY, payModes: [
      { name: 'Cash', type: 'cash', isActive: true, isArchived: false }, { name: 'QRPH', type: 'online', isActive: true, isArchived: false }, { name: 'Old', type: 'other', isActive: true, isArchived: true },
    ] });
    expect(p.tenders).toEqual([{ name: 'Cash', kind: 'cash', alias: 'Cash' }, { name: 'QRPH', kind: 'wallet', alias: 'QRPH' }]);
  });
  it('pesoText keeps whole centavos and refuses fractions of a centavo, negatives and junk', () => {
    expect([pesoText(298), pesoText(1499.5), pesoText(0.07), pesoText(10.005), pesoText(-1), pesoText(Number.NaN), pesoText(null)]).toEqual(['298.00', '1499.50', '0.07', null, null, null, null]);
  });
});

// ---- T-626 audit fixes (BOSS rulings 1-7). Each describe names the mutant it was proven against. -----------------------------------------
const item = (name: string, o: Record<string, unknown> = {}) => ({ name, groupName: null, variantLabel: null, kind: 'single', subCategory: 'Drinks', sellingPrice: 50, isActive: true, isArchived: false, isAddon: true, stationId: 'k', customerEnabled: false, hasModifiers: false, ...o });

describe('ruling 1: what v1 sells and the plan cannot carry is a GAP (mutant: gap() only writes skipped)', () => {
  it('unpairable and unpriced packages, an unpriced item and hours a package needs are gaps; switched-off things are not', () => {
    const p = planStoreMenu({
      ...EMPTY,
      schedules: [{ ...SCHEDULES[0]!, startTime: '' }],
      packages: [pkg('a', 'LT-Feast', 599), pkg('b', 'DT-Feast', 649), pkg('c', 'Free', 0), pkg('d', 'Off', 100, { isEnabled: false }), pkg('e', 'Solo', 200, { scheduleId: 'L' })],
      items: [item('Gift', { sellingPrice: null }), item('Old', { isActive: false })],
    });
    expect(p.gaps).toEqual([
      'Package Free (no usable price in v1)',
      'Hours Lunch (no usable start and end time in v1, where it meant all day)',
      'Package Solo: its hours are not loadable, so it is priced all day (v1 did the same)',
      'Package Feast (its copies have different prices but not one window each: pair them by hand)',
      'Item Gift (no usable price in v1)',
    ]);
    for (const g of p.gaps) expect(p.skipped).toContain(g);
    expect(p.skipped).toContain('Package Off (switched off in v1)');
    expect(p.gaps.join('|')).not.toMatch(/Off|Old/);
  });
  it('the check turns every gap into a failing row', () => {
    expect(planGapRows({ gaps: ['Item Gift (no usable price in v1)'] })).toEqual([
      { kind: 'Not loadable from v1', name: 'Item Gift (no usable price in v1)', ok: false, detail: 'v1 sells it; POS v2 will not until it is fixed' },
    ]);
  });
});

describe('ruling 2: only hours some package is priced in are set up (mutant: every active schedule becomes a daypart)', () => {
  it('Lunch and Dinner used by a package, Breakfast used by none: Breakfast is left out by name', () => {
    const schedules = [...SCHEDULES, { id: 'B', name: 'Breakfast', isActive: true, isArchived: false, days: [], startTime: '06:00', endTime: '08:00' }];
    const p = planStoreMenu({ ...EMPTY, schedules, packages: [pkg('a', 'LT-Beef', 399, { scheduleId: 'L' }), pkg('b', 'DT-Beef', 449, { scheduleId: 'D' })] });
    expect(p.dayparts.map((d) => d.name)).toEqual(['Lunch', 'Dinner']);
    expect(p.skipped).toContain('Hours Breakfast (no package on sale is priced in them, so they are not set up)');
    expect(p.gaps).toEqual([]);
  });
  it('two copies at one price collapse to all day, so their hours are not set up either', () => {
    expect(plan([pkg('a', 'LT-Chicken', 298, { scheduleId: 'L' }), pkg('b', 'DT-Chicken', 298, { scheduleId: 'D' })]).dayparts).toEqual([]);
  });
});

describe('ruling 3: no unpriced default left orderable on a grouped item', () => {
  const GLASS_PITCHER = [{ label: 'Glass' }, { label: 'Pitcher' }];
  const fresh = [{ label: null, isDefault: true, active: true, priced: false }];
  it('a fresh grouped item names its default after the first label (mutant: always null -> red)', () => {
    expect(defaultVariantLabel(GLASS_PITCHER, fresh)).toBe('Glass');
  });
  it('never touches a priced default, an already-labelled default, a single item, or a label some variant already has', () => {
    expect(defaultVariantLabel(GLASS_PITCHER, [{ ...fresh[0]!, priced: true }])).toBeNull();
    expect(defaultVariantLabel(GLASS_PITCHER, [{ ...fresh[0]!, label: 'Glass' }])).toBeNull();
    expect(defaultVariantLabel([{ label: null }], fresh)).toBeNull();
    expect(defaultVariantLabel(GLASS_PITCHER, [...fresh, { label: 'glass', isDefault: false, active: true, priced: true }])).toBeNull();
  });
  it('the check names a variant on sale with no price, and only that one (mutant: amount check dropped -> red)', () => {
    const v = (label: string | null, store: { orderable: boolean; amount?: string | null }) => ({ label, channels: { store } });
    expect(unpricedOrderable([v(null, { orderable: true, amount: null }), v('Glass', { orderable: true, amount: '50.00' }), v('Old', { orderable: false })])).toEqual(['default']);
  });
});

describe('ruling 4: refill links are added only to a package with none (mutant: add the missing ones to an existing list -> red)', () => {
  it('none here: add all; same: nothing; an own list here: the v1 extras are a difference, never added', () => {
    expect(refillLinkStep([], ['pork', 'rice'])).toEqual({ kind: 'add', ids: ['pork', 'rice'] });
    expect(refillLinkStep(['rice', 'pork'], ['pork', 'rice'])).toEqual({ kind: 'same' });
    expect(refillLinkStep(['pork'], ['pork', 'rice'])).toEqual({ kind: 'differ', missing: ['rice'] });
  });
});

describe('ruling 5: a sold thing with no v1 kitchen station is a named GAP (mutant: stationFor stays silent -> red)', () => {
  it('unset and switched-off stations, for a package, a refill and an item; a later copy with a station is enough', () => {
    const off = { id: 'x', name: 'Old Bar', sortOrder: 2, isActive: false, slaMinutes: null, printOnOutage: false };
    const p = planStoreMenu({
      ...EMPTY,
      stations: [K, off],
      packages: [pkg('a', 'Nowhere', 100, { stationId: null }), pkg('b', 'LT-Split', 100, { stationId: null }), pkg('c', 'DT-Split', 100)],
      refills: [refill('r', 'Rice', { stationId: 'x' })],
      items: [item('Tea', { stationId: null })],
    });
    expect(p.gaps).toEqual([
      'Refill Rice: no kitchen station in v1 (its station Old Bar is switched off), so it has no route',
      'Package Nowhere: no kitchen station in v1 (none set), so it has no route',
      'Item Tea: no kitchen station in v1 (none set), so it has no route',
    ]);
    expect(p.packages.find((x) => x.name === 'Split')!.stationName).toBe('Grill');
  });
});

describe('ruling 6: a package on hours that are off in v1 is not on sale (mutant: priced all day -> red)', () => {
  it('is left out as a NOTE, not a gap, and not priced all day', () => {
    const p = planStoreMenu({ ...EMPTY, schedules: [{ ...SCHEDULES[0]!, isActive: false }], packages: [pkg('a', 'Night Promo', 499, { scheduleId: 'L' })] });
    expect(p.packages).toEqual([]);
    expect(p.notes).toEqual(['Package Night Promo: not on sale in v1 (its hours are off)']);
    expect(p.gaps).toEqual([]);
  });
});

describe('ruling 7: an empty v1 refill list follows v1 and is listed as a NOTE (mutant: empty means none -> red)', () => {
  it('the package gets every enabled refill and a note names it; a listed package gets no note', () => {
    expect(EMPTY_REFILL_LIST_MEANS_ALL).toBe(true);
    const p = planStoreMenu({ ...EMPTY, refills: [refill('r1', 'Pork'), refill('r2', 'Rice')], packages: [pkg('a', 'All', 100), pkg('b', 'Some', 100, { refillIds: ['r2'] })] });
    expect(p.packages.find((x) => x.name === 'All')!.refillNames).toEqual(['Pork', 'Rice']);
    expect(p.notes).toEqual(["Package All: v1 lists no refills for it, so it gets every enabled refill (as v1's cashier screen)"]);
  });
});
