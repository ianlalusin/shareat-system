import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves docs/tasks/117-replay-harness-stage-a.md's invariants 7, 8 and 9 against a real
 * PostgreSQL (bible §9 rule 3) — replays every specimen committed under packages/etl/corpus/,
 * following packages/db/tests/integration/journal.test.ts's pattern.
 *
 * Lives under tests/integration/ (task Scope + Method step 4's explicit reason: vitest's
 * "unit" project runs BEFORE migrations exist in CI, so a DB-touching test outside this
 * directory would fail on a fresh database with "relation does not exist").
 *
 * seedChartOfAccounts is imported by RELATIVE PATH across the packages/etl -> packages/db
 * boundary rather than through `@shareat/db`'s package.json exports map, because that map
 * only publishes ".", "./schema" and "./client" (Scope explicitly forbids editing
 * packages/db/package.json for this task) — see the task report for why this is judged a
 * reasonable, low-risk choice rather than a workaround to flag as a defect: both packages
 * already compile from source under one `packages/**\/*.ts` tsconfig include, and the
 * existing vitest aliases already resolve every `@shareat/*` specifier straight to source
 * for the same reason.
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
import { convertSpecimen, type ConversionResult, type RawSpecimen } from '../../src/convert';
import { summarizeConversions } from '../../src/report';

const sql = postgres(url, { max: 2 });

// ---------------------------------------------------------------------------------------
// Load the corpus
// ---------------------------------------------------------------------------------------

const corpusRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'corpus');

interface LoadedSpecimen {
  raw: RawSpecimen;
  expected: ConversionResult;
  path: string;
}

function loadCorpus(): LoadedSpecimen[] {
  const specimens: LoadedSpecimen[] = [];
  for (const caseClassDir of readdirSync(corpusRoot)) {
    const dirPath = join(corpusRoot, caseClassDir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.raw.json')) continue;
      const rawPath = join(dirPath, file);
      const expectedPath = rawPath.replace(/\.raw\.json$/, '.expected.json');
      const rawJson = JSON.parse(readFileSync(rawPath, 'utf8'));
      const expectedJson = JSON.parse(readFileSync(expectedPath, 'utf8'));
      const raw: RawSpecimen = {
        specimenId: rawJson.specimenId,
        caseClass: rawJson.caseClass,
        kind: rawJson.kind,
        storeCode: rawJson.storeCode,
        doc: rawJson.doc,
      };
      specimens.push({ raw, expected: expectedJson, path: rawPath });
    }
  }
  return specimens;
}

const corpus = loadCorpus();

// ---------------------------------------------------------------------------------------
// Helpers — same shape as packages/db/tests/integration/journal.test.ts
// ---------------------------------------------------------------------------------------

async function insertOrg(hint: string): Promise<string> {
  const code = `replay-${hint}`;
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function insertStore(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${code}, ${`Store ${code}`})
    returning id
  `;
  return row!.id;
}

async function insertPeriod(orgId: string, startsOn: string, endsOn: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, 'open')
    returning id
  `;
  return row!.id;
}

async function accountIdByCode(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
  if (!row) throw new Error(`seeded account ${code} not found for org ${orgId}`);
  return row.id;
}

async function resetTables() {
  await sql`
    truncate table
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

let orgId: string;
let periodId: string;
const accountCache = new Map<string, string>();
/** storeCode ("STORE-A") -> resolved Postgres stores.id. Populated in beforeAll — every
 *  specimen's storeCode must have a matching row here, or resolveStore throws rather
 *  than silently dropping store scoping. */
const storeByCode = new Map<string, string>();

async function resolveAccount(code: string): Promise<string> {
  const cached = accountCache.get(code);
  if (cached) return cached;
  const id = await accountIdByCode(orgId, code);
  accountCache.set(code, id);
  return id;
}

function resolveStore(code: string | null): string | null {
  if (code === null) return null;
  const id = storeByCode.get(code);
  if (!id) throw new Error(`No fixture store registered for storeCode "${code}" — add it in beforeAll`);
  return id;
}

/**
 * Inserts one converted entry + its lines inside a single real transaction (same
 * requirement as journal.test.ts's insertEntryWithLines — the balance/min-lines
 * constraint is DEFERRED to commit, so entry + all lines must land in one transaction).
 * Uses `ON CONFLICT (org_id, idempotency_key) DO NOTHING` so a second replay of the same
 * corpus is a no-op (invariant 8), never a duplicate or a duplicate-key error.
 */
async function replayEntry(entry: ConversionResult['entries'][number]): Promise<{ inserted: boolean }> {
  return sql.begin(async (trx) => {
    const existing = await trx<{ id: string }[]>`
      select id from journal_entries where org_id = ${orgId} and idempotency_key = ${entry.idempotencyKey}
    `;
    if (existing.length > 0) {
      return { inserted: false };
    }

    const [row] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, memo, source_type, source_id, idempotency_key, status)
      values (${orgId}, ${entry.entryDate}, ${periodId}, ${entry.memo}, ${entry.sourceType}, ${entry.sourceId}, ${entry.idempotencyKey}, 'draft')
      returning id
    `;
    const entryId = row!.id;

    let lineNo = 1;
    for (const l of entry.lines) {
      const accountId = await resolveAccount(l.accountCode);
      const lineStoreId = resolveStore(l.storeCode);
      await trx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, channel_id, debit, credit, line_memo)
        values (${entryId}, ${lineNo}, ${accountId}, ${lineStoreId}, ${l.channelId}, ${l.debit}, ${l.credit}, ${l.lineMemo})
      `;
      lineNo++;
    }
    return { inserted: true };
  });
}

beforeAll(async () => {
  await resetTables();
  orgId = await insertOrg('t117');
  await seedChartOfAccounts(sql, orgId);
  const storeAId = await insertStore(orgId, 'STORE-A');
  storeByCode.set('STORE-A', storeAId);
  periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31');
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------------------

describe('replay harness — the corpus loads', () => {
  it('found at least one specimen per hand-written class (Part 1 sanity check)', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(8);
  });
});

describe('invariant 7 — conversion output matches .expected.json exactly, for every specimen', () => {
  for (const { raw, expected, path } of corpus) {
    it(`${raw.specimenId} (${raw.caseClass})`, () => {
      const actual = convertSpecimen(raw);
      expect(actual, `mismatch against ${path}`).toEqual(expected);
    });
  }
});

describe('invariant 4/9 — every specimen loads cleanly or is classified with a reason; converted entries satisfy T-103 constraints', () => {
  it('classifies the whole corpus and reports findings (never a bare failure)', () => {
    const results = corpus.map(({ raw }) => convertSpecimen(raw));
    const summary = summarizeConversions(results);

    // Every result MUST be one of the three statuses with SOME entries or SOME reason —
    // "never a bare failure" (Contract §4).
    for (const r of results) {
      const hasOutcome = r.status === 'converted' ? r.entries.length > 0 : typeof r.reason === 'string' && r.reason.length > 0;
      expect(hasOutcome, `specimen ${r.specimenId} produced neither entries nor a reason`).toBe(true);
    }

    expect(summary.total).toBe(corpus.length);
    // Part 1's hand-picked corpus: 7 convert cleanly (unli, à la carte, discount, comps,
    // cash expense, AP expense, CAPEX expense), 1 skips (voided sale). None quarantine —
    // every specimen was deliberately engineered to balance to the centavo.
    expect(summary.converted).toBe(7);
    expect(summary.skipped).toBe(1);
    expect(summary.quarantined).toBe(0);
  });

  it('inserts every converted entry into real Postgres and it satisfies every T-103 constraint', async () => {
    const findings: string[] = [];
    let insertedCount = 0;

    for (const { raw } of corpus) {
      const result = convertSpecimen(raw);
      if (result.status !== 'converted') continue;
      for (const entry of result.entries) {
        try {
          const { inserted } = await replayEntry(entry);
          if (inserted) insertedCount++;
        } catch (err) {
          // Invariant 9: a converted entry that fails a real DB constraint is a FINDING
          // about the specimen, reported with the real error — never silently swallowed
          // and never a bare test failure with no context.
          findings.push(`${raw.specimenId}: ${(err as Error).message}`);
        }
      }
    }

    expect(findings, `T-103 constraint violations found:\n${findings.join('\n')}`).toEqual([]);
    expect(insertedCount).toBe(7); // one entry per converted specimen
  });
});

describe('invariant 8 — replaying the corpus twice is idempotent', () => {
  it('produces the same row counts on a second pass, no duplicates', async () => {
    const beforeRows = await sql<{ count: string }[]>`
      select count(*)::int as count from journal_entries where org_id = ${orgId}
    `;
    const beforeCount = beforeRows[0]!.count;

    for (const { raw } of corpus) {
      const result = convertSpecimen(raw);
      if (result.status !== 'converted') continue;
      for (const entry of result.entries) {
        await replayEntry(entry); // second pass — every one of these should be a no-op
      }
    }

    const afterRows = await sql<{ count: string }[]>`
      select count(*)::int as count from journal_entries where org_id = ${orgId}
    `;
    const afterCount = afterRows[0]!.count;
    expect(Number(afterCount)).toBe(Number(beforeCount));

    // And exactly one row per idempotency key — no duplicate ever got past the guard.
    const dupes = await sql<{ idempotency_key: string; n: number }[]>`
      select idempotency_key, count(*)::int as n
      from journal_entries
      where org_id = ${orgId} and idempotency_key is not null
      group by idempotency_key
      having count(*) > 1
    `;
    expect(dupes).toEqual([]);
  });
});

describe('the skipped specimen never touches the ledger', () => {
  it('the voided sales day produced zero journal_entries rows for its source_id', async () => {
    const voided = corpus.find((c) => c.raw.caseClass === 'sale.voided');
    expect(voided).toBeDefined();
    const rows = await sql`
      select id from journal_entries where org_id = ${orgId} and source_type = 'sale' and source_id = ${(voided!.raw.doc as { id: string }).id}
    `;
    expect(rows).toHaveLength(0);
  });
});
