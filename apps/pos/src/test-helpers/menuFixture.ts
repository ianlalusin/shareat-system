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
