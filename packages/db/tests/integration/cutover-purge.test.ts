import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-119 — the purge, proven against real PostgreSQL.
 *
 * The invariant that matters most is 14: a violated post-condition ROLLS THE WHOLE THING
 * BACK. This runs once, on a busy day, against a database that cannot be un-purged without
 * a restore — so "it mostly worked" is not an available outcome, and the test that proves
 * the abort path is worth more than the one that proves the happy path.
 */
config({ path: '../../../.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import {
  CUTOVER_CLASSIFICATION,
  tablesInClass,
  type CutoverEntry,
} from '../../src/cutover/classification';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

const sql = postgres(url, { max: 2 });

let orgId: string;

async function reset(): Promise<void> {
  await sql`
    truncate table
      etl_reconciliation, etl_quarantine, etl_source_documents, etl_runs,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values ('Purge Test', 'purge-test') returning id
  `;
  orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into stores (org_id, code, name) values (${orgId}, 'S1', 'Store One')`;
  // Two periods: one 2026 (purged by date scope) and one 2027 (kept).
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgId}, '2026-11-01', '2026-11-30', 'open')`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
}

/** Mirrors the script's transaction. Kept here so the abort path can be exercised directly. */
async function runPurge(opts: { asOf: string; sabotage?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const purgeTables = tablesInClass('purge').filter((t) => {
    const nb = (CUTOVER_CLASSIFICATION[t] as { notBefore?: string }).notBefore;
    return !nb || opts.asOf >= nb;
  });
  const order = ['audit_log', 'journal_lines', 'journal_entries'].filter((t) => purgeTables.includes(t));
  const keepTables = tablesInClass('keep');
  const before = new Map<string, number>();
  for (const t of [...purgeTables, ...keepTables]) {
    const [r] = await sql<{ c: number }[]>`select count(*)::int c from ${sql(t)}`;
    before.set(t, r?.c ?? 0);
  }

  try {
    await sql.begin(async (tx) => {
      for (const t of order) await tx`delete from ${tx(t)}`;
      for (const t of tablesInClass('date_scoped')) {
        const e = CUTOVER_CLASSIFICATION[t] as Extract<CutoverEntry, { class: 'date_scoped' }>;
        await tx`delete from ${tx(t)} where ${tx(e.dateColumn)} < ${e.keepFrom}`;
      }

      // Invariant 14's lever: delete from a KEEP table so its post-condition must fail.
      // ⚠️ money_accounts first. Since T-142 every store is born with five foundation accounts,
      // and they FK to stores — so deleting stores alone now raises a FOREIGN KEY error before
      // the post-condition below can run, which would test the wrong failure. Both are KEEP
      // tables, so the lever still means what it meant: a KEEP table lost rows.
      if (opts.sabotage) {
        await tx`delete from money_accounts`;
        await tx`delete from stores`;
      }

      const problems: string[] = [];
      for (const t of order) {
        const [r] = await tx<{ c: number }[]>`select count(*)::int c from ${tx(t)}`;
        if ((r?.c ?? -1) !== 0) problems.push(`${t} still has rows`);
      }
      for (const t of keepTables) {
        const [r] = await tx<{ c: number }[]>`select count(*)::int c from ${tx(t)}`;
        if ((r?.c ?? -1) !== before.get(t)) problems.push(`${t} changed — a KEEP table must be untouched`);
      }
      if (problems.length > 0) throw new Error('POST-CONDITION FAILED: ' + problems.join('; '));
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

beforeEach(reset);
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-119 — the cutover purge', () => {
  it('empties every purge-class table and leaves every keep-class table untouched', async () => {
    // ONE transaction, draft-first. The balance and min-two-lines rules are DEFERRED
    // constraint triggers that fire at COMMIT, so inserting the entry in its own statement
    // commits it alone with zero lines and is correctly rejected. This is the canonical
    // ordering postEntry uses (T-105 §2) and the reason it exists.
    await sql.begin(async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, status)
        select ${orgId}, '2026-11-15', p.id, 'expense', 'x1', 'k1', 'draft'
        from fiscal_periods p where p.starts_on = '2026-11-01' returning id
      `;
      const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1110'`;
      const [cogs] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '5100'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit)
               values (${entry!.id}, 1, ${cogs!.id}, '100.00', '0'), (${entry!.id}, 2, ${cash!.id}, '0', '100.00')`;
    });

    const accountsBefore = (await sql<{ c: number }[]>`select count(*)::int c from accounts`)[0]!.c;
    const storesBefore = (await sql<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c;

    const result = await runPurge({ asOf: '2027-01-01' });
    expect(result.ok, result.error).toBe(true);

    expect((await sql<{ c: number }[]>`select count(*)::int c from journal_lines`)[0]!.c).toBe(0);
    expect((await sql<{ c: number }[]>`select count(*)::int c from journal_entries`)[0]!.c).toBe(0);
    // The chart of accounts must survive byte-identical: the opening entry references these ids.
    expect((await sql<{ c: number }[]>`select count(*)::int c from accounts`)[0]!.c).toBe(accountsBefore);
    expect((await sql<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c).toBe(storesBefore);
  });

  it('date-scoped: keeps 2027 periods, purges 2026 ones', async () => {
    const result = await runPurge({ asOf: '2027-01-01' });
    expect(result.ok, result.error).toBe(true);
    // ::text in SQL, not String(value) in JS. A `date` comes back as a JS Date and renders
    // as "Fri Jan 01 2027 08:00:00 GMT+0800" locally, or shifts to 2026-12-31 under
    // toISOString — the exact class of timezone bug the bible's datetime landmine records.
    // Letting Postgres format it removes the question.
    const rows = await sql<{ d: string }[]>`select starts_on::text d from fiscal_periods order by starts_on`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.d).toBe('2027-01-01');
  });

  it('⭐ invariant 14 — a failing post-condition rolls the WHOLE purge back', async () => {
    const before = {
      entries: (await sql<{ c: number }[]>`select count(*)::int c from fiscal_periods`)[0]!.c,
      stores: (await sql<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c,
    };

    const result = await runPurge({ asOf: '2027-01-01', sabotage: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('POST-CONDITION FAILED');
    expect(result.error).toContain('stores');

    // The whole transaction rolled back — including the 2026 period the date scope had
    // already deleted before the sabotage. A half-purged database is the outcome this
    // design exists to make impossible.
    expect((await sql<{ c: number }[]>`select count(*)::int c from stores`)[0]!.c).toBe(before.stores);
    expect((await sql<{ c: number }[]>`select count(*)::int c from fiscal_periods`)[0]!.c).toBe(before.entries);
  });

  it('the ETL tables are REFUSED before their notBefore date', async () => {
    // ADR-007 §6 — they are the evidence behind the opening balance.
    const onCutover = tablesInClass('purge').filter((t) => {
      const nb = (CUTOVER_CLASSIFICATION[t] as { notBefore?: string }).notBefore;
      return !nb || '2027-01-01' >= nb;
    });
    expect(onCutover).not.toContain('etl_source_documents');
    expect(onCutover).not.toContain('etl_runs');

    const afterSignoff = tablesInClass('purge').filter((t) => {
      const nb = (CUTOVER_CLASSIFICATION[t] as { notBefore?: string }).notBefore;
      return !nb || '2027-01-31' >= nb;
    });
    expect(afterSignoff).toContain('etl_source_documents');
  });

  it('no purge-class table is missing from the classification', async () => {
    // Cross-check against the LIVE database rather than only the Drizzle schema — a table
    // created by a hand-written migration would exist here and not there.
    const live = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name not like 'drizzle%' and table_name not like '__drizzle%'
    `;
    const unclassified = live.map((r) => r.table_name).filter((t) => !(t in CUTOVER_CLASSIFICATION));
    expect(
      unclassified,
      `Live tables with no cutover classification: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });
});
