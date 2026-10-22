import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-436 audit follow-ups (tester, 2026-10-17). Each case names the mutant it catches.
 *   A  SIL cash payout vs a concurrent paid-SIL approval (year-end run, and final pay)  - payout must take lockPersonLeave
 *   B  paid leave dated inside an already POSTED pay-run period is refused LEAVE_PERIOD_PAID; unpaid is not
 *   D  attendance reconcile takes the person leave lock (punch landing next to an approval)
 *   E  super_admin RECORDING their own leave writes leave.self_approved
 *   F  a missing request id is refused exactly like a real one the caller may not touch (no id probing)
 * Real concurrency: every race holds one transaction open on its own connection (the `transaction` pool hands each its own).
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
import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  adjudicateDay,
  approveLeave,
  cancelLeave,
  postPayRun,
  postSeparation,
  recordLeave,
  recordPunch,
  rejectLeave,
  requestLeave,
  seedAttendanceConfig,
  seedCanonicalPositions,
  shiftDayRange,
  silBalance,
  toShiftDay,
  voidPayRun,
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fixture(hint: string) {
  const code = uid(`a436-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const storeId = s!.id;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const officeId = office!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  // T-190: a pay run refuses without confirmed statutory tables (no government numbers on file here, so nothing is deducted).
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId]);
  const mgrId = await mk('Manager', 'manager');
  const mgr2Id = await mk('Manager 2', 'manager');
  const superId = await mk('Super', 'super_admin');
  const outsiderId = await mk('Outsider', 'staff'); // holds no manage_attendance anywhere
  const emp = async (personId: string, startedOn: string, rate: string, endedOn: string | null = null) => {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, ${startedOn}, ${endedOn},
              ${endedOn ? 'resigned' : 'regular'}, ${adminId}) returning id`;
    const [r] = await sql<{ id: string }[]>`
      insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
      values (${orgId}, ${e!.id}, 'daily', ${rate}, '2025-01-01', ${adminId}) returning id`;
    return { employmentId: e!.id, rateId: r!.id };
  };
  const workerId = await mk('Worker', 'staff');
  const w = await emp(workerId, '2025-01-01', '600.00');
  const sup = await emp(superId, '2025-01-01', '600.00');
  return {
    orgId, storeId, officeId, mk, emp, adminId, mgrId, workerId, superId, superEmp: sup.employmentId, ...w,
    admin: actor(orgId, adminId), mgr: actor(orgId, mgrId), mgr2: actor(orgId, mgr2Id),
    worker: actor(orgId, workerId), superA: actor(orgId, superId), outsider: actor(orgId, outsiderId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const day = (date: string, kind: 'leave' | 'rest_day' = 'leave') => ({ date, kind });
const record = (f: F, over: Record<string, unknown> = {}, who: Actor = f.mgr) =>
  asOrg(f.orgId, (tx) =>
    recordLeave(tx, who, { employmentId: f.employmentId, leaveType: 'sil', days: [day('2026-01-05')], ...over } as never));
const pending = (f: F, leaveType: string, date: string, employmentId = f.employmentId, who: Actor = f.worker) =>
  asOrg(f.orgId, (tx) => requestLeave(tx, who, { employmentId, leaveType, days: [day(date)] } as never));
const post = (f: F, periodStart: string, periodEnd: string) =>
  asOrg(f.orgId, (tx) =>
    postPayRun(tx, f.admin, { storeId: f.storeId, periodStart, periodEnd, moneyAccountId: f.officeId } as never));
const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message?: string; constructor: { name: string } };
  }
  return undefined;
};

async function workedDay(f: F, shiftDay: string) {
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${f.storeId} order by effective_from desc limit 1`;
  await sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
                                 status, computed_minutes)
    values (${f.orgId}, ${f.storeId}, ${f.workerId}, ${f.employmentId}, ${shiftDay}, ${cfg!.id}, 'exact', 'verified', 540)`;
}

/**
 * Runs `hold` on one connection and keeps its transaction OPEN after it returns; then runs `other` on a SECOND connection.
 * `other` gets `waitMs` to finish while `hold`'s transaction is still open - if it finishes, it did NOT wait for `hold`
 * (i.e. it did not queue behind the person lock). Then `hold` is released (commits) and both are settled.
 */
async function holdAndRace<H, O>(
  orgId: string,
  hold: (tx: Tx) => Promise<H>,
  other: (tx: Tx) => Promise<O>,
  waitMs = 1500,
) {
  let signal!: () => void;
  const held = new Promise<void>((r) => (signal = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t1 = asOrg(orgId, async (tx) => {
    const v = await hold(tx);
    signal();
    await gate;
    return v;
  });
  const t1Settled = t1.then(() => undefined, () => undefined);
  await Promise.race([held, t1Settled]);
  let otherDone = false;
  const t2 = asOrg(orgId, other).finally(() => { otherDone = true; });
  const t2Settled = t2.then(() => undefined, () => undefined);
  await Promise.race([t2Settled, sleep(waitMs)]);
  const finishedWhileHeld = otherDone;
  release();
  const [r1, r2] = await Promise.allSettled([t1, t2]);
  return { r1, r2, finishedWhileHeld };
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================
describe('T-436 A - the SIL cash payout takes the person leave lock (no balance paid twice)', () => {
  const commutedDays = async (personId: string) =>
    Number((await sql<{ n: string }[]>`select coalesce(sum(days),0)::text as n from leave_commutations where person_id = ${personId}`)[0]!.n);

  it('A1. year-end run posting while a paid SIL day is approved: cash days + approved paid days never exceed the 5-day entitlement', async () => {
    const f = await fixture('A1');
    await record(f, { days: [day('2026-03-02'), day('2026-03-03')] }); // 2 of 5 used -> the run will convert 3
    await workedDay(f, '2026-12-20');
    const req = await pending(f, 'sil', '2026-11-10');
    const { r1, r2 } = await holdAndRace(
      f.orgId,
      (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-12-16', periodEnd: '2026-12-31', moneyAccountId: f.officeId } as never),
      (tx) => approveLeave(tx, f.mgr, { requestId: req.requestId } as never),
    );
    expect(r1.status, 'the year-end run itself must post').toBe('fulfilled');
    const cash = await commutedDays(f.workerId);
    const used = (await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: 2026 } as never))).used;
    // MUTANT: applyLeaveToRun does not take lockPersonLeave -> approval commits unseen by the payout (3 cash + 3 used = 6 > 5).
    expect(cash + used, `paid ${cash} cash days AND ${used} approved SIL days from a 5-day entitlement (approval ${r2.status})`).toBeLessThanOrEqual(5);
  });

  it('A2. final pay (separation) settling while a paid SIL day is approved: same invariant', async () => {
    const f = await fixture('A2');
    const leaver = await f.mk('Leaver', 'staff');
    const e = await f.emp(leaver, '2025-01-01', '600.00');
    await asOrg(f.orgId, (tx) =>
      recordLeave(tx, f.mgr, { employmentId: e.employmentId, leaveType: 'sil', days: [day('2026-03-02'), day('2026-03-03')] } as never));
    const req = await pending(f, 'sil', '2026-04-10', e.employmentId, f.mgr); // filed while the job is still open
    await sql`update employments set ended_on = '2026-06-30', employment_status = 'resigned' where id = ${e.employmentId}`;
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', '2026-01-15', 'posted', ${f.officeId}, now(), ${f.adminId}, ${f.adminId}) returning id`;
    await sql`insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
              values (${run!.id}, ${f.orgId}, ${e.employmentId}, ${leaver}, ${e.rateId}, '1', '6000.00', '6000.00', '0', '6000.00')`;
    const { r1, r2 } = await holdAndRace(
      f.orgId,
      (tx) => postSeparation(tx, f.admin, {
        storeId: f.storeId, employmentId: e.employmentId, separationDate: '2026-06-30', cause: 'resignation',
        separationPayAmount: '0', moneyAccountId: f.officeId, clearanceConfirmedBy: f.adminId,
      }),
      (tx) => approveLeave(tx, f.mgr2, { requestId: req.requestId } as never),
    );
    expect(r1.status, `the separation itself must post (${r1.status === 'rejected' ? String(r1.reason) : ''})`).toBe('fulfilled');
    const cash = await commutedDays(leaver);
    const used = (await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: leaver, year: 2026 } as never))).used;
    // MUTANT: settleSilAtSeparation does not take lockPersonLeave.
    expect(cash + used, `paid ${cash} cash days AND ${used} approved SIL days from a 5-day entitlement (approval ${r2.status})`).toBeLessThanOrEqual(5);
  });
});

// =====================================================================================
describe('T-436 B - paid leave cannot be dated into a period a posted pay run already covered', () => {
  it('B1. recording PAID leave inside a posted run period is LEAVE_PERIOD_PAID; unpaid leave there is still fine', async () => {
    const f = await fixture('B1');
    await workedDay(f, '2026-01-12');
    await post(f, '2026-01-01', '2026-01-15');
    // MUTANT: checkAndPrice never looks at posted runs -> a paid day nobody will ever pay.
    expect((await errOf(record(f, { days: [day('2026-01-08')] })))?.code).toBe('LEAVE_PERIOD_PAID');
    expect((await errOf(record(f, { leaveType: 'sick', paid: true, days: [day('2026-01-09')] })))?.code).toBe('LEAVE_PERIOD_PAID');
    expect((await errOf(record(f, { days: [day('2026-01-15')] })))?.code, 'last day of the period is inside it').toBe('LEAVE_PERIOD_PAID');
    // control: unpaid, and a date outside the period
    await record(f, { leaveType: 'unpaid_other', days: [day('2026-01-08')] });
    await record(f, { days: [day('2026-01-16')] });
  });

  it('B2. approving a PAID request filed before the run posted is LEAVE_PERIOD_PAID and leaves it pending; approving it unpaid works', async () => {
    const f = await fixture('B2');
    const req = await pending(f, 'sil', '2026-01-09');
    await workedDay(f, '2026-01-12');
    await post(f, '2026-01-01', '2026-01-15');
    const err = await errOf(asOrg(f.orgId, (tx) => approveLeave(tx, f.mgr, { requestId: req.requestId } as never)));
    expect(err?.code).toBe('LEAVE_PERIOD_PAID');
    const [r] = await sql<{ status: string }[]>`select status from leave_requests where id = ${req.requestId}`;
    expect(r!.status).toBe('pending');
    await asOrg(f.orgId, (tx) => approveLeave(tx, f.mgr, { requestId: req.requestId, paid: false } as never));
  });

  it('B3. a VOIDED run no longer blocks: the same paid day records fine after the void', async () => {
    const f = await fixture('B3');
    await workedDay(f, '2026-01-12');
    const out = await post(f, '2026-01-01', '2026-01-15');
    expect((await errOf(record(f, { days: [day('2026-01-08')] })))?.code).toBe('LEAVE_PERIOD_PAID');
    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'redo' }));
    await record(f, { days: [day('2026-01-08')] });
  });
});

// =====================================================================================
describe('T-436 D - the attendance recompute takes the person leave lock', () => {
  const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
  const DAY_START = shiftDayRange(DAY).start.getTime();
  const at = (hour: number) => new Date(DAY_START + ((((hour - 5) % 24) + 24) % 24) * 60 * 60_000);

  it('D1. approval in flight (uncommitted) when the punch is adjudicated: the recompute waits, then the leave day ends superseded_by_work and the SIL day is given back', async () => {
    const f = await fixture('D1');
    const req = await pending(f, 'sil', DAY);
    for (const [when, intent] of [[at(14), 'in'], [at(23), 'out']] as const) {
      await asOrg(f.orgId, (tx) =>
        recordPunch(tx, { clientPunchId: uid('cp'), employmentId: f.employmentId, occurredAt: when, method: 'qr', assertedIntent: intent, source: 'online' }));
    }
    const { r1, r2, finishedWhileHeld } = await holdAndRace(
      f.orgId,
      (tx) => approveLeave(tx, f.mgr, { requestId: req.requestId } as never),
      (tx) => adjudicateDay(tx, { employmentId: f.employmentId, shiftDay: DAY }),
    );
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');
    const [d] = await sql<{ status: string }[]>`
      select d.status from leave_request_days d where d.request_id = ${req.requestId}`;
    // MUTANT: adjudicateDay / reconcileLeaveWithWorkedDay never lock the person -> the recompute ran beside the uncommitted
    // approval, saw no approved day, and the clash (approved leave AND a worked day) is permanent.
    expect(d!.status, `recompute finished while the approval was still open: ${finishedWhileHeld}`).toBe('superseded_by_work');
    const bal = await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: Number(DAY.slice(0, 4)) } as never));
    expect(bal).toMatchObject({ used: 0, remaining: 5 });
    expect(finishedWhileHeld, 'the recompute must queue behind the approval holding the person lock').toBe(false);
  });
});

// =====================================================================================
describe('T-436 E - a super_admin recording their OWN leave is audited leave.self_approved', () => {
  it('E1. record own leave -> leave.self_approved; control: a manager recording a worker\'s leave writes none', async () => {
    const f = await fixture('E1');
    const own = await record(f, { employmentId: f.superEmp, leaveType: 'sick', days: [day('2026-03-02')] }, f.superA);
    const actions = async (id: string) =>
      (await sql<{ action: string }[]>`select action from audit_log where org_id = ${f.orgId} and entity_id = ${id}`).map((r) => r.action);
    // MUTANT: only approveLeave writes the row; the record path skips it.
    expect(await actions(own.requestId)).toContain('leave.self_approved');
    const other = await record(f, { leaveType: 'sick', days: [day('2026-03-03')] });
    expect(await actions(other.requestId)).not.toContain('leave.self_approved');
  });
});

// =====================================================================================
describe('T-436 F - a missing request id is refused exactly like a real one the caller may not touch', () => {
  const MISSING = '00000000-0000-4000-8000-000000000436';
  const ops: [string, (f: F, id: string) => Promise<unknown>][] = [
    ['approve', (f, id) => asOrg(f.orgId, (tx) => approveLeave(tx, f.outsider, { requestId: id } as never))],
    ['reject', (f, id) => asOrg(f.orgId, (tx) => rejectLeave(tx, f.outsider, { requestId: id } as never))],
    ['cancel', (f, id) => asOrg(f.orgId, (tx) => cancelLeave(tx, f.outsider, { requestId: id } as never))],
  ];
  for (const [name, op] of ops) {
    it(`F-${name}. an unauthorised caller gets the same refusal for a missing id as for a real request`, async () => {
      const f = await fixture(`F${name}`);
      const real = await pending(f, 'sick', '2026-03-02');
      const forReal = await errOf(op(f, real.requestId));
      const forMissing = await errOf(op(f, MISSING));
      expect(forReal, 'control: the outsider must be refused on a real request').toBeDefined();
      // MUTANT: lockedRequest throws "does not exist" BEFORE authorize -> the response tells the caller which ids exist.
      expect(forMissing?.constructor.name, 'missing id must fail the same way (not a "does not exist" refusal)').toBe(forReal!.constructor.name);
      expect(forMissing?.message).toBe(forReal!.message);
    });
  }
});
