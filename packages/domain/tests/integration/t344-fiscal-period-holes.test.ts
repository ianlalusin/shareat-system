import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-344 / DEF-422 — the fiscal-period seed finds every hole, not only those after the latest
 * period end. `docs/tasks/344-def-422-fiscal-period-holes.md` §4, File 1.
 *
 * ⛔ RED until the builder lands `coverageHoles`/`classifyHoles`/`insertFilledPeriod` (§3.1-§3.2)
 * and migration 0160's order-guard trigger (§3.5 item 4, R1.2). H12/H13 need 0160 itself — they
 * fail on the missing migration (no such column/trigger), a DIFFERENT red than the others, which
 * fail on the real assertion because the classifier doesn't exist yet.
 *
 * `bareOrg`/`insertPeriod`/`periodsFor`/`periodCount`/`latestRun`/`runCount`/`monthEnd` copied from
 * `t276-fiscal-period-seed-job.test.ts` per this task's own Scope note ("Fixtures come from
 * t276-fiscal-period-seed-job.test.ts").
 *
 * `NOW = Date.parse('2026-08-31T20:00:00Z')` = 2026-09-01 04:00 Asia/Manila, so `M = '2026-09'`,
 * through `2027-08-31` (M+11).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { runFiscalPeriodSeed, closeYear, closePeriod, postEntry } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { journalRepo } from '@shareat/db';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const NOW = Date.parse('2026-08-31T20:00:00Z'); // 2026-09-01 04:00 Asia/Manila, M = '2026-09'.

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** An otherwise-ordinary org (chart of accounts, a store, an admin) with NO fiscal periods —
 *  same shape `t276-fiscal-period-seed-job.test.ts` uses. */
async function bareOrg(hint: string): Promise<{ orgId: string; personId: string }> {
  const code = uid(`fp-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return { orgId, personId: p!.id };
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
    values (${orgId}, ${startsOn}, ${endsOn}, ${opts.status ?? 'open'}, ${opts.closedAt ?? null}, ${opts.closedBy ?? null})`;
}

function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}

/** Inserts every month `startYear`-`startMonth` .. `endYear`-`endMonth` inclusive, same status. */
async function insertMonths(
  orgId: string,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    await insertPeriod(orgId, `${y}-${String(m).padStart(2, '0')}-01`, monthEnd(y, m), opts);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

interface PeriodRow {
  starts_on: string;
  ends_on: string;
  status: string;
  closed_at: string | null;
  closed_by: string | null;
  updated_at: string;
}
async function periodsFor(orgId: string): Promise<PeriodRow[]> {
  return sql<PeriodRow[]>`
    select starts_on::text as starts_on, ends_on::text as ends_on, status, closed_at, closed_by, updated_at
    from fiscal_periods where org_id = ${orgId} order by starts_on`;
}
async function periodCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from fiscal_periods where org_id = ${orgId}`;
  return row!.n;
}

interface RunRow {
  period: string;
  posted_count: number;
  skipped_count: number;
  failed_count: number;
  outcome: string;
  error: string | null;
  failures: { subjectId: string; subjectName: string; reason: string }[] | null;
}
async function latestRun(orgId: string): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`
    select period, posted_count, skipped_count, failed_count, outcome, error, failures
    from scheduler_runs where org_id = ${orgId} and job = 'fiscal_period_seed'
    order by started_at desc limit 1`;
  if (!row) throw new Error(`no fiscal_period_seed run row for org ${orgId}`);
  return row;
}

/** Same shape as `fiscal-period-close.test.ts`'s `asOrg` — APP_ROLE, org GUC set, for raw-SQL
 *  tests against the real trigger (H12/H13's own writes; not the job, which manages its own
 *  system-principal transaction). */
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Every race test below waits on a barrier (a connection signalling it has reached its held
 *  point). A barrier that never signals must FAIL the test, not hang the whole run — orchestrator
 *  CHANGES, 2026-09-25. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

describe('H1-H2 — an interior hole between two open ranges is filled (class A), and the rerun is quiet', () => {
  let orgId = '';

  it('H1 — 2026-01..05 open, 2026-09..2027-08 open: the 06..08 hole is backfilled, reported once', async () => {
    const { orgId: id } = await bareOrg('h1');
    orgId = id;
    await insertMonths(orgId, 2026, 1, 2026, 5);
    await insertMonths(orgId, 2026, 9, 2027, 8);
    const before = await periodsFor(orgId);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(3);
    expect(run.outcome).toBe('partial');
    expect(run.failures).toHaveLength(1);
    expect(run.failures![0]!.reason).toMatch(/backfilled 3 elapsed month\(s\) 2026-06\.\.2026-08 as open/);

    const period = await withOrgPrincipal(orgId, (tx) => journalRepo.findPeriodForDate(tx, orgId, '2026-07-15'));
    expect(period?.startsOn).toBe('2026-07-01');

    const after = await periodsFor(orgId);
    // NEGATIVE — nothing before 2026-01-01.
    expect(after.every((p) => p.starts_on >= '2026-01-01')).toBe(true);
    // NEGATIVE — the five original rows are byte-unchanged.
    const beforeFive = before.filter((p) => p.starts_on < '2026-06-01');
    const afterFive = after.filter((p) => p.starts_on < '2026-06-01');
    expect(afterFive.map((p) => ({ status: p.status, updated_at: p.updated_at }))).toEqual(
      beforeFive.map((p) => ({ status: p.status, updated_at: p.updated_at })),
    );
  });

  it('H2 — rerun: the now-covered org from H1 reports ok, not partial twice', async () => {
    expect(orgId, 'H1 must run first').not.toBe('');
    const before = await periodCount(orgId);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(0);
    expect(run.outcome).toBe('ok');
    expect(await periodCount(orgId)).toBe(before);
  });
});

describe('H3-H4 — a whole month missing inside closed books is reported, never filled', () => {
  let orgId = '';

  it('H3 — 2026-01..03 closed, 04 missing, 05 closed, 06..2027-08 open: April is reported, not created', async () => {
    const { orgId: id } = await bareOrg('h3');
    orgId = id;
    await insertMonths(orgId, 2026, 1, 2026, 3, { status: 'closed' });
    await insertMonths(orgId, 2026, 5, 2026, 5, { status: 'closed' });
    await insertMonths(orgId, 2026, 6, 2027, 8);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(0);
    expect(run.outcome).toBe('failed');
    expect(run.failures).toHaveLength(1);
    expect(run.failures![0]!.reason).toBe(
      'month 2026-04 is missing inside closed books, so posts dated in it are refused; an administrator ' +
        'can create it as closed with "Create the missing month" on /findings',
    );
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2026-04-01')).toBe(false);
  });

  it('H4 — rerun: the same April line is reported again, not silenced', async () => {
    expect(orgId, 'H3 must run first').not.toBe('');
    await runFiscalPeriodSeed({ orgId, nowMs: NOW });
    const run = await latestRun(orgId);
    expect(run.outcome).toBe('failed');
    expect(run.failures![0]!.reason).toMatch(/2026-04 is missing inside closed books/);
  });
});

describe('H5 — a hole in a locked year is reported "as locked", and postEntry still refuses it', () => {
  it('2025 all locked except 2025-06 missing; 2026-01..2027-08 open', async () => {
    const { orgId } = await bareOrg('h5');
    await insertMonths(orgId, 2025, 1, 2025, 5, { status: 'locked' });
    await insertMonths(orgId, 2025, 7, 2025, 12, { status: 'locked' });
    await insertMonths(orgId, 2026, 1, 2027, 8);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.outcome).toBe('failed');
    expect(run.failures![0]!.reason).toMatch(/2025-06 is missing inside closed books/);
    expect(run.failures![0]!.reason).toMatch(/create it as locked/);
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2025-06-01')).toBe(false);

    await expect(
      withOrgPrincipal(orgId, (tx) => postEntry(tx, {
        orgId,
        entryDate: '2025-06-15',
        sourceType: 'test',
        sourceId: uid('h5'),
        idempotencyKey: uid('h5-key'),
        lines: [
          { accountCode: '6300', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
      })),
    ).rejects.toThrow(/no fiscal period covers/);
  });
});

describe('H6 — a part-month hole in open books (class D) is reported, never filled', () => {
  it('2026-09..2027-07 open + 2027-08-01..15 open: 2027-08-16..08-31 is reported', async () => {
    const { orgId } = await bareOrg('h6');
    await insertMonths(orgId, 2026, 9, 2027, 7);
    // 0174: an open period must be a whole month, so the part-month piece is closed; closed-after-open
    // is legacy state (R1.2), built under replica as the cutover ETL does. Only this raw insert.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${orgId}, '2027-08-01', '2027-08-15', 'closed')`;
    });

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.outcome).toBe('failed');
    expect(run.failures![0]!.reason).toMatch(/2027-08-16\.\.2027-08-31/);
    expect(run.failures![0]!.reason).toMatch(/coverage hole NOT filled/);
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2027-08-16')).toBe(false);
  });
});

describe('H7 — a part-month hole in closed books (class C) is reported, never filled', () => {
  it('2026-04 closed, 2026-05-01..05-20 closed, 06 closed, 07..2027-08 open: 05-21..05-31 is reported', async () => {
    const { orgId } = await bareOrg('h7');
    await insertMonths(orgId, 2026, 4, 2026, 4, { status: 'closed' });
    await insertPeriod(orgId, '2026-05-01', '2026-05-20', { status: 'closed' });
    await insertMonths(orgId, 2026, 6, 2026, 6, { status: 'closed' });
    await insertMonths(orgId, 2026, 7, 2027, 8);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.outcome).toBe('failed');
    expect(run.failures![0]!.reason).toMatch(/2026-05-21\.\.2026-05-31/);
    expect(run.failures![0]!.reason).toMatch(/\(part of 2026-05\)/);
    expect(run.failures![0]!.reason).toMatch(/Create the missing month/);
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2026-05-21')).toBe(false);
  });
});

describe('H8 — a B hole and an A hole in the same run each get their own line', () => {
  it('2026-01 closed, 02 missing (03 closed), 04-05 open, 06-08 missing (A), 09..2027-08 open', async () => {
    const { orgId } = await bareOrg('h8');
    await insertMonths(orgId, 2026, 1, 2026, 1, { status: 'closed' });
    await insertMonths(orgId, 2026, 3, 2026, 3, { status: 'closed' });
    await insertMonths(orgId, 2026, 4, 2026, 5);
    await insertMonths(orgId, 2026, 9, 2027, 8);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(3);
    expect(run.outcome).toBe('partial');
    expect(run.failures).toHaveLength(2);
    const reasons = run.failures!.map((f) => f.reason).join('\n');
    expect(reasons).toMatch(/2026-02 is missing inside closed books/);
    expect(reasons).toMatch(/backfilled 3 elapsed month\(s\) 2026-06\.\.2026-08 as open/);
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2026-02-01')).toBe(false);
  });
});

describe('H9 — a future interior hole (not yet elapsed) is filled quietly, no failure line', () => {
  it('2026-09..10, 2027-01..08 open: 2026-11..12 is backfilled as open, outcome ok', async () => {
    const { orgId } = await bareOrg('h9');
    await insertMonths(orgId, 2026, 9, 2026, 10);
    await insertMonths(orgId, 2027, 1, 2027, 8);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(2);
    expect(run.outcome).toBe('ok');
    expect(run.failures).toBeNull();
    const periods = await periodsFor(orgId);
    const nov = periods.find((p) => p.starts_on === '2026-11-01');
    const dec = periods.find((p) => p.starts_on === '2026-12-01');
    expect(nov?.status).toBe('open');
    expect(dec?.status).toBe('open');
  });
});

describe('H10 — fully covered: no holes, the ordinary forward-seed detail is unchanged', () => {
  it('2026-01..08 closed, 09..2027-08 open', async () => {
    const { orgId } = await bareOrg('h10');
    await insertMonths(orgId, 2026, 1, 2026, 8, { status: 'closed' });
    await insertMonths(orgId, 2026, 9, 2027, 8);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(0);
    expect(run.skipped_count).toBe(12);
    expect(run.outcome).toBe('ok');
  });
});

describe('H11-H11b — R1.1: a gap in a closed year is B/C (locked), never A (open)', () => {
  it('H11 — closeYear(2025) locks Jan-May; 2025-06..12 missing is reported as seven B lines, none created', async () => {
    const { orgId, personId } = await bareOrg('h11');
    const who = actor(orgId, personId);
    // Jan-May start OPEN — real activity is posted, then each is closed through the real
    // `closePeriod` (in order), then the real `closeYear` locks them and posts the year_close
    // entry. This exercises the actual domain path H11's own "given" describes, rather than
    // hand-faking a `locked` status this test cannot otherwise produce.
    await insertMonths(orgId, 2025, 1, 2025, 5);
    await insertMonths(orgId, 2026, 1, 2027, 8);
    await withOrgPrincipal(orgId, (tx) =>
      postEntry(tx, {
        orgId,
        entryDate: '2025-01-15',
        sourceType: 'test',
        sourceId: uid('h11-activity'),
        idempotencyKey: uid('h11-activity-key'),
        lines: [
          { accountCode: '6300', debit: '500.00' },
          { accountCode: '1110', credit: '500.00' },
        ],
      }),
    );
    for (let m = 1; m <= 5; m++) {
      await withOrgPrincipal(orgId, (tx) => closePeriod(tx, who, { period: `2025-${String(m).padStart(2, '0')}` }));
    }
    await withOrgPrincipal(orgId, (tx) => closeYear(tx, who, { orgId, year: 2025 }));

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(0);
    expect(run.outcome).toBe('failed');
    expect(run.failures).toHaveLength(7);
    for (const f of run.failures!) {
      expect(f.reason).toMatch(/is missing inside closed books/);
      expect(f.reason).toMatch(/create it as locked/);
    }
    const periods = await periodsFor(orgId);
    for (let m = 6; m <= 12; m++) {
      expect(periods.some((p) => p.starts_on === `2025-${String(m).padStart(2, '0')}-01`)).toBe(false);
    }
  });

  it('H11b — 2024-12 closed; no 2025 periods at all; a posted year_close entry alone closes the year', async () => {
    const { orgId, personId } = await bareOrg('h11b');
    await insertMonths(orgId, 2024, 12, 2024, 12, { status: 'closed', closedAt: '2025-01-01T00:00:00Z', closedBy: personId });
    await insertMonths(orgId, 2026, 1, 2027, 8);
    // Superuser SQL: a posted year_close entry dated 2026-01-01, `sourceId` `{org}:2025`, matching
    // `closeYear`'s own idempotency-key shape (close-year.ts:118-121) without running the domain
    // function (there is nothing to actually close — no 2025 periods exist to lock). Both rows go
    // in ONE transaction — the balance/minimum-two-lines guard is a DEFERRED constraint trigger
    // that fires at commit, so the entry and its lines must land together.
    const [period2026] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${orgId} and starts_on = '2026-01-01'`;
    const accts = await sql<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${orgId} and code in ('6300', '1110')`;
    const acctId = (code: string) => accts.find((a) => a.code === code)!.id;
    await sql.begin(async (tx) => {
      // Lines may only be inserted while the entry is `draft` — insert draft, add lines, then
      // flip to `posted` in the same transaction (the balance/minimum-two-lines guard is a
      // DEFERRED constraint trigger, checked at commit, so this order is safe).
      const [entry] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
        values (${orgId}, '2026-01-01', ${period2026!.id}, 'year_close', ${`${orgId}:2025`}, ${uid('h11b-key')}, 'fixture year close', ${personId}, 'draft')
        returning id`;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, debit, credit)
        values
          (${entry!.id}, 1, ${acctId('6300')}, 500.00, 0),
          (${entry!.id}, 2, ${acctId('1110')}, 0, 500.00)`;
      await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
    });

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(0);
    expect(run.outcome).toBe('failed');
    expect(run.failures).toHaveLength(12);
    for (const f of run.failures!) {
      expect(f.reason).toMatch(/is missing inside closed books/);
      expect(f.reason).toMatch(/create it as locked/);
    }
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on.startsWith('2025-'))).toBe(false);
  });
});

describe('H12 — R1.2: the order-guard trigger refuses an open row that starts before a closed one', () => {
  it('APP role, raw SQL: 2026-07 and 2026-08 closed exist', async () => {
    const { orgId, personId } = await bareOrg('h12');
    await insertMonths(orgId, 2026, 7, 2026, 8, { status: 'closed', closedAt: '2026-09-01T00:00:00Z', closedBy: personId });

    await expect(
      asOrg(orgId, (tx) =>
        tx.execute(
          dsql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-06-01', '2026-06-30', 'open')`,
        ),
      ),
    ).rejects.toThrow(/an open period cannot start on 2026-06-01/);

    await expect(
      asOrg(orgId, (tx) =>
        tx.execute(
          dsql`update fiscal_periods set status = 'open' where org_id = ${orgId} and starts_on = '2026-07-01'`,
        ),
      ),
    ).rejects.toThrow(/an open period cannot start on 2026-07-01/);
  });
});

describe('H13 — R1.2 race: a concurrent close is not raced past by the seed job', () => {
  it("0174 (DEF-424) made the original close-vs-seed race unreachable; this pins the seed job's response to a legacy hole behind closed books", async () => {
    const { orgId, personId } = await bareOrg('h13');
    const who = actor(orgId, personId);
    // Reshaped post-0160 (orchestrator CHANGES, 2026-09-25): Jan-May are closed FIRST, through the
    // real `closePeriod`, each succeeding while nothing else in the org is open yet — so the AT-REST
    // state is always valid under R1.2's now-bidirectional, statement-level guard. The original
    // fixture left Jan-May OPEN while July closed underneath the race, which is precisely the shape
    // the guard now refuses outright, before the race is ever exercised.
    await insertMonths(orgId, 2026, 1, 2026, 5);
    for (let m = 1; m <= 5; m++) {
      await withOrgPrincipal(orgId, (tx) => closePeriod(tx, who, { period: `2026-${String(m).padStart(2, '0')}` }));
    }
    // 2026-06 stays MISSING (the hole B will try to fill). July starts OPEN — closed AFTER May
    // (closed) is the ordinary, valid direction, so this insert itself is unremarkable.
    await insertPeriod(orgId, '2026-07-01', '2026-07-31');
    await insertMonths(orgId, 2026, 8, 2026, 8);
    await insertMonths(orgId, 2026, 9, 2027, 8);

    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const aPromise = sql.begin(async (tx) => {
      // 0174's gap guard refuses closing July over the missing June; legacy state (a hole behind a
      // closed month) is built under replica, as the cutover ETL does. Only this raw statement.
      await tx`set local session_replication_role = 'replica'`;
      await tx`
        update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${personId}
        where org_id = ${orgId} and starts_on = '2026-07-01'`;
      signalReady();
      await held;
    });

    await withTimeout(ready, 5000, 'connection A to signal it has closed July and is holding');
    // Under replica A's close takes no advisory lock (0160's guard is silent), so B cannot be made to
    // wait on it: A commits first, and B then meets the committed legacy state (July closed, June missing).
    releaseA();
    await aPromise;
    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    // 0174 (DEF-424): the close-vs-seed race is gone; legacy hole behind closed July is reported, not filled.
    expect(run.error).toBeNull();
    expect(run.failures![0]!.reason).toMatch(/missing inside closed books/);
    expect(run.failures![0]!.reason).toMatch(/2026-06/);
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2026-06-01')).toBe(false);
  });
});

/** True when this org has ANY open period that starts before a closed/locked one — the shape R1.2
 *  forbids in either direction. `0160:67`'s guard today only re-checks an INSERT/UPDATE that sets
 *  `NEW.status = 'open'`; it never re-validates when the OTHER side of the race — a period being
 *  closed/locked — is what lands last. Asserted as a raw data shape, not a specific error message,
 *  because the fix's exact wording is the builder's call. */
async function hasOpenBeforeClosedOrLocked(orgId: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from fiscal_periods p1
      join fiscal_periods p2 on p2.org_id = p1.org_id
      where p1.org_id = ${orgId} and p1.status = 'open'
        and p2.status in ('closed', 'locked') and p2.starts_on > p1.starts_on
    ) as "exists"`;
  return row!.exists;
}

/** 2025 Jan-Nov CLOSED (real activity, real `closePeriod`, in order — succeeds since nothing else
 *  is open or closed yet), 2025-12 deliberately MISSING, 2026-01 open (so the year-close entry, dated
 *  2026-01-01, has a period to post into). Orchestrator CHANGES (2026-09-25) — the real at-rest
 *  shape for H13b's own race: closed months before an open month is the ordinary, valid direction
 *  (Nov 2025 < Jan 2026), so nothing here conflicts with R1.2's guard on its own. */
async function h13bYearFixture(hint: string): Promise<{ orgId: string; personId: string; who: Actor }> {
  const { orgId, personId } = await bareOrg(hint);
  const who = actor(orgId, personId);
  await insertMonths(orgId, 2025, 1, 2025, 11);
  await withOrgPrincipal(orgId, (tx) =>
    postEntry(tx, {
      orgId,
      entryDate: '2025-01-15',
      sourceType: 'test',
      sourceId: uid(hint),
      idempotencyKey: uid(`${hint}-key`),
      lines: [
        { accountCode: '6300', debit: '500.00' },
        { accountCode: '1110', credit: '500.00' },
      ],
    }),
  );
  for (let m = 1; m <= 11; m++) {
    await withOrgPrincipal(orgId, (tx) => closePeriod(tx, who, { period: `2025-${String(m).padStart(2, '0')}` }));
  }
  await insertMonths(orgId, 2026, 1, 2026, 1);
  return { orgId, personId, who };
}

/** The exact bad final state Q1/R1.1 exist to forbid: 2025-12 open while some 2025 period is
 *  locked — a month sitting INSIDE a year that has already been closed and locked around it.
 *  ⚠️ This is NOT the same shape `hasOpenBeforeClosedOrLocked` checks: Nov 2025 (locked) is
 *  chronologically BEFORE Dec 2025 (open) either way, so R1.2's ordering guard alone does not
 *  reach this — it needs its own check. */
async function decOpenInsideLockedYear(orgId: string): Promise<boolean> {
  const [row] = await sql<{ dec_open: boolean; year_locked: boolean }[]>`
    select
      exists (select 1 from fiscal_periods where org_id = ${orgId} and starts_on = '2025-12-01' and status = 'open') as dec_open,
      exists (select 1 from fiscal_periods where org_id = ${orgId} and starts_on >= '2025-01-01' and starts_on <= '2025-11-01' and status = 'locked') as year_locked`;
  return row!.dec_open && row!.year_locked;
}

describe('H13b — R1.2 reverse race: a concurrent open-period insert must not slip past a close', () => {
  it("closePeriod on May must refuse while April is concurrently being opened", async () => {
    const { orgId, personId } = await bareOrg('h13b-close');
    await insertMonths(orgId, 2026, 5, 2026, 5);

    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const aPromise = sql.begin(async (tx) => {
      await tx`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${orgId}, '2026-04-01', '2026-04-30', 'open')`;
      signalReady();
      await held;
    });

    await withTimeout(ready, 5000, 'connection A to signal it has inserted April and is holding');
    const bPromise = withOrgPrincipal(orgId, (tx) => closePeriod(tx, actor(orgId, personId), { period: '2026-05' }));
    bPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    releaseA();
    await aPromise;

    await expect(bPromise).rejects.toThrow();
    expect(
      await hasOpenBeforeClosedOrLocked(orgId),
      'April must never end up open with May closed after it',
    ).toBe(false);
  });

  it('closeYear(2025) must refuse while Dec-2025 is concurrently opened (A-first): the real race the review named', async () => {
    // Orchestrator CHANGES (2026-09-25), restoring the real shape after my first reshape drifted
    // away from it: 2025 Jan-Nov CLOSED, 2025-12 missing, 2026 open — VALID at rest (closed months
    // before an open month is the ordinary direction; R1.2's guard is max(closed/locked starts_on) >
    // min(open starts_on), and Nov 2025 < Jan 2026, so nothing here conflicts). Connection A inserts
    // 2025-12 as open (the job's own class-A fill, since nothing closed/locked starts after it and
    // 2025 is not yet "closed" under R1.1 — merely `closed`, not `locked`, and no year_close entry
    // exists yet) and holds, uncommitted. Connection B runs `closeYear(2025)` concurrently, which
    // locks Jan-Nov and posts the year-close entry.
    //
    // ⚠️ The order guard as built does NOT necessarily catch this shape: Nov-2025 (locked) sits
    // BEFORE Dec-2025 (open) chronologically either way — that is the FORWARD direction the guard
    // allows, not the one it refuses. The defect this test is really pinned against is Q1's own
    // rule ("never inside a closed year"), racing against `hasEarlierOpenPeriod`'s plain SELECT
    // (unprotected by the advisory lock) inside `closeYear` — not R1.2's ordering check. This is
    // reported as red or green on its own real terms; a red here is a genuine, distinct gap from
    // R1.2, not a test-authoring bug.
    const { orgId, who } = await h13bYearFixture('h13b-2-a-first');

    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const aPromise = sql.begin(async (tx) => {
      await tx`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${orgId}, '2025-12-01', '2025-12-31', 'open')`;
      signalReady();
      await held;
    });

    await withTimeout(ready, 5000, 'connection A to insert 2025-12 and hold');
    const bPromise = withOrgPrincipal(orgId, (tx) => closeYear(tx, who, { orgId, year: 2025 }));
    bPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    releaseA();
    await aPromise;

    let bError: string | null = null;
    try {
      await bPromise;
    } catch (err) {
      bError = err instanceof Error ? err.message : String(err);
    }

    const badState = await decOpenInsideLockedYear(orgId);
    expect(badState, `Dec-2025 open inside a locked 2025 — closeYear error was: ${bError ?? '(none — it succeeded)'}`).toBe(
      false,
    );
  });

  it('closeYear(2025) must refuse while Dec-2025 is concurrently opened (B-first): same race, reversed start order', async () => {
    const { orgId, who } = await h13bYearFixture('h13b-2-b-first');

    let releaseB: () => void = () => {};
    const heldB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let signalReadyB: () => void = () => {};
    const readyB = new Promise<void>((resolve) => {
      signalReadyB = resolve;
    });

    // B does its real work (posts the entry, locks Jan-Nov — which is where `lockYearPeriods`'s
    // UPDATE acquires the per-org advisory lock) and only THEN signals and holds, uncommitted —
    // so A's insert, started after the signal, must contend for the SAME lock B is still holding.
    const bPromise = withOrgPrincipal(orgId, async (tx) => {
      const result = await closeYear(tx, who, { orgId, year: 2025 });
      signalReadyB();
      await heldB;
      return result;
    });
    bPromise.catch(() => {});

    await withTimeout(readyB, 5000, 'connection B to finish closeYear and hold before commit');
    const aPromise = sql.begin(async (tx) => {
      await tx`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${orgId}, '2025-12-01', '2025-12-31', 'open')`;
    });
    aPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    releaseB();

    let bError: string | null = null;
    try {
      await bPromise;
    } catch (err) {
      bError = err instanceof Error ? err.message : String(err);
    }
    let aError: string | null = null;
    try {
      await aPromise;
    } catch (err) {
      aError = err instanceof Error ? err.message : String(err);
    }

    const badState = await decOpenInsideLockedYear(orgId);
    expect(
      badState,
      `Dec-2025 open inside a locked 2025 — closeYear error: ${bError ?? '(none)'}; insert error: ${aError ?? '(none)'}`,
    ).toBe(false);
  });
});

describe('H13c — a related, DIFFERENT race: closing 2026 in sequence while an earlier missing month (2025-12) is opened', () => {
  // Kept per the orchestrator's suggestion (2026-09-25) — this is real coverage of a genuine shape
  // (an earlier open period blocking a close sequence via R1.2's lock), just not H13b's own named
  // race. Jan-May 2026 close successfully FIRST (valid: nothing else is open yet), THEN the race:
  // A inserts 2025-12 as open and holds (valid at that moment too — nothing in the org is
  // closed/locked yet). B closes January 2026 next — this is where the two collide: B's UPDATE
  // needs the SAME per-org advisory lock A holds, blocks, and once A commits, B's re-check sees
  // 2025-12 (open) sitting before 2026-01 (about to close) and refuses. `closeYear` itself is never
  // reached in this scenario, which is a stronger outcome than the original test even asked for.
  it('two connections: A opens 2025-12 and holds; B is refused closing 2026-01, and closeYear never runs', async () => {
    const { orgId, personId } = await bareOrg('h13c');
    const who = actor(orgId, personId);
    // Jan-May 2026 start OPEN (not yet closed) — closing them is what B's sequence does, racing A.
    await insertMonths(orgId, 2026, 1, 2026, 5);
    await insertMonths(orgId, 2027, 1, 2027, 8);

    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const aPromise = sql.begin(async (tx) => {
      await tx`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${orgId}, '2025-12-01', '2025-12-31', 'open')`;
      signalReady();
      await held;
    });

    await withTimeout(ready, 5000, 'connection A to insert 2025-12 and hold');
    // B closes January first (the FIRST step any real "close the 2026 year" workflow would take).
    // At the moment B's UPDATE runs, 2025-12 is not yet committed (READ COMMITTED), so B's own
    // `hasEarlierOpenPeriod` plain SELECT sees nothing wrong — the UPDATE itself is what contends
    // for A's advisory lock, blocks, and once A commits, the order guard's re-check sees 2025-12
    // (open) sitting before 2026-01 (about to close) and refuses. `closeYear` is never reached.
    const bPromise = withOrgPrincipal(orgId, (tx) => closePeriod(tx, who, { period: '2026-01' }));
    bPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    releaseA();
    await aPromise;

    await expect(bPromise).rejects.toThrow();
    expect(
      await hasOpenBeforeClosedOrLocked(orgId),
      '2025-12 must never end up open with any of 2026 closed after it',
    ).toBe(false);
  });
});

describe('H14 — the tail failure line names the real latest period end even when the tail starts with a closed-books piece', () => {
  it('2025-01..10 locked; 2025-11..12 missing (inside the closed year); nothing in 2026/2027', async () => {
    const { orgId, personId } = await bareOrg('h14');
    await insertMonths(orgId, 2025, 1, 2025, 10, { status: 'locked', closedAt: '2025-11-01T00:00:00Z', closedBy: personId });

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(20); // 8 elapsed (2026-01..08) + 12 forward (2026-09..2027-08)
    expect(run.outcome).toBe('partial');
    expect(run.failures).toHaveLength(3);
    const reasons = run.failures!.map((f) => f.reason);
    expect(reasons.some((r) => /2025-11 is missing inside closed books/.test(r))).toBe(true);
    expect(reasons.some((r) => /2025-12 is missing inside closed books/.test(r))).toBe(true);
    expect(reasons).toContainEqual(
      'coverage gap: periods ended 2025-10-31; backfilled 8 elapsed month(s) 2026-01..2026-08 as open — ' +
        'created after their own month ended, so no close ever ran on them',
    );
    const periods = await periodsFor(orgId);
    expect(periods.some((p) => p.starts_on === '2025-11-01' || p.starts_on === '2025-12-01')).toBe(false);
  });
});
