/**
 * T-651 - the POS picker and size buttons use the one menu order rule: tied sort orders fall to the name, the default size comes first,
 * option values follow the same rule. Plain data, no database (hand-built StoreMenuV2 from the T-527 helper).
 */
import { describe, expect, it } from 'vitest';
import type { StoreMenuV2 } from '@shareat/domain';
import { orderableVariants, pickerCatalog } from '../src/app/pos/_orders/menu-filter';
import { id } from './helpers/t527-menu';

type Item = StoreMenuV2['items'][number];
type Variant = Item['variants'][number];
const live = { orderable: true as const, amount: '100.00', bundleHeads: null, extraHeadAmount: null };
const off = { orderable: false as const, notOffered: 'no_offer' as const };
const variant = (n: number, label: string | null, sortOrder: number, isDefault: boolean): Variant => ({
  id: id(n), label, isDefault, sortOrder, channels: { store: live, online: off }, optionGroups: [], refillItemIds: [],
});
const item = (n: number, categoryId: string, name: string, sortOrder: number, variants: Variant[]): Item => ({
  id: id(n), categoryId, name, description: null, itemType: 'a_la_carte', soldALaCarte: true, soldInPackageSession: false, dinerOrderable: true, sortOrder, variants, stationId: null,
});

describe('T-651: POS picker order', () => {
  const cat = id(1);
  const menu = (items: Item[], cats = [{ id: cat, name: 'Grill', parentId: null, sortOrder: 0 }]): StoreMenuV2 => ({
    schemaVersion: 2, storeId: id(99), stations: [], categories: cats, items, notOnPos: [],
  });

  it('items with the same sort order list by name (not by the order the snapshot holds them)', () => {
    const m = menu([item(11, cat, 'Squid', 0, [variant(21, null, 0, true)]), item(12, cat, 'beef', 0, [variant(22, null, 0, true)]), item(13, cat, 'Chicken', 0, [variant(23, null, 0, true)])]);
    expect(pickerCatalog(m, { packageOpen: false })[0]!.items.map((i) => i.name)).toEqual(['beef', 'Chicken', 'Squid']);
  });

  it('categories with the same sort order list by name', () => {
    const c2 = id(2);
    const m = menu(
      [item(11, cat, 'A', 0, [variant(21, null, 0, true)]), item(12, c2, 'B', 0, [variant(22, null, 0, true)])],
      [{ id: cat, name: 'Zebra', parentId: null, sortOrder: 0 }, { id: c2, name: 'Apple', parentId: null, sortOrder: 0 }],
    );
    expect(pickerCatalog(m, { packageOpen: false }).map((c) => c.name)).toEqual(['Apple', 'Zebra']);
  });

  it('the default size is the first size button, whatever its sort order', () => {
    const m = menu([item(11, cat, 'Soda', 0, [variant(21, 'Large', 0, false), variant(22, null, 90, true), variant(23, 'Small', 5, false)])]);
    const [soda] = pickerCatalog(m, { packageOpen: false })[0]!.items;
    expect(orderableVariants(soda!).map((v) => v.label)).toEqual([null, 'Large', 'Small']);
  });
});
