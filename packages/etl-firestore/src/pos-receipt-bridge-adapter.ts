/**
 * pos-receipt-bridge-adapter.ts - gives the domain's receipt-bridge port its Firestore reads (T-472 S2).
 * docs/tasks/472-pos-nightly-receipt-bridge.md Ruling 1.
 *
 * `packages/domain` has no `firebase-admin`; it asks for receipts through `PosReceiptBridgePort`, and THIS class answers
 * it from `PosReceiptReader` (read-only by structure) and `mapPosReceipt` (pure). The Firestore it talks to is built
 * only by `createPosReceiptFirestore`, i.e. from `POS_BRIDGE_SA_KEY_FILE`, a Datastore-Viewer-only credential: never the
 * POS v2 server key. There is no write call anywhere in this module's graph (`tests/unit/t472-s2-bridge-guards.test.ts`).
 *
 * A class, not free functions: the one factory (`fromEnv`) is a static method, so the production-caller census (which
 * counts exported FUNCTIONS) sees `createPosReceiptFirestore` and `mapPosReceipt` called from here.
 */
import type { BridgeChangeField, BridgeDayCrossCheck, BridgeSourceReceipt, PosReceiptBridgePort } from '@shareat/domain';

import { mapPosReceipt } from './pos-receipt-map';
import { PosReceiptReader, createPosReceiptFirestore, type PosFirestoreLike, type PosReceiptDoc } from './pos-receipts';

/** POS's Firebase project (the one the receipts live in). A key for any other project is refused. */
export const POS_FIREBASE_PROJECT_ID = 'shareat-hub-v2';

function mapped(doc: PosReceiptDoc): BridgeSourceReceipt {
  const m = mapPosReceipt({ id: doc.id, data: doc.data });
  return { id: doc.id, header: m.header, lines: m.lines, tenders: m.tenders, docHash: m.docHash };
}

export class PosReceiptBridgeAdapter implements PosReceiptBridgePort {
  private readonly reader: PosReceiptReader;

  constructor(firestore: PosFirestoreLike) {
    this.reader = new PosReceiptReader({ firestore });
  }

  /** Builds the read surface from the environment (`POS_BRIDGE_SA_KEY_FILE`). Throws a fixed-sentence error when the key is missing or wrong. */
  static fromEnv(env: Readonly<Record<string, string | undefined>>, expectedProjectId: string = POS_FIREBASE_PROJECT_ID): PosReceiptBridgeAdapter {
    return new PosReceiptBridgeAdapter(createPosReceiptFirestore(env, expectedProjectId));
  }

  async *listDay(posStoreId: string, businessDate: string): AsyncGenerator<BridgeSourceReceipt> {
    for await (const doc of this.reader.listDay(posStoreId, businessDate)) yield mapped(doc);
  }

  async *listMissingClientTime(posStoreId: string, businessDate: string): AsyncGenerator<BridgeSourceReceipt> {
    for await (const doc of this.reader.listMissingClientMs(posStoreId, businessDate)) yield mapped(doc);
  }

  crossCheckDay(posStoreId: string, businessDate: string): Promise<BridgeDayCrossCheck> {
    return this.reader.crossCheckDay(posStoreId, businessDate);
  }

  async *listChangedSince(posStoreId: string, field: BridgeChangeField, since: Date): AsyncGenerator<BridgeSourceReceipt> {
    for await (const doc of this.reader.listChangedSince(posStoreId, field, since)) yield mapped(doc);
  }
}
