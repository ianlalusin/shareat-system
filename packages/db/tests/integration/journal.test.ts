import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the 19 invariants of docs/tasks/103-journal-tables.md against a real PostgreSQL
 * (PROJECT_BIBLE.md §9 rule 3) — never a mock.
 *
 * This file lives under packages/db/tests/integration/ (task Scope + the task's explicit
 * landmine #3): vitest.config.mts's "integration" project picks up
 * `packages/**\/tests/integration/**\/*.test.ts` and runs `tests/integration/setup.ts`
 * first, which points DATABASE_URL at TEST_DATABASE_URL and refuses to run against
 * anything whose name doesn't contain "_test". The guard below is redundant with that
 * setup file but kept anyway (belt and suspenders, matching chart-of-accounts.test.ts) in
 * case this file is ever run standalone.
 *
 * Written FIRST, before the migration existed, to confirm the initial run fails for the
 * right reason — "relation journal_entries does not exist" — not a typo or a wrong import.
 * See the task report for the actual first-run output.
 *
 * T-118 addendum (docs/tasks/118-subledger-party-on-line.md, closing DEF-037): the
 * "T-118 invariant N" blocks near the end of this file prove the nine numbered
 * invariants of that task — independently numbered from the 19 above, same convention
 * chart-of-accounts.test.ts already uses for its own "T-102b invariant N" section.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

const sql = postgres(url, { max: 2 });

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

let orgSeq = 0;
async function insertOrg(hint: string): Promise<string> {
  const code = `jrnl-${hint}-${++orgSeq}`;
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from accounts where org_id = ${orgId} and code = ${code}
  `;
  if (!row) throw new Error(`seeded account ${code} not found for org ${orgId}`);
  return row.id;
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  status: 'open' | 'closed' | 'locked' = 'open',
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, ${status})
    returning id
  `;
  return row!.id;
}

type LineSpec = {
  accountId: string;
  debit: string;
  credit: string;
  storeId?: string | null;
  channelId?: string | null;
  // T-118: the counterparty, nullable and always both-or-neither (enforced by
  // journal_lines_party_both_or_neither_check).
  partyType?: string | null;
  partyId?: string | null;
};

type EntrySpec = {
  entryDate?: string;
  sourceType?: string;
  sourceId?: string;
  memo?: string | null;
  idempotencyKey?: string | null;
  status?: 'draft' | 'posted' | 'reversed';
  postedAt?: Date | null;
  postedBy?: string | null;
};

/**
 * Inserts one entry plus its lines INSIDE A SINGLE REAL TRANSACTION via postgres.js's
 * `sql.begin()`. This matters: without it, each `sql\`insert...\`` call is its own
 * autocommitted statement, so the deferred balance trigger — deferred to the end of
 * *that statement's own implicit transaction* — would fire (and fail) after inserting
 * just the first line, which would make it impossible to ever write a legitimately
 * balanced multi-line entry through this helper. This is the realistic shape of how an
 * application posts an entry: one transaction, entry + all its lines, then commit.
 */
async function insertEntryWithLines(
  orgId: string,
  periodId: string,
  lines: LineSpec[],
  opts: EntrySpec = {},
): Promise<string> {
  return sql.begin(async (trx) => {
    const [entry] = await trx<{ id: string }[]>`
      insert into journal_entries
        (org_id, entry_date, period_id, memo, source_type, source_id, idempotency_key, status, posted_at, posted_by)
      values
        (${orgId}, ${opts.entryDate ?? '2026-01-15'}, ${periodId}, ${opts.memo ?? null},
         ${opts.sourceType ?? 'test'}, ${opts.sourceId ?? `test-${Date.now()}-${Math.random()}`},
         ${opts.idempotencyKey ?? null}, 'draft', ${opts.postedAt ?? null},
         ${opts.postedBy ?? null})
      returning id
    `;
    const entryId = entry!.id;
    let lineNo = 1;
    for (const line of lines) {
      await trx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, channel_id, debit, credit, party_type, party_id)
        values (${entryId}, ${lineNo}, ${line.accountId}, ${line.storeId ?? null}, ${line.channelId ?? null}, ${line.debit}, ${line.credit}, ${line.partyType ?? null}, ${line.partyId ?? null})
      `;
      lineNo++;
    }

    // DRAFT FIRST, ALWAYS. The entry is created as 'draft' regardless of the caller's
    // requested status, the lines go on, and only then is the status set. Migration 0004
    // (T-105, closing DEF-031) makes it impossible to INSERT a line onto an entry that is
    // not draft — which is the whole point: a posted entry's content can never change.
    //
    // This helper originally inserted the entry at its final status and then added lines.
    // That pattern is now unbuildable, and rightly so: it is exactly the shape DEF-031
    // described. Updated 2026-08-23 rather than weakening the trigger.
    const finalStatus = opts.status ?? 'draft';
    if (finalStatus !== 'draft') {
      await trx`update journal_entries set status = ${finalStatus} where id = ${entryId}`;
    }
    return entryId;
  });
}

/**
 * Creates and commits an already-VALID, balanced two-line entry (line_no 1 and 2), and
 * returns its id. Several "immediate rejection" tests below need a real, already-durable
 * entry to attempt a THIRD, bad line against — they must not create a bare journal_entries
 * row with zero lines as their own standalone autocommitted statement, because (correctly
 * — see the "bonus" zero-lines test) that alone now fails at commit: an entry can never
 * durably exist with fewer than two lines, not even for the lifetime of one statement.
 * Building on top of an already-valid entry cleanly isolates "does this ONE additional line
 * get rejected immediately" from the entry-level balance rule.
 */
async function insertValidEntry(
  orgId: string,
  periodId: string,
  cash: string,
  opex: string,
  sourceId: string,
): Promise<string> {
  return insertEntryWithLines(
    orgId,
    periodId,
    [
      { accountId: opex, debit: '10.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '10.00' },
    ],
    { sourceId },
  );
}

async function resetTables() {
  await sql`
    truncate table
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------------------
// A shared, seeded fixture: one org, an open period, and the chart of accounts.
// ---------------------------------------------------------------------------------------

async function baseFixture(hint: string) {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
  const cash = await accountId(orgId, '1110'); // active, postable asset
  const opex = await accountId(orgId, '6900'); // active, postable expense
  return { orgId, periodId, cash, opex };
}

// =========================================================================================
// Balance and shape (1-8)
// =========================================================================================

describe('invariant 1 — a balanced two-line entry commits', () => {
  it('accepts a debit/credit pair that sums equal', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv1');
    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '100.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '100.00' },
    ]);
    const rows = await sql`select id from journal_entries where id = ${entryId}`;
    expect(rows).toHaveLength(1);
    const lineRows = await sql`select id from journal_lines where entry_id = ${entryId}`;
    expect(lineRows).toHaveLength(2);
  });
});

describe('invariant 2 — a single-line entry is rejected at COMMIT', () => {
  it('rejects an entry with only one line — there is no trivially-balanced escape hatch', async () => {
    const { orgId, periodId, opex } = await baseFixture('inv2');
    await expect(
      insertEntryWithLines(orgId, periodId, [{ accountId: opex, debit: '100.00', credit: '0' }]),
    ).rejects.toThrow();
  });
});

describe('invariant 3 — an unbalanced multi-line entry is rejected at COMMIT', () => {
  it('rejects three lines whose debits and credits do not sum equal', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv3');
    await expect(
      insertEntryWithLines(orgId, periodId, [
        { accountId: opex, debit: '100.00', credit: '0' },
        { accountId: opex, debit: '50.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '100.00' }, // 150 debit vs 100 credit
      ]),
    ).rejects.toThrow();
  });
});

describe('invariant 4 — an entry is legitimately unbalanced mid-transaction, and only fails at COMMIT', () => {
  it('tolerates the first line with no error, then fails at COMMIT and rolls back the whole unit', async () => {
    const { orgId, periodId, opex } = await baseFixture('inv4');

    let firstLineInsertSucceeded = false;
    let entryIdCreated: string | undefined;

    await expect(
      sql.begin(async (trx) => {
        const [entry] = await trx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
          values (${orgId}, '2026-01-15', ${periodId}, 'test', 'inv4-1')
          returning id
        `;
        entryIdCreated = entry!.id;

        // Only ONE line, deliberately. If this INSERT itself throws, the implementation
        // is wrong — the spec says explicitly: "If your implementation rejects the first
        // INSERT of a two-line entry, it is wrong." A single-line entry mid-transaction
        // must be TOLERATED; it only has to be correct at COMMIT.
        await trx`
          insert into journal_lines (entry_id, line_no, account_id, debit, credit)
          values (${entryIdCreated}, 1, ${opex}, '100.00', '0')
        `;
        firstLineInsertSucceeded = true;

        // No second line — the callback resolves here, and postgres.js issues COMMIT,
        // which is exactly where the deferred constraint trigger must fire and fail.
      }),
    ).rejects.toThrow();

    expect(firstLineInsertSucceeded).toBe(true);

    // And prove the whole unit rolled back — the entry itself must not exist either.
    expect(entryIdCreated).toBeDefined();
    const rows = await sql`select id from journal_entries where id = ${entryIdCreated!}`;
    expect(rows).toHaveLength(0);
  });
});

describe('invariant 5 — a line with both debit and credit non-zero is rejected immediately', () => {
  it('fails on the single INSERT itself, not at commit', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv5');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 'inv5-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${opex}, '50.00', '50.00')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 6 — a line with both debit and credit zero is rejected immediately', () => {
  it('fails on the single INSERT itself', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv6');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 'inv6-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${opex}, '0', '0')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 7 — a negative debit or credit is rejected', () => {
  it('rejects a negative debit', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv7a');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 'inv7a-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${opex}, '-1.00', '0')
      `,
    ).rejects.toThrow();
  });

  it('rejects a negative credit', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv7b');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 'inv7b-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${opex}, '0', '-1.00')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 8 — line_no is unique per entry', () => {
  it('rejects a second line reusing the same line_no', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv8');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 'inv8-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 1, ${cash}, '0', '10.00')
      `,
    ).rejects.toThrow();
  });
});

// =========================================================================================
// Eligibility (9-10)
// =========================================================================================

describe('invariant 9 — posting to a header account (is_postable = false) is rejected', () => {
  it('fails immediately on the single INSERT', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv9');
    const header = await accountId(orgId, '1000'); // Assets header, is_postable = false
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 'inv9-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${header}, '10.00', '0')
      `,
    ).rejects.toThrow();
  });
});

describe("invariant 10 — posting to a 'reserved' account is rejected", () => {
  it.each(['2120', '2145', '2250', '4920'])('rejects posting to reserved account %s', async (code) => {
    const { orgId, periodId, cash, opex } = await baseFixture(`inv10-${code}`);
    const reserved = await accountId(orgId, code);
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, `inv10-${code}`);
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${reserved}, '10.00', '0')
      `,
    ).rejects.toThrow();
  });
});

// =========================================================================================
// Period (11-13)
// =========================================================================================

describe("invariant 11 — posting into a 'closed' period is rejected", () => {
  it('fails on the journal_entries INSERT itself', async () => {
    const orgId = await insertOrg('inv11');
    await seedChartOfAccounts(sql, orgId);
    const closedPeriod = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'closed');
    await expect(
      sql`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
        values (${orgId}, '2026-01-15', ${closedPeriod}, 'test', 'inv11-1')
      `,
    ).rejects.toThrow();
  });
});

describe("invariant 12 — posting into a 'locked' period is rejected", () => {
  it('fails on the journal_entries INSERT itself', async () => {
    const orgId = await insertOrg('inv12');
    await seedChartOfAccounts(sql, orgId);
    const lockedPeriod = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'locked');
    await expect(
      sql`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
        values (${orgId}, '2026-01-15', ${lockedPeriod}, 'test', 'inv12-1')
      `,
    ).rejects.toThrow();
  });
});

describe("invariant 13 — posting into an 'open' period succeeds", () => {
  it('commits a balanced two-line entry into an open period', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv13');
    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '25.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '25.00' },
    ]);
    const rows = await sql`select status from journal_entries where id = ${entryId}`;
    expect(rows).toHaveLength(1);
  });
});

// =========================================================================================
// Immutability and traceability (14-19)
// =========================================================================================

describe("invariant 14 — updating a posted entry's amount is rejected", () => {
  it('rejects an UPDATE to a posted line’s debit amount', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv14');
    const entryId = await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: opex, debit: '100.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '100.00' },
      ],
      { status: 'posted', postedAt: new Date() },
    );

    await expect(
      sql`update journal_lines set debit = '999.00' where entry_id = ${entryId} and line_no = 1`,
    ).rejects.toThrow();
  });

  it('rejects an UPDATE to a posted entry’s own financial column (entry_date)', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv14b');
    const entryId = await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: opex, debit: '10.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '10.00' },
      ],
      { status: 'posted', postedAt: new Date() },
    );

    await expect(
      sql`update journal_entries set entry_date = '2026-01-20' where id = ${entryId}`,
    ).rejects.toThrow();
  });
});

describe('invariant 15 — deleting a posted entry is rejected', () => {
  it('rejects the DELETE outright', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv15');
    const entryId = await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: opex, debit: '10.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '10.00' },
      ],
      { status: 'posted', postedAt: new Date() },
    );

    await expect(sql`delete from journal_entries where id = ${entryId}`).rejects.toThrow();
  });
});

describe('invariant 16 — deleting a draft entry succeeds and cascades its lines', () => {
  it('removes the entry and every one of its lines', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv16');
    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '10.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '10.00' },
    ]);

    await sql`delete from journal_entries where id = ${entryId}`;

    const entryRows = await sql`select id from journal_entries where id = ${entryId}`;
    expect(entryRows).toHaveLength(0);
    const lineRows = await sql`select id from journal_lines where entry_id = ${entryId}`;
    expect(lineRows).toHaveLength(0);
  });
});

describe('invariant 17 — source_type / source_id cannot be null', () => {
  it('rejects a null source_type', async () => {
    const orgId = await insertOrg('inv17a');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
    await expect(
      sql`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
        values (${orgId}, '2026-01-15', ${periodId}, null, 'inv17a-1')
      `,
    ).rejects.toThrow();
  });

  it('rejects a null source_id', async () => {
    const orgId = await insertOrg('inv17b');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
    await expect(
      sql`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
        values (${orgId}, '2026-01-15', ${periodId}, 'test', null)
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 18 — a duplicate (org_id, idempotency_key) is rejected', () => {
  it('rejects a second entry in the same org reusing an idempotency_key', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv18');

    // The first entry must be a real, valid, committed entry (>= 2 balanced lines) — a
    // bare journal_entries row with zero lines would itself now be rejected at commit
    // (see the "bonus — zero lines" test), for an unrelated reason, before we ever get to
    // exercise the idempotency-key uniqueness this test is actually about.
    await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: opex, debit: '10.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '10.00' },
      ],
      { sourceId: 'inv18-1', idempotencyKey: 'retry-key-1' },
    );

    // The second insert is expected to fail regardless of its lines — on the partial
    // UNIQUE index, immediately, before any line is ever considered — so it is fine for
    // it to remain a single bare statement with no lines of its own.
    await expect(
      sql`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key)
        values (${orgId}, '2026-01-16', ${periodId}, 'test', 'inv18-2', 'retry-key-1')
      `,
    ).rejects.toThrow();
  });

  it('accepts the same idempotency_key reused in a different org', async () => {
    const orgA = await insertOrg('inv18a');
    const orgB = await insertOrg('inv18b');
    await seedChartOfAccounts(sql, orgA);
    await seedChartOfAccounts(sql, orgB);
    const periodA = await insertPeriod(orgA, '2026-01-01', '2026-01-31', 'open');
    const periodB = await insertPeriod(orgB, '2026-01-01', '2026-01-31', 'open');
    const cashA = await accountId(orgA, '1110');
    const opexA = await accountId(orgA, '6900');
    const cashB = await accountId(orgB, '1110');
    const opexB = await accountId(orgB, '6900');

    await insertEntryWithLines(
      orgA,
      periodA,
      [
        { accountId: opexA, debit: '10.00', credit: '0' },
        { accountId: cashA, debit: '0', credit: '10.00' },
      ],
      { sourceId: 'inv18a-1', idempotencyKey: 'shared-key' },
    );
    await insertEntryWithLines(
      orgB,
      periodB,
      [
        { accountId: opexB, debit: '10.00', credit: '0' },
        { accountId: cashB, debit: '0', credit: '10.00' },
      ],
      { sourceId: 'inv18b-1', idempotencyKey: 'shared-key' },
    );
    const rows = await sql`select id from journal_entries where idempotency_key = 'shared-key'`;
    expect(rows).toHaveLength(2);
  });

  it('accepts multiple entries with a NULL idempotency_key in the same org', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv18c');
    await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '1.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '1.00' },
    ]);
    await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '2.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '2.00' },
    ]);
    const rows = await sql`select id from journal_entries where org_id = ${orgId}`;
    expect(rows).toHaveLength(2);
  });
});

describe('invariant 19 — amounts round to the centavo; 0.1 + 0.2 stored and summed returns exactly 0.30', () => {
  it('numeric(14,2) never produces IEEE-754 float drift', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('inv19');
    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '0.10', credit: '0' },
      { accountId: opex, debit: '0.20', credit: '0' },
      { accountId: cash, debit: '0', credit: '0.30' },
    ]);

    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select sum(debit)::numeric(14,2) as total_debit, sum(credit)::numeric(14,2) as total_credit
      from journal_lines where entry_id = ${entryId}
    `;
    expect(row!.total_debit).toBe('0.30');
    expect(row!.total_credit).toBe('0.30');
  });
});

// =========================================================================================
// BONUS — not among the 19 numbered invariants, but two real gaps found while making them
// precise. Flagged separately in the task report per the task's explicit invitation to
// report spec defects rather than silently work around them.
// =========================================================================================

describe('bonus — an entry inserted with literally zero lines, ever, is rejected at COMMIT', () => {
  it('closes the gap a lines-only deferred trigger would miss', async () => {
    // If the balance/min-lines constraint trigger were declared ONLY on journal_lines
    // (as the Contract's enforcement table could be read to imply), an entry that never
    // gets any lines inserted at all would never trigger any check — a worse escape
    // hatch than the single-leg one this task exists to close. This proves the
    // journal_entries-level deferred trigger (AFTER INSERT) catches it too.
    const { orgId, periodId } = await baseFixture('bonus-zero-lines');
    await expect(
      sql.begin(async (trx) => {
        await trx`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
          values (${orgId}, '2026-01-15', ${periodId}, 'test', 'bonus-zero-1')
        `;
        // deliberately no lines at all
      }),
    ).rejects.toThrow();
  });
});

describe('bonus — period-open resolution: draft→posted into a closed period is blocked, posted→reversed after close remains legal', () => {
  it('rejects transitioning a draft entry to posted once its period has closed', async () => {
    const orgId = await insertOrg('bonus-period-a');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
    const cash = await accountId(orgId, '1110');
    const opex = await accountId(orgId, '6900');

    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '10.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '10.00' },
    ]); // status defaults to 'draft'

    await sql`update fiscal_periods set status = 'closed' where id = ${periodId}`;

    await expect(
      sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`,
    ).rejects.toThrow();
  });

  it('still allows posted→reversed on an entry whose period has since closed (Contract §7)', async () => {
    const orgId = await insertOrg('bonus-period-b');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
    const cash = await accountId(orgId, '1110');
    const opex = await accountId(orgId, '6900');

    const entryId = await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: opex, debit: '10.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '10.00' },
      ],
      { status: 'posted', postedAt: new Date() },
    );

    await sql`update fiscal_periods set status = 'closed' where id = ${periodId}`;

    await sql`update journal_entries set status = 'reversed' where id = ${entryId}`;
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${entryId}`;
    expect(row!.status).toBe('reversed');
  });
});

// =========================================================================================
// T-118 — docs/tasks/118-subledger-party-on-line.md, closing DEF-037. Gives journal lines
// a counterparty so the AP/AR subledgers exist. The 9 invariants below are numbered per
// that task spec, independently of the 19 numbered above (same convention
// chart-of-accounts.test.ts already uses for its own "T-102b invariant N" section).
//
// Invariant 8 is the point of the task, not the columns: it proves the subledger — a
// GROUP BY party_id over journal_lines — reconciles EXACTLY to the 2110 control balance.
// That is bible invariant 6 ("subsidiary ledgers reconcile to control accounts")
// demonstrated for the first time in this codebase.
// =========================================================================================

describe('T-118 invariant 1 — a line with party_type and party_id on a party-requiring account posts', () => {
  it('debits opex, credits 2110 AP for one supplier, and commits', async () => {
    const { orgId, periodId, opex } = await baseFixture('t118-inv1');
    const ap = await accountId(orgId, '2110');
    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '100.00', credit: '0' },
      { accountId: ap, debit: '0', credit: '100.00', partyType: 'supplier', partyId: 'supplier-a' },
    ]);
    const rows = await sql`select id from journal_entries where id = ${entryId}`;
    expect(rows).toHaveLength(1);
    const [line] = await sql<{ party_type: string; party_id: string }[]>`
      select party_type, party_id from journal_lines where entry_id = ${entryId} and account_id = ${ap}
    `;
    expect(line!.party_type).toBe('supplier');
    expect(line!.party_id).toBe('supplier-a');
  });
});

describe('T-118 invariant 2 — a line on a party-requiring account without a party is rejected, naming the account', () => {
  it('fails immediately on the INSERT, and the error names account 2110', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('t118-inv2');
    const ap = await accountId(orgId, '2110');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 't118-inv2-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, 3, ${ap}, '0', '10.00')
      `,
    ).rejects.toThrow(/2110/);
  });
});

describe('T-118 invariant 3 — a party on an account that does not require one is rejected', () => {
  it('fails immediately on the INSERT when a party is given on the opex (6900) account', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('t118-inv3');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 't118-inv3-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit, party_type, party_id)
        values (${entryId}, 3, ${opex}, '10.00', '0', 'supplier', 'supplier-a')
      `,
    ).rejects.toThrow(/6900/);
  });
});

describe('T-118 invariant 4 — party_type alone, or party_id alone, is rejected by the CHECK', () => {
  it('rejects party_type given without party_id', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('t118-inv4a');
    const ap = await accountId(orgId, '2110');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 't118-inv4a-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit, party_type)
        values (${entryId}, 3, ${ap}, '0', '10.00', 'supplier')
      `,
    ).rejects.toThrow();
  });

  it('rejects party_id given without party_type', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('t118-inv4b');
    const ap = await accountId(orgId, '2110');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 't118-inv4b-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit, party_id)
        values (${entryId}, 3, ${ap}, '0', '10.00', 'supplier-a')
      `,
    ).rejects.toThrow();
  });
});

describe('T-118 invariant 5 — an invalid party_type value is rejected', () => {
  it('fails the CHECK for a party_type outside the five allowed values', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('t118-inv5');
    const ap = await accountId(orgId, '2110');
    const entryId = await insertValidEntry(orgId, periodId, cash, opex, 't118-inv5-1');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit, party_type, party_id)
        values (${entryId}, 3, ${ap}, '0', '10.00', 'vendor', 'supplier-a')
      `,
    ).rejects.toThrow();
  });
});

describe('T-118 invariant 6 — an ordinary line (cash, expense) with neither party continues to post — no regression', () => {
  it('a plain two-line entry with no party on either line still commits', async () => {
    const { orgId, periodId, cash, opex } = await baseFixture('t118-inv6');
    const entryId = await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '20.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '20.00' },
    ]);
    const rows = await sql`select id from journal_entries where id = ${entryId}`;
    expect(rows).toHaveLength(1);
  });
});

describe('T-118 invariant 8 — the subledger query: GROUP BY party_id over 2110 sums exactly to the control balance', () => {
  it('three AP lines across two suppliers reconcile exactly — bible invariant 6, demonstrated', async () => {
    const { orgId, periodId, opex } = await baseFixture('t118-inv8');
    const ap = await accountId(orgId, '2110');

    // Supplier A: two lines (100 + 50). Supplier B: one line (75).
    await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '100.00', credit: '0' },
      { accountId: ap, debit: '0', credit: '100.00', partyType: 'supplier', partyId: 'supplier-a' },
    ]);
    await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '50.00', credit: '0' },
      { accountId: ap, debit: '0', credit: '50.00', partyType: 'supplier', partyId: 'supplier-a' },
    ]);
    await insertEntryWithLines(orgId, periodId, [
      { accountId: opex, debit: '75.00', credit: '0' },
      { accountId: ap, debit: '0', credit: '75.00', partyType: 'supplier', partyId: 'supplier-b' },
    ]);

    // The subledger — a GROUP BY over journal_lines, not a second table.
    const bySupplier = await sql<{ party_id: string; total: string }[]>`
      select party_id, sum(credit - debit)::numeric(14,2) as total
      from journal_lines
      where account_id = ${ap} and party_id is not null
      group by party_id
      order by party_id
    `;
    expect(bySupplier).toHaveLength(2);
    const supplierA = bySupplier.find((r) => r.party_id === 'supplier-a');
    const supplierB = bySupplier.find((r) => r.party_id === 'supplier-b');
    expect(supplierA).toBeDefined();
    expect(supplierB).toBeDefined();
    expect(supplierA!.total).toBe('150.00');
    expect(supplierB!.total).toBe('75.00');

    // The control balance — the same account, no GROUP BY.
    const [controlRow] = await sql<{ control: string }[]>`
      select sum(credit - debit)::numeric(14,2) as control
      from journal_lines
      where account_id = ${ap}
    `;
    expect(controlRow!.control).toBe('225.00');

    // The point of the task: per-supplier totals sum EXACTLY to the control balance.
    const subledgerTotal = bySupplier.reduce((sum, r) => sum + Number(r.total), 0);
    expect(subledgerTotal).toBe(Number(controlRow!.control));
  });
});

describe('T-118 invariant 9 — re-running the migration is a no-op', () => {
  it('the migrator applies cleanly a second time with no error, and no duplicate trigger is created', async () => {
    // Same tool the real "npm run db:migrate" uses (packages/db/migrate.ts), pointed at
    // this file's own TEST_DATABASE_URL connection — proving the actual mechanism the
    // task's Method step ("apply, re-run to prove the no-op") describes, not a
    // hand-rolled substitute for it.
    const migrationsFolder = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      '..',
      'migrations',
    );
    const db = drizzle(sql);
    await expect(migrate(db, { migrationsFolder })).resolves.toBeUndefined();
    await expect(migrate(db, { migrationsFolder })).resolves.toBeUndefined();

    const [countRow] = await sql<{ count: string }[]>`
      select count(*)::int as count from pg_trigger where tgname = 'journal_lines_party_requirement'
    `;
    expect(Number(countRow!.count)).toBe(1);
  });
});
