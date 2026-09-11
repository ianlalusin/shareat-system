import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves the 19 invariants of docs/tasks/106-reverse-entry.md against a real PostgreSQL
 * (PROJECT_BIBLE.md §9 rule 3) — never a mock.
 *
 * Lives under packages/domain/tests/integration/, matching post-entry.test.ts's own
 * reasoning exactly (task landmine #5 / Method step 5): CI runs the unit project BEFORE
 * migrations, so a DB-touching test outside a `tests/integration/` directory fails on a
 * fresh database.
 *
 * Written FIRST, before reverse-entry.ts existed, per the task's "Method — test-driven"
 * step 1. The first run fails with "reverseEntry is not a function" (no such export from
 * @shareat/domain yet) — confirmed before any implementation code was written. See the
 * task report for that first-run transcript.
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

// Cross-package relative import, same pattern post-entry.test.ts already uses to reach
// the seed helper one package over.
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { postEntry, reverseEntry } from '@shareat/domain';

/**
 * Both postEntry and reverseEntry are reached in production only through an API-layer
 * wrapper that has already called withOrgPrincipal — neither establishes a principal
 * itself. Standing in for that layer here, at the same depth production wraps at.
 */
function postEntryAsOrg(input: Parameters<typeof postEntry>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => postEntry(tx, input));
}
function reverseEntryAsOrg(orgId: string, input: Parameters<typeof reverseEntry>[1]) {
  return withOrgPrincipal(orgId, (tx) => reverseEntry(tx, input));
}

const sql = postgres(url, { max: 5 });

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`reverse-entry-${hint}`);
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

async function insertStore(orgId: string, hint: string): Promise<string> {
  const code = uid(`store-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${code}, ${`Store ${code}`})
    returning id
  `;
  return row!.id;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from accounts where org_id = ${orgId} and code = ${code}
  `;
  if (!row) throw new Error(`test fixture: no account ${code} for org ${orgId}`);
  return row.id;
}

async function setAccountStatus(
  orgId: string,
  code: string,
  status: 'active' | 'reserved' | 'archived',
): Promise<void> {
  await sql`update accounts set status = ${status}, updated_at = now() where org_id = ${orgId} and code = ${code}`;
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

interface EntryRow {
  id: string;
  status: string;
  entry_date: string;
  memo: string | null;
  source_type: string;
  source_id: string;
  reversal_of_entry_id: string | null;
  period_id: string;
}

async function fetchEntry(entryId: string): Promise<EntryRow> {
  const [row] = await sql<EntryRow[]>`
    select id, status, entry_date::text as entry_date, memo, source_type, source_id,
           reversal_of_entry_id, period_id
    from journal_entries where id = ${entryId}
  `;
  if (!row) throw new Error(`test fixture: entry ${entryId} not found`);
  return row;
}

interface LineRow {
  line_no: number;
  account_code: string;
  store_id: string | null;
  channel_id: string | null;
  debit: string;
  credit: string;
}

async function fetchLines(entryId: string): Promise<LineRow[]> {
  return sql<LineRow[]>`
    select jl.line_no, a.code as account_code, jl.store_id, jl.channel_id, jl.debit, jl.credit
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId}
    order by jl.line_no
  `;
}

/**
 * A minimal raw fixture for a real, committed 'draft' entry — postEntry can never
 * produce one that survives (it always finishes as 'posted' or the whole transaction
 * rolls back), so invariant 7 ("reversing a draft is rejected") needs its own
 * construction path. Mirrors packages/db/tests/integration/journal.test.ts's own
 * insertEntryWithLines: everything happens inside ONE `sql.begin()` transaction because
 * the balance/minimum-two-lines check is DEFERRED to commit, not to each statement.
 */
async function insertRawDraftEntry(
  orgId: string,
  periodId: string,
  lines: Array<{ accountId: string; debit: string; credit: string }>,
): Promise<string> {
  return sql.begin(async (trx) => {
    const [entry] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-15', ${periodId}, 'test', ${uid('raw-draft')}, 'draft')
      returning id
    `;
    const entryId = entry!.id;
    let lineNo = 1;
    for (const line of lines) {
      await trx`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${entryId}, ${lineNo}, ${line.accountId}, ${line.debit}, ${line.credit})
      `;
      lineNo++;
    }
    return entryId;
  });
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
// Shape (1-6)
// =========================================================================================

describe('invariant 1 — reversing a posted entry creates a new entry with debit/credit swapped', () => {
  it('every line is mirrored with debit and credit swapped', async () => {
    const { orgId, periodId } = await baseFixture('inv1');
    const storeId = await insertStore(orgId, 'inv1');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv1'),
      idempotencyKey: uid('inv1-key'),
      lines: [
        { accountCode: '6900', storeId, channelId: 'dine-in', debit: '100.00' },
        { accountCode: '1110', storeId, channelId: 'dine-in', credit: '100.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, {
      entryId: original.entryId,
      reason: 'test reversal',
    });

    expect(result.created).toBe(true);
    const originalLines = await fetchLines(original.entryId);
    const reversalLines = await fetchLines(result.reversalEntryId);
    expect(reversalLines).toHaveLength(originalLines.length);
    for (let i = 0; i < originalLines.length; i++) {
      expect(reversalLines[i]!.debit).toBe(originalLines[i]!.credit);
      expect(reversalLines[i]!.credit).toBe(originalLines[i]!.debit);
    }
  });
});

describe('invariant 2 — accounts, store_id, channel_id, and amounts are identical to the original', () => {
  it('only debit/credit swap; everything else matches line-for-line', async () => {
    const { orgId, periodId } = await baseFixture('inv2');
    const storeId = await insertStore(orgId, 'inv2');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv2'),
      idempotencyKey: uid('inv2-key'),
      lines: [
        { accountCode: '6900', storeId, channelId: 'grab', debit: '75.00' },
        { accountCode: '1110', storeId, channelId: 'grab', credit: '75.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'wrong store' });

    const originalLines = await fetchLines(original.entryId);
    const reversalLines = await fetchLines(result.reversalEntryId);
    for (let i = 0; i < originalLines.length; i++) {
      expect(reversalLines[i]!.account_code).toBe(originalLines[i]!.account_code);
      expect(reversalLines[i]!.store_id).toBe(originalLines[i]!.store_id);
      expect(reversalLines[i]!.channel_id).toBe(originalLines[i]!.channel_id);
    }
  });
});

describe('invariant 3 — reversal_of_entry_id points at the original; source_type/source_id inherited', () => {
  it('carries the linkage and the same source document reference', async () => {
    const { orgId } = await baseFixture('inv3');
    const sourceId = uid('inv3-source');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'expense',
      sourceId,
      idempotencyKey: uid('inv3-key'),
      lines: [
        { accountCode: '6900', debit: '20.00' },
        { accountCode: '1110', credit: '20.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'duplicate' });

    const reversalRow = await fetchEntry(result.reversalEntryId);
    expect(reversalRow.reversal_of_entry_id).toBe(original.entryId);
    expect(reversalRow.source_type).toBe('expense');
    expect(reversalRow.source_id).toBe(sourceId);
  });
});

describe("invariant 4 — original transitions to 'reversed'; the reversal is 'posted'", () => {
  it('flips exactly one status each', async () => {
    const { orgId } = await baseFixture('inv4');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv4'),
      idempotencyKey: uid('inv4-key'),
      lines: [
        { accountCode: '6900', debit: '30.00' },
        { accountCode: '1110', credit: '30.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'correction' });

    const originalRow = await fetchEntry(original.entryId);
    const reversalRow = await fetchEntry(result.reversalEntryId);
    expect(originalRow.status).toBe('reversed');
    expect(reversalRow.status).toBe('posted');
  });
});

describe('invariant 5 — for every account touched, original + reversal sum to exactly zero', () => {
  it('net debit minus credit across both entries is 0 per account', async () => {
    const { orgId } = await baseFixture('inv5');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv5'),
      idempotencyKey: uid('inv5-key'),
      lines: [
        { accountCode: '6900', debit: '40.00' },
        { accountCode: '1110', credit: '25.00' },
        { accountCode: '1110', credit: '15.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'net to zero' });

    const rows = await sql<{ account_code: string; net: string }[]>`
      select a.code as account_code, sum(jl.debit - jl.credit) as net
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id in (${original.entryId}, ${result.reversalEntryId})
      group by a.code
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.net)).toBe(0);
    }
  });
});

describe('invariant 6 — both entries still exist afterwards; nothing deleted or changed on the original', () => {
  it('the original keeps its own lines, amounts, and row', async () => {
    const { orgId } = await baseFixture('inv6');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv6'),
      idempotencyKey: uid('inv6-key'),
      lines: [
        { accountCode: '6900', debit: '55.00' },
        { accountCode: '1110', credit: '55.00' },
      ],
    });
    const linesBefore = await fetchLines(original.entryId);

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'audit' });

    const originalStillThere = await sql`select id from journal_entries where id = ${original.entryId}`;
    const reversalStillThere = await sql`select id from journal_entries where id = ${result.reversalEntryId}`;
    expect(originalStillThere).toHaveLength(1);
    expect(reversalStillThere).toHaveLength(1);

    const linesAfter = await fetchLines(original.entryId);
    expect(linesAfter).toEqual(linesBefore);
  });
});

// =========================================================================================
// Guards (7-10)
// =========================================================================================

describe('invariant 7 — reversing a draft entry is rejected', () => {
  it('nothing has been asserted yet — rejected, telling the caller to delete it instead', async () => {
    const { orgId, periodId } = await baseFixture('inv7');
    const opex = await accountId(orgId, '6900');
    const cash = await accountId(orgId, '1110');
    const draftId = await insertRawDraftEntry(orgId, periodId, [
      { accountId: opex, debit: '10.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '10.00' },
    ]);

    const msg = await rejectionMessage(
      reverseEntryAsOrg(orgId, { entryId: draftId, reason: 'oops' }),
    );
    expect(msg).toMatch(/draft/i);
  });
});

describe('invariant 8 — reversing an already-reversed entry is rejected, naming the existing reversal', () => {
  it('the second, distinct reversal attempt fails and names the first reversal', async () => {
    const { orgId } = await baseFixture('inv8');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv8'),
      idempotencyKey: uid('inv8-key'),
      lines: [
        { accountCode: '6900', debit: '12.00' },
        { accountCode: '1110', credit: '12.00' },
      ],
    });
    const firstReversal = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'first' });

    const msg = await rejectionMessage(
      reverseEntryAsOrg(orgId, {
        entryId: original.entryId,
        reason: 'second attempt, different key',
        idempotencyKey: uid('inv8-second-key'),
      }),
    );
    expect(msg).toContain(firstReversal.reversalEntryId);
  });
});

describe('invariant 9 — reversing a reversal succeeds', () => {
  it('undoing an erroneous reversal is legitimate', async () => {
    const { orgId } = await baseFixture('inv9');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv9'),
      idempotencyKey: uid('inv9-key'),
      lines: [
        { accountCode: '6900', debit: '18.00' },
        { accountCode: '1110', credit: '18.00' },
      ],
    });
    const firstReversal = await reverseEntryAsOrg(orgId, {
      entryId: original.entryId,
      reason: 'reversed by mistake',
    });

    const secondReversal = await reverseEntryAsOrg(orgId, {
      entryId: firstReversal.reversalEntryId,
      reason: 'undo the erroneous reversal',
    });

    expect(secondReversal.created).toBe(true);
    const firstReversalRow = await fetchEntry(firstReversal.reversalEntryId);
    expect(firstReversalRow.status).toBe('reversed');
    const secondReversalRow = await fetchEntry(secondReversal.reversalEntryId);
    expect(secondReversalRow.status).toBe('posted');
    expect(secondReversalRow.reversal_of_entry_id).toBe(firstReversal.reversalEntryId);

    // The original entry itself is untouched by this second reversal.
    const originalRow = await fetchEntry(original.entryId);
    expect(originalRow.status).toBe('reversed');
  });
});

describe('invariant 10 — an empty or whitespace-only reason is rejected', () => {
  it.each(['', '   ', '\t\n'])('rejects reason %j', async (reason) => {
    const { orgId } = await baseFixture('inv10');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid(`inv10-${JSON.stringify(reason)}`),
      idempotencyKey: uid('inv10-key'),
      lines: [
        { accountCode: '6900', debit: '5.00' },
        { accountCode: '1110', credit: '5.00' },
      ],
    });

    await expect(reverseEntryAsOrg(orgId, { entryId: original.entryId, reason })).rejects.toThrow(/reason/i);
  });
});

// =========================================================================================
// Period (11-14)
// =========================================================================================

describe("invariant 11 — original in an open period, no reversalDate given, posts on the original's date", () => {
  it('defaults reversalDate to the original entry_date, same period', async () => {
    const { orgId, periodId } = await baseFixture('inv11');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-20',
      sourceType: 'test',
      sourceId: uid('inv11'),
      idempotencyKey: uid('inv11-key'),
      lines: [
        { accountCode: '6900', debit: '8.00' },
        { accountCode: '1110', credit: '8.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'same period' });

    const reversalRow = await fetchEntry(result.reversalEntryId);
    expect(reversalRow.entry_date).toBe('2026-01-20');
    expect(reversalRow.period_id).toBe(periodId);
    expect(reversalRow.memo).not.toMatch(/\[prior period\]/);
  });
});

describe("invariant 12 — original's period closed, no reversalDate given -> rejected", () => {
  it('tells the caller to supply a reversalDate', async () => {
    const { orgId, periodId } = await baseFixture('inv12');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv12'),
      idempotencyKey: uid('inv12-key'),
      lines: [
        { accountCode: '6900', debit: '9.00' },
        { accountCode: '1110', credit: '9.00' },
      ],
    });
    await sql`update fiscal_periods set status = 'closed' where id = ${periodId}`;

    const msg = await rejectionMessage(
      reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'late correction' }),
    );
    expect(msg).toMatch(/reversalDate/);
  });
});

describe("invariant 13 — original's period closed, reversalDate in an open period -> posts there, memo prefixed", () => {
  it('the memo is prefixed [prior period]', async () => {
    const { orgId, periodId } = await baseFixture('inv13');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv13'),
      idempotencyKey: uid('inv13-key'),
      lines: [
        { accountCode: '6900', debit: '11.00' },
        { accountCode: '1110', credit: '11.00' },
      ],
    });
    await sql`update fiscal_periods set status = 'closed' where id = ${periodId}`;
    const febPeriodId = await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'open');

    const result = await reverseEntryAsOrg(orgId, {
      entryId: original.entryId,
      reason: 'late correction',
      reversalDate: '2026-02-10',
    });

    const reversalRow = await fetchEntry(result.reversalEntryId);
    expect(reversalRow.entry_date).toBe('2026-02-10');
    expect(reversalRow.period_id).toBe(febPeriodId);
    expect(reversalRow.memo).toMatch(/^\[prior period\]/);
    expect(reversalRow.memo).toContain('late correction');
  });
});

describe('invariant 14 — a reversalDate in a closed period is rejected', () => {
  it('rejects even when explicitly supplied', async () => {
    const { orgId, periodId } = await baseFixture('inv14');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv14'),
      idempotencyKey: uid('inv14-key'),
      lines: [
        { accountCode: '6900', debit: '13.00' },
        { accountCode: '1110', credit: '13.00' },
      ],
    });
    await sql`update fiscal_periods set status = 'closed' where id = ${periodId}`;

    await expect(
      reverseEntryAsOrg(orgId, {
        entryId: original.entryId,
        reason: 'late correction',
        reversalDate: '2026-01-20', // falls inside the now-closed January period
      }),
    ).rejects.toThrow();
  });
});

// =========================================================================================
// Always reversible — §5 (15-17)
// =========================================================================================

describe('invariant 15 — an entry whose account has since been set reserved is still reversible', () => {
  it('reversal succeeds despite the account no longer being active', async () => {
    const { orgId } = await baseFixture('inv15');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv15'),
      idempotencyKey: uid('inv15-key'),
      lines: [
        { accountCode: '6900', debit: '14.00' },
        { accountCode: '1110', credit: '14.00' },
      ],
    });
    await setAccountStatus(orgId, '6900', 'reserved');

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'account reserved since' });
    expect(result.created).toBe(true);
    const reversalRow = await fetchEntry(result.reversalEntryId);
    expect(reversalRow.status).toBe('posted');
  });
});

describe('invariant 16 — an entry whose account has since been archived is still reversible', () => {
  it('reversal succeeds despite the account being archived', async () => {
    const { orgId } = await baseFixture('inv16');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv16'),
      idempotencyKey: uid('inv16-key'),
      lines: [
        { accountCode: '6900', debit: '16.00' },
        { accountCode: '1110', credit: '16.00' },
      ],
    });
    await setAccountStatus(orgId, '1110', 'archived');

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'account archived since' });
    expect(result.created).toBe(true);
  });
});

describe('invariant 17 — an ordinary posting to that same non-active account is still rejected', () => {
  it('the §5 exemption does not leak into normal postEntry calls', async () => {
    const { orgId } = await baseFixture('inv17');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv17'),
      idempotencyKey: uid('inv17-key'),
      lines: [
        { accountCode: '6900', debit: '17.00' },
        { accountCode: '1110', credit: '17.00' },
      ],
    });
    await setAccountStatus(orgId, '6900', 'archived');

    // The reversal succeeds (§5) ...
    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'account archived since' });
    expect(result.created).toBe(true);

    // ... but a brand-new, ordinary postEntry call to the SAME now-archived account, in
    // its own separate transaction, is still rejected exactly as before. This is the
    // proof the exemption is scoped to the one reversal transaction and does not leak.
    await expect(
      postEntryAsOrg({
        orgId,
        entryDate: '2026-01-16',
        sourceType: 'test',
        sourceId: uid('inv17-ordinary'),
        idempotencyKey: uid('inv17-ordinary-key'),
        lines: [
          { accountCode: '6900', debit: '5.00' },
          { accountCode: '1110', credit: '5.00' },
        ],
      }),
    ).rejects.toThrow(/cannot be posted to|status/i);
  });
});

// =========================================================================================
// Idempotency and immutability (18-19)
// =========================================================================================

describe('invariant 18 — reversing twice returns the same reversalEntryId with created:false', () => {
  it('the second call is a safe no-op; balances are unchanged', async () => {
    const { orgId } = await baseFixture('inv18');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv18'),
      idempotencyKey: uid('inv18-key'),
      lines: [
        { accountCode: '6900', debit: '21.00' },
        { accountCode: '1110', credit: '21.00' },
      ],
    });

    const first = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'first call' });
    const second = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'retried call' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reversalEntryId).toBe(first.reversalEntryId);

    // Exactly one reversal entry exists, and the net effect on the opex account is
    // still a single reversal's worth — a double-reversal would silently re-apply
    // the amount, netting to -100.00 (or double-zero) instead of a clean pair.
    const rows = await sql<{ id: string }[]>`
      select id from journal_entries where reversal_of_entry_id = ${original.entryId}
    `;
    expect(rows).toHaveLength(1);

    const opex = await accountId(orgId, '6900');
    const [net] = await sql<{ net: string }[]>`
      select coalesce(sum(debit - credit), 0) as net from journal_lines
      where account_id = ${opex} and entry_id in (${original.entryId}, ${first.reversalEntryId})
    `;
    expect(Number(net!.net)).toBe(0);
  });
});

describe("invariant 19 — the reversal's own lines are immutable (DEF-031's guarantee holds for reversals too)", () => {
  it('raw SQL cannot INSERT, UPDATE, or DELETE a reversal line', async () => {
    const { orgId } = await baseFixture('inv19');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('inv19'),
      idempotencyKey: uid('inv19-key'),
      lines: [
        { accountCode: '6900', debit: '22.00' },
        { accountCode: '1110', credit: '22.00' },
      ],
    });
    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'immutability check' });

    const opex = await accountId(orgId, '6900');
    const cash = await accountId(orgId, '1110');

    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values
          (${result.reversalEntryId}, 3, ${opex}, '1.00', '0'),
          (${result.reversalEntryId}, 4, ${cash}, '0', '1.00')
      `,
    ).rejects.toThrow();

    const [oneLine] = await sql`select id from journal_lines where entry_id = ${result.reversalEntryId} order by line_no limit 1`;
    await expect(
      sql`update journal_lines set debit = '999.00' where id = ${oneLine!.id}`,
    ).rejects.toThrow();
    await expect(sql`delete from journal_lines where id = ${oneLine!.id}`).rejects.toThrow();

    const lineRows = await sql`select id from journal_lines where entry_id = ${result.reversalEntryId}`;
    expect(lineRows).toHaveLength(2);
  });
});

// =========================================================================================
// Beyond the 19 — a defect this task found while implementing §5, fixed in the same
// migration rather than reported and left open (see the task report for the full
// reasoning). Not one of the spec's numbered invariants; kept separate and clearly
// labelled so it is never confused with one.
// =========================================================================================

describe('extra — a REVERSED entry (not just a posted one) keeps its lines immutable', () => {
  it('raw SQL cannot mutate the ORIGINAL entry\'s lines once it has been reversed', async () => {
    const { orgId } = await baseFixture('extra-reversed-immutable');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('extra-reversed'),
      idempotencyKey: uid('extra-reversed-key'),
      lines: [
        { accountCode: '6900', debit: '33.00' },
        { accountCode: '1110', credit: '33.00' },
      ],
    });
    await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'flip to reversed' });

    const [oneLine] = await sql`select id from journal_lines where entry_id = ${original.entryId} order by line_no limit 1`;
    await expect(
      sql`update journal_lines set debit = '999.00' where id = ${oneLine!.id}`,
    ).rejects.toThrow();
    await expect(sql`delete from journal_lines where id = ${oneLine!.id}`).rejects.toThrow();

    const opex = await accountId(orgId, '6900');
    await expect(
      sql`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values (${original.entryId}, 99, ${opex}, '1.00', '0')
      `,
    ).rejects.toThrow();
  });
});

describe('extra — a header (non-postable) account is still rejected even inside a reversal context', () => {
  it('the §5 exemption never covers is_postable, only the active-status check', async () => {
    const { orgId, periodId } = await baseFixture('extra-header-rejected');
    const header = await accountId(orgId, '1000'); // Assets — header, is_postable=false
    const cash = await accountId(orgId, '1110');

    // Simulate being "inside" a reversal's own transaction the same way reverseEntry
    // does, then attempt to insert a line against a header account — this can never
    // happen through reverseEntry itself (no original line could ever have targeted a
    // header, since ordinary postEntry already rejects that), so it is exercised
    // directly against the trigger to prove the exemption's scope is as narrow as
    // Contract §5 requires.
    await expect(
      sql.begin(async (trx) => {
        await trx`select set_config('app.reversal_posting', 'on', true)`;
        const [entry] = await trx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
          values (${orgId}, '2026-01-15', ${periodId}, 'test', ${uid('extra-header')}, 'draft')
          returning id
        `;
        await trx`
          insert into journal_lines (entry_id, line_no, account_id, debit, credit)
          values (${entry!.id}, 1, ${header}, '1.00', '0')
        `;
        await trx`
          insert into journal_lines (entry_id, line_no, account_id, debit, credit)
          values (${entry!.id}, 2, ${cash}, '0', '1.00')
        `;
      }),
    ).rejects.toThrow(/not postable|header/i);
  });
});
