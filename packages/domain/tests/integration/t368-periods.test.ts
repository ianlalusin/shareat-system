import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-368 S1 (DEF-424, DEF-433) — periods close in order, and the monthly seed job never opens a
 * month behind closed books. `docs/tasks/368-periods-depreciation.md` §S1, legs P1-P7.
 *
 * ⛔ TESTER, not BUILDER. `closePeriod`/`closeYear` (`packages/domain/src/fiscal-periods/`) and
 * `runFiscalPeriodSeedForOrg` (`packages/domain/src/scheduler/index.ts:1035-1224`) today check only
 * for an EARLIER OPEN period, never a MISSING one — a whole month can be skipped and never noticed.
 * S1 is not built; `firstCoverageGapBefore` does not exist yet. These tests call only the existing
 * public domain functions (`closePeriod`, `closeYear`, `runFiscalPeriodSeed`) and assert the TARGET
 * behaviour, per the orchestrator: S0's migration is NOT applied to this database, so a leg's "red
 * today" is whatever the unfixed domain code (plus the pre-existing 0160 order-guard trigger)
 * actually does — verified per-leg below, not assumed from the task doc's own "red today" column,
 * which describes a database with S0 already migrated.
 *
 * ⚠️ **P1 flag (see the RED report):** verified via a throwaway probe against `classifyHoles`
 * (`packages/domain/src/fiscal-periods/holes.ts`) that with "02 closed, 03 missing, 04 open" and 04
 * not yet closed, March classifies as **A**, not B — `closeFrontierStartsOn` is Feb (the only
 * closed/locked period), and March's `endsOn` (03-31) is not before it. The task doc's P1 row says
 * "the class-B user sentence"; this file asserts the class-A trailer instead, since that is what
 * `classifyHoles`, called in the ordinary way the S1 spec describes, actually returns for this
 * fixture. Flagged, not silently picked.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { closePeriod, closeYear, createMissingClosedPeriod, postEntry, runFiscalPeriodSeed } from '@shareat/domain';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t368p-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  return { orgId, storeId: store!.id, admin: actor(orgId, admin!.id), adminId: admin!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function period(orgId: string, startsOn: string, endsOn: string, status: 'open' | 'closed' | 'locked' = 'open') {
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${startsOn}, ${endsOn}, ${status})`;
}
function monthBounds(month: string): { startsOn: string; endsOn: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { startsOn: `${month}-01`, endsOn: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
async function monthPeriod(orgId: string, month: string, status: 'open' | 'closed' | 'locked' = 'open') {
  const { startsOn, endsOn } = monthBounds(month);
  await period(orgId, startsOn, endsOn, status);
}
async function statusOf(orgId: string, month: string): Promise<string | null> {
  const { startsOn } = monthBounds(month);
  const [row] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${orgId} and starts_on = ${startsOn}`;
  return row?.status ?? null;
}
async function existsMonth(orgId: string, month: string): Promise<boolean> {
  return (await statusOf(orgId, month)) !== null;
}
async function statusesOf(orgId: string, year: number): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${orgId} and starts_on >= ${`${year}-01-01`} and ends_on <= ${`${year}-12-31`} order by starts_on`;
  return rows.map((r) => r.status);
}

/**
 * Narrows a call expected to REJECT to its typed error, instead of unioning the `.catch` handler's
 * return with the call's resolve type (`ClosePeriodResult`/`CloseYearResult` here) — which is what
 * made a bare `.catch((e) => e as Error)` fail typecheck: `err.message` doesn't exist on the
 * success shape. Same fix as t367-s1-write-off-once.test.ts's own `rejection()`.
 */
async function rejection<E = Error & { userMessage?: string }>(p: Promise<unknown>): Promise<E> {
  return p.then(
    () => {
      throw new Error('expected a refusal, but the call resolved');
    },
    (e: unknown) => e as E,
  );
}

describe('P1 — closePeriod refuses over a missing earlier month', () => {
  it('closePeriod(2027-04) with 02 closed, 03 missing, 04 open: refuses naming 2027-03-01..2027-03-31; 04 stays open', async () => {
    const f = await fixture('p1');
    await monthPeriod(f.orgId, '2027-02', 'closed');
    await monthPeriod(f.orgId, '2027-04', 'open');

    const err = await rejection(asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: '2027-04' })));
    expect(err, 'closePeriod must refuse — 2027-03 has no period').toBeInstanceOf(Error);
    expect(err.message).toMatch(/2027-03-01/);
    expect(err.message).toMatch(/2027-03-31/);
    expect(err.userMessage ?? err.message).toMatch(/order/i);
    expect(await statusOf(f.orgId, '2027-04')).toBe('open');
  });
});

describe('P2 — +control: once the gap is filled, the close it was blocking succeeds', () => {
  it('02 closed, 03 missing, 04 ALREADY closed (so 03 is class B): fill 03, then close 05 open', async () => {
    const f = await fixture('p2');
    await monthPeriod(f.orgId, '2027-02', 'closed');
    await monthPeriod(f.orgId, '2027-04', 'closed');
    await monthPeriod(f.orgId, '2027-05', 'open');

    const filled = await asOrg(f.orgId, (tx) =>
      createMissingClosedPeriod(tx, f.admin, { startsOn: '2027-03-01', endsOn: '2027-03-31', reason: 'backfill' }),
    );
    expect(filled.status).toBe('closed');

    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: '2027-05' }));
    expect(result.periodId).toBeTruthy();
    expect(await statusOf(f.orgId, '2027-05')).toBe('closed');
  });
});

describe('P3 — +control: an org whose first period is 2027-02 closes it with no gap error', () => {
  it('no period exists before the org\'s first — nothing "before the first period" counts as a hole', async () => {
    const f = await fixture('p3');
    await monthPeriod(f.orgId, '2027-02', 'open');

    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: '2027-02' }));
    expect(result.periodId).toBeTruthy();
    expect(await statusOf(f.orgId, '2027-02')).toBe('closed');
  });
});

describe('P4 — closeYear refuses over a missing month inside the year', () => {
  const YEAR = 2041;

  // ⛔ 0174's NEW order-guard trigger (T-368 S0, live in this DB) refuses an UPDATE that closes a
  // month whose earlier coverage has a gap — so the ORIGINAL fixture here (bulk `closeDirectly`
  // across the whole year in one UPDATE, with 06 missing) now throws from fixture SETUP, not from
  // the domain call under test: it is exactly the shape the trigger exists to prevent, so it can no
  // longer be reached by normal (sequential) closes either. Jan and Feb close ONE UPDATE AT A TIME
  // (each individually gap-free when it runs) so `postEntry` can post into them as OPEN first; the
  // rest are inserted DIRECTLY as 'closed' — "INSERT is deliberately not guarded" (S0's own design:
  // filling any shape by insert is harmless) — simulating months closed before this trigger existed.
  async function yearWithGap(f: Fixture, revenue: string, expense: string) {
    await monthPeriod(f.orgId, `${YEAR}-01`, 'open');
    await monthPeriod(f.orgId, `${YEAR}-02`, 'open');
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: `${YEAR}-01-15`, sourceType: 'test', sourceId: uid('activity'), idempotencyKey: uid('activity-key'),
        lines: [
          { accountCode: '1110', storeId: f.storeId, debit: revenue },
          { accountCode: '4100', storeId: f.storeId, credit: revenue },
        ],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: `${YEAR}-02-01`, sourceType: 'test', sourceId: uid('activity'), idempotencyKey: uid('activity-key'),
        lines: [
          { accountCode: '6900', storeId: f.storeId, debit: expense },
          { accountCode: '1110', storeId: f.storeId, credit: expense },
        ],
      }),
    );
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = ${`${YEAR}-01-01`}`;
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = ${`${YEAR}-02-01`}`;
    for (let m = 3; m <= 12; m++) {
      if (m === 6) continue; // the gap
      await monthPeriod(f.orgId, `${YEAR}-${String(m).padStart(2, '0')}`, 'closed');
    }
    await monthPeriod(f.orgId, `${YEAR + 1}-01`, 'open');
  }

  it('2041-06 missing, the other 11 months closed: refuses naming 2041-06-01..2041-06-30; nothing locked', async () => {
    const f = await fixture('p4');
    await yearWithGap(f, '20000.00', '8000.00');
    expect(await existsMonth(f.orgId, '2041-06')).toBe(false);

    const err = await rejection(asOrg(f.orgId, (tx) => closeYear(tx, f.admin, { orgId: f.orgId, year: YEAR })));
    expect(err, 'closeYear must refuse — 2041-06 has no period').toBeInstanceOf(Error);
    expect(err.message).toMatch(/2041-06-01/);
    expect(err.message).toMatch(/2041-06-30/);

    const statuses = await statusesOf(f.orgId, YEAR);
    expect(statuses, 'nothing may have been locked').not.toContain('locked');
    expect(statuses.every((s) => s === 'closed')).toBe(true);
    const [entry] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${f.orgId} and source_type = 'year_close'`;
    expect(entry, 'the year-close entry must not have posted').toBeUndefined();
  });
});

describe('P5 — +control: the fill action is unaffected by an UNRELATED earlier gap', () => {
  it('01 also missing does not block filling 03 (the earlier-open gate only covers closePeriod, not closeBlockers)', async () => {
    const f = await fixture('p5');
    await monthPeriod(f.orgId, '2027-02', 'closed');
    await monthPeriod(f.orgId, '2027-04', 'closed');
    // 2027-01 is also missing — a SECOND, earlier hole the fill action must not notice.

    const filled = await asOrg(f.orgId, (tx) =>
      createMissingClosedPeriod(tx, f.admin, { startsOn: '2027-03-01', endsOn: '2027-03-31', reason: 'backfill' }),
    );
    expect(filled.status).toBe('closed');
    expect(await existsMonth(f.orgId, '2027-01')).toBe(false);
  });
});

describe('P6 — the seed job never opens a month behind closed books', () => {
  const NOW = Date.parse('2027-01-31T20:00:00Z'); // 2027-02-01 04:00 Asia/Manila -> M = '2027-02'.

  it('02, 03 closed; 04 missing; 05 closed: job does not error; 04 stays absent; a B failure names it; 06..2028-01 inserted open', async () => {
    const f = await fixture('p6');
    await monthPeriod(f.orgId, '2027-02', 'closed');
    await monthPeriod(f.orgId, '2027-03', 'closed');
    await monthPeriod(f.orgId, '2027-05', 'closed');

    const { outcomes } = await runFiscalPeriodSeed({ orgId: f.orgId, nowMs: NOW });
    const outcome = outcomes[0]!;
    expect(outcome.error, `job must not error — got: ${outcome.error}`).toBeUndefined();
    expect(await existsMonth(f.orgId, '2027-04')).toBe(false);
    expect(outcome.failures.some((fl) => fl.reason.includes('2027-04') && fl.reason.includes('missing inside closed books'))).toBe(true);

    for (const m of ['2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12', '2028-01']) {
      expect(await statusOf(f.orgId, m), m).toBe('open');
    }
  });
});

describe('P7 — +control: a fully-covered org, and a tail-gap org, are unaffected', () => {
  const NOW = Date.parse('2027-01-31T20:00:00Z'); // M = '2027-02'.

  it('full coverage M..M+11: inserted 0, skipped 12, no failure', async () => {
    const f = await fixture('p7-full');
    for (let i = 0; i < 12; i++) {
      const y = 2027 + Math.floor((1 + i) / 12);
      const m = ((1 + i) % 12) + 1;
      await monthPeriod(f.orgId, `${y}-${String(m).padStart(2, '0')}`, 'open');
    }
    const { outcomes } = await runFiscalPeriodSeed({ orgId: f.orgId, nowMs: NOW });
    const outcome = outcomes[0]!;
    expect(outcome.error).toBeUndefined();
    expect(outcome.posted).toBe(0);
    expect(outcome.skipped).toBe(12);
    expect(outcome.failures).toEqual([]);
  });

  it('a tail-gap org (t276 case 4\'s shape) still gives its exact reason string', async () => {
    const f = await fixture('p7-tail');
    const NOW276 = Date.parse('2026-08-31T20:00:00Z'); // M = '2026-09'.
    await monthPeriod(f.orgId, '2026-01', 'closed');
    await monthPeriod(f.orgId, '2026-02', 'closed');
    await monthPeriod(f.orgId, '2026-03', 'closed');
    await monthPeriod(f.orgId, '2026-04', 'closed');
    await monthPeriod(f.orgId, '2026-05', 'open');

    const { outcomes } = await runFiscalPeriodSeed({ orgId: f.orgId, nowMs: NOW276 });
    const outcome = outcomes[0]!;
    expect(outcome.error).toBeUndefined();
    expect(outcome.failed).toBe(1);
    expect(outcome.failures).toEqual([
      {
        subjectId: f.orgId,
        subjectName: expect.any(String),
        reason:
          'coverage gap: periods ended 2026-05-31; backfilled 3 elapsed month(s) 2026-06..2026-08 as open — ' +
          'created after their own month ended, so no close ever ran on them',
      },
    ]);
  });
});
