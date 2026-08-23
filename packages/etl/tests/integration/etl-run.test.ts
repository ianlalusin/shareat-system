import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves docs/tasks/112-etl-framework.md's 22 invariants against a real PostgreSQL
 * (bible §9 rule 3) — the landing/run/quarantine/reconciliation invariants (1-18) and
 * the three-mode invariants (19-21) that only make sense against a live database.
 * Invariant 22 (no Firebase dependency) is structural and lives in reconcile.test.ts
 * alongside the pure computation tests (no database needed for it either).
 *
 * Lives under tests/integration/ (same reason replay.test.ts does — vitest's "unit"
 * project runs BEFORE migrations exist in CI).
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

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { etlRepo } from '../../../db/src';
import { runAnalyze, runCaptureMode, runLoad } from '../../src/run';
import type { ClassifyOutcome } from '../../src/reconcile';
import { FixtureReader, type SourceDocument, type SourceReader } from '../../src/source-reader';

const sql = postgres(url, { max: 2 });

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** A SourceReader every method of which throws — invariant 20's proof that `analyze`
 *  never touches it. */
class ThrowingReader implements SourceReader {
  readonly sourceSystem = 'erp_v1';
  async listCollections(): Promise<readonly string[]> {
    throw new Error('ThrowingReader.listCollections should NEVER be called in analyze/load mode');
  }
  // eslint-disable-next-line require-yield -- deliberate: must throw before yielding anything.
  async *readDocuments(): AsyncIterable<SourceDocument> {
    throw new Error('ThrowingReader.readDocuments should NEVER be called in analyze/load mode');
  }
}
const throwingReader = new ThrowingReader();

let orgId: string;

async function insertOrg(hint: string): Promise<string> {
  const code = `etl-${hint}`;
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function resetTables() {
  await sql`
    truncate table
      etl_reconciliation, etl_quarantine, etl_source_documents, etl_runs,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

beforeEach(async () => {
  await resetTables();
  orgId = await insertOrg('t112');
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into stores (org_id, code, name) values (${orgId}, ${'STORE-A'}, ${'Store A'})`;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${'2026-01-01'}, ${'2026-01-31'}, 'open')
  `;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

function doc(overrides: Partial<SourceDocument> & { docId: string }): SourceDocument {
  return {
    docPath: `stores/STORE-A/salesDays/${overrides.docId}`,
    collectionPath: 'stores/STORE-A/salesDays',
    storeCode: 'STORE-A',
    payload: { totalSales: 100 },
    ...overrides,
  };
}

// =========================================================================================
// Landing — invariants 1-5
// =========================================================================================

describe('landing — invariants 1-5', () => {
  it('invariant 1 — a new document lands as one row carrying a content hash', async () => {
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'd1', payload: { totalSales: 100, note: 'a' } })],
    });
    const result = await runCaptureMode({ sourceSystem: 'erp_v1', reader });
    expect(result.perCollection).toEqual([
      { collectionPath: 'stores/STORE-A/salesDays', sourceCount: 1, landedCount: 1, newlyLanded: 1 },
    ]);

    const rows = await sql`select content_hash from etl_source_documents where doc_path = ${'stores/STORE-A/salesDays/d1'}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('invariant 2 — re-landing the byte-identical document inserts NO new row, and the run reports it unchanged', async () => {
    const payload = { totalSales: 100, note: 'a' };
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'd1', payload })],
    });
    await runCaptureMode({ sourceSystem: 'erp_v1', reader });
    const second = await runCaptureMode({ sourceSystem: 'erp_v1', reader });

    expect(second.perCollection).toEqual([
      { collectionPath: 'stores/STORE-A/salesDays', sourceCount: 1, landedCount: 1, newlyLanded: 0 },
    ]);
    const rows = await sql`select id from etl_source_documents where doc_path = ${'stores/STORE-A/salesDays/d1'}`;
    expect(rows).toHaveLength(1);
  });

  it('invariant 3 — canonical hashing: the same document with keys reordered hashes IDENTICALLY, no phantom change', async () => {
    const readerA = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'd1', payload: { a: 1, b: 2, c: { x: 1, y: 2 } } })],
    });
    await runCaptureMode({ sourceSystem: 'erp_v1', reader: readerA });

    const readerB = new FixtureReader('erp_v1', {
      // Same document, keys in a different order at every level.
      'stores/STORE-A/salesDays': [doc({ docId: 'd1', payload: { c: { y: 2, x: 1 }, b: 2, a: 1 } })],
    });
    const second = await runCaptureMode({ sourceSystem: 'erp_v1', reader: readerB });

    expect(second.perCollection[0]!.newlyLanded).toBe(0); // no phantom "changed" row
    const rows = await sql`select id from etl_source_documents where doc_path = ${'stores/STORE-A/salesDays/d1'}`;
    expect(rows).toHaveLength(1);
  });

  it('invariant 4 — a CHANGED document inserts a second row; both survive; "current" resolves to the later one', async () => {
    const reader1 = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'd1', payload: { totalSales: 100 } })],
    });
    await runCaptureMode({ sourceSystem: 'erp_v1', reader: reader1 });

    // Ensure a real time gap so captured_at strictly orders (uuidv7 + defaultNow() both
    // sort correctly even at equal millisecond resolution, but a real gap removes any doubt).
    await new Promise((r) => setTimeout(r, 5));

    const reader2 = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'd1', payload: { totalSales: 250 } })],
    });
    const second = await runCaptureMode({ sourceSystem: 'erp_v1', reader: reader2 });
    expect(second.perCollection[0]!.newlyLanded).toBe(1);

    const rows = await sql`
      select payload from etl_source_documents where doc_path = ${'stores/STORE-A/salesDays/d1'} order by captured_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload).toEqual({ totalSales: 100 });
    expect(rows[1]!.payload).toEqual({ totalSales: 250 });

    // "Current" resolves to the LATER row via a query, not a maintained flag.
    const current = await sql.begin(async (trx) => {
      // Exercised through the real repo function via @shareat/db's transaction() would
      // need the app's own pool; here we prove the same DISTINCT-ON semantics directly,
      // matching repo/etl.ts's findCurrentDocument.
      return trx`
        select distinct on (doc_path) payload from etl_source_documents
        where source_system = 'erp_v1' and doc_path = ${'stores/STORE-A/salesDays/d1'}
        order by doc_path, captured_at desc
      `;
    });
    expect(current[0]!.payload).toEqual({ totalSales: 250 });
  });

  it('invariant 5 — the framework never UPDATEs or DELETEs a landed row (structural)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const repoPath = path.join(
      path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
      '..',
      '..',
      '..',
      'db',
      'src',
      'repo',
      'etl.ts',
    );
    const src = fs.readFileSync(repoPath, 'utf8');
    expect(src).not.toMatch(/\.update\(etlSourceDocuments/);
    expect(src).not.toMatch(/\.delete\(etlSourceDocuments/);
  });
});

// =========================================================================================
// Runs — invariants 6-9
// =========================================================================================

describe('runs — invariants 6-9', () => {
  it('invariant 6 — a run records start, finish and status', async () => {
    const reader = new FixtureReader('erp_v1', { 'stores/STORE-A/salesDays': [doc({ docId: 'd1' })] });
    const { runId } = await runCaptureMode({ sourceSystem: 'erp_v1', reader, startedBy: 'test-suite' });

    const [row] = await sql`select status, started_at, finished_at, started_by from etl_runs where id = ${runId}`;
    expect(row!.status).toBe('succeeded');
    expect(row!.started_at).toBeTruthy();
    expect(row!.finished_at).toBeTruthy();
    expect(row!.started_by).toBe('test-suite');
  });

  it('invariant 7 — a run whose body throws is finalised FAILED with the error recorded, never left running', async () => {
    const converter: (doc: unknown) => ClassifyOutcome = () => {
      throw new Error('deliberate converter failure for invariant 7');
    };
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'd1' })],
    });
    await runCaptureMode({ sourceSystem: 'erp_v1', reader });

    await expect(
      runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: converter }),
    ).rejects.toThrow(/deliberate converter failure/);

    const rows = await sql`select status, error from etl_runs where source_system = 'erp_v1' and mode = 'analyze'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toMatch(/deliberate converter failure/);
  });

  it('invariant 8/9 — a second run of the same (source_system, mode) is rejected while one is running; finishing releases the lock', async () => {
    const { id: firstRunId } = await etlRepo.startRun({ sourceSystem: 'erp_v1', mode: 'capture' });

    await expect(etlRepo.startRun({ sourceSystem: 'erp_v1', mode: 'capture' })).rejects.toThrow(
      /already running/,
    );

    await etlRepo.finishRun(firstRunId, 'succeeded');

    // The lock is released — a clean new run starts without error.
    const reader = new FixtureReader('erp_v1', { 'stores/STORE-A/salesDays': [doc({ docId: 'd1' })] });
    await expect(runCaptureMode({ sourceSystem: 'erp_v1', reader })).resolves.toBeTruthy();
  });
});

// =========================================================================================
// Quarantine — invariants 10-13
// =========================================================================================

describe('quarantine — invariants 10-13', () => {
  async function landOneDoc(): Promise<void> {
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'q1', payload: { totalSales: 100 } })],
    });
    await runCaptureMode({ sourceSystem: 'erp_v1', reader });
  }

  it('invariant 10/11 — an unconvertible document quarantines with a reason CODE and a detail; GROUP BY reason_code returns usable counts', async () => {
    await landOneDoc();
    const converter: (d: { docPath: string }) => ClassifyOutcome = () => ({
      sourceType: 'sale',
      caseClass: 'sale.branch_sale',
      status: 'quarantined',
      reasonCode: 'unsupported_case_class',
      reasonDetail: 'branch sale posting is not implemented yet',
    });
    await runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: converter });

    const rows = await sql`
      select doc_path, source_type, case_class, reason_code, reason_detail, resolved_at
      from etl_quarantine where source_system = 'erp_v1'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('unsupported_case_class');
    expect(rows[0]!.reason_detail).toMatch(/branch sale/);
    expect(rows[0]!.resolved_at).toBeNull();

    const grouped = await sql`
      select reason_code, count(*)::int as n from etl_quarantine where source_system = 'erp_v1' group by reason_code
    `;
    expect(grouped).toEqual([{ reason_code: 'unsupported_case_class', n: 1 }]);
  });

  it('invariant 12 — a re-run that now converts a previously quarantined document RESOLVES the row, recording the resolving run, never deleting it', async () => {
    await landOneDoc();
    const quarantiningConverter: (d: { docPath: string }) => ClassifyOutcome = () => ({
      sourceType: 'sale',
      caseClass: null,
      status: 'quarantined',
      reasonCode: 'unmapped',
      reasonDetail: 'no mapping yet',
    });
    await runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: quarantiningConverter });

    const convertingConverter: (d: { docPath: string }) => ClassifyOutcome = () => ({
      sourceType: 'sale',
      caseClass: null,
      status: 'converted',
      entries: [
        {
          entryDate: '2026-01-05',
          sourceType: 'sale',
          sourceId: 'q1',
          idempotencyKey: 'etl:q1',
          memo: null,
          lines: [
            { accountCode: '1110', debit: '100.00' },
            { accountCode: '4100', credit: '100.00' },
          ],
        },
      ],
    });
    const { runId: resolvingRunId } = await runAnalyze({
      sourceSystem: 'erp_v1',
      reader: throwingReader,
      convert: convertingConverter,
    });

    const rows = await sql`
      select resolved_at, resolved_run_id from etl_quarantine where source_system = 'erp_v1' and doc_path = ${'stores/STORE-A/salesDays/q1'}
    `;
    expect(rows).toHaveLength(1); // never deleted
    expect(rows[0]!.resolved_at).not.toBeNull();
    expect(rows[0]!.resolved_run_id).toBe(resolvingRunId);
  });

  it('invariant 13 — a STILL-unconvertible document advances last_seen_at instead of inserting a duplicate', async () => {
    await landOneDoc();
    const converter: (d: { docPath: string }) => ClassifyOutcome = () => ({
      sourceType: 'sale',
      caseClass: null,
      status: 'quarantined',
      reasonCode: 'unmapped',
      reasonDetail: 'no mapping yet',
    });
    await runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: converter });
    const [first] = await sql`select id, first_seen_at, last_seen_at from etl_quarantine where source_system = 'erp_v1'`;

    await new Promise((r) => setTimeout(r, 5));
    await runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: converter });

    const rows = await sql`select id, first_seen_at, last_seen_at from etl_quarantine where source_system = 'erp_v1'`;
    expect(rows).toHaveLength(1); // no duplicate row
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.first_seen_at).toEqual(first!.first_seen_at); // unchanged
    expect(new Date(rows[0]!.last_seen_at).getTime()).toBeGreaterThan(new Date(first!.last_seen_at).getTime());
  });
});

// =========================================================================================
// Reconciliation — invariants 14-18 (14/15/17 are unit-tested directly in
// reconcile.test.ts; this section proves 16 with a REAL land failure, and 18 — persisted
// and readable after the process exits).
// =========================================================================================

describe('reconciliation — invariants 16 and 18', () => {
  it('invariant 16 — a genuine land failure (an unhashable document) makes source_count != landed_count and FAILS the run', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws on this — a real, reproducible land failure
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [
        doc({ docId: 'ok-1', payload: { totalSales: 1 } }),
        doc({ docId: 'bad-1', payload: circular }),
        doc({ docId: 'ok-2', payload: { totalSales: 2 } }),
      ],
    });

    await expect(runCaptureMode({ sourceSystem: 'erp_v1', reader })).rejects.toThrow(
      /source_count \(3\) != landed_count \(2\)/,
    );

    const runRows = await sql`select status, error from etl_runs where source_system = 'erp_v1' and mode = 'capture'`;
    expect(runRows[0]!.status).toBe('failed');
    expect(runRows[0]!.error).toMatch(/source_count \(3\) != landed_count \(2\)/);

    // The 2 landable documents still landed — a partial capture failure does not roll
    // back documents that landed fine.
    const landed = await sql`select doc_path from etl_source_documents where source_system = 'erp_v1'`;
    expect(landed).toHaveLength(2);
  });

  it('invariant 18 — reconciliation is persisted per (run, source_type) and readable after the run — including a FAILED run', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId: 'bad-1', payload: circular })],
    });
    let runId = '';
    try {
      await runCaptureMode({ sourceSystem: 'erp_v1', reader });
    } catch {
      // expected — the reconciliation row is still the point of this test
    }
    const runRows = await sql`select id from etl_runs where source_system = 'erp_v1' and mode = 'capture'`;
    runId = runRows[0]!.id;

    const reconRows = await sql`
      select source_type, source_count, landed_count from etl_reconciliation where run_id = ${runId}
    `;
    expect(reconRows).toEqual([
      { source_type: 'stores/STORE-A/salesDays', source_count: 1, landed_count: 0 },
    ]);
  });
});

// =========================================================================================
// Modes — invariants 19-21
// =========================================================================================

describe('modes — invariants 19-21', () => {
  async function landConvertibleDoc(docId: string): Promise<void> {
    const reader = new FixtureReader('erp_v1', {
      'stores/STORE-A/salesDays': [doc({ docId, payload: { totalSales: 100 } })],
    });
    await runCaptureMode({ sourceSystem: 'erp_v1', reader });
  }

  function convertibleConverter(docId: string): (d: { docPath: string }) => ClassifyOutcome {
    return (d) => ({
      sourceType: 'sale',
      caseClass: 'sale.dine_in_unli.plain',
      status: 'converted',
      entries: [
        {
          entryDate: '2026-01-05',
          sourceType: 'sale',
          sourceId: docId,
          idempotencyKey: `etl:${d.docPath}`,
          memo: null,
          lines: [
            { accountCode: '1110', debit: '100.00' },
            { accountCode: '4100', credit: '100.00' },
          ],
        },
      ],
    });
  }

  it('invariant 19 — analyze posts NOTHING; journal_entries is unchanged across the run', async () => {
    await landConvertibleDoc('m1');
    const before = await sql`select count(*)::int as n from journal_entries`;

    await runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: convertibleConverter('m1') });

    const after = await sql`select count(*)::int as n from journal_entries`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(after[0]!.n).toBe(0);
  });

  it('invariant 20 — analyze completes with a reader that throws on EVERY method, proving it works purely from landed data', async () => {
    await landConvertibleDoc('m2');
    // throwingReader's listCollections/readDocuments both throw synchronously/on iteration
    // — if runAnalyze ever called either, this test would reject with that error instead
    // of resolving.
    await expect(
      runAnalyze({ sourceSystem: 'erp_v1', reader: throwingReader, convert: convertibleConverter('m2') }),
    ).resolves.toBeTruthy();
  });

  it('invariant 21 — a repeated load run posts NO duplicate entries', async () => {
    await landConvertibleDoc('m3');
    const converter = convertibleConverter('m3');

    const first = await runLoad({
      sourceSystem: 'erp_v1',
      reader: throwingReader,
      convert: converter,
      orgId,
    });
    expect(first.tallies[0]!.entriesPosted).toBe(1);

    const second = await runLoad({
      sourceSystem: 'erp_v1',
      reader: throwingReader,
      convert: converter,
      orgId,
    });
    expect(second.tallies[0]!.entriesPosted).toBe(0); // idempotent — nothing NEW posted

    const entries = await sql`select id from journal_entries where source_type = 'sale' and source_id = 'm3'`;
    expect(entries).toHaveLength(1); // no duplicate

    const dupes = await sql`
      select idempotency_key, count(*)::int as n from journal_entries
      where org_id = ${orgId} and idempotency_key is not null group by idempotency_key having count(*) > 1
    `;
    expect(dupes).toEqual([]);
  });

  it('load mode actually posts a real, constraint-satisfying entry to Postgres', async () => {
    await landConvertibleDoc('m4');
    await runLoad({
      sourceSystem: 'erp_v1',
      reader: throwingReader,
      convert: convertibleConverter('m4'),
      orgId,
    });

    const rows = await sql`
      select je.status, jl.debit, jl.credit from journal_entries je
      join journal_lines jl on jl.entry_id = je.id
      where je.org_id = ${orgId} and je.source_type = 'sale' and je.source_id = 'm4'
      order by jl.line_no
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.debit).toBe('100.00');
    expect(rows[1]!.credit).toBe('100.00');
  });
});

// =========================================================================================
// DEF-041 — landing immutability, enforced by the DATABASE (migration 0009)
//
// Invariant 5 above proves our own repo code never calls update/delete on the landing
// table. That is a fact about OUR code, and bible §15 / RULES.md §6.3 are explicit that
// the database enforces the rules — a rule phrased as "our code does not do X" is a
// convention, not a constraint. Verified empirically before 0009 was written: a plain
// UPDATE rewrote a landed payload and a plain DELETE removed the row, silently.
//
// It matters more than the original phrasing implied. The entire "land before you convert"
// argument rests on the September bytes being the December bytes; a payload that can be
// silently rewritten destroys that WITHOUT A SIGNAL — reconciliation still balances, every
// count still ties, and the audit report quietly describes data that no longer exists.
// =========================================================================================

describe('DEF-041 — the landing table is immutable in the database', () => {
  async function landOne(hash: string, payload: Record<string, number>): Promise<string> {
    const [run] = await sql<{ id: string }[]>`
      insert into etl_runs (source_system, mode, status)
      values ('erp_v1', 'capture', 'running') returning id
    `;
    await sql`
      insert into etl_source_documents
        (run_id, source_system, collection_path, doc_path, doc_id, payload, content_hash)
      values
        (${run!.id}, 'erp_v1', 'c', 'stores/STORE-A/salesDays/2026-01-05', '2026-01-05',
         ${sql.json(payload)}, ${hash})
    `;
    return run!.id;
  }

  it('raw SQL cannot UPDATE a landed payload, even outside the framework', async () => {
    await landOne('hash-a', { totalSales: 100 });
    await expect(
      sql`update etl_source_documents set payload = ${sql.json({ totalSales: 999_999 })}`,
    ).rejects.toThrow(/append-only/i);

    const [row] = await sql<{ payload: { totalSales: number } }[]>`
      select payload from etl_source_documents
    `;
    expect(row!.payload.totalSales, 'the original bytes must be untouched').toBe(100);
  });

  it('raw SQL cannot DELETE a landed row', async () => {
    await landOne('hash-b', { totalSales: 100 });
    await expect(sql`delete from etl_source_documents`).rejects.toThrow(/append-only/i);
    const [count] = await sql<{ c: number }[]>`select count(*)::int c from etl_source_documents`;
    expect(count!.c).toBe(1);
  });

  it('INSERT stays open — a CHANGED source document re-lands as a new row beside the old', async () => {
    // The point of the trigger is append-only, NOT frozen. Re-landing a changed document is
    // the designed behaviour (invariant 4) and must not be collateral damage of the fix.
    const runId = await landOne('hash-c', { totalSales: 100 });
    await sql`
      insert into etl_source_documents
        (run_id, source_system, collection_path, doc_path, doc_id, payload, content_hash)
      values
        (${runId}, 'erp_v1', 'c', 'stores/STORE-A/salesDays/2026-01-05', '2026-01-05',
         ${sql.json({ totalSales: 250 })}, 'hash-c2')
    `;
    const [count] = await sql<{ c: number }[]>`select count(*)::int c from etl_source_documents`;
    expect(count!.c, 'both versions coexist — history is added to, never overwritten').toBe(2);
  });

  it('the error names the document, so an operator can act on it', async () => {
    await landOne('hash-d', { totalSales: 100 });
    await expect(sql`update etl_source_documents set doc_id = 'x'`).rejects.toThrow(
      /stores\/STORE-A\/salesDays\/2026-01-05/,
    );
  });
});
