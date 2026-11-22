/**
 * pos-store-setup-source.ts - the read-only v1 source for the one-time store setup load (T-533 S2).
 * docs/tasks/533-pos-lipa-switch.md R2.
 *
 * Read-only BY STRUCTURE like `pos-receipts.ts`: the only Firestore surface used is `PosFirestoreLike.collection(path).get()`, so there is no write member
 * to call. The credential is `POS_BRIDGE_SA_KEY_FILE` (a Datastore-Viewer-only key for POS's own project, `shareat-hub-v2`), never the ERP project's key:
 * v1's stands and discounts live in POS's project. Shapes match `V1StoreSetupSource` in `packages/etl/src/pos-v2/load-store-setup.ts` structurally.
 *
 * v1 paths: `stores/{posStoreId}/tables` (`tableNumber`, `isActive`) `stores/{posStoreId}/storeDiscounts` and the root `globalDiscounts` (`name`, `type`, `value`,
 * `isArchived`, `isEnabled`, `adminSuspended`, `startDate`, `endDate`). A class, so the production-caller census sees `createPosReceiptFirestore` called from here.
 *
 * T-626 `readMenu`: `stores/{id}/` kitchenLocations, menuSchedules, storePackages, storeRefills, storeFlavors, inventory, storeModesOfPayment, storeCharges, and the root
 * `refills` and `flavors` (the global switches and the flavour rules). Every call is a plain `collection(path).get()`. Shapes match `V1MenuSetup` (plan-store-menu.ts).
 */
import { POS_FIREBASE_PROJECT_ID } from './pos-receipt-bridge-adapter';
import { createPosReceiptFirestore, type PosFirestoreLike } from './pos-receipts';

interface SetupDiscount {
  name: string;
  type: unknown;
  value: unknown;
  isArchived: boolean;
  isEnabled: boolean;
  adminSuspended: boolean;
  startDate?: string;
  endDate?: string;
}

function toDiscount(x: Record<string, unknown>): SetupDiscount {
  return {
    name: String(x.name ?? ''),
    type: x.type,
    value: x.value,
    isArchived: x.isArchived === true,
    isEnabled: x.isEnabled !== false,
    adminSuspended: x.adminSuspended === true,
    ...(typeof x.startDate === 'string' && x.startDate ? { startDate: x.startDate } : {}),
    ...(typeof x.endDate === 'string' && x.endDate ? { endDate: x.endDate } : {}),
  };
}

type Doc = { readonly id: string; data(): Record<string, unknown> };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const numOr = (v: unknown, d: number): number => num(v) ?? d;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class PosStoreSetupFirestoreSource {
  constructor(private readonly firestore: PosFirestoreLike) {}

  /** Builds the read surface from the environment (`POS_BRIDGE_SA_KEY_FILE`). Throws a fixed-sentence error when the key is missing or wrong. */
  static fromEnv(env: Readonly<Record<string, string | undefined>>, expectedProjectId: string = POS_FIREBASE_PROJECT_ID): PosStoreSetupFirestoreSource {
    return new PosStoreSetupFirestoreSource(createPosReceiptFirestore(env, expectedProjectId));
  }

  async listTables(posStoreId: string): Promise<{ tableNumber: string; isActive: boolean }[]> {
    const snap = await this.firestore.collection(`stores/${posStoreId}/tables`).get();
    return snap.docs.map((d) => {
      const x = d.data();
      return { tableNumber: String(x.tableNumber ?? ''), isActive: x.isActive !== false };
    });
  }

  async listDiscounts(posStoreId: string): Promise<SetupDiscount[]> {
    const snap = await this.firestore.collection(`stores/${posStoreId}/storeDiscounts`).get();
    return snap.docs.map((d) => toDiscount(d.data()));
  }

  /** v1's universal discounts for this store: `globalDiscounts` where `applicableStoreIds` contains it and `isArchived` is false (v1's own query). */
  async listGlobalDiscounts(posStoreId: string): Promise<SetupDiscount[]> {
    const snap = await this.firestore
      .collection('globalDiscounts')
      .where('applicableStoreIds', 'array-contains', posStoreId)
      .where('isArchived', '==', false)
      .get();
    return snap.docs.map((d) => toDiscount(d.data()));
  }

  /** The store's menu, kitchen, hours and payment methods (T-626), read raw-but-typed; the planner decides what each means. */
  async readMenu(posStoreId: string) {
    const get = async (path: string): Promise<readonly Doc[]> => (await this.firestore.collection(path).get()).docs;
    const base = `stores/${posStoreId}`;
    const [stations, schedules, packages, refills, flavors, items, modes, charges, globalRefills, globalFlavors] = await Promise.all([
      get(`${base}/kitchenLocations`), get(`${base}/menuSchedules`), get(`${base}/storePackages`), get(`${base}/storeRefills`), get(`${base}/storeFlavors`),
      get(`${base}/inventory`), get(`${base}/storeModesOfPayment`), get(`${base}/storeCharges`), get('refills'), get('flavors'),
    ]);
    const globalRefill = new Map(globalRefills.map((d) => [d.id, d.data()]));
    const globalFlavor = new Map(globalFlavors.map((d) => [d.id, d.data()]));
    return {
      stations: stations.map((d) => {
        const x = d.data();
        return { id: d.id, name: str(x.name), sortOrder: numOr(x.sortOrder, 0), isActive: x.isActive !== false, slaMinutes: num(x.slaMinutes), printOnOutage: x.printOnOutage === true };
      }),
      schedules: schedules.map((d) => {
        const x = d.data();
        return { id: d.id, name: str(x.name), isActive: x.isActive === true, isArchived: x.isArchived === true, days: strs(x.days), startTime: str(x.startTime), endTime: str(x.endTime) };
      }),
      packages: packages.map((d) => {
        const x = d.data();
        return {
          id: d.id, name: str(x.packageName) || str(x.name), isEnabled: x.isEnabled !== false, pricePerHead: num(x.pricePerHead), stationId: strOrNull(x.kitchenLocationId),
          refillIds: strs(x.refillsAllowed), sortOrder: numOr(x.sortOrder, 0), scheduleId: strOrNull(x.menuScheduleId),
          isBundle: x.isBundle === true, bundlePrice: num(x.bundlePrice), bundleMaxCap: num(x.bundleMaxCap), bundleExtraHeadPrice: num(x.bundleExtraHeadPrice),
        };
      }),
      refills: refills.map((d) => {
        const x = d.data();
        const g = globalRefill.get(str(x.refillId) || d.id);
        return {
          id: str(x.refillId) || d.id, name: str(x.refillName) || str(x.name), isEnabled: x.isEnabled !== false, isOther: x.isOther === true, sortOrder: numOr(x.sortOrder, 1000),
          stationId: strOrNull(x.kitchenLocationId), globallyActive: !g || g.isActive !== false, requiresFlavor: g?.requiresFlavor === true, allowedFlavorIds: strs(g?.allowedFlavorIds),
        };
      }),
      flavors: flavors.map((d) => {
        const x = d.data();
        const id = str(x.flavorId) || d.id;
        const g = globalFlavor.get(id);
        return { id, name: str(x.flavorName) || str(g?.name), isEnabled: x.isEnabled !== false, sortOrder: numOr(x.sortOrder, 1000), globallyActive: !g || g.isActive !== false };
      }),
      items: items.map((d) => {
        const x = d.data();
        return {
          name: str(x.name), groupName: strOrNull(x.groupName), variantLabel: strOrNull(x.variantLabel), kind: strOrNull(x.kind), subCategory: strOrNull(x.subCategory),
          sellingPrice: num(x.sellingPrice), isActive: x.isActive !== false, isArchived: x.isArchived === true, isAddon: x.isAddon === true, stationId: strOrNull(x.kitchenLocationId),
          customerEnabled: x.customerEnabled === true, hasModifiers: strs(x.optionGroupIds).length > 0,
        };
      }),
      payModes: modes.map((d) => {
        const x = d.data();
        return { name: str(x.name), type: str(x.type), isActive: x.isActive !== false, isArchived: x.isArchived === true };
      }),
      charges: charges.map((d) => {
        const x = d.data();
        return { name: str(x.name), isActive: x.isEnabled !== false && x.isArchived !== true };
      }),
    };
  }
}
