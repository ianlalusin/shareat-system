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
}
