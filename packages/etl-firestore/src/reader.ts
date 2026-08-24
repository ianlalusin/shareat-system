/**
 * reader.ts — `FirestoreSourceReader implements SourceReader`.
 * docs/tasks/114a-firestore-reader-and-capture.md Contract §2.
 *
 * Read-only, STRUCTURALLY (task's non-negotiable table, row 1): this class implements
 * exactly the two `SourceReader` methods (`packages/etl/src/source-reader.ts`) and nothing
 * else. There is no `.set()`, `.update()`, `.delete()`, `.add()` or batch-writer member on
 * it (invariant 11) — not a promise kept by convention, a call that does not exist to make.
 *
 * Talks to Firestore only through `FirestoreClientLike` below — a minimal structural slice
 * of the Admin SDK's query-builder API (`collection` / `orderBy` / `startAfter` / `limit` /
 * `get` / `count`). A real `firebase-admin` `Firestore` instance (from `client.ts`) satisfies
 * this shape as-is, with no adapter code; `tests/reader.test.ts` satisfies it with a small
 * hand-written fake object — "not a mock of firebase-admin itself" per the Invariants
 * preamble. Verified directly (see task report): constructing `firebase-admin`'s `Timestamp`,
 * `GeoPoint` and a real `DocumentReference` (via `getFirestore(app).doc(path)`, `app`
 * initialised with a fake project id and no credential) touches no network and needs no
 * credential, so `toStableJson` below is tested against the REAL value classes it will meet
 * in production, not a hand-rolled lookalike.
 */
import { FieldPath, DocumentReference, GeoPoint, Timestamp } from 'firebase-admin/firestore';

import type { SourceDocument, SourceReader } from '@shareat/etl/source-reader';

/** Firestore's own page-size default this reader falls back to (Contract §2). */
export const DEFAULT_PAGE_SIZE = 500;

// -----------------------------------------------------------------------------------------
// The minimal structural surface this module needs from Firestore. Deliberately NOT
// `FirebaseFirestore.Firestore` / `CollectionReference` — that would force every test to
// construct (or heavily fake) the real SDK's full surface. A real `Firestore` instance is
// structurally assignable to `FirestoreClientLike` as-is (verified by `npm run typecheck`);
// a test fake only ever has to implement these six methods.
// -----------------------------------------------------------------------------------------

export interface FirestoreCountSnapshotLike {
  data(): { count: number };
}

export interface FirestoreAggregateQueryLike {
  get(): Promise<FirestoreCountSnapshotLike>;
}

export interface FirestoreDocLike {
  readonly id: string;
  readonly ref: { readonly path: string };
  data(): Record<string, unknown>;
}

export interface FirestoreQuerySnapshotLike {
  readonly docs: readonly FirestoreDocLike[];
  readonly empty: boolean;
}

export interface FirestoreQueryLike {
  orderBy(field: unknown, direction?: 'asc' | 'desc'): FirestoreQueryLike;
  startAfter(cursor: unknown): FirestoreQueryLike;
  limit(n: number): FirestoreQueryLike;
  get(): Promise<FirestoreQuerySnapshotLike>;
  count(): FirestoreAggregateQueryLike;
}

export interface FirestoreClientLike {
  collection(collectionPath: string): FirestoreQueryLike;
}

// -----------------------------------------------------------------------------------------
// Value conversion — Contract §2's Timestamp/GeoPoint/DocumentReference/Buffer rule.
// -----------------------------------------------------------------------------------------

/**
 * Recursively converts Firestore's non-JSON value types to a stable, SDK-version-independent
 * form before landing. A `Timestamp` that serialises as `{_seconds,_nanoseconds}` in one SDK
 * version and something else in the next would silently change every content hash and
 * manufacture a whole-database "the source changed" finding (Contract §2) — the same hazard
 * class as T-112's canonical-key-order rule, and more likely to bite because every document
 * in this migration carries at least one Timestamp.
 *
 * - `Timestamp` -> ISO-8601 string (invariant 4).
 * - `DocumentReference` -> its `.path` string (invariant 5).
 * - `GeoPoint` -> a stable `{ latitude, longitude }` object (invariant 5).
 * - `Buffer` -> a base64 string (named in Contract §2's opening sentence; no v1 collection is
 *   known to carry one, but a converter that silently drops an unexpected binary field would
 *   be a worse failure than one that converts it predictably).
 */
export function toStableJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof GeoPoint) return { latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return value.path;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map((v) => toStableJson(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toStableJson(v);
    }
    return out;
  }
  return value;
}

/** `stores/{storeCode}/{collection}` -> `storeCode`. `null` for a path with no `stores/` prefix. */
export function extractStoreCode(collectionPath: string): string | null {
  const match = /^stores\/([^/]+)\//.exec(collectionPath);
  return match ? match[1]! : null;
}

// -----------------------------------------------------------------------------------------
// FirestoreSourceReader
// -----------------------------------------------------------------------------------------

export interface FirestoreSourceReaderOptions {
  /**
   * An initialised Firestore client for the ERP project (see `client.ts`), or — in tests —
   * any object satisfying `FirestoreClientLike`. Named `credential` per Contract §2's
   * illustrative constructor signature.
   */
  credential: FirestoreClientLike;
  sourceSystem: string;
  /**
   * Fully-qualified collection paths this reader serves, e.g. `['stores/ABC/journal']`.
   * `listCollections()` returns exactly this list — "the collection paths the PLAN asked
   * for", never a live sweep (Contract §2). **Not present in the spec's illustrative
   * constructor signature** (`{ credential, sourceSystem, pageSize? }`); added because that
   * same Contract paragraph's very next sentence requires `listCollections()` to return
   * something the reader cannot otherwise know. Flagged as a spec gap in the task report
   * rather than silently narrowed — RULES.md §3.4a.
   */
  collections: readonly string[];
  pageSize?: number;
  /**
   * `--limit N` (Contract §3, invariant 10) — caps documents yielded per collection. Lives
   * on the reader, not on a per-call `readDocuments` parameter, because `SourceReader`
   * (`packages/etl/src/source-reader.ts`, out of Scope to modify) declares
   * `readDocuments(collectionPath: string)` with no options parameter, and `runCaptureMode`
   * (T-112, also out of Scope) calls it exactly that way — so a limit that `--fetch --limit`
   * must honour when streaming through `runCaptureMode` has nowhere to live but the
   * constructor.
   */
  limitPerCollection?: number;
}

export class FirestoreSourceReader implements SourceReader {
  readonly sourceSystem: string;
  private readonly firestore: FirestoreClientLike;
  private readonly collections: readonly string[];
  private readonly pageSize: number;
  private readonly limitPerCollection: number | undefined;

  constructor(options: FirestoreSourceReaderOptions) {
    this.sourceSystem = options.sourceSystem;
    this.firestore = options.credential;
    this.collections = options.collections;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.limitPerCollection = options.limitPerCollection;
  }

  async listCollections(): Promise<readonly string[]> {
    return this.collections;
  }

  /**
   * Pages with a cursor — `orderBy(FieldPath.documentId()).startAfter(last)` — never an
   * offset. `startAfter` is EXCLUSIVE of the cursor value in real Firestore, which is what
   * makes this loop free of the classic off-by-one: no document is ever re-yielded across a
   * page boundary, and none is skipped (invariant 1). The fake in `tests/reader.test.ts`
   * mirrors that exclusivity deliberately, because a fake that got this wrong would let a
   * duplicate/gap bug pass silently — precisely the failure mode the task spec calls out by
   * name.
   */
  async *readDocuments(collectionPath: string): AsyncIterable<SourceDocument> {
    const storeCode = extractStoreCode(collectionPath);
    let cursor: string | undefined;
    let yielded = 0;

    for (;;) {
      const remaining =
        this.limitPerCollection === undefined
          ? this.pageSize
          : Math.min(this.pageSize, this.limitPerCollection - yielded);
      if (remaining <= 0) return;

      let query: FirestoreQueryLike = this.firestore.collection(collectionPath).orderBy(FieldPath.documentId());
      if (cursor !== undefined) query = query.startAfter(cursor);
      query = query.limit(remaining);

      const snapshot = await query.get();
      if (snapshot.empty || snapshot.docs.length === 0) return;

      for (const doc of snapshot.docs) {
        yield {
          docPath: doc.ref.path,
          docId: doc.id,
          collectionPath,
          storeCode,
          payload: toStableJson(doc.data()) as Record<string, unknown>,
        };
        yielded++;
        cursor = doc.id;
      }

      // A short page (fewer docs than asked for) is the last page — no extra round trip.
      // An exact-length page requires one more query to confirm there is nothing after it;
      // that is the correct, standard cost of cursor pagination without a separate count.
      if (snapshot.docs.length < remaining) return;
    }
  }
}
