import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-274 — `closeYear`: the year-close journal entry ADR-006 describes, computed from a real year's
 * ledger activity. `docs/tasks/274-adr-006-year-close-entry.md`,
 * `docs/decisions/ADR-006-period-close.md`. `packages/domain/src/fiscal-periods/close-year.ts`.
 *
 * Gate order proved, in this order, per this codebase's own discipline — a gate not watched failing
 * is not a gate that has been tested:
 *   1. capability refusal — staff
 *   2. earlier-open-period gate (an unclosed month in the year being closed)
 *   3. no-activity refusal
 *   4. the happy path — net income, correct lines, 3300 credited, periods locked
 *   5. net-loss year — 3300 debited, not credited
 *   6. exact-zero year — no 3300 line at all
 *   7. idempotency — a second call is a safe no-op
 *   8. reversal of the posted year-close entry, with no override
 *   9. the double-count regression `includeYearClose: false` exists to prevent
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { closeYear, postEntry, reverseEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** One org, an admin, a staff member, and a store — the year-close capability check only needs the
 *  admin/staff distinction `close_period` already draws; no per-store scope question here (the
 *  entry is org-wide, never per-store, per ADR-006). */
async function fixture(hint: string) {
  const code = uid(`yc-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Store') returning id`;

  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  const staffId = await person('Staff', 'staff');

  return {
    orgId,
    storeId: store!.id,
    admin: actor(orgId, adminId),
    staff: actor(orgId, staffId),
    adminPersonId: adminId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Real-clock-disjoint years so no runway/readiness finding ever fires by accident (same technique
 *  `fiscal-period-close.test.ts` uses for its own real-but-disjoint period). */
const YEAR = 2040;

/** `ON CONFLICT DO NOTHING` bare (no target) so re-seeding a month already inserted by a PRIOR
 *  year's `openJanuary` call (test 10 closes two consecutive years back to back) is a safe skip
 *  rather than an EXCLUDE-constraint error — same idiom `seedCalendarMonths` uses in production. */
async function seedYear(orgId: string, year: number, status: 'open' | 'closed' = 'open') {
  for (let month = 1; month <= 12; month++) {
    const startsOn = `${year}-${String(month).padStart(2, '0')}-01`;
    const endsOn = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${startsOn}, ${endsOn}, ${status})
      on conflict do nothing`;
  }
}

async function closeYearPeriodsDirectly(orgId: string, year: number) {
  await sql`
    update fiscal_periods set status = 'closed'
    where org_id = ${orgId} and starts_on >= ${`${year}-01-01`} and ends_on <= ${`${year}-12-31`}`;
}

async function openJanuary(orgId: string, year: number) {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${`${year}-01-01`}, ${`${year}-01-31`}, 'open')
    on conflict do nothing`;
}

async function statusesOf(orgId: string, year: number): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    select status from fiscal_periods
    where org_id = ${orgId} and starts_on >= ${`${year}-01-01`} and ends_on <= ${`${year}-12-31`}
    order by starts_on`;
  return rows.map((r) => r.status);
}

/** Posts real revenue (4100) and expense (6900) activity dated inside `year`, then closes every
 *  month of `year` directly (bypassing `closePeriod` — this file tests `closeYear`, not the month
 *  lock) and opens `year + 1`'s January so the entry has somewhere to land. */
async function realActivity(f: Fixture, year: number, revenue: string, expense: string) {
  await seedYear(f.orgId, year, 'open');
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: `${year}-06-15`,
      sourceType: 'test',
      sourceId: uid('activity'),
      idempotencyKey: uid('activity-key'),
      lines: [
        { accountCode: '1110', storeId: f.storeId, debit: revenue },
        { accountCode: '4100', storeId: f.storeId, credit: revenue },
      ],
    }),
  );
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: `${year}-07-01`,
      sourceType: 'test',
      sourceId: uid('activity'),
      idempotencyKey: uid('activity-key'),
      lines: [
        { accountCode: '6900', storeId: f.storeId, debit: expense },
        { accountCode: '1110', storeId: f.storeId, credit: expense },
      ],
    }),
  );
  await closeYearPeriodsDirectly(f.orgId, year);
  await openJanuary(f.orgId, year + 1);
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-274 closeYear — capability refusal', () => {
  it('⛔ staff may not close a year', async () => {
    const f = await fixture('staff-refused');
    await realActivity(f, YEAR, '20000.00', '8000.00');

    await expect(
      asOrg(f.orgId, (tx) => closeYear(tx, f.staff, { orgId: f.orgId, year: YEAR })),
    ).rejects.toThrow(AuthorizationError);
    expect(await statusesOf(f.orgId, YEAR)).toEqual(Array(12).fill('closed'));
  });
});

describe('T-274 closeYear — periods close in order', () => {
  it('⛔ a month of the year still open refuses the close', async () => {
    const f = await fixture('open-month-blocks');
    await seedYear(f.orgId, YEAR, 'open');
    // Only November+December stay open; everything else closes — still enough to trip the gate.
    await sql`
      update fiscal_periods set status = 'closed'
      where org_id = ${f.orgId} and starts_on >= ${`${YEAR}-01-01`} and starts_on < ${`${YEAR}-11-01`}`;
    await openJanuary(f.orgId, YEAR + 1);

    await expect(
      asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR })),
    ).rejects.toThrow(/still open/);
  });
});

describe('T-274 closeYear — no activity to close', () => {
  it('⛔ a year with zero income/expense activity refuses, naming it', async () => {
    const f = await fixture('no-activity');
    await seedYear(f.orgId, YEAR, 'closed');
    await openJanuary(f.orgId, YEAR + 1);

    await expect(
      asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR })),
    ).rejects.toThrow(/no income or expense activity/);
  });
});

describe('T-274 closeYear — the missing-January precondition (Q1)', () => {
  it('⛔ with no `year+1`-01 period seeded, surfaces postEntry\'s own error rather than doing anything else', async () => {
    const f = await fixture('missing-january');
    // Real activity, every month of YEAR closed — but January of YEAR+1 was never seeded at all,
    // simulating the coverage gap Q1 found (nothing keeps fiscal_periods rolling forward).
    await seedYear(f.orgId, YEAR, 'open');
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: `${YEAR}-06-15`,
        sourceType: 'test',
        sourceId: uid('activity'),
        idempotencyKey: uid('activity-key'),
        lines: [
          { accountCode: '1110', storeId: f.storeId, debit: '20000.00' },
          { accountCode: '4100', storeId: f.storeId, credit: '20000.00' },
        ],
      }),
    );
    await closeYearPeriodsDirectly(f.orgId, YEAR);
    // Deliberately no openJanuary(f.orgId, YEAR + 1) here.

    await expect(
      asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR })),
    ).rejects.toThrow(/no fiscal period covers entry date/);
  });
});

describe('T-274 closeYear — the happy path: net income', () => {
  it('✅ one entry, 4100/6900 zeroed, 3300 CREDITED the net income, periods locked', async () => {
    const f = await fixture('happy-path');
    await realActivity(f, YEAR, '20000.00', '8000.00');

    const result = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));
    expect(result.created).toBe(true);
    expect(result.periodsLocked).toBe(12);

    const lines = await sql<{ account_code: string; debit: string; credit: string }[]>`
      select a.code as account_code, jl.debit::text, jl.credit::text
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId}
      order by a.code`;
    expect(lines).toEqual([
      { account_code: '3300', debit: '0.00', credit: '12000.00' },
      { account_code: '4100', debit: '20000.00', credit: '0.00' },
      { account_code: '6900', debit: '0.00', credit: '8000.00' },
    ]);

    const [entry] = await sql<{ entry_date: string; source_type: string; status: string }[]>`
      select entry_date::text, source_type, status from journal_entries where id = ${result.entryId}`;
    expect(entry).toEqual({ entry_date: `${YEAR + 1}-01-01`, source_type: 'year_close', status: 'posted' });

    expect(await statusesOf(f.orgId, YEAR)).toEqual(Array(12).fill('locked'));
  });
});

describe('T-274 closeYear — a net-loss year', () => {
  it('✅ 3300 is DEBITED, not credited, when expense exceeds revenue', async () => {
    const f = await fixture('net-loss');
    await realActivity(f, YEAR, '8000.00', '20000.00');

    const result = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));

    const [line3300] = await sql<{ debit: string; credit: string }[]>`
      select jl.debit::text, jl.credit::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} and a.code = '3300'`;
    expect(line3300).toEqual({ debit: '12000.00', credit: '0.00' });
  });
});

describe('T-274 closeYear — an exact-zero year', () => {
  it('✅ no 3300 line at all when revenue exactly equals expense', async () => {
    const f = await fixture('exact-zero');
    await realActivity(f, YEAR, '5000.00', '5000.00');

    const result = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));

    const codes = await sql<{ code: string }[]>`
      select a.code from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} order by a.code`;
    expect(codes.map((r) => r.code)).toEqual(['4100', '6900']);
  });
});

describe('T-274 closeYear — idempotency', () => {
  it('✅ a second call is a safe no-op: created:false, periodsLocked:0, nothing double-posted', async () => {
    const f = await fixture('idempotent');
    await realActivity(f, YEAR, '20000.00', '8000.00');

    const first = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));
    expect(first.created).toBe(true);
    expect(first.periodsLocked).toBe(12);

    const second = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));
    expect(second.created).toBe(false);
    expect(second.entryId).toBe(first.entryId);
    expect(second.periodsLocked).toBe(0);

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text from journal_entries where source_type = 'year_close' and org_id = ${f.orgId}`;
    expect(row!.count).toBe('1');
  });
});

describe('T-274 closeYear — correcting it needs no override (Q3)', () => {
  it('✅ reverseEntry with an explicit reversalDate in a currently-open period succeeds', async () => {
    const f = await fixture('reversal');
    await realActivity(f, YEAR, '20000.00', '8000.00');
    const posted = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));

    // Year+1's January is where the entry landed and is still open — reverse into it directly,
    // no periodOverride anywhere in this call.
    const reversal = await asOrg(f.orgId, (tx) =>
      reverseEntry(tx, {
        entryId: posted.entryId,
        reason: 'fixture correction',
        reversalDate: `${YEAR + 1}-01-15`,
      }),
    );
    expect(reversal.created).toBe(true);

    const [row] = await sql<{ source_type: string }[]>`
      select source_type from journal_entries where id = ${reversal.reversalEntryId}`;
    expect(row!.source_type).toBe('year_close');
  });
});

describe('T-274 closeYear — the double-count regression includeYearClose:false prevents (test 10)', () => {
  it('✅ closing two consecutive years does not double-count the first year into 3300', async () => {
    const f = await fixture('two-years');
    await realActivity(f, YEAR, '20000.00', '8000.00'); // net 12,000.00
    const closeN = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));
    await realActivity(f, YEAR + 1, '30000.00', '10000.00'); // net 20,000.00
    const closeN1 = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR + 1 }));

    const linesN1 = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, jl.debit::text, jl.credit::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${closeN1.entryId} order by a.code`;
    // Only YEAR+1's own 4100/6900 activity and its own 3300 plug — year N's closing amounts
    // (which landed on 3300, an account outside v_income_statement) must not appear here at all.
    expect(linesN1.map((l) => l.code)).toEqual(['3300', '4100', '6900']);
    expect(linesN1.find((l) => l.code === '3300')).toEqual({ code: '3300', debit: '0.00', credit: '20000.00' });
    expect(linesN1.find((l) => l.code === '4100')).toEqual({ code: '4100', debit: '30000.00', credit: '0.00' });

    const [row] = await sql<{ balance: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
      from journal_lines jl join accounts a on a.id = jl.account_id
      where a.code = '3300' and jl.entry_id in (${closeN.entryId}, ${closeN1.entryId})`;
    // 12,000.00 (year N) + 20,000.00 (year N+1) = 32,000.00 — the sum of BOTH years' net income,
    // never one year counted twice.
    expect(row!.balance).toBe('32000.00');
  });
});

describe('T-274 closeYear — two-sided account activity nets to ONE line (test 11)', () => {
  it('✅ an expense charged 100 and refunded 30 closes as a single line crediting 70', async () => {
    const f = await fixture('two-sided-account');
    await seedYear(f.orgId, YEAR, 'open');
    // 6900 charged 100.00 (debit), then refunded 30.00 (credit) — both sides nonzero for the
    // year. debitTotal='100.00', creditTotal='30.00'. Net debit balance of 70.00.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: `${YEAR}-03-01`,
        sourceType: 'test',
        sourceId: uid('charge'),
        idempotencyKey: uid('charge-key'),
        lines: [
          { accountCode: '6900', storeId: f.storeId, debit: '100.00' },
          { accountCode: '1110', storeId: f.storeId, credit: '100.00' },
        ],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: `${YEAR}-04-01`,
        sourceType: 'test',
        sourceId: uid('refund'),
        idempotencyKey: uid('refund-key'),
        lines: [
          { accountCode: '1110', storeId: f.storeId, debit: '30.00' },
          { accountCode: '6900', storeId: f.storeId, credit: '30.00' },
        ],
      }),
    );
    await closeYearPeriodsDirectly(f.orgId, YEAR);
    await openJanuary(f.orgId, YEAR + 1);

    const result = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));

    const lines = await sql<{ account_code: string; debit: string; credit: string }[]>`
      select a.code as account_code, jl.debit::text, jl.credit::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} order by a.code`;
    // ONE line for 6900 (not two), crediting the NET 70.00 — never a two-sided line.
    expect(lines).toEqual([
      { account_code: '3300', debit: '70.00', credit: '0.00' },
      { account_code: '6900', debit: '0.00', credit: '70.00' },
    ]);
  });
});

describe('T-274 closeYear — an account that nets to exactly zero contributes no line (test 12)', () => {
  it('✅ 100 charged and 100 refunded on one account: no line for it, others close normally', async () => {
    const f = await fixture('nets-to-zero');
    await seedYear(f.orgId, YEAR, 'open');
    // 6300 charged 100.00 then fully refunded 100.00 — nets to exactly zero for the year.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: `${YEAR}-03-01`,
        sourceType: 'test',
        sourceId: uid('charge'),
        idempotencyKey: uid('charge-key'),
        lines: [
          { accountCode: '6300', storeId: f.storeId, debit: '100.00' },
          { accountCode: '1110', storeId: f.storeId, credit: '100.00' },
        ],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: `${YEAR}-04-01`,
        sourceType: 'test',
        sourceId: uid('refund'),
        idempotencyKey: uid('refund-key'),
        lines: [
          { accountCode: '1110', storeId: f.storeId, debit: '100.00' },
          { accountCode: '6300', storeId: f.storeId, credit: '100.00' },
        ],
      }),
    );
    // Real activity elsewhere so the year still has something to close.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: `${YEAR}-06-15`,
        sourceType: 'test',
        sourceId: uid('revenue'),
        idempotencyKey: uid('revenue-key'),
        lines: [
          { accountCode: '1110', storeId: f.storeId, debit: '20000.00' },
          { accountCode: '4100', storeId: f.storeId, credit: '20000.00' },
        ],
      }),
    );
    await closeYearPeriodsDirectly(f.orgId, YEAR);
    await openJanuary(f.orgId, YEAR + 1);

    const result = await asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR }));

    const codes = await sql<{ code: string }[]>`
      select a.code from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} order by a.code`;
    // 6300 nets to zero and is ABSENT — only 3300 (plug) and 4100 (real revenue) appear.
    expect(codes.map((r) => r.code)).toEqual(['3300', '4100']);
  });
});
