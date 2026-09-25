import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-276 / DEF-305 — the fiscal-period coverage job. `docs/tasks/276-def-305-fiscal-period-coverage.md`,
 * "Build slice (2026-09-25)" §3 T1.
 *
 * ✅ Green since T-276 shipped `runFiscalPeriodSeed` (`packages/domain/src/scheduler/index.ts`,
 * re-exported from `@shareat/domain` via its `export * from './scheduler'` barrel). Stale RED
 * header corrected 2026-09-25 (T-344/DEF-422, tester) — the original claim that the import binds
 * but the call throws no longer describes this file.
 *
 * `bareOrg`/`asOrg` copied from `fiscal-periods-seeding.test.ts:40-63` — that file's own header
 * explains why (an otherwise-ordinary org with no fiscal periods, the exact pre-DEF-284 shape).
 * Periods are seeded directly by raw SQL (never through `seedCalendarMonths`, which is the function
 * under indirect test here) so each fixture states its own "given" precisely, matching the task's
 * own table column-for-column.
 *
 * `NOW = Date.parse('2026-08-31T20:00:00Z')` = 2026-09-01 04:00 Asia/Manila, so `M = '2026-09'`
 * (`fiscalPeriodSeedWindow`'s own `toBusinessDate` conversion) — the spec's pinned instant.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, SCHEDULER_JOBS } from '@shareat/db';
import { runFiscalPeriodSeed } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const NOW = Date.parse('2026-08-31T20:00:00Z'); // 2026-09-01 04:00 Asia/Manila, M = '2026-09'.

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** An otherwise-ordinary org (chart of accounts, a store, an admin) with NO fiscal periods —
 *  `fiscal-periods-seeding.test.ts:41-54`, plus the admin's own id (for `closed_by`). */
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

interface PeriodRow {
  starts_on: string;
  ends_on: string;
  status: string;
  closed_at: string | null;
  closed_by: string | null;
  updated_at: string;
}
async function periodsFor(orgId: string): Promise<PeriodRow[]> {
  // ⭐ Fix (2026-09-25, builder-flagged): `starts_on`/`ends_on` are SQL `date` columns; the
  // `postgres` client returns those as JS `Date`, not string, so every `p.starts_on === '2027-08-01'`
  // / `>= '2026-09-01'` comparison in this file was silently comparing a Date to a string and never
  // matching. Cast to `::text` explicitly so this file's own literal date comparisons mean what
  // they say — `YYYY-MM-DD`, byte for byte.
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
  failures: { subjectId: string; subjectName: string; reason: string }[] | null;
}
async function latestRun(orgId: string): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`
    select period, posted_count, skipped_count, failed_count, outcome, failures
    from scheduler_runs where org_id = ${orgId} and job = 'fiscal_period_seed'
    order by started_at desc limit 1`;
  if (!row) throw new Error(`no fiscal_period_seed run row for org ${orgId}`);
  return row;
}
async function runCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from scheduler_runs where org_id = ${orgId} and job = 'fiscal_period_seed'`;
  return row!.n;
}

describe('T1 — runFiscalPeriodSeed', () => {
  /** Handed from case 4 to case 4b — the spec's "4b rerun" is explicitly the SAME org case 4
   *  produced, not a fresh one, so this file's tests run in declaration order (Vitest's default
   *  within one describe block; no `.concurrent` here). */
  let case4OrgId = '';

  it('case 1 — on schedule: coverage already 2026-09..2027-07, tops up exactly the missing month', async () => {
    const { orgId } = await bareOrg('c1');
    // 2026-09 .. 2027-07 inclusive = 11 months.
    for (let m = 9; m <= 12; m++) await insertPeriod(orgId, `2026-${String(m).padStart(2, '0')}-01`, monthEnd(2026, m));
    for (let m = 1; m <= 7; m++) await insertPeriod(orgId, `2027-${String(m).padStart(2, '0')}-01`, monthEnd(2027, m));
    const before = await periodCount(orgId);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run).toMatchObject({ posted_count: 1, skipped_count: 11, failed_count: 0, outcome: 'ok', period: '2026-09' });
    const periods = await periodsFor(orgId);
    const aug2027 = periods.find((p) => p.starts_on === '2027-08-01');
    expect(aug2027?.status).toBe('open');
    // NEGATIVE — nothing before 2026-09-01; exactly one new row.
    expect(periods.every((p) => p.starts_on >= '2026-09-01')).toBe(true);
    expect(await periodCount(orgId)).toBe(before + 1);
  });

  it('case 2 — covered no-op: rerunning a fully-covered org posts nothing and still records a run', async () => {
    const { orgId } = await bareOrg('c2');
    for (let m = 9; m <= 12; m++) await insertPeriod(orgId, `2026-${String(m).padStart(2, '0')}-01`, monthEnd(2026, m));
    for (let m = 1; m <= 8; m++) await insertPeriod(orgId, `2027-${String(m).padStart(2, '0')}-01`, monthEnd(2027, m));
    const before = await periodCount(orgId);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run).toMatchObject({ posted_count: 0, skipped_count: 12, outcome: 'ok' });
    expect(await runCount(orgId), 'a second run row exists (DEF-044)').toBe(1);
    await runFiscalPeriodSeed({ orgId, nowMs: NOW });
    expect(await runCount(orgId)).toBe(2);
    const rerun = await latestRun(orgId);
    // NEGATIVE — count unchanged; gap not re-reported.
    expect(await periodCount(orgId)).toBe(before);
    expect(rerun).toMatchObject({ posted_count: 0, outcome: 'ok', failures: null });
  });

  it('case 3 — legacy wide period: every candidate month conflicts, detail names where coverage ends', async () => {
    const { orgId } = await bareOrg('c3');
    await insertPeriod(orgId, '2020-01-01', '2035-12-31');

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run).toMatchObject({ posted_count: 0, skipped_count: 12, outcome: 'ok' });
    // NEGATIVE — count still 1.
    expect(await periodCount(orgId)).toBe(1);
  });

  it('case 4 — gap → partial: a 4-month-stale org gets backfilled and the gap is reported', async () => {
    const { orgId, personId } = await bareOrg('c4');
    await insertPeriod(orgId, '2026-01-01', '2026-01-31', { status: 'closed', closedAt: '2026-02-15T00:00:00Z', closedBy: personId });
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', { status: 'closed', closedAt: '2026-03-15T00:00:00Z', closedBy: personId });
    await insertPeriod(orgId, '2026-03-01', '2026-03-31', { status: 'closed', closedAt: '2026-04-15T00:00:00Z', closedBy: personId });
    await insertPeriod(orgId, '2026-04-01', '2026-04-30', { status: 'closed', closedAt: '2026-05-15T00:00:00Z', closedBy: personId });
    await insertPeriod(orgId, '2026-05-01', '2026-05-31', { status: 'open' });
    const before = await periodsFor(orgId);

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(15);
    expect(run.failed_count).toBe(1);
    expect(run.outcome).toBe('partial');
    expect(run.failures).toEqual([
      {
        subjectId: orgId,
        subjectName: expect.any(String),
        reason:
          'coverage gap: periods ended 2026-05-31; backfilled 3 elapsed month(s) 2026-06..2026-08 as open — ' +
          'created after their own month ended, so no close ever ran on them',
      },
    ]);
    const after = await periodsFor(orgId);
    const aug2027 = after.find((p) => p.starts_on === '2027-08-01');
    expect(aug2027?.ends_on).toBe('2027-08-31');

    // NEGATIVE — 06/07/08 open, closed_at/by null.
    for (const m of ['2026-06-01', '2026-07-01', '2026-08-01']) {
      const p = after.find((r) => r.starts_on === m)!;
      expect(p.status, m).toBe('open');
      expect(p.closed_at, m).toBeNull();
      expect(p.closed_by, m).toBeNull();
    }
    // NEGATIVE — the original 5 rows are byte-unchanged (ON CONFLICT DO NOTHING never touches them).
    const beforeFive = before.filter((p) => p.starts_on < '2026-06-01');
    const afterFive = after.filter((p) => p.starts_on < '2026-06-01');
    expect(afterFive.map((p) => ({ status: p.status, closed_at: p.closed_at, closed_by: p.closed_by, updated_at: p.updated_at }))).toEqual(
      beforeFive.map((p) => ({ status: p.status, closed_at: p.closed_at, closed_by: p.closed_by, updated_at: p.updated_at })),
    );
    // NEGATIVE — nothing NEW before 2026-06-01 (the backfill starts at the gap, not earlier).
    const newlyCreated = after.filter((p) => !before.some((b) => b.starts_on === p.starts_on));
    expect(newlyCreated.every((p) => p.starts_on >= '2026-06-01')).toBe(true);

    case4OrgId = orgId;
  });


  it('case 4b — rerun: the now-covered org from case 4 reports ok, not partial twice', async () => {
    expect(case4OrgId, 'case 4 must run first to produce this fixture').not.toBe('');
    const before = await periodCount(case4OrgId);

    await runFiscalPeriodSeed({ orgId: case4OrgId, nowMs: NOW });

    const run = await latestRun(case4OrgId);
    expect(run).toMatchObject({ posted_count: 0, skipped_count: 12, outcome: 'ok' });
    expect(await periodCount(case4OrgId)).toBe(before);
  });

  it('case 5 — slack boundary: coverage ends exactly at M-1, one clean forward seed, never partial', async () => {
    const { orgId } = await bareOrg('c5');
    for (let m = 9; m <= 12; m++) await insertPeriod(orgId, `2025-${String(m).padStart(2, '0')}-01`, monthEnd(2025, m));
    for (let m = 1; m <= 8; m++) await insertPeriod(orgId, `2026-${String(m).padStart(2, '0')}-01`, monthEnd(2026, m));

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run).toMatchObject({ posted_count: 12, outcome: 'ok', failures: null });
    // NEGATIVE — not partial; nothing before 2026-09-01 among the newly created rows.
    const periods = await periodsFor(orgId);
    const created = periods.filter((p) => p.starts_on >= '2026-09-01');
    expect(created.length).toBe(12);
  });

  it('case 6 — zero periods: a bare org is reported partial, never silently "ok on nothing"', async () => {
    const { orgId } = await bareOrg('c6');

    await runFiscalPeriodSeed({ orgId, nowMs: NOW });

    const run = await latestRun(orgId);
    expect(run.posted_count).toBe(12);
    expect(run.failed_count).toBe(1);
    expect(run.outcome).toBe('partial');
    expect(run.failures).toEqual([
      { subjectId: orgId, subjectName: expect.any(String), reason: 'no fiscal periods existed at all; seeded 2026-09..2027-08 forward only — no earlier month was invented' },
    ]);
    // NEGATIVE — nothing before 2026-09-01.
    const periods = await periodsFor(orgId);
    expect(periods.every((p) => p.starts_on >= '2026-09-01')).toBe(true);
  });

  it('case 7 — Manila pin (DEF-283): the business month is read from Asia/Manila, not raw UTC', async () => {
    // Main: 2026-08-31T16:00:00Z = 2026-09-01T00:00:00+08:00 — just past Manila midnight, M = '2026-09'.
    const { orgId: orgA } = await bareOrg('c7a');
    for (let m = 9; m <= 12; m++) await insertPeriod(orgA, `2026-${String(m).padStart(2, '0')}-01`, monthEnd(2026, m));
    for (let m = 1; m <= 7; m++) await insertPeriod(orgA, `2027-${String(m).padStart(2, '0')}-01`, monthEnd(2027, m));
    await runFiscalPeriodSeed({ orgId: orgA, nowMs: Date.parse('2026-08-31T16:00:00Z') });
    const runA = await latestRun(orgA);
    expect(runA).toMatchObject({ posted_count: 1, period: '2026-09' });

    // NEGATIVE: a fresh, otherwise-identically-shaped org (12 months forward from ITS OWN M), one
    // minute earlier in UTC — 2026-08-31T15:59:00Z = 2026-08-31T23:59:00+08:00 — still 2026-08-31
    // in Manila, M = '2026-08'. Seeded 2026-08..2027-07 so that M's own window is already full,
    // proving the earlier timestamp reads as the PREVIOUS Manila day, not the same UTC one.
    const { orgId: orgB } = await bareOrg('c7b');
    for (let m = 8; m <= 12; m++) await insertPeriod(orgB, `2026-${String(m).padStart(2, '0')}-01`, monthEnd(2026, m));
    for (let m = 1; m <= 7; m++) await insertPeriod(orgB, `2027-${String(m).padStart(2, '0')}-01`, monthEnd(2027, m));
    await runFiscalPeriodSeed({ orgId: orgB, nowMs: Date.parse('2026-08-31T15:59:00Z') });
    const runB = await latestRun(orgB);
    expect(runB).toMatchObject({ posted_count: 0, skipped_count: 12, period: '2026-08' });
  });

  it('case 8 — job_check: scheduler_runs_job_check accepts every SCHEDULER_JOBS name, refuses a bogus one', async () => {
    // ✅ Green since 'fiscal_period_seed' landed on SCHEDULER_JOBS (today: 11). Stale RED comment
    // corrected 2026-09-25 (T-344/DEF-422, tester).
    expect(SCHEDULER_JOBS.length).toBeGreaterThanOrEqual(11);
    const { orgId } = await bareOrg('c8');
    const accepted: string[] = [];
    for (const job of SCHEDULER_JOBS) {
      await sql`insert into scheduler_runs (org_id, job, period) values (${orgId}, ${job}, '2026-09')`;
      accepted.push(job);
    }
    expect(accepted.sort()).toEqual([...SCHEDULER_JOBS].sort());

    // NEGATIVE — a name outside the constraint is refused, by the database, not the application.
    await expect(
      sql`insert into scheduler_runs (org_id, job, period) values (${orgId}, 'not_a_job', '2026-09')`,
    ).rejects.toThrow(/scheduler_runs_job_check/);
  });
});

function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}
