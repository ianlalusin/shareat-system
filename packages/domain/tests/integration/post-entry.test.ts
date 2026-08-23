import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves the 16 invariants of docs/tasks/105-posting-engine.md against a real
 * PostgreSQL (PROJECT_BIBLE.md §9 rule 3) — never a mock.
 *
 * Lives under packages/domain/tests/integration/ (task Scope + landmine #6): CI runs
 * the unit project BEFORE migrations, so a DB-touching test outside a
 * `tests/integration/` directory fails on a fresh database. vitest.config.mts's
 * "integration" project picks this up via `packages/**\/tests/integration/**\/*.test.ts`
 * and runs `tests/integration/setup.ts` first, which points DATABASE_URL AND
 * TEST_DATABASE_URL at the disposable test database and refuses to run against
 * anything whose name doesn't contain "_test". `postEntry` opens its own transaction
 * through `@shareat/db`'s lazily-created connection, which reads DATABASE_URL — so it
 * lands on the same database this file's own raw `postgres` client uses for fixtures
 * and for the DEF-031 raw-SQL regression (invariant 14).
 *
 * The `config({ path: '.env.local' })` call below is redundant with setup.ts's own —
 * kept anyway (belt and suspenders, matching packages/db/tests/integration/journal.test.ts)
 * in case this file is ever run standalone. dotenv resolves `path` relative to CWD, not
 * to this file, so the same bare '.env.local' works regardless of where the test lives.
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

// Cross-package relative import: @shareat/db has no "./seed" export (Scope only lists
// packages/db/src/index.ts, and that re-export is specifically "the repo" per the task
// spec — the seed helper is a separate concern). packages/db/tests/integration/journal.test.ts
// reaches this same file the same way, one package closer.
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb } from '@shareat/db';
import { postEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`post-entry-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
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

/** One org, seeded chart of accounts, and one open period covering January 2026. */
async function baseFixture(hint: string): Promise<{ orgId: string; periodId: string }> {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
  return { orgId, periodId };
}

/** Awaits a promise expected to reject and returns the rejection's message text. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the promise to reject, but it resolved');
}

async function countEntries(sourceType: string, sourceId: string): Promise<number> {
  const rows = await sql`select id from journal_entries where source_type = ${sourceType} and source_id = ${sourceId}`;
  return rows.length;
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
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// Posting (1-7)
// =========================================================================================

describe('invariant 1 — a balanced two-line entry posts', () => {
  it('comes back status=posted with posted_at set', async () => {
    const { orgId } = await baseFixture('inv1');
    const sourceId = uid('inv1');
    const result = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId,
      idempotencyKey: uid('inv1-key'),
      lines: [
        { accountCode: '6900', debit: '100.00' },
        { accountCode: '1110', credit: '100.00' },
      ],
    });

    expect(result.created).toBe(true);
    const [row] = await sql<{ status: string; posted_at: Date | null }[]>`
      select status, posted_at from journal_entries where id = ${result.entryId}
    `;
    expect(row!.status).toBe('posted');
    expect(row!.posted_at).not.toBeNull();
  });
});

describe('invariant 2 — a three-line entry (one debit, two credits) that balances, posts', () => {
  it('accepts a 1-debit/2-credit split summing equal', async () => {
    const { orgId } = await baseFixture('inv2');
    const result = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv2'),
      idempotencyKey: uid('inv2-key'),
      lines: [
        { accountCode: '6900', debit: '100.00' },
        { accountCode: '1110', credit: '60.00' },
        { accountCode: '1110', credit: '40.00' },
      ],
    });

    expect(result.created).toBe(true);
    const lineRows = await sql`select id from journal_lines where entry_id = ${result.entryId}`;
    expect(lineRows).toHaveLength(3);
  });
});

describe('invariant 3 — an unbalanced entry rolls the whole transaction back', () => {
  it('leaves no orphan entry row', async () => {
    const { orgId } = await baseFixture('inv3');
    const sourceId = uid('inv3');

    await expect(
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId,
        idempotencyKey: uid('inv3-key'),
        lines: [
          { accountCode: '6900', debit: '100.00' },
          { accountCode: '1110', credit: '50.00' },
        ],
      }),
    ).rejects.toThrow();

    expect(await countEntries('test', sourceId)).toBe(0);
  });
});

describe('invariant 4 — a single-line entry is rejected at COMMIT and leaves nothing behind', () => {
  it('rejects and rolls back', async () => {
    const { orgId } = await baseFixture('inv4');
    const sourceId = uid('inv4');

    await expect(
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId,
        idempotencyKey: uid('inv4-key'),
        lines: [{ accountCode: '6900', debit: '100.00' }],
      }),
    ).rejects.toThrow();

    expect(await countEntries('test', sourceId)).toBe(0);
  });
});

describe('invariant 5 — an unknown accountCode is rejected, naming the code', () => {
  it('throws an error containing the unknown code', async () => {
    const { orgId } = await baseFixture('inv5');

    const msg = await rejectionMessage(
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid('inv5'),
        idempotencyKey: uid('inv5-key'),
        lines: [
          { accountCode: 'ZZZZ-NOPE', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    );

    expect(msg).toContain('ZZZZ-NOPE');
  });
});

describe('invariant 6 — a reserved account code is rejected', () => {
  it.each(['2145', '2250', '4920'])('rejects posting to reserved account %s', async (code) => {
    const { orgId } = await baseFixture(`inv6-${code}`);

    await expect(
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid(`inv6-${code}`),
        idempotencyKey: uid(`inv6-${code}-key`),
        lines: [
          { accountCode: code, debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe('invariant 7 — a header account code is rejected', () => {
  it('rejects posting to a non-postable header account', async () => {
    const { orgId } = await baseFixture('inv7');

    await expect(
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid('inv7'),
        idempotencyKey: uid('inv7-key'),
        lines: [
          { accountCode: '1000', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    ).rejects.toThrow();
  });
});

// =========================================================================================
// Idempotency (8-10)
// =========================================================================================

describe('invariant 8 — posting twice with the same key writes one entry', () => {
  it('the second call returns created:false with the same entryId', async () => {
    const { orgId } = await baseFixture('inv8');
    const key = uid('inv8-key');
    const lines = [
      { accountCode: '6900', debit: '10.00' },
      { accountCode: '1110', credit: '10.00' },
    ];

    const first = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv8-a'),
      idempotencyKey: key,
      lines,
    });
    const second = await postEntry(null, {
      orgId,
      entryDate: '2026-01-16',
      sourceType: 'test',
      sourceId: uid('inv8-b'),
      idempotencyKey: key,
      lines,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entryId).toBe(first.entryId);

    const rows = await sql`select id from journal_entries where org_id = ${orgId} and idempotency_key = ${key}`;
    expect(rows).toHaveLength(1);
  });
});

describe('invariant 9 — two different keys write two entries', () => {
  it('both calls create a new entry', async () => {
    const { orgId } = await baseFixture('inv9');
    const lines = [
      { accountCode: '6900', debit: '10.00' },
      { accountCode: '1110', credit: '10.00' },
    ];

    const first = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv9-a'),
      idempotencyKey: uid('inv9-key-a'),
      lines,
    });
    const second = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv9-b'),
      idempotencyKey: uid('inv9-key-b'),
      lines,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.entryId).not.toBe(first.entryId);
  });
});

describe('invariant 10 — concurrent posts with the same key produce exactly one entry', () => {
  it('no duplicate, no deadlock', async () => {
    const { orgId } = await baseFixture('inv10');
    const key = uid('inv10-key');
    const lines = [
      { accountCode: '6900', debit: '10.00' },
      { accountCode: '1110', credit: '10.00' },
    ];

    const [r1, r2] = await Promise.all([
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid('inv10-a'),
        idempotencyKey: key,
        lines,
      }),
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid('inv10-b'),
        idempotencyKey: key,
        lines,
      }),
    ]);

    expect(r1.entryId).toBe(r2.entryId);
    expect([r1.created, r2.created].sort()).toEqual([false, true]);

    const rows = await sql`select id from journal_entries where org_id = ${orgId} and idempotency_key = ${key}`;
    expect(rows).toHaveLength(1);
  });
});

// =========================================================================================
// Period (11-13)
// =========================================================================================

describe("invariant 11 — an entryDate in a 'closed' period is rejected, naming the period", () => {
  it('throws an error naming the period id and its status', async () => {
    const orgId = await insertOrg('inv11');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');

    const msg = await rejectionMessage(
      postEntry(null, {
        orgId,
        entryDate: '2026-02-15',
        sourceType: 'test',
        sourceId: uid('inv11'),
        idempotencyKey: uid('inv11-key'),
        lines: [
          { accountCode: '6900', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    );

    expect(msg).toContain(periodId);
    expect(msg).toMatch(/closed/i);
  });
});

describe("invariant 12 — an entryDate in a 'locked' period is rejected", () => {
  it('throws, naming the locked status', async () => {
    const orgId = await insertOrg('inv12');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-03-01', '2026-03-31', 'locked');

    const msg = await rejectionMessage(
      postEntry(null, {
        orgId,
        entryDate: '2026-03-15',
        sourceType: 'test',
        sourceId: uid('inv12'),
        idempotencyKey: uid('inv12-key'),
        lines: [
          { accountCode: '6900', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    );

    expect(msg).toContain(periodId);
    expect(msg).toMatch(/locked/i);
  });
});

describe('invariant 13 — an entryDate with no covering period is rejected, naming the date', () => {
  it('throws an error containing the entryDate', async () => {
    const orgId = await insertOrg('inv13');
    await seedChartOfAccounts(sql, orgId);
    // Deliberately no fiscal_periods row for this org at all.

    const msg = await rejectionMessage(
      postEntry(null, {
        orgId,
        entryDate: '2026-04-15',
        sourceType: 'test',
        sourceId: uid('inv13'),
        idempotencyKey: uid('inv13-key'),
        lines: [
          { accountCode: '6900', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    );

    expect(msg).toContain('2026-04-15');
  });
});

// =========================================================================================
// DEF-031 (14-16)
// =========================================================================================

describe('invariant 14 — DEF-031 regression: raw SQL cannot INSERT a line onto an already-posted entry', () => {
  it('rejects even a balanced pair, even in a new transaction', async () => {
    const { orgId } = await baseFixture('inv14');
    const posted = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv14'),
      idempotencyKey: uid('inv14-key'),
      lines: [
        { accountCode: '6900', debit: '100.00' },
        { accountCode: '1110', credit: '100.00' },
      ],
    });
    expect(posted.created).toBe(true);

    const [opex] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '6900'`;
    const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1110'`;

    // A brand-new, later, autocommitted statement — not the transaction that posted the
    // entry above. Appends a BALANCED pair (5.00/5.00), which would not trip the balance
    // trigger at all — this is exactly the DEF-031 hole. It must be rejected anyway,
    // immediately, by the replacement journal_lines_posted_immutable trigger (migration
    // 0004), because the parent entry's status is 'posted', not 'draft'.
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values
          (${posted.entryId}, 3, ${opex!.id}, '5.00', '0'),
          (${posted.entryId}, 4, ${cash!.id}, '0', '5.00')
      `,
    ).rejects.toThrow();

    const lineRows = await sql`select id from journal_lines where entry_id = ${posted.entryId}`;
    expect(lineRows).toHaveLength(2);
  });
});

describe('invariant 15 — postEntry itself still works after the DEF-031 fix', () => {
  it('the legitimate draft -> lines -> posted sequence still succeeds', async () => {
    const { orgId } = await baseFixture('inv15');
    const result = await postEntry(null, {
      orgId,
      entryDate: '2026-01-20',
      sourceType: 'test',
      sourceId: uid('inv15'),
      idempotencyKey: uid('inv15-key'),
      memo: 'DEF-031 fix did not break the legitimate path',
      lines: [
        { accountCode: '6900', debit: '25.00' },
        { accountCode: '1110', credit: '15.00' },
        { accountCode: '1110', credit: '10.00' },
      ],
    });

    expect(result.created).toBe(true);
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${result.entryId}`;
    expect(row!.status).toBe('posted');
    const lineRows = await sql`select id from journal_lines where entry_id = ${result.entryId}`;
    expect(lineRows).toHaveLength(3);
  });
});

describe('invariant 16 — an ETL-style historical post succeeds', () => {
  it('back-dated into an open period, with postedBy null', async () => {
    const orgId = await insertOrg('inv16');
    await seedChartOfAccounts(sql, orgId);
    // A wide-open historical period, and an entryDate near its start — the ETL replays
    // history into periods that were open at the time, not "today".
    await insertPeriod(orgId, '2020-01-01', '2020-12-31', 'open');

    const result = await postEntry(null, {
      orgId,
      entryDate: '2020-03-05',
      sourceType: 'etl',
      sourceId: uid('inv16'),
      idempotencyKey: uid('inv16-key'),
      postedBy: null,
      lines: [
        { accountCode: '6900', debit: '500.00' },
        { accountCode: '1110', credit: '500.00' },
      ],
    });

    expect(result.created).toBe(true);
    const [row] = await sql<{ status: string; posted_by: string | null; entry_date: string }[]>`
      select status, posted_by, entry_date::text as entry_date from journal_entries where id = ${result.entryId}
    `;
    expect(row!.status).toBe('posted');
    expect(row!.posted_by).toBeNull();
    expect(row!.entry_date).toBe('2020-03-05');
  });
});
