import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PlanError, countTargets, formatCountTable, planCapture, runPlan } from '../src/plan';
import type {
  FirestoreAggregateQueryLike,
  FirestoreClientLike,
  FirestoreDocLike,
  FirestoreQueryLike,
  FirestoreQuerySnapshotLike,
} from '../src/reader';

/**
 * Unit tests for `plan.ts` — docs/tasks/114a-firestore-reader-and-capture.md invariants 7-9.
 * No network, no credential, no database: `runFetch`/`runPlan({fetch:true})` streams through
 * `runCaptureMode`, which needs real Postgres — that path is proven by
 * `tests/integration/capture.test.ts` (invariant 14), never here. This file only ever
 * exercises `runPlan({ fetch: false })`, which returns before touching Postgres at all.
 */

interface Stats {
  docReads: number;
  countReads: number;
}

class FakeQuery implements FirestoreQueryLike {
  constructor(
    private readonly allDocs: readonly FirestoreDocLike[],
    private readonly stats: Stats,
  ) {}
  orderBy(): FirestoreQueryLike {
    return this;
  }
  startAfter(): FirestoreQueryLike {
    return this;
  }
  limit(): FirestoreQueryLike {
    return this;
  }
  async get(): Promise<FirestoreQuerySnapshotLike> {
    this.stats.docReads++;
    return { docs: this.allDocs, empty: this.allDocs.length === 0 };
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

// -----------------------------------------------------------------------------------------
// invariant 7 — a plan with no targets is rejected, naming the problem
// -----------------------------------------------------------------------------------------

describe('invariant 7 — planCapture rejects a plan with no targets, naming the problem', () => {
  it('throws PlanError when no stores are given', () => {
    expect(() => planCapture({ storeCodes: [], collections: ['journal'] })).toThrow(PlanError);
    expect(() => planCapture({ storeCodes: [], collections: ['journal'] })).toThrow(/no store named/);
  });

  it('throws PlanError when no collections are given', () => {
    expect(() => planCapture({ storeCodes: ['STORE-A'], collections: [] })).toThrow(PlanError);
    expect(() => planCapture({ storeCodes: ['STORE-A'], collections: [] })).toThrow(/no collection named/);
  });

  it('throws PlanError when NEITHER is given', () => {
    expect(() => planCapture({ storeCodes: [], collections: [] })).toThrow(PlanError);
  });

  it('a well-formed plan produces the cross product of stores x collections', () => {
    const plan = planCapture({ storeCodes: ['A', 'B'], collections: ['journal', 'expenses'] });
    expect(plan.targets).toEqual([
      { storeCode: 'A', collectionPath: 'stores/A/journal' },
      { storeCode: 'A', collectionPath: 'stores/A/expenses' },
      { storeCode: 'B', collectionPath: 'stores/B/journal' },
      { storeCode: 'B', collectionPath: 'stores/B/expenses' },
    ]);
  });

  it('Contract §4 — "--store all" is explicitly rejected, not silently swept in', () => {
    expect(() => planCapture({ storeCodes: ['all'], collections: ['journal'] })).toThrow(/--store all/);
  });
});

// -----------------------------------------------------------------------------------------
// invariant 8 — count mode issues one count() per target and reads zero documents
// -----------------------------------------------------------------------------------------

describe('invariant 8 — count mode issues one count() per target and reads zero documents', () => {
  it('calls count() exactly once per target and never calls the document-listing get()', async () => {
    const firestore = new FakeFirestore();
    firestore.setCollection('stores/A/journal', [{ id: 'j1', ref: { path: 'x' }, data: () => ({}) }]);
    firestore.setCollection('stores/A/expenses', []);
    const plan = planCapture({ storeCodes: ['A'], collections: ['journal', 'expenses'] });

    const counts = await countTargets(plan, firestore);

    expect(counts).toEqual([
      { storeCode: 'A', collectionPath: 'stores/A/journal', count: 1 },
      { storeCode: 'A', collectionPath: 'stores/A/expenses', count: 0 },
    ]);
    expect(firestore.stats.countReads).toBe(2);
    expect(firestore.stats.docReads).toBe(0);
  });

  it('formatCountTable prints every target and a total', () => {
    const table = formatCountTable([
      { storeCode: 'A', collectionPath: 'stores/A/journal', count: 3 },
      { storeCode: 'A', collectionPath: 'stores/A/expenses', count: 5 },
    ]);
    expect(table).toContain('stores/A/journal');
    expect(table).toContain('stores/A/expenses');
    expect(table).toMatch(/TOTAL\s+8/);
  });
});

// -----------------------------------------------------------------------------------------
// invariant 9 — --fetch is required to read; without it the plan reports and stops
// -----------------------------------------------------------------------------------------

describe('invariant 9 — --fetch is required to read; without it the plan reports and stops', () => {
  it('runPlan({fetch:false}) counts, reports, and returns WITHOUT ever reading a document', async () => {
    const firestore = new FakeFirestore();
    firestore.setCollection('stores/A/journal', [
      { id: 'j1', ref: { path: 'stores/A/journal/j1' }, data: () => ({}) },
      { id: 'j2', ref: { path: 'stores/A/journal/j2' }, data: () => ({}) },
    ]);
    const plan = planCapture({ storeCodes: ['A'], collections: ['journal'] });

    const result = await runPlan(plan, firestore, 'erp_v1', { fetch: false });

    expect(result.fetched).toBe(false);
    expect(result.captureResult).toBeUndefined();
    expect(result.counts).toEqual([{ storeCode: 'A', collectionPath: 'stores/A/journal', count: 2 }]);
    expect(firestore.stats.docReads).toBe(0); // the point of this invariant
    expect(firestore.stats.countReads).toBe(1);
  });
});

// -----------------------------------------------------------------------------------------
// Safety — invariant 12, restated (see reader.test.ts for the primary copy)
// -----------------------------------------------------------------------------------------

describe('Safety', () => {
  it('invariant 12 — @shareat/etl-firestore itself is the ONLY package depending on firebase-admin here', () => {
    // Restates the isolation invariant 22/12 protects from the other direction: this
    // package's OWN package.json is exactly where firebase-admin is allowed to live.
    const pkgPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toContain('firebase-admin');
  });
});
