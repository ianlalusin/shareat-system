import type { ErpMenu as StoreMenuV2 } from '@/lib/menu/types';

const off = { orderable: true as const, amount: '100.00', bundleHeads: null, extraHeadAmount: null };
const noOnline = { orderable: false as const, notOffered: 'no_offer' as const };
const v = (id: string, amount: string | null, over: Record<string, unknown> = {}) => ({
  id, label: null, isDefault: true, sortOrder: 0, refillItemIds: [] as string[], optionGroups: [] as any[],
  channels: { store: amount === null ? noOnline : { ...off, amount }, online: noOnline }, ...over,
});
const item = (id: string, name: string, itemType: 'package' | 'refill' | 'a_la_carte', over: Record<string, unknown> = {}) => ({
  id, categoryId: 'c1', name, description: null, itemType, soldALaCarte: false, soldInPackageSession: false, dinerOrderable: false,
  sortOrder: 1, variants: [v(`${id}-v`, '100.00')], stationId: 'st-grill', ...over,
});

/** Flavours are option values (S0): no seed makes them, so this fixture builds its own group linked to a refill item. */
export const flavourGroup = {
  id: 'g1', name: 'Flavour', selectionMode: 'single' as const, minSelections: 1, maxSelections: 1,
  values: [
    { id: 'fv-original', name: 'Original', sortOrder: 1, channels: { store: { orderable: true as const, priceDelta: '0.00' }, online: { orderable: false as const, notOffered: 'no_offer' as const } } },
    { id: 'fv-spicy', name: 'Spicy', sortOrder: 2, channels: { store: { orderable: true as const, priceDelta: '0.00' }, online: { orderable: false as const, notOffered: 'no_offer' as const } } },
    { id: 'fv-hidden', name: 'Hidden', sortOrder: 3, channels: { store: { orderable: false as const, notOffered: 'no_offer' as const }, online: { orderable: false as const, notOffered: 'no_offer' as const } } },
  ],
};

export function sampleMenu(): StoreMenuV2 {
  return {
    schemaVersion: 2, storeId: 'erp-store-1',
    stations: [{ id: 'st-grill', name: 'Grill', slaMinutes: 12, printOnOutage: true }, { id: 'st-bar', name: 'Bar', slaMinutes: 5, printOnOutage: false }],
    categories: [{ id: 'c1', name: 'Mains', parentId: null, sortOrder: 1 }],
    items: [
      item('pk-a', 'Samgyup', 'package', { sortOrder: 1, variants: [v('pk-a-lt', '338.00', { label: 'Lunch', refillItemIds: ['rf-pork'] }), v('pk-a-dt', '358.00', { label: 'Dinner', isDefault: false, sortOrder: 1, refillItemIds: ['rf-pork'] })] }),
      item('pk-b', 'Bundle for 4', 'package', { sortOrder: 2, variants: [{ ...v('pk-b-v', '999.00'), channels: { store: { orderable: true, amount: '999.00', bundleHeads: 4, extraHeadAmount: '250.00' }, online: noOnline } }] }),
      item('pk-c', 'Online only package', 'package', { sortOrder: 3, variants: [v('pk-c-v', null)] }),
      item('rf-pork', 'Pork refill', 'refill', { stationId: 'st-grill', variants: [v('rf-pork-v', '0.00', { optionGroups: [flavourGroup] })] }),
      item('rf-rice', 'Rice refill', 'refill', { stationId: 'st-bar', sortOrder: 2 }),
      item('al-1', 'Soju', 'a_la_carte', { soldALaCarte: true, stationId: 'st-bar', variants: [v('al-1-v', '90.00')] }),
      item('al-2', 'Extra lettuce', 'a_la_carte', { soldInPackageSession: true, variants: [v('al-2-s', '20.00', { label: 'S' }), v('al-2-l', '30.00', { label: 'L', isDefault: false, sortOrder: 1 })] }),
    ],
    notOnPos: [{ itemId: 'x-unrouted', name: 'Unrouted thing', reason: 'no_station' }],
  } as StoreMenuV2;
}

// ---- T-510 S4b: a dayparted menu. `channels` says what the SERVER thought was live at its own clock; the device must price from the slots + ITS clock. ----
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DAYPART_HOURS = {
  timeZone: 'Asia/Manila',
  dayparts: [
    { id: 'D', days: ALL_DAYS, start: '17:00', end: '08:00' },
    { id: 'L', days: ALL_DAYS, start: '08:00', end: '17:00' },
    { id: 'X', days: ALL_DAYS, start: '10:00', end: '14:00' }, // overlaps L: two slots hold at noon (a data fault the device must not guess through)
  ],
};
const orderable = (amount: string | null, over: Record<string, unknown> = {}) => ({ orderable: true as const, amount, bundleHeads: null, extraHeadAmount: null, ...over });
const slot = (daypartId: string, store: ReturnType<typeof orderable> | typeof noOnline) => ({ daypartId, store, online: noOnline });
const closedNow = { orderable: false as const, notOffered: 'outside_hours' as const, availableFrom: '17:00' };

export function daypartedMenu(): StoreMenuV2 {
  const base = sampleMenu();
  const slotted = (id: string, name: string, itemType: 'package' | 'refill' | 'a_la_carte', slots: unknown[], store: unknown, over: Record<string, unknown> = {}, vover: Record<string, unknown> = {}) =>
    item(id, name, itemType, { variants: [{ ...v(`${id}-v`, '1.00', vover), channels: { store, online: noOnline }, slots }], ...over });
  return {
    ...base,
    hours: DAYPART_HOURS,
    items: [
      ...base.items,
      slotted('dp-pb', 'Pork and Beef', 'package', [slot('D', orderable('358.00')), slot('L', orderable('338.00'))], orderable('338.00'), { sortOrder: 10 }, { refillItemIds: ['dp-rf'] }),
      slotted('dp-lo', 'Lunch only', 'package', [slot('L', orderable('300.00', { bundleHeads: 4, extraHeadAmount: '60.00' }))], closedNow, { sortOrder: 11 }),
      slotted('dp-ov', 'Overlapping', 'package', [slot('L', orderable('100.00')), slot('X', orderable('999.00'))], orderable('100.00'), { sortOrder: 12 }),
      slotted('dp-rf', 'Pork refill (lunch)', 'refill', [slot('L', orderable('0.00'))], closedNow, { sortOrder: 13 }, { optionGroups: [flavourGroup] }),
      slotted('dp-al', 'House wine', 'a_la_carte', [slot('D', orderable('110.00')), slot('L', orderable('90.00'))], orderable('90.00'), { sortOrder: 14, soldALaCarte: true }),
    ],
  } as StoreMenuV2;
}
