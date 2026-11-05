/**
 * T-508 S5 - the wire shape of GET /api/pos2/menu as the tablet reads it. A client file may not import the domain package (T-424 boundary),
 * so this restates the domain package's `StoreMenuV2` (packages/domain/src/menu/project.ts). Drift is caught at compile time: from-erp.test.ts assigns the real
 * StoreMenuV2 to this type, so a server-side change that breaks it fails `tsc`.
 */
type Offer =
  | { orderable: true; amount: string | null; bundleHeads: number | null; extraHeadAmount: string | null }
  | { orderable: false; notOffered: string };
type Delta = { orderable: true; priceDelta: string } | { orderable: false; notOffered: string };

export interface ErpMenu {
  schemaVersion: 2;
  storeId: string;
  stations: { id: string; name: string; slaMinutes: number; printOnOutage: boolean }[];
  categories: { id: string; name: string; parentId: string | null; sortOrder: number }[];
  items: {
    id: string; categoryId: string; name: string; description: string | null; itemType: 'a_la_carte' | 'package' | 'refill';
    soldALaCarte: boolean; soldInPackageSession: boolean; dinerOrderable: boolean; sortOrder: number; stationId: string | null;
    variants: {
      id: string; label: string | null; isDefault: boolean; sortOrder: number; refillItemIds: string[];
      channels: { store: Offer; online: Offer };
      optionGroups: { id: string; name: string; selectionMode: 'single' | 'multi'; minSelections: number; maxSelections: number;
        values: { id: string; name: string; sortOrder: number; channels: { store: Delta; online: Delta } }[] }[];
    }[];
  }[];
  notOnPos: { itemId: string; name: string; reason: string }[];
}
