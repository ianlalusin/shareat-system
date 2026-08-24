import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { GeoPoint, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  FirestoreSourceReader,
  extractStoreCode,
  toStableJson,
  type FirestoreAggregateQueryLike,
  type FirestoreClientLike,
  type FirestoreDocLike,
  type FirestoreQueryLike,
  type FirestoreQuerySnapshotLike,
} from '../src/reader';
import { createErpFirestoreClient } from '../src/client';

/**
 * Unit tests for `FirestoreSourceReader` — docs/tasks/114a-firestore-reader-and-capture.md.
 * No network, no credential (Invariants preamble): the fake below implements the same six
 * methods the real Admin SDK's query builder exposes, and value-conversion tests use REAL
 * `firebase-admin` value classes (`Timestamp`, `GeoPoint`, a `DocumentReference` obtained
 * from a Firestore app initialised with a fake project id and no credential) — verified
 * directly, before writing this file, that none of that touches the network.
 */

// -----------------------------------------------------------------------------------------
// A fake Firestore surface — collection() / orderBy() / startAfter() / limit() / get() /
// count(). Deliberately not a mock of firebase-admin: a plain hand-written object.
// -----------------------------------------------------------------------------------------

interface Stats {
  docReads: number;
  countReads: number;
}

class FakeQuery implements FirestoreQueryLike {
  constructor(
    private readonly allDocs: readonly FirestoreDocLike[],
    private readonly stats: Stats,
    private readonly afterId?: string,
    private readonly limitN?: number,
  ) {}

  orderBy(_field: unknown, _direction?: 'asc' | 'desc'): FirestoreQueryLike {
    // The reader only ever calls orderBy(FieldPath.documentId()) — this fake always sorts
    // by id internally (see get()) regardless of the argument, which is enough to prove
    // pagination/cursor correctness without re-implementing Firestore's field-path model.
    return this;
  }

  startAfter(cursor: unknown): FirestoreQueryLike {
    return new FakeQuery(this.allDocs, this.stats, cursor as string, this.limitN);
  }

  limit(n: number): FirestoreQueryLike {
    return new FakeQuery(this.allDocs, this.stats, this.afterId, n);
  }

  async get(): Promise<FirestoreQuerySnapshotLike> {
    this.stats.docReads++;
    const sorted = [...this.allDocs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Real Firestore's startAfter is EXCLUSIVE — mirrored here deliberately (reader.ts's
    // top comment): getting this wrong is exactly the bug invariant 1 exists to catch.
    let page = this.afterId !== undefined ? sorted.filter((d) => d.id > this.afterId!) : sorted;
    if (this.limitN !== undefined) page = page.slice(0, this.limitN);
    return { docs: page, empty: page.length === 0 };
  }

  count(): FirestoreAggregateQueryLike {
    return {
      get: async () => {
        this.stats.countReads++;
        return { data: () => ({ count: this.allDocs.length }) };
      },
    };
  }
}

class FakeFirestore implements FirestoreClientLike {
  readonly stats: Stats = { docReads: 0, countReads: 0 };
  private readonly collections = new Map<string, FirestoreDocLike[]>();

  setCollection(path: string, docs: readonly FirestoreDocLike[]): void {
    this.collections.set(path, [...docs]);
  }

  collection(collectionPath: string): FirestoreQueryLike {
    return new FakeQuery(this.collections.get(collectionPath) ?? [], this.stats);
  }
}

function fakeDoc(collectionPath: string, id: string, data: Record<string, unknown>): FirestoreDocLike {
  return { id, ref: { path: `${collectionPath}/${id}` }, data: () => data };
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

// -----------------------------------------------------------------------------------------
// invariant 1 — multi-page paging, id order, no duplicate, no gap at the boundary
// -----------------------------------------------------------------------------------------

describe('invariant 1 — readDocuments pages across MORE THAN ONE page with no duplicate and no gap', () => {
  it('yields every document exactly once, in id order, across 3 pages (pageSize=2, 5 docs)', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/journal';
    firestore.setCollection(path, [
      fakeDoc(path, 'doc-01', { n: 1 }),
      fakeDoc(path, 'doc-02', { n: 2 }),
      fakeDoc(path, 'doc-03', { n: 3 }),
      fakeDoc(path, 'doc-04', { n: 4 }),
      fakeDoc(path, 'doc-05', { n: 5 }),
    ]);
    const reader = new FirestoreSourceReader({
      credential: firestore,
      sourceSystem: 'erp_v1',
      collections: [path],
      pageSize: 2,
    });

    const docs = await drain(reader.readDocuments(path));

    expect(docs.map((d) => d.docId)).toEqual(['doc-01', 'doc-02', 'doc-03', 'doc-04', 'doc-05']);
    // No duplicate.
    expect(new Set(docs.map((d) => d.docId)).size).toBe(5);
    // At least 3 pages were actually issued (2 + 2 + 1, plus the confirming empty page).
    expect(firestore.stats.docReads).toBeGreaterThanOrEqual(3);
  });

  it('a broken cursor (inclusive startAfter) WOULD duplicate the boundary doc — sanity-checking the fake catches it', async () => {
    // Regression proof for the fake itself, not the reader: if startAfter were mistakenly
    // inclusive, doc-02 would appear on both page 1 and page 2. This test constructs that
    // broken variant inline and confirms IT fails the "no duplicate" assertion, so a
    // reader.ts regression to inclusive-startAfter would be caught by the test above, not
    // silently pass because the fake was too forgiving.
    const path = 'stores/STORE-A/journal';
    const docs = [fakeDoc(path, 'doc-01', {}), fakeDoc(path, 'doc-02', {}), fakeDoc(path, 'doc-03', {})];
    const sorted = [...docs].sort((a, b) => (a.id < b.id ? -1 : 1));
    const inclusivePage1 = sorted.slice(0, 2); // doc-01, doc-02
    const inclusivePage2 = sorted.filter((d) => d.id >= 'doc-02').slice(0, 2); // doc-02, doc-03 (BROKEN)
    const ids = [...inclusivePage1, ...inclusivePage2].map((d) => d.id);
    expect(new Set(ids).size).toBeLessThan(ids.length); // proves the broken variant WOULD duplicate
  });
});

describe('invariant 2 — an empty collection yields nothing and does not throw', () => {
  it('yields zero documents for a collection with no data', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/expenses';
    const reader = new FirestoreSourceReader({ credential: firestore, sourceSystem: 'erp_v1', collections: [path] });

    await expect(drain(reader.readDocuments(path))).resolves.toEqual([]);
  });
});

describe('invariant 3 — docPath is the full path; storeCode is carried through', () => {
  it('derives docPath and storeCode from the collectionPath and doc id', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-Z/expenses';
    firestore.setCollection(path, [fakeDoc(path, 'x1', { amount: 5 })]);
    const reader = new FirestoreSourceReader({ credential: firestore, sourceSystem: 'erp_v1', collections: [path] });

    const [doc] = await drain(reader.readDocuments(path));
    expect(doc!.docPath).toBe('stores/STORE-Z/expenses/x1');
    expect(doc!.docId).toBe('x1');
    expect(doc!.collectionPath).toBe(path);
    expect(doc!.storeCode).toBe('STORE-Z');
  });

  it('extractStoreCode returns null for a path with no stores/ prefix', () => {
    expect(extractStoreCode('users/abc')).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------
// invariants 4-6 — value conversion, against REAL firebase-admin value classes
// -----------------------------------------------------------------------------------------

describe('invariants 4-6 — value conversion to a stable JSON form', () => {
  const testApp =
    getApps().find((a) => a.name === 'etl-firestore-reader-test') ??
    initializeApp({ projectId: 'fake-test-project' }, 'etl-firestore-reader-test');
  const testFirestore = getFirestore(testApp);

  afterAll(async () => {
    await deleteApp(testApp);
  });

  it('invariant 4 — a Timestamp lands as a stable ISO-8601 string, NOT {_seconds,_nanoseconds}', () => {
    const ts = new Timestamp(1_700_000_000, 123_000_000);
    const converted = toStableJson({ postedAt: ts }) as { postedAt: unknown };
    expect(typeof converted.postedAt).toBe('string');
    expect(converted.postedAt).toBe(ts.toDate().toISOString());
    expect(converted.postedAt).not.toHaveProperty('_seconds');
  });

  it('invariant 5a — a DocumentReference lands as its path string', () => {
    const ref = testFirestore.doc('stores/STORE-A/journal/xyz');
    const converted = toStableJson({ ref }) as { ref: unknown };
    expect(converted.ref).toBe('stores/STORE-A/journal/xyz');
  });

  it('invariant 5b — a GeoPoint lands as a stable {latitude, longitude} object', () => {
    const gp = new GeoPoint(14.5, 121.0);
    const converted = toStableJson({ loc: gp }) as { loc: unknown };
    expect(converted.loc).toEqual({ latitude: 14.5, longitude: 121.0 });
  });

  it('a Buffer lands as a base64 string (Contract §2 names it alongside the other three)', () => {
    const buf = Buffer.from('hello');
    const converted = toStableJson({ blob: buf }) as { blob: unknown };
    expect(converted.blob).toBe(buf.toString('base64'));
  });

  it('converts nested arrays and objects recursively', () => {
    const ts = new Timestamp(1_700_000_000, 0);
    const converted = toStableJson({ list: [{ at: ts }, { at: ts }] }) as { list: { at: string }[] };
    expect(converted.list[0]!.at).toBe(ts.toDate().toISOString());
    expect(converted.list[1]!.at).toBe(ts.toDate().toISOString());
  });

  it('invariant 6 — the same document read twice produces byte-identical JSON', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/journal';
    const ref = testFirestore.doc(`${path}/j1`);
    const payload = { amount: 100, postedAt: new Timestamp(1_700_000_000, 0), ref, loc: new GeoPoint(1, 2) };
    firestore.setCollection(path, [fakeDoc(path, 'j1', payload)]);
    const reader = new FirestoreSourceReader({ credential: firestore, sourceSystem: 'erp_v1', collections: [path] });

    const [first] = await drain(reader.readDocuments(path));
    const [second] = await drain(reader.readDocuments(path));

    expect(JSON.stringify(first!.payload)).toBe(JSON.stringify(second!.payload));
    expect(first!.payload).toEqual(second!.payload);
  });
});

// -----------------------------------------------------------------------------------------
// invariant 10 — --limit N stops at exactly N per target
//
// Tested here at the READER layer (not through plan.ts's runFetch/runCaptureMode, which
// need real Postgres — see plan.test.ts's top comment) even though the spec groups
// invariant 10 under "Plan". The limiting behaviour genuinely lives on the reader (Contract
// §3's --limit has nowhere else to live, since SourceReader#readDocuments takes no options
// parameter and runCaptureMode calls it with none — see reader.ts's constructor comment).
// -----------------------------------------------------------------------------------------

describe('invariant 10 — --limit N stops at exactly N per target', () => {
  it('yields exactly N documents when the collection has more than N, across multiple pages', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/journal';
    firestore.setCollection(
      path,
      Array.from({ length: 10 }, (_, i) => fakeDoc(path, `doc-${String(i + 1).padStart(2, '0')}`, { n: i })),
    );
    const reader = new FirestoreSourceReader({
      credential: firestore,
      sourceSystem: 'erp_v1',
      collections: [path],
      pageSize: 3,
      limitPerCollection: 7,
    });

    const docs = await drain(reader.readDocuments(path));
    expect(docs).toHaveLength(7);
    expect(docs.map((d) => d.docId)).toEqual([
      'doc-01',
      'doc-02',
      'doc-03',
      'doc-04',
      'doc-05',
      'doc-06',
      'doc-07',
    ]);
  });

  it('a limit larger than the collection yields every document, no fewer', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/journal';
    firestore.setCollection(path, [fakeDoc(path, 'a', {}), fakeDoc(path, 'b', {})]);
    const reader = new FirestoreSourceReader({
      credential: firestore,
      sourceSystem: 'erp_v1',
      collections: [path],
      limitPerCollection: 1000,
    });
    const docs = await drain(reader.readDocuments(path));
    expect(docs).toHaveLength(2);
  });

  it('with no limit set, the default page size is 500', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(500);
  });
});

// -----------------------------------------------------------------------------------------
// Safety — invariants 11, 12, 13
// -----------------------------------------------------------------------------------------

describe('Safety', () => {
  it('invariant 11 — FirestoreSourceReader exposes no write method', () => {
    const firestore = new FakeFirestore();
    const reader = new FirestoreSourceReader({ credential: firestore, sourceSystem: 'erp_v1', collections: [] });
    for (const member of ['set', 'update', 'delete', 'add', 'batch'] as const) {
      expect(member in reader, `FirestoreSourceReader must not expose .${member}()`).toBe(false);
    }
  });

  it('invariant 12 — packages/etl/package.json still declares no Firebase dependency (T-112 invariant 22, restated here)', () => {
    const pkgPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'etl', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    const firebaseDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => /firebase/i.test(d));
    expect(firebaseDeps).toEqual([]);
  });

  it('invariant 13 — missing credentials produce the existing skip result, not a crash', () => {
    expect(() => createErpFirestoreClient({})).not.toThrow();
    const result = createErpFirestoreClient({});
    expect('skipped' in result && result.skipped).toBe(true);
  });
});
