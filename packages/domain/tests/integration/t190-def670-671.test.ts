import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * DEF-670 / DEF-671 (T-190 merge audit). RED tests.
 *
 * DEF-670: one person with TWO employments in ONE run (a rehire: the first employment ended mid-period, the second began after; both sit
 * at the same store because `employments_open_person_store_unique` allows one OPEN row per person+store). `buildPreview` reads the
 * outstanding 1230 advance once per employment, so each slip recovers the whole advance: 2 x 1,000 against a 1,000 balance, 1230 goes -1,000.
 *
 * DEF-671: a leave-only slip (no worked day) starts `dailyRateAtEnd` at ZERO. The period-end lookup only overwrites it when the rate in
 * force at period_end is `daily`. "No rate at period_end" is unreachable (a leave day's own rate has effective_from <= the leave date <= period_end),
 * but "the rate in force at period_end is NOT daily" is reachable: leave paid at the daily 900 rate, then a later hourly row. The slip is then
 * judged on a daily rate of 0 -> minimum-wage earner (0 <= 645) although the person was paid 900/day.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { postPayRun, previewPayRun, recordLeave, seedAttendanceConfig, seedCanonicalPositions } from '@shareat/domain';

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

async function fixture(hint: string, minimumWage = '645.00') {
  const code = uid(`d670-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const storeId = s!.id;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId], minimumWage);
  const mgrId = await mk('Manager', 'manager');
  const workerId = await mk('Worker', 'staff');
  const emp = async (startedOn: string, rate: string, endedOn: string | null = null, basis = 'daily') => {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
      values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, ${startedOn}, ${endedOn}, ${endedOn ? 'resigned' : 'regular'}, ${adminId}) returning id`;
    await sql`insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
              values (${orgId}, ${e!.id}, ${basis}, ${rate}, ${startedOn}, ${adminId})`;
    return e!.id;
  };
  return { orgId, storeId, officeId: office!.id, adminId, workerId, emp, admin: actor(orgId, adminId), mgr: actor(orgId, mgrId) };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function workedDay(f: F, employmentId: string, shiftDay: string) {
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${f.storeId} order by effective_from desc limit 1`;
  await sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes)
    values (${f.orgId}, ${f.storeId}, ${f.workerId}, ${employmentId}, ${shiftDay}, ${cfg!.id}, 'exact', 'verified', 540)`;
}

async function advance(f: F, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-01-01'`;
  const [adv] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1230'`;
  const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-02', ${period!.id}, 'cashrequest', ${uid('adv')}, 'draft') returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 1, ${adv!.id}, ${f.storeId}, ${amount}, '0', 'employee', ${f.workerId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${cash!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
const advanceBalance = async (f: F) =>
  (await sql<{ b: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.org_id = ${f.orgId} and a.code = '1230' and l.party_id = ${f.workerId} and e.status <> 'draft'`)[0]!.b;
const recovered = (runId: string) =>
  sql<{ advance_recovered: string }[]>`select advance_recovered::text from payslips where run_id = ${runId}`;

const post = (f: F, periodStart: string, periodEnd: string) =>
  asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, periodStart, periodEnd, moneyAccountId: f.officeId }));
const preview = (f: F, periodStart: string, periodEnd: string) =>
  asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, periodStart, periodEnd }));
const total = (rows: { advance_recovered: string }[]) => rows.reduce((n, r) => n + Number(r.advance_recovered), 0);

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('DEF-670 - an advance is recovered once per PERSON, not once per employment', () => {
  it('two employments of one person in one run, 1,000 outstanding: total recovered is 1,000 and 1230 ends at 0.00', async () => {
    const f = await fixture('two');
    const e1 = await f.emp('2025-01-01', '600.00', '2026-01-10');
    const e2 = await f.emp('2026-01-11', '600.00');
    for (const d of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) await workedDay(f, e1, d);
    for (const d of ['2026-01-12', '2026-01-13', '2026-01-14']) await workedDay(f, e2, d);
    await advance(f, '1000.00');
    const out = await post(f, '2026-01-01', '2026-01-15');
    const rows = await recovered(out.runId);
    expect(rows).toHaveLength(2);
    expect(total(rows), 'total advance recovered across both slips').toBe(1000);
    expect(await advanceBalance(f)).toBe('0.00');
  });

  it('preview agrees: totalAdvanceRecovered is 1,000.00, not 2,000.00', async () => {
    const f = await fixture('prev');
    const e1 = await f.emp('2025-01-01', '600.00', '2026-01-10');
    const e2 = await f.emp('2026-01-11', '600.00');
    await workedDay(f, e1, '2026-01-05');
    await workedDay(f, e2, '2026-01-12');
    await advance(f, '1000.00');
    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slips).toHaveLength(2);
    expect(pv.totalAdvanceRecovered).toBe('1000.00');
  });

  it('control: one job, 1,000 outstanding, gross 5,000 -> recovers 1,000 and 1230 ends at 0.00', async () => {
    const f = await fixture('one');
    const e = await f.emp('2025-01-01', '1000.00');
    for (const d of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) await workedDay(f, e, d);
    await advance(f, '1000.00');
    const out = await post(f, '2026-01-01', '2026-01-15');
    const rows = await recovered(out.runId);
    expect(total(rows)).toBe(1000);
    expect(await advanceBalance(f)).toBe('0.00');
  });
});

describe('DEF-671 - a leave-only slip is judged on the daily rate it was paid, not on zero', () => {
  const leaveOnly = async (hint: string, laterHourly: boolean) => {
    const f = await fixture(hint);
    const e = await f.emp('2025-01-01', '900.00');
    await asOrg(f.orgId, (tx) =>
      recordLeave(tx, f.mgr, { employmentId: e, leaveType: 'sil', days: [{ date: '2026-01-05', kind: 'leave' }, { date: '2026-01-06', kind: 'leave' }] } as never));
    // A later rate row that is NOT daily: the lookup at period_end finds it, basis is not daily, and the zero seed survives.
    if (laterHourly) {
      await sql`insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
                values (${f.orgId}, ${e}, 'hourly', '110.00', '2026-01-10', ${f.adminId})`;
    }
    return preview(f, '2026-01-01', '2026-01-15');
  };

  it('control: leave-only, daily 900 in force at period_end (above the 645 minimum) -> NOT a minimum-wage earner', async () => {
    const pv = await leaveOnly('c671', false);
    expect(pv.slips).toHaveLength(1);
    expect(pv.slips[0]).toMatchObject({ leavePay: '1800.00', grossPay: '1800.00', isMwe: false });
  });

  it('leave paid at daily 900, then an hourly row before period_end: still NOT a minimum-wage earner (the leave line rate 900, not 0)', async () => {
    const pv = await leaveOnly('r671', true);
    expect(pv.slips).toHaveLength(1);
    expect(pv.slips[0]!.leavePay).toBe('1800.00');
    expect(pv.slips[0]!.isMwe, 'daily rate 900 > 645 minimum, so MWE must be false').toBe(false);
  });
});
