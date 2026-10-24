/**
 * pos-receipts.ts - the read-only POS receipt reader (T-472 slice 1).
 * docs/tasks/472-pos-nightly-receipt-bridge.md Rulings 1 and 2.
 *
 * Read-only BY STRUCTURE, the same way `reader.ts` is: the only Firestore surface this module
 * knows is `PosFirestoreLike` / `PosQueryLike` below - `collection`, `where`, `orderBy`,
 * `startAfter`, `limit`, `get`, `count`. There is no write member to call, and
 * `tests/pos-receipts.test.ts` fails the build if any module in this graph names a write API.
 *
 * Credential: `POS_BRIDGE_SA_KEY_FILE` ONLY (a Datastore-Viewer-only service account). It is
 * never the POS v2 server key, and a key whose project_id is not the one the caller expects is
 * refused. No error here ever carries key text.
 */
import { readFileSync } from 'node:fs';

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

import { businessDayRange, parseBusinessDate } from '@shareat/core/datetime';

import { toStableJson } from './reader';

/** Firestore page size for every list here (Ruling 2: 500 + cursor). */
export const POS_PAGE_SIZE = 500;

// ---- the minimal, read-only structural surface -------------------------------------------

export interface PosDocLike {
  readonly id: string;
  readonly ref: { readonly path: string };
  data(): Record<string, unknown>;
}

export interface PosSnapshotLike {
  readonly docs: readonly PosDocLike[];
  readonly empty: boolean;
}

export interface PosQueryLike {
  where(field: string, op: '>=' | '<' | '>' | '<=' | '==', value: unknown): PosQueryLike;
  orderBy(field: unknown, direction?: 'asc' | 'desc'): PosQueryLike;
  startAfter(...cursor: unknown[]): PosQueryLike;
  limit(n: number): PosQueryLike;
  get(): Promise<PosSnapshotLike>;
  count(): { get(): Promise<{ data(): { count: number } }> };
}

export interface PosFirestoreLike {
  collection(collectionPath: string): PosQueryLike;
}

/** One receipt as read: the id, its path, and the data with Firestore value types made stable. */
export interface PosReceiptDoc {
  readonly id: string;
  readonly path: string;
  readonly data: Record<string, unknown>;
}

export type PosChangeField = 'voidedAt' | 'editedAt' | 'createdAt';
const CHANGE_FIELDS: readonly PosChangeField[] = ['voidedAt', 'editedAt', 'createdAt'];

export interface PosDayCrossCheck {
  /** Receipts whose `createdAtClientMs` falls in the Manila day. */
  readonly byClientMs: number;
  /** Receipts whose server `createdAt` falls in the same day. */
  readonly byServerCreatedAt: number;
  /** `max(0, byServerCreatedAt - byClientMs)`: docs the client-time query cannot see. */
  readonly missingClientMs: number;
}

export interface PosReceiptReaderOptions {
  firestore: PosFirestoreLike;
  pageSize?: number;
}

function receiptsPath(posStoreId: string): string {
  if (!posStoreId || posStoreId.includes('/')) throw new Error('pos-receipts: invalid POS store id');
  return `stores/${posStoreId}/receipts`;
}

export class PosReceiptReader {
  private readonly firestore: PosFirestoreLike;
  private readonly pageSize: number;

  constructor(options: PosReceiptReaderOptions) {
    this.firestore = options.firestore;
    this.pageSize = options.pageSize ?? POS_PAGE_SIZE;
  }

  /** Receipts of one store for one Manila calendar day, by `createdAtClientMs`, paged. */
  async *listDay(posStoreId: string, businessDate: string): AsyncGenerator<PosReceiptDoc> {
    const { start, end } = businessDayRange(parseBusinessDate(businessDate));
    const base = this.firestore
      .collection(receiptsPath(posStoreId))
      .where('createdAtClientMs', '>=', start.getTime())
      .where('createdAtClientMs', '<', end.getTime());
    yield* this.page(base, 'createdAtClientMs');
  }

  /** Count by client time vs by server `createdAt`, for docs that lack `createdAtClientMs`. */
  async crossCheckDay(posStoreId: string, businessDate: string): Promise<PosDayCrossCheck> {
    const { start, end } = businessDayRange(parseBusinessDate(businessDate));
    const col = receiptsPath(posStoreId);
    const byClient = await this.firestore
      .collection(col)
      .where('createdAtClientMs', '>=', start.getTime())
      .where('createdAtClientMs', '<', end.getTime())
      .count()
      .get();
    const byServer = await this.firestore
      .collection(col)
      .where('createdAt', '>=', start)
      .where('createdAt', '<', end)
      .count()
      .get();
    const a = byClient.data().count;
    const b = byServer.data().count;
    return { byClientMs: a, byServerCreatedAt: b, missingClientMs: Math.max(0, b - a) };
  }

  /** Receipts whose `voidedAt`, `editedAt` or server `createdAt` is after `since`, paged. */
  async *listChangedSince(posStoreId: string, field: PosChangeField, since: Date): AsyncGenerator<PosReceiptDoc> {
    if (!CHANGE_FIELDS.includes(field)) throw new Error('pos-receipts: unsupported change-time field');
    if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw new Error('pos-receipts: invalid since');
    const base = this.firestore.collection(receiptsPath(posStoreId)).where(field, '>', since);
    yield* this.page(base, field);
  }

  /** Cursor paging on (orderField, document id): ties on the order field neither repeat nor skip. */
  private async *page(base: PosQueryLike, orderField: string): AsyncGenerator<PosReceiptDoc> {
    let cursor: [unknown, string] | undefined;
    for (;;) {
      let q = base.orderBy(orderField).orderBy(FieldPath.documentId());
      if (cursor) q = q.startAfter(cursor[0], cursor[1]);
      const snap = await q.limit(this.pageSize).get();
      if (snap.empty || snap.docs.length === 0) return;
      for (const d of snap.docs) {
        const raw = d.data();
        yield { id: d.id, path: d.ref.path, data: toStableJson(raw) as Record<string, unknown> };
        cursor = [raw[orderField], d.id];
      }
      if (snap.docs.length < this.pageSize) return;
    }
  }
}

// ---- credential --------------------------------------------------------------------------

export class PosBridgeCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PosBridgeCredentialError';
  }
}

export interface PosBridgeCredential {
  readonly projectId: string;
  readonly serviceAccount: { projectId: string; clientEmail: string; privateKey: string };
}

/**
 * Reads the key file named by `POS_BRIDGE_SA_KEY_FILE` and checks its `project_id` is the one the
 * caller expects. Errors are fixed sentences: nothing from the file is ever echoed.
 */
export function loadPosBridgeCredential(
  env: Readonly<Record<string, string | undefined>>,
  expectedProjectId: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): PosBridgeCredential {
  const file = env.POS_BRIDGE_SA_KEY_FILE;
  if (!file) throw new PosBridgeCredentialError('POS_BRIDGE_SA_KEY_FILE is not set; the POS receipt bridge will not start.');
  let parsed: { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    parsed = JSON.parse(readFile(file)) as typeof parsed;
  } catch {
    throw new PosBridgeCredentialError('The POS bridge key file could not be read as a service-account JSON file.');
  }
  if (
    typeof parsed.project_id !== 'string' ||
    typeof parsed.client_email !== 'string' ||
    typeof parsed.private_key !== 'string'
  ) {
    throw new PosBridgeCredentialError('The POS bridge key file does not look like a service-account key.');
  }
  if (parsed.project_id !== expectedProjectId) {
    throw new PosBridgeCredentialError('The POS bridge key belongs to a different Firebase project than expected.');
  }
  return {
    projectId: parsed.project_id,
    serviceAccount: { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key },
  };
}

const APP_NAME = 'shareat-pos-receipt-bridge';

/** An initialised read surface for the POS project, from `POS_BRIDGE_SA_KEY_FILE`. */
export function createPosReceiptFirestore(
  env: Readonly<Record<string, string | undefined>>,
  expectedProjectId: string,
  readFile?: (path: string) => string,
): PosFirestoreLike {
  const cred = loadPosBridgeCredential(env, expectedProjectId, readFile);
  const app =
    getApps().find((a) => a.name === APP_NAME) ??
    initializeApp({ credential: cert(cred.serviceAccount), projectId: cred.projectId }, APP_NAME);
  return getFirestore(app);
}
