import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Integration test for docs/tasks/114a-firestore-reader-and-capture.md invariant 14 —
 * "A planned fetch through runCaptureMode lands documents, and re-running lands nothing
 * new." Real Postgres, FAKE Firestore (no network, no credential — same discipline as every
 * other test in this package; the only thing "integration" about this file is the database).
 *
 * Lives under tests/integration/ (same reason packages/etl/tests/integration/etl-run.test.ts
 * does — vitest's "unit" project runs BEFORE migrations exist in CI).
 *
 * Not explicitly named in the task spec's Scope file tree (which lists only
 * tests/plan.test.ts and tests/reader.test.ts) — added because the spec's own Invariants
 * section requires proving invariant 14 against real Postgres, and neither of those two
 * files can do that without becoming DB-touching unit tests (excluded from vitest's "unit"
 * project by convention). Reported explicitly rather than added silently — RULES.md §3.4a.
 */
config({ path: '../../../.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { planCapture, runPlan } from '../../src/plan';
import type {
  FirestoreAggregateQueryLike,
  FirestoreClientLike,
  FirestoreDocLike,
  FirestoreQueryLike,
  FirestoreQuerySnapshotLike,
} from '../../src/reader';

const sql = postgres(url, { max: 2 });

// ---------------------------------------------------------------------------------------
// The same small fake Firestore surface as tests/reader.test.ts and tests/plan.test.ts,
// duplicated deliberately: this file must stay self-contained under tests/integration/.
// ---------------------------------------------------------------------------------------

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
  orderBy(): FirestoreQueryLike {
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

async function resetTables(): Promise<void> {
  await sql`truncate table etl_reconciliation, etl_quarantine, etl_source_documents, etl_runs restart identity cascade`;
}

beforeEach(resetTables);

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('invariant 14 — a planned fetch through runCaptureMode lands documents, and re-running lands nothing new', () => {
  it('runPlan({fetch:true}) lands every document from the fake Firestore surface into Postgres, content-hashed', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/journal';
    firestore.setCollection(path, [fakeDoc(path, 'j1', { amount: 100 }), fakeDoc(path, 'j2', { amount: 200 })]);
    const plan = planCapture({ storeCodes: ['STORE-A'], collections: ['journal'] });

    const first = await runPlan(plan, firestore, 'erp_v1', { fetch: true, startedBy: 'test-suite' });

    expect(first.fetched).toBe(true);
    expect(first.captureResult!.perCollection).toEqual([
      { collectionPath: path, sourceCount: 2, landedCount: 2, newlyLanded: 2 },
    ]);

    const rows = await sql`
      select doc_path, content_hash from etl_source_documents
      where source_system = 'erp_v1' order by doc_path
    `;
    expect(rows.map((r) => r.doc_path)).toEqual(['stores/STORE-A/journal/j1', 'stores/STORE-A/journal/j2']);
    for (const row of rows) {
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('re-running the SAME plan against UNCHANGED source data lands nothing new', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/expenses';
    firestore.setCollection(path, [fakeDoc(path, 'e1', { amount: 50 })]);
    const plan = planCapture({ storeCodes: ['STORE-A'], collections: ['expenses'] });

    await runPlan(plan, firestore, 'erp_v1', { fetch: true });
    const second = await runPlan(plan, firestore, 'erp_v1', { fetch: true });

    expect(second.captureResult!.perCollection).toEqual([
      { collectionPath: path, sourceCount: 1, landedCount: 1, newlyLanded: 0 },
    ]);

    const rows = await sql`select count(*)::int as n from etl_source_documents where source_system = 'erp_v1'`;
    expect(rows[0]!.n).toBe(1); // no duplicate row
  });

  it('--limit caps what actually lands, end to end through Postgres', async () => {
    const firestore = new FakeFirestore();
    const path = 'stores/STORE-A/journal';
    firestore.setCollection(
      path,
      Array.from({ length: 5 }, (_, i) => fakeDoc(path, `doc-${String(i + 1).padStart(2, '0')}`, { n: i })),
    );
    const plan = planCapture({ storeCodes: ['STORE-A'], collections: ['journal'] });

    const result = await runPlan(plan, firestore, 'erp_v1', { fetch: true, limitPerCollection: 3, pageSize: 2 });

    expect(result.captureResult!.perCollection[0]!.landedCount).toBe(3);
    const rows = await sql`select doc_path from etl_source_documents where source_system = 'erp_v1' order by doc_path`;
    expect(rows).toHaveLength(3);
  });
});
