import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-436 payroll interaction - cases 16-20g. Leave pay, freeze/release, the paid-first / worked-first clash,
 * the year-end SIL cash payout, final pay (separation) and the 13th month staying clean.
 *
 * API contract: header of `t436-leave.test.ts`. Payroll surface pinned here (spec D9-D12):
 *   previewPayRun slips gain `leavePay` and `silConversionPay` (money strings); `payslips` gains the columns
 *   `leave_pay` / `sil_conversion_pay`; `leave_commutations` carries (person_id, employment_id, days, daily_rate,
 *   amount, frozen_by_pay_run_id, separation_id); a posted run freezes `leave_request_days` and a void releases.
 *
 * RED REASON today: the leave module, `leave_*` tables and the two payslip columns (migration 0205) do not exist.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  addShiftDays,
  adjudicateDay,
  leaveGrid,
  postPayRun,
  postSeparation,
  preview13thMonthRun,
  previewPayRun,
  recordLeave,
  recordPunch,
  requestLeave,
  approveLeave,
  seedAttendanceConfig,
  seedCanonicalPositions,
  shiftDayRange,
  silBalance,
  toShiftDay,
  voidLeave,
  voidPayRun,
  voidSeparation,
} from '@shareat/domain';

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

async function fixture(hint: string, opts: { secondStore?: boolean } = {}) {
  const code = uid(`p436-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id`;
    await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId: s!.id, effectiveFrom: '2025-01-01' }));
    const [office] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${s!.id} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    return { storeId: s!.id, officeId: office!.id };
  };
  const A = await mkStore('A');
  const B = opts.secondStore ? await mkStore('B') : null;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${A.storeId})`;
    if (B) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${B.storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const emp = async (personId: string, storeId: string, startedOn: string, rate: string, endedOn: string | null = null) => {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${uid('sc')}, ${startedOn}, ${endedOn},
              ${endedOn ? 'resigned' : 'regular'}, ${adminId}) returning id`;
    const [r] = await sql<{ id: string }[]>`
      insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
      values (${orgId}, ${e!.id}, 'daily', ${rate}, '2025-01-01', ${adminId}) returning id`;
    return { employmentId: e!.id, rateId: r!.id };
  };
  const workerId = await mk('Worker', 'staff');
  const w = await emp(workerId, A.storeId, '2025-01-01', '600.00');
  return {
    orgId, A, B, mk, emp, adminId, managerId, workerId, ...w,
    admin: actor(orgId, adminId), mgr: actor(orgId, managerId), worker: actor(orgId, workerId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const day = (date: string, kind: 'leave' | 'rest_day' = 'leave') => ({ date, kind });
const dates = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

const record = (f: F, over: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) =>
    recordLeave(tx, f.mgr, { employmentId: f.employmentId, leaveType: 'sil', days: [day('2026-01-05')], ...over } as never));

/** A payable attendance day, inserted directly (for payroll a day is an INPUT, as in payroll.test.ts). */
async function workedDay(f: F, shiftDay: string, over: { employmentId?: string; personId?: string; storeId?: string } = {}) {
  const storeId = over.storeId ?? f.A.storeId;
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${storeId} order by effective_from desc limit 1`;
  await sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
                                 status, computed_minutes)
    values (${f.orgId}, ${storeId}, ${over.personId ?? f.workerId}, ${over.employmentId ?? f.employmentId}, ${shiftDay},
            ${cfg!.id}, 'exact', 'verified', 540)`;
}

const post = (f: F, periodStart: string, periodEnd: string, store = f.A) =>
  asOrg(f.orgId, (tx) =>
    postPayRun(tx, f.admin, { storeId: store.storeId, periodStart, periodEnd, moneyAccountId: store.officeId } as never));
const preview = (f: F, periodStart: string, periodEnd: string, store = f.A) =>
  asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: store.storeId, periodStart, periodEnd })) as Promise<{
    slips: { personId: string; employmentId: string; daysWorked: number; basicPay: string; leavePay: string; silConversionPay: string; grossPay: string }[];
    needsReviewDays: number;
  }>;
const slipRows = (runId: string) =>
  sql<{ person_id: string; employment_id: string; days_worked: string; basic_pay: string; leave_pay: string; sil_conversion_pay: string; gross_pay: string }[]>`
    select person_id, employment_id, days_worked, basic_pay, leave_pay, sil_conversion_pay, gross_pay from payslips where run_id = ${runId}`;

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-436 payroll - what leave pays', () => {
  it('16. two paid leave days at 600 -> leave_pay 1200, basic_pay UNCHANGED (600 for the one worked day), gross identity holds', async () => {
    const f = await fixture('p16');
    await record(f, { days: [day('2026-01-05'), day('2026-01-06')] });
    await workedDay(f, '2026-01-12');
    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slips).toHaveLength(1);
    expect(pv.slips[0]).toMatchObject({ basicPay: '600.00', leavePay: '1200.00', silConversionPay: '0.00', grossPay: '1800.00' });

    const out = await post(f, '2026-01-01', '2026-01-15');
    const [s] = await slipRows(out.runId);
    expect(s).toMatchObject({ basic_pay: '600.00', leave_pay: '1200.00', sil_conversion_pay: '0.00', gross_pay: '1800.00' });
    const [six] = await sql<{ debit: string }[]>`
      select sum(l.debit)::text as debit from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id where e.org_id = ${f.orgId} and e.source_type = 'payrollpayslip' and a.code = '6100'`;
    expect(six!.debit).toBe('1800.00'); // leave pay is salary expense too
  });

  it('17. unpaid leave and rest_day rows add 0 and use no SIL', async () => {
    const f = await fixture('p17');
    await record(f, { leaveType: 'unpaid_other', days: [day('2026-01-05'), day('2026-01-06')] });
    await record(f, { leaveType: 'sil', days: [day('2026-01-07', 'rest_day'), day('2026-01-08', 'rest_day')] });
    await workedDay(f, '2026-01-12');
    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slips[0]).toMatchObject({ basicPay: '600.00', leavePay: '0.00', grossPay: '600.00' });
    expect(await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: 2026 } as never)))
      .toMatchObject({ entitlement: 5, used: 0, remaining: 5 });
  });

  it('20g. maternity and paternity days add 0 to leave_pay (paid by SSS / T-190, not the employer here)', async () => {
    const f = await fixture('p20g');
    await record(f, { leaveType: 'maternity', birthDate: '2025-12-20', days: [day('2026-01-05'), day('2026-01-06')] });
    await record(f, { leaveType: 'paternity', birthDate: '2025-12-21', days: [day('2026-01-07'), day('2026-01-08')] });
    await workedDay(f, '2026-01-12');
    const out = await post(f, '2026-01-01', '2026-01-15');
    const [s] = await slipRows(out.runId);
    expect(s).toMatchObject({ leave_pay: '0.00', gross_pay: '600.00' });
  });
});

// =====================================================================================

describe('T-436 payroll - freeze and release', () => {
  it('19. leave days frozen to a run are not picked by a second preview; voiding the run releases them', async () => {
    const f = await fixture('p19');
    await record(f, { days: [day('2026-01-05'), day('2026-01-06')] });
    await workedDay(f, '2026-01-12');
    const out = await post(f, '2026-01-01', '2026-01-15');
    const frozen = await sql<{ frozen_by_pay_run_id: string | null; frozen_at: Date | null }[]>`
      select d.frozen_by_pay_run_id, d.frozen_at from leave_request_days d join leave_requests r on r.id = d.request_id
      where r.org_id = ${f.orgId}`;
    expect(frozen).toHaveLength(2);
    expect(frozen.every((r) => r.frozen_by_pay_run_id === out.runId && r.frozen_at !== null)).toBe(true);

    await workedDay(f, '2026-01-13'); // something payable so a slip exists to inspect
    const again = await preview(f, '2026-01-01', '2026-01-15');
    expect(again.slips[0]!.leavePay).toBe('0.00'); // not paid twice

    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'wrong period' }));
    const released = await preview(f, '2026-01-01', '2026-01-15');
    expect(released.slips[0]!.leavePay).toBe('1200.00');
    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from leave_request_days d join leave_requests r on r.id = d.request_id
      where r.org_id = ${f.orgId} and d.frozen_by_pay_run_id is not null`;
    expect(after[0]!.n).toBe('0');
  });

  it('19a. voiding a leave request with a day frozen to a posted run is LEAVE_DAY_PAID; void the run first and it works', async () => {
    const f = await fixture('p19a');
    const r = await record(f, { days: [day('2026-01-05')] });
    await workedDay(f, '2026-01-12');
    const out = await post(f, '2026-01-01', '2026-01-15');
    let err: { code?: string } | undefined;
    try {
      await asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: r.requestId, reason: 'entered in error' } as never));
    } catch (e) {
      err = e as never;
    }
    expect(err?.code).toBe('LEAVE_DAY_PAID');
    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'redo' }));
    await asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: r.requestId, reason: 'entered in error' } as never));
  });
});

// =====================================================================================

describe('T-436 payroll - leave and attendance on the same date (real punches, yesterday\'s shift day)', () => {
  // ⚠️ Yesterday, not a fixed date: a punch\'s arrival lag is measured against now(), and an old fixture date trips
  // `late_event_arrival` and lands the day in needs_review for the wrong reason (see attendance-adjudication.test.ts).
  const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
  const DAY_START = shiftDayRange(DAY).start.getTime();
  const at = (hour: number, minute = 0) =>
    new Date(DAY_START + (((((hour - 5) % 24) + 24) % 24) * 60 + minute) * 60_000);
  const FROM = addShiftDays(DAY, -3);

  async function punchesArrive(f: F) {
    for (const [when, intent] of [[at(14), 'in'], [at(23), 'out']] as const) {
      await asOrg(f.orgId, (tx) =>
        recordPunch(tx, {
          clientPunchId: uid('cp'), employmentId: f.employmentId, occurredAt: when,
          method: 'qr', assertedIntent: intent, source: 'online',
        }));
    }
    await asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId: f.employmentId, shiftDay: DAY }));
  }

  it('18. leave PAID FIRST, then punches arrive: the attendance day is held needs_review with a clash flag, and is not paid', async () => {
    const f = await fixture('p18');
    await record(f, { days: [day(DAY)] });
    await workedDay(f, addShiftDays(DAY, -2)); // a normal worked day so the slip exists
    const out = await post(f, FROM, DAY);
    const [s] = await slipRows(out.runId);
    expect(s).toMatchObject({ leave_pay: '600.00', basic_pay: '600.00', gross_pay: '1200.00' });

    await punchesArrive(f);
    const [d] = await sql<{ status: string }[]>`
      select status from attendance_days where employment_id = ${f.employmentId} and shift_day = ${DAY}`;
    expect(d!.status).toBe('needs_review');
    const grid = (await asOrg(f.orgId, (tx) =>
      leaveGrid(tx, f.mgr, { storeId: f.A.storeId, from: DAY, to: DAY } as never))) as { date: string; clash?: boolean }[];
    expect(grid.find((g) => g.date === DAY)?.clash).toBe(true);

    // The next preview of that window must not pay the clash day as worked.
    const pv = await preview(f, DAY, DAY);
    expect(pv.slips.reduce((n, x) => n + Number(x.basicPay), 0)).toBe(0);
    expect(pv.needsReviewDays).toBeGreaterThanOrEqual(1);
    expect(pv.slips.reduce((n, x) => n + Number(x.leavePay), 0)).toBe(0);
  });

  it('18a. punches FIRST (before any run): the leave day is superseded_by_work, paid once as worked, the SIL day is given back', async () => {
    const f = await fixture('p18a');
    const r = await record(f, { days: [day(DAY)] });
    expect(await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: Number(DAY.slice(0, 4)) } as never)))
      .toMatchObject({ used: 1, remaining: 4 });
    await punchesArrive(f);

    const actions = await sql<{ action: string }[]>`
      select action from audit_log where org_id = ${f.orgId} and entity_id = ${r.requestId}`;
    expect(actions.map((a) => a.action)).toContain('leave.superseded_by_work');
    expect(await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: Number(DAY.slice(0, 4)) } as never)))
      .toMatchObject({ used: 0, remaining: 5 });

    const out = await post(f, FROM, DAY);
    const [s] = await slipRows(out.runId);
    expect(s).toMatchObject({ days_worked: '1.00', basic_pay: '600.00', leave_pay: '0.00', gross_pay: '606.67' }); // 606.67 = 600 + 6.67 night differential (14:00-23:00 shift has 1h after 22:00)
  });
});

// =====================================================================================

describe('T-436 payroll - the year-end SIL cash payout (D11)', () => {
  /** Worker has used 2 of 5 SIL days in 2026, so 3 are unpaid-out: 3 x 600 = 1800. */
  async function withUsed2(hint: string, opts: { secondStore?: boolean } = {}) {
    const f = await fixture(hint, opts);
    await record(f, { days: [day('2026-03-02'), day('2026-03-03')] });
    return f;
  }
  const commutations = (personId: string) =>
    sql<{ days: string; daily_rate: string; amount: string; employment_id: string; frozen_by_pay_run_id: string | null; separation_id: string | null }[]>`
      select days, daily_rate, amount, employment_id, frozen_by_pay_run_id, separation_id from leave_commutations where person_id = ${personId}`;

  it('20. 3 unused days x 600 land in sil_conversion_pay of the run covering 31 Dec; frozen so a re-run pays nothing; a void releases it', async () => {
    const f = await withUsed2('p20');
    await workedDay(f, '2026-12-20');
    const out = await post(f, '2026-12-16', '2026-12-31');
    const [s] = await slipRows(out.runId);
    expect(s).toMatchObject({ basic_pay: '600.00', sil_conversion_pay: '1800.00', leave_pay: '0.00', gross_pay: '2400.00' });
    const [c] = await commutations(f.workerId);
    expect(c).toMatchObject({ days: '3.00', daily_rate: '600.00', amount: '1800.00', employment_id: f.employmentId, frozen_by_pay_run_id: out.runId });

    await workedDay(f, '2026-12-21'); // a fresh payable day so a new slip would show a second payout
    const again = await preview(f, '2026-12-16', '2026-12-31');
    expect(again.slips[0]!.silConversionPay).toBe('0.00'); // mutant: payout not idempotent

    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'redo' }));
    const [released] = await commutations(f.workerId);
    expect(released!.frozen_by_pay_run_id).toBeNull();
    const back = await preview(f, '2026-12-16', '2026-12-31');
    expect(back.slips[0]!.silConversionPay).toBe('1800.00');
  });

  it('20a. a person with no attendance in the 31 Dec period still gets a slip (days_worked 0) carrying the payout', async () => {
    const f = await fixture('p20a'); // nothing used: 5 x 600 = 3000
    const out = await post(f, '2026-12-16', '2026-12-31');
    expect(out.payslips).toBe(1);
    const rows = await slipRows(out.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: f.workerId, employment_id: f.employmentId, days_worked: '0.00',
      basic_pay: '0.00', sil_conversion_pay: '3000.00', gross_pay: '3000.00',
    });
  });

  it('20b. two concurrent jobs: paid ONCE, on the designated (earliest-started) employment, at ITS rate', async () => {
    const f = await withUsed2('p20b', { secondStore: true });
    const b = await f.emp(f.workerId, f.B!.storeId, '2025-06-01', '700.00');
    await workedDay(f, '2026-12-20', { employmentId: b.employmentId, storeId: f.B!.storeId });
    await workedDay(f, '2026-12-20');
    // store B first: a per-employment mutant would pay here at 700
    const outB = await post(f, '2026-12-16', '2026-12-31', f.B!);
    expect((await slipRows(outB.runId))[0]).toMatchObject({ sil_conversion_pay: '0.00' });
    const outA = await post(f, '2026-12-16', '2026-12-31', f.A);
    expect((await slipRows(outA.runId))[0]).toMatchObject({ sil_conversion_pay: '1800.00' });
    const rows = await commutations(f.workerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ employment_id: f.employmentId, daily_rate: '600.00', amount: '1800.00' });
  });

  it('20c. once the payout is frozen, approving a paid SIL day in that year is SIL_YEAR_CLOSED', async () => {
    const f = await withUsed2('p20c');
    await workedDay(f, '2026-12-20');
    await post(f, '2026-12-16', '2026-12-31');
    const r = await asOrg(f.orgId, (tx) =>
      requestLeave(tx, f.worker, { employmentId: f.employmentId, leaveType: 'sil', days: [day('2026-11-10')] } as never));
    let err: { code?: string } | undefined;
    try {
      await asOrg(f.orgId, (tx) => approveLeave(tx, f.mgr, { requestId: r.requestId } as never));
    } catch (e) {
      err = e as never;
    }
    expect(err?.code).toBe('SIL_YEAR_CLOSED');
  });

  it('20d. separated 30 Jun: final pay writes the row with separation_id and a journal line; the year-end run skips the person; void releases and reverses', async () => {
    const f = await fixture('p20d');
    // a separated employment: replace the open one with an ended one for a second person
    const pid = await f.mk('Leaver', 'staff');
    const e = await f.emp(pid, f.A.storeId, '2025-01-01', '600.00', '2026-06-30');
    await asOrg(f.orgId, (tx) =>
      recordLeave(tx, f.mgr, { employmentId: e.employmentId, leaveType: 'sil', days: [day('2026-03-02'), day('2026-03-03')] } as never));
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
      values (${f.orgId}, ${f.A.storeId}, '2026-01-01', '2026-01-15', 'posted', ${f.A.officeId}, now(), ${f.adminId}, ${f.adminId}) returning id`;
    await sql`insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
              values (${run!.id}, ${f.orgId}, ${e.employmentId}, ${pid}, ${e.rateId}, '1', '6000.00', '6000.00', '0', '6000.00')`;

    const sep = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.A.storeId, employmentId: e.employmentId, separationDate: '2026-06-30', cause: 'resignation',
        separationPayAmount: '0', moneyAccountId: f.A.officeId, clearanceConfirmedBy: f.adminId,
      }));
    const [c] = await commutations(pid);
    expect(c).toMatchObject({ amount: '1800.00', separation_id: sep.id, frozen_by_pay_run_id: null });
    const debit = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_lines l join journal_entries e2 on e2.id = l.entry_id
      where e2.org_id = ${f.orgId} and l.debit = '1800.00'`;
    expect(Number(debit[0]!.n)).toBeGreaterThanOrEqual(1);

    // the year-end run does not pay this person (no open employment on 31 Dec, and the row is spoken for)
    const yearEnd = await preview(f, '2026-12-16', '2026-12-31');
    expect(yearEnd.slips.find((s) => s.personId === pid)).toBeUndefined();
    expect((await commutations(pid))[0]!.frozen_by_pay_run_id).toBeNull();

    await asOrg(f.orgId, (tx) => voidSeparation(tx, f.admin, { id: sep.id, reason: 'wrong cause entered' }));
    const afterVoid = await commutations(pid);
    expect(afterVoid.filter((r) => r.separation_id !== null)).toHaveLength(0); // released
    const reversal = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_lines l join journal_entries e2 on e2.id = l.entry_id
      where e2.org_id = ${f.orgId} and l.credit = '1800.00'`;
    expect(Number(reversal[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('20e. the 13th month for a person with leave pay AND a SIL payout equals the same-pay person\'s without them', async () => {
    const f = await fixture('p20e');
    const bId = await f.mk('Twin', 'staff');
    const b = await f.emp(bId, f.A.storeId, '2025-01-01', '600.00');
    await record(f, { days: [day('2026-01-05'), day('2026-01-06')] }); // worker gets leave pay; twin does not
    for (const [pid, eid] of [[f.workerId, f.employmentId], [bId, b.employmentId]] as const) {
      await workedDay(f, '2026-01-12', { personId: pid, employmentId: eid });
      await workedDay(f, '2026-12-20', { personId: pid, employmentId: eid });
    }
    const jan = await post(f, '2026-01-01', '2026-01-15');
    expect((await slipRows(jan.runId)).find((s) => s.person_id === f.workerId)!.leave_pay).toBe('1200.00');
    const dec = await post(f, '2026-12-16', '2026-12-31');
    const decSlips = await slipRows(dec.runId);
    expect(decSlips.find((s) => s.person_id === f.workerId)!.sil_conversion_pay).toBe('1800.00');
    expect(decSlips.find((s) => s.person_id === bId)!.sil_conversion_pay).toBe('3000.00');

    const thirteenth = (await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.A.storeId, year: 2026 }))) as {
      payouts: { personId: string; basicPayEarned: string; grossPay: string }[];
    };
    const w = thirteenth.payouts.find((p) => p.personId === f.workerId)!;
    const t = thirteenth.payouts.find((p) => p.personId === bId)!;
    expect(w.basicPayEarned).toBe('1200.00');
    expect(t.basicPayEarned).toBe('1200.00');
    expect(w.grossPay).toBe(t.grossPay);
    expect(w.grossPay).toBe('100.00');
  });
});
