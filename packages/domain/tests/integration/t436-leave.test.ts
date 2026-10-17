import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-436 - leave tracking: requests, records, approvals, caps, per-birth limits, SIL, scope, privacy, audit.
 * `docs/tasks/436-leave-tracking.md`. Cases 1-12, 13a, 14, 15, 20f, 22-24, 26 (+6, 6a). The races are in
 * `t436-leave-races.test.ts`, payroll in `t436-leave-payroll.test.ts`, files in `t436-leave-documents.test.ts`.
 *
 * ## THE API CONTRACT THIS FILE (and its three siblings) PINS - the spec names tables, not functions.
 * All exported from `@shareat/domain` (`packages/domain/src/leave/index.ts`), all `(tx, actor, input)`.
 *   requestLeave  {employmentId, leaveType, days:[{date, kind?:'leave'|'rest_day'}], note?, birthDate?} -> {requestId}
 *   recordLeave   same input; the request is created already `approved` (past dates only)           -> {requestId}
 *   approveLeave  {requestId, paid?: boolean}   rejectLeave {requestId, reason?}   cancelLeave {requestId}
 *   voidLeave     {requestId, reason}           setLeaveCap {leaveType, storeId?, positionId?, monthlyCap, yearlyCap}
 *   silBalance    {personId, year} -> {entitlement, used, remaining}
 *   loadLeaveRequest {requestId} -> {requestId, personId, status, leaveType, days, hasProof, note?}  (`note` key ONLY if allowed)
 *   listLeave / leaveGrid {storeId, from, to} -> rows {requestId, personId, date, leaveType, kind, paid, status, clash?}
 *   exportLeaveCsv {storeId, from, to} -> string
 * A refusal is a typed error with a string `code` (LEAVE_CAP_MONTHLY ...) and the numbers in `message`
 * ("sick: 2 of 2 this month"). Authorization failures are `AuthorizationError`. Audit rows are written to
 * `audit_log` with `entity_id` = the request id and `action` = `leave.requested|approved|...`.
 *
 * RED REASON today: `requestLeave` & co. are not exported (the leave module and migration 0205 do not exist).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  approveLeave,
  cancelLeave,
  exportLeaveCsv,
  leaveGrid,
  listLeave,
  loadLeaveRequest,
  recordLeave,
  rejectLeave,
  requestLeave,
  setLeaveCap,
  silBalance,
  voidLeave,
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

async function fixture(hint: string) {
  const code = uid(`l436-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const emp = async (personId: string, storeId: string, startedOn: string, createdBy: string, endedOn: string | null = null) => {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${uid('sc')}, ${startedOn}, ${endedOn},
              ${endedOn ? 'resigned' : 'regular'}, ${createdBy}) returning id`;
    return e!.id;
  };
  const adminId = await mk('Admin', 'admin', [storeA, storeB]);
  const managerA1Id = await mk('Manager A1', 'manager', [storeA]);
  const managerA2Id = await mk('Manager A2', 'manager', [storeA]);
  const managerBId = await mk('Manager B', 'manager', [storeB]);
  const workerId = await mk('Worker', 'staff', [storeA]);
  const colleagueId = await mk('Colleague', 'staff', [storeA]);
  const granteeId = await mk('Grantee', 'staff', [storeA]);
  const superId = await mk('Super', 'super_admin', [storeA]);
  await sql`insert into person_grants (person_id, grant_name) values (${granteeId}, 'manage_attendance')`;
  const workerEmp = await emp(workerId, storeA, '2025-01-01', adminId);
  const colleagueEmp = await emp(colleagueId, storeA, '2025-01-01', adminId);
  const mgrEmp = await emp(managerA1Id, storeA, '2025-01-01', adminId);
  const adminEmp = await emp(adminId, storeA, '2025-01-01', adminId);
  const granteeEmp = await emp(granteeId, storeA, '2025-01-01', adminId);
  const superEmp = await emp(superId, storeA, '2025-01-01', adminId);
  await sql`insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift,
              overtime_multiplier, night_diff_multiplier, overtime_mode)
            values (${orgId}, ${storeA}, '2025-01-01', '9', '1.25', '1.10', 'multiplier')`;
  return {
    orgId, storeA, storeB, emp, mk,
    adminId, managerA1Id, managerA2Id, managerBId, workerId, colleagueId, granteeId, superId,
    workerEmp, colleagueEmp, mgrEmp, adminEmp, granteeEmp, superEmp,
    admin: actor(orgId, adminId), mgr: actor(orgId, managerA1Id), mgr2: actor(orgId, managerA2Id),
    mgrB: actor(orgId, managerBId), worker: actor(orgId, workerId), colleague: actor(orgId, colleagueId),
    grantee: actor(orgId, granteeId), superA: actor(orgId, superId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const day = (date: string, kind: 'leave' | 'rest_day' = 'leave') => ({ date, kind });
const dates = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

const record = (f: F, who: Actor, over: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) =>
    recordLeave(tx, who, { employmentId: f.workerEmp, leaveType: 'sick', days: [day('2026-03-02')], ...over } as never));
const request = (f: F, who: Actor, over: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) =>
    requestLeave(tx, who, { employmentId: f.workerEmp, leaveType: 'sick', days: [day('2026-03-02')], ...over } as never));
const approve = (f: F, who: Actor, requestId: string, over: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) => approveLeave(tx, who, { requestId, ...over } as never));
/** request then approve - a refusal may land at either step, and the spec does not say which. */
const submitAndApprove = async (f: F, over: Record<string, unknown> = {}, approver: Actor = f.mgr) => {
  const r = await request(f, f.worker, over);
  return approve(f, approver, (r as { requestId: string }).requestId);
};
const cap = (f: F, who: Actor, over: Record<string, unknown>) =>
  asOrg(f.orgId, (tx) => setLeaveCap(tx, who, { leaveType: 'sick', monthlyCap: null, yearlyCap: null, ...over } as never));
const statusOf = async (f: F, requestId: string) =>
  (await asOrg(f.orgId, (tx) => loadLeaveRequest(tx, f.admin, { requestId } as never)) as { status: string }).status;

async function refused(p: Promise<unknown>, code: string, msg?: RegExp) {
  let err: { code?: string; message?: string; userMessage?: string } | undefined;
  try {
    await p;
  } catch (e) {
    err = e as never;
  }
  expect(err, `expected a ${code} refusal, but the call succeeded`).toBeDefined();
  expect(err!.code).toBe(code);
  if (msg) expect(`${err!.message} ${err!.userMessage ?? ''}`).toMatch(msg);
}
const refusedAny = async (p: Promise<unknown>) => {
  let err: { code?: unknown } | undefined;
  try {
    await p;
  } catch (e) {
    err = e as never;
  }
  expect(err, 'expected a typed LEAVE_* refusal, but the call succeeded').toBeDefined();
  expect(String(err!.code)).toMatch(/^LEAVE_|^SIL_/);
};
const auditActions = async (orgId: string, entityId: string) =>
  (await sql<{ action: string }[]>`select action from audit_log where org_id = ${orgId} and entity_id = ${entityId} order by recorded_at, id`)
    .map((r) => r.action);

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-436 caps - monthly and yearly, independent', () => {
  it('1. a third sick day in the same month is refused LEAVE_CAP_MONTHLY, naming "2 of 2"', async () => {
    const f = await fixture('c1');
    await cap(f, f.admin, { monthlyCap: 2 });
    await record(f, f.mgr, { days: [day('2026-03-02'), day('2026-03-03')] });
    await refused(record(f, f.mgr, { days: [day('2026-03-04')] }), 'LEAVE_CAP_MONTHLY', /sick/i);
    await refused(record(f, f.mgr, { days: [day('2026-03-04')] }), 'LEAVE_CAP_MONTHLY', /2 of 2/);
  });

  it('2. a yearly cap used up by March still refuses in a fresh month: LEAVE_CAP_YEARLY (monthly unlimited)', async () => {
    const f = await fixture('c2');
    await cap(f, f.admin, { yearlyCap: 5 });
    await record(f, f.mgr, { days: dates('2026-03-02', 5).map((d) => day(d)) });
    await refused(record(f, f.mgr, { days: [day('2026-04-06')] }), 'LEAVE_CAP_YEARLY', /5 of 5/);
  });

  it('3. voided, rejected, cancelled and rest_day rows do not count toward a cap', async () => {
    const f = await fixture('c3');
    await cap(f, f.admin, { monthlyCap: 1 });
    const rej = await request(f, f.worker, { days: [day('2026-03-02')] });
    await asOrg(f.orgId, (tx) => rejectLeave(tx, f.mgr, { requestId: rej.requestId, reason: 'no cover' } as never));
    const can = await request(f, f.worker, { days: [day('2026-03-03')] });
    await asOrg(f.orgId, (tx) => cancelLeave(tx, f.worker, { requestId: can.requestId } as never));
    const rec = await record(f, f.mgr, { days: [day('2026-03-04')] });
    await asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: rec.requestId, reason: 'entered twice' } as never));
    await record(f, f.mgr, { days: [day('2026-03-05', 'rest_day')] });
    // none of the four counted, so ONE real day still fits ...
    await record(f, f.mgr, { days: [day('2026-03-06')] });
    // ... and now the cap is genuinely used (a mutant that never counts would let this through).
    await refused(record(f, f.mgr, { days: [day('2026-03-09')] }), 'LEAVE_CAP_MONTHLY', /1 of 1/);
  });

  it('4. a position cap beats the org default; store+position beats position; position beats store', async () => {
    const f = await fixture('c4');
    const [pos] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical) values (${f.orgId}, ${f.storeA}, 'Cook', false) returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${f.workerEmp}, ${pos!.id}, true)`;
    await cap(f, f.admin, { monthlyCap: 5 }); // org default
    await cap(f, f.admin, { positionId: pos!.id, monthlyCap: 2 });
    await record(f, f.mgr, { days: [day('2026-03-02'), day('2026-03-03')] });
    await refused(record(f, f.mgr, { days: [day('2026-03-04')] }), 'LEAVE_CAP_MONTHLY', /2 of 2/); // position, not 5
    await cap(f, f.admin, { storeId: f.storeA, positionId: pos!.id, monthlyCap: 3 });
    await record(f, f.mgr, { days: [day('2026-03-04')] }); // store+position (3) wins over position (2)
    await refused(record(f, f.mgr, { days: [day('2026-03-05')] }), 'LEAVE_CAP_MONTHLY', /3 of 3/);
  });

  it('4b. position beats store-only when both exist', async () => {
    const f = await fixture('c4b');
    const [pos] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical) values (${f.orgId}, ${f.storeA}, 'Server', false) returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${f.workerEmp}, ${pos!.id}, true)`;
    await cap(f, f.admin, { storeId: f.storeA, monthlyCap: 1 });
    await cap(f, f.admin, { positionId: pos!.id, monthlyCap: 3 });
    await record(f, f.mgr, { days: [day('2026-03-02'), day('2026-03-03'), day('2026-03-04')] });
    await refused(record(f, f.mgr, { days: [day('2026-03-05')] }), 'LEAVE_CAP_MONTHLY', /3 of 3/);
    // control: the colleague has no position, so the STORE row (1) applies to them.
    await record(f, f.mgr, { employmentId: f.colleagueEmp, days: [day('2026-03-02')] });
    await refused(record(f, f.mgr, { employmentId: f.colleagueEmp, days: [day('2026-03-03')] }), 'LEAVE_CAP_MONTHLY', /1 of 1/);
  });

  it('20f. the caps reset on 1 Jan: a person at the yearly cap on 31 Dec can take leave on 2 Jan', async () => {
    const f = await fixture('c20f');
    await cap(f, f.admin, { yearlyCap: 2 });
    await record(f, f.mgr, { days: [day('2025-12-30'), day('2025-12-31')] });
    await refused(record(f, f.mgr, { days: [day('2025-12-29')] }), 'LEAVE_CAP_YEARLY', /2 of 2/); // control: 2025 really is full
    const r = await record(f, f.mgr, { days: [day('2026-01-02')] });
    expect(await statusOf(f, r.requestId)).toBe('approved');
  });
});

// =====================================================================================

describe('T-436 scope - the PERSON, not the employment', () => {
  async function twoJobs(hint: string) {
    const f = await fixture(hint);
    const empB = await f.emp(f.workerId, f.storeB, '2025-03-01', f.adminId);
    return { f, empB };
  }

  it('6. a leave day at store A blocks the same date at store B; caps and SIL count both jobs', async () => {
    const { f, empB } = await twoJobs('s6');
    await record(f, f.admin, { days: [day('2026-03-02')] });
    await refusedAny(record(f, f.admin, { employmentId: empB, days: [day('2026-03-02')] }));

    await cap(f, f.admin, { monthlyCap: 2 });
    await record(f, f.admin, { employmentId: empB, days: [day('2026-03-03')] });
    await refused(record(f, f.admin, { days: [day('2026-03-04')] }), 'LEAVE_CAP_MONTHLY', /2 of 2/);
  });

  it('6. one SIL balance across both jobs: 3 days at A + 2 at B exhausts the 5; the 6th paid day is refused at either', async () => {
    const { f, empB } = await twoJobs('s6sil');
    await record(f, f.admin, { leaveType: 'sil', days: dates('2026-03-02', 3).map((d) => day(d)) });
    await record(f, f.admin, { employmentId: empB, leaveType: 'sil', days: dates('2026-03-10', 2).map((d) => day(d)) });
    await refused(record(f, f.admin, { employmentId: empB, leaveType: 'sil', days: [day('2026-03-20')] }), 'SIL_BALANCE_EXHAUSTED');
    await refused(record(f, f.admin, { leaveType: 'sil', days: [day('2026-03-21')] }), 'SIL_BALANCE_EXHAUSTED');
    const b = await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: 2026 } as never));
    expect(b).toMatchObject({ entitlement: 5, used: 5, remaining: 0 });
  });

  it('6a. a transfer A->B with no gap keeps A\'s service start (5 SIL days in 2026); a one-day gap restarts it (0)', async () => {
    const f = await fixture('s6a');
    // continuous: A until 2025-12-31, B from 2026-01-01
    const p1 = await f.mk('Transfer', 'staff', [f.storeA, f.storeB]);
    await f.emp(p1, f.storeA, '2025-01-01', f.adminId, '2025-12-31');
    await f.emp(p1, f.storeB, '2026-01-01', f.adminId);
    expect(await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: p1, year: 2026 } as never)))
      .toMatchObject({ entitlement: 5 });
    // gap: A until 2025-12-30, B from 2026-01-01 (31 Dec has no open employment)
    const p2 = await f.mk('Gap', 'staff', [f.storeA, f.storeB]);
    await f.emp(p2, f.storeA, '2025-01-01', f.adminId, '2025-12-30');
    await f.emp(p2, f.storeB, '2026-01-01', f.adminId);
    expect(await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: p2, year: 2026 } as never)))
      .toMatchObject({ entitlement: 0 });
  });
});

// =====================================================================================

describe('T-436 who may do what', () => {
  it('7. a staff actor cannot approve; a store-B manager cannot approve store-A leave', async () => {
    const f = await fixture('w7');
    const r = await request(f, f.worker);
    await expect(approve(f, f.colleague, r.requestId)).rejects.toThrow(AuthorizationError);
    await expect(approve(f, f.mgrB, r.requestId)).rejects.toThrow(AuthorizationError);
    expect(await statusOf(f, r.requestId)).toBe('pending');
    await approve(f, f.mgr, r.requestId); // control: the store-A manager can
    expect(await statusOf(f, r.requestId)).toBe('approved');
  });

  it('8. nobody approves their own leave: manager, admin and a position-granted staff are refused LEAVE_OWN_APPROVAL', async () => {
    const f = await fixture('w8');
    const own = async (who: Actor, employmentId: string) => {
      const r = await request(f, who, { employmentId });
      return approve(f, who, r.requestId);
    };
    await refused(own(f.mgr, f.mgrEmp), 'LEAVE_OWN_APPROVAL');
    await refused(own(f.admin, f.adminEmp), 'LEAVE_OWN_APPROVAL'); // admins are NOT exempt
    await refused(own(f.grantee, f.granteeEmp), 'LEAVE_OWN_APPROVAL'); // keyed on the person, not the role
  });

  it('8. a super_admin may approve their own leave, audited as leave.self_approved', async () => {
    const f = await fixture('w8s');
    const r = await request(f, f.superA, { employmentId: f.superEmp });
    await approve(f, f.superA, r.requestId);
    expect(await statusOf(f, r.requestId)).toBe('approved');
    expect(await auditActions(f.orgId, r.requestId)).toContain('leave.self_approved');
  });

  it('8. control: another manager CAN approve a manager\'s request', async () => {
    const f = await fixture('w8c');
    const r = await request(f, f.mgr, { employmentId: f.mgrEmp });
    await approve(f, f.mgr2, r.requestId);
    expect(await statusOf(f, r.requestId)).toBe('approved');
  });

  it('9. staff request their own leave (pending); for a colleague is refused; a manager may file on their behalf', async () => {
    const f = await fixture('w9');
    const mine = await request(f, f.worker);
    expect(await statusOf(f, mine.requestId)).toBe('pending');
    await expect(request(f, f.colleague, { employmentId: f.workerEmp, days: [day('2026-03-03')] })).rejects.toThrow(AuthorizationError);
    const onBehalf = await request(f, f.mgr, { employmentId: f.workerEmp, days: [day('2026-03-04')] });
    expect(await statusOf(f, onBehalf.requestId)).toBe('pending');
  });

  it('7. staff cannot RECORD leave (record is a manage_attendance act)', async () => {
    const f = await fixture('w7r');
    await expect(record(f, f.worker)).rejects.toThrow(AuthorizationError);
    await expect(record(f, f.mgrB)).rejects.toThrow(AuthorizationError);
  });
});

// =====================================================================================

describe('T-436 kinds and dates', () => {
  it('10. a future-dated record is refused; a future-dated request is accepted', async () => {
    const f = await fixture('d10');
    await refusedAny(record(f, f.mgr, { days: [day('2099-01-05')] }));
    const r = await request(f, f.worker, { days: [day('2099-01-05')] });
    expect(await statusOf(f, r.requestId)).toBe('pending');
  });

  it('11. no_show cannot be requested, only recorded, and is always unpaid', async () => {
    const f = await fixture('k11');
    await refusedAny(request(f, f.worker, { leaveType: 'no_show' }));
    await refusedAny(request(f, f.mgr, { leaveType: 'no_show' }));
    const r = await record(f, f.mgr, { leaveType: 'no_show' });
    const rows = (await asOrg(f.orgId, (tx) =>
      listLeave(tx, f.mgr, { storeId: f.storeA, from: '2026-03-01', to: '2026-03-31' } as never))) as { requestId: string; paid: boolean }[];
    const mine = rows.filter((x) => x.requestId === r.requestId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.paid).toBe(false);
    // asking to approve a no_show as paid does not make it paid
    const r2 = await record(f, f.mgr, { leaveType: 'no_show', days: [day('2026-03-03')], paid: true });
    const rows2 = (await asOrg(f.orgId, (tx) =>
      listLeave(tx, f.mgr, { storeId: f.storeA, from: '2026-03-01', to: '2026-03-31' } as never))) as { requestId: string; paid: boolean }[];
    expect(rows2.find((x) => x.requestId === r2.requestId)!.paid).toBe(false);
  });

  it('12. a statutory yearly limit cannot be lowered (solo parent 7); raising it is fine', async () => {
    const f = await fixture('k12a');
    await refusedAny(cap(f, f.admin, { leaveType: 'solo_parent', yearlyCap: 3 }));
    await cap(f, f.admin, { leaveType: 'solo_parent', yearlyCap: 7 });
    await cap(f, f.admin, { leaveType: 'solo_parent', yearlyCap: 10 });
  });

  it('12. maternity: 105 days for one birth is accepted with a yearly cap of 5 on file; day 106 is LEAVE_BIRTH_LIMIT', async () => {
    const f = await fixture('k12m');
    await cap(f, f.admin, { leaveType: 'maternity', monthlyCap: 1, yearlyCap: 5 });
    const all = dates('2026-02-01', 106).map((d) => day(d));
    const r = await record(f, f.mgr, { leaveType: 'maternity', birthDate: '2026-01-20', days: all.slice(0, 105) });
    expect(await statusOf(f, r.requestId)).toBe('approved');
    await refused(
      record(f, f.mgr, { leaveType: 'maternity', birthDate: '2026-01-20', days: [all[105]!] }),
      'LEAVE_BIRTH_LIMIT',
      /105/,
    );
  });

  it('12. paternity: 7 days per birth (8th refused) and a 5th delivery is refused', async () => {
    const f = await fixture('k12p');
    await record(f, f.mgr, { leaveType: 'paternity', birthDate: '2026-01-10', days: dates('2026-03-02', 7).map((d) => day(d)) });
    await refused(record(f, f.mgr, { leaveType: 'paternity', birthDate: '2026-01-10', days: [day('2026-03-20')] }), 'LEAVE_BIRTH_LIMIT', /7/);
    // deliveries 2..4 (one day each) are accepted, the 5th is not
    for (const [i, birth] of ['2026-02-10', '2026-03-10', '2026-04-10'].entries()) {
      await record(f, f.mgr, { leaveType: 'paternity', birthDate: birth, days: [day(`2026-04-0${i + 1}`)] });
    }
    await refused(
      record(f, f.mgr, { leaveType: 'paternity', birthDate: '2026-05-10', days: [day('2026-05-04')] }),
      'LEAVE_BIRTH_LIMIT',
      /4/,
    );
  });

  it('26. a half-day request is refused (whole days only)', async () => {
    const f = await fixture('k26');
    await refusedAny(request(f, f.worker, { portion: 0.5 }));
    await refusedAny(request(f, f.worker, { days: [{ date: '2026-03-02', kind: 'leave', portion: 0.5 }] }));
    await refusedAny(record(f, f.mgr, { portion: 0.5 }));
  });
});

// =====================================================================================

describe('T-436 SIL - the anniversary and the balance', () => {
  it('13a. service start 2026-06-15: a paid SIL day on 2027-05-10 is SIL_BEFORE_ANNIVERSARY; 2027-06-20 is allowed', async () => {
    const f = await fixture('sil13a');
    const p = await f.mk('New hire', 'staff', [f.storeA]);
    const e = await f.emp(p, f.storeA, '2026-06-15', f.adminId);
    const go = async (date: string) => {
      const r = await request(f, actor(f.orgId, p), { employmentId: e, leaveType: 'sil', days: [day(date)] });
      return approve(f, f.mgr, r.requestId);
    };
    await refused(go('2027-05-10'), 'SIL_BEFORE_ANNIVERSARY');
    await go('2027-06-20');
    expect(await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: p, year: 2027 } as never)))
      .toMatchObject({ entitlement: 3, used: 1, remaining: 2 });
  });

  it('14. the sixth paid SIL day is SIL_BALANCE_EXHAUSTED; the manager may approve it as unpaid, audited leave.paid_override', async () => {
    const f = await fixture('sil14');
    await record(f, f.mgr, { leaveType: 'sil', days: dates('2026-03-02', 5).map((d) => day(d)) });
    const r = await request(f, f.worker, { leaveType: 'sil', days: [day('2026-03-20')] });
    await refused(approve(f, f.mgr, r.requestId), 'SIL_BALANCE_EXHAUSTED');
    expect(await statusOf(f, r.requestId)).toBe('pending'); // the refusal rolled back
    await approve(f, f.mgr, r.requestId, { paid: false });
    expect(await statusOf(f, r.requestId)).toBe('approved');
    expect(await auditActions(f.orgId, r.requestId)).toContain('leave.paid_override');
    const b = await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: 2026 } as never));
    expect(b).toMatchObject({ used: 5, remaining: 0 }); // the unpaid day drew nothing
  });
});

// =====================================================================================

describe('T-436 case 15 - a worked date cannot be leave', () => {
  async function workedDay(f: F, shiftDay: string, status: string) {
    const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${f.storeA} limit 1`;
    await sql`
      insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id,
                                   anchor_mode, status, computed_minutes)
      values (${f.orgId}, ${f.storeA}, ${f.workerId}, ${f.workerEmp}, ${shiftDay}, ${cfg!.id}, 'exact', ${status}, 540)`;
  }

  it('an attendance day in needs_review (not only verified/computed) blocks approval: LEAVE_DAY_WORKED', async () => {
    const f = await fixture('w15');
    await workedDay(f, '2026-03-10', 'needs_review');
    await workedDay(f, '2026-03-11', 'computed');
    await workedDay(f, '2026-03-12', 'voided');
    const a = await request(f, f.worker, { days: [day('2026-03-10')] });
    await refused(approve(f, f.mgr, a.requestId), 'LEAVE_DAY_WORKED');
    const b = await request(f, f.worker, { days: [day('2026-03-11')] });
    await refused(approve(f, f.mgr, b.requestId), 'LEAVE_DAY_WORKED');
    // control: a VOIDED attendance day is not "worked"
    const c = await request(f, f.worker, { days: [day('2026-03-12')] });
    await approve(f, f.mgr, c.requestId);
    expect(await statusOf(f, c.requestId)).toBe('approved');
  });

  it('record on a worked date is refused too', async () => {
    const f = await fixture('w15r');
    await workedDay(f, '2026-03-10', 'verified');
    await refused(record(f, f.mgr, { days: [day('2026-03-10')] }), 'LEAVE_DAY_WORKED');
  });
});

// =====================================================================================

const NOTE = 'MEDNOTE-ubiquitous-xyzzy-4471';

describe('T-436 privacy (bible row 353) - the note is shown only to the person and manage_attendance holders at the store', () => {
  async function withNote(hint: string) {
    const f = await fixture(hint);
    const r = await request(f, f.worker, { note: NOTE, days: [day('2026-03-02')] });
    return { f, requestId: r.requestId as string };
  }
  const load = (f: F, who: Actor, requestId: string) =>
    asOrg(f.orgId, (tx) => loadLeaveRequest(tx, who, { requestId } as never)).catch(() => null) as Promise<Record<string, unknown> | null>;

  it('22. the person and a store-A manager get the note', async () => {
    const { f, requestId } = await withNote('p22a');
    expect((await load(f, f.worker, requestId))!.note).toBe(NOTE);
    expect((await load(f, f.mgr, requestId))!.note).toBe(NOTE);
  });

  it('22. a store-B manager and a colleague get NO note key (and no note text anywhere in what they see)', async () => {
    const { f, requestId } = await withNote('p22b');
    for (const who of [f.mgrB, f.colleague]) {
      const r = await load(f, who, requestId);
      if (r) {
        expect('note' in r).toBe(false);
        expect(JSON.stringify(r)).not.toContain(NOTE);
      }
    }
  });

  it('23. the grid, the list and the CSV export carry the kind only - never the note', async () => {
    const { f, requestId } = await withNote('p23');
    await approve(f, f.mgr, requestId);
    const range = { storeId: f.storeA, from: '2026-03-01', to: '2026-03-31' };
    const list = await asOrg(f.orgId, (tx) => listLeave(tx, f.mgr, range as never));
    const grid = await asOrg(f.orgId, (tx) => leaveGrid(tx, f.mgr, range as never));
    const csv = await asOrg(f.orgId, (tx) => exportLeaveCsv(tx, f.mgr, range as never));
    expect(JSON.stringify(list)).toContain('sick');
    expect(JSON.stringify(list)).not.toContain(NOTE);
    expect(JSON.stringify(grid)).not.toContain(NOTE);
    expect(String(csv)).toContain('sick');
    expect(String(csv)).not.toContain(NOTE);
  });

  it('23. audit payloads carry no note text', async () => {
    const { f, requestId } = await withNote('p23a');
    await approve(f, f.mgr, requestId);
    const rows = await sql<{ blob: string }[]>`
      select coalesce(before::text, '') || coalesce(after::text, '') as blob from audit_log where org_id = ${f.orgId}`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.blob.includes(NOTE))).toBe(false);
  });
});

// =====================================================================================

describe('T-436 case 24 - every transition is audited with who, when, whom, which dates, which kind', () => {
  it('requested, approved, rejected, cancelled, recorded, voided each leave an audit row', async () => {
    const f = await fixture('a24');
    const r1 = await request(f, f.worker, { days: [day('2026-03-02')] });
    await approve(f, f.mgr, r1.requestId);
    const r2 = await request(f, f.worker, { days: [day('2026-03-03')] });
    await asOrg(f.orgId, (tx) => rejectLeave(tx, f.mgr, { requestId: r2.requestId, reason: 'short staffed' } as never));
    const r3 = await request(f, f.worker, { days: [day('2026-03-04')] });
    await asOrg(f.orgId, (tx) => cancelLeave(tx, f.worker, { requestId: r3.requestId } as never));
    const r4 = await record(f, f.mgr, { days: [day('2026-03-05')] });
    await asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: r1.requestId, reason: 'entered in error' } as never));

    expect(await auditActions(f.orgId, r1.requestId)).toEqual(['leave.requested', 'leave.approved', 'leave.voided']);
    expect(await auditActions(f.orgId, r2.requestId)).toEqual(['leave.requested', 'leave.rejected']);
    expect(await auditActions(f.orgId, r3.requestId)).toEqual(['leave.requested', 'leave.cancelled']);
    expect(await auditActions(f.orgId, r4.requestId)).toEqual(['leave.recorded']);
  });

  it('each row names the actor and carries person, date and kind (but no note)', async () => {
    const f = await fixture('a24b');
    const r = await request(f, f.worker, { note: NOTE, days: [day('2026-03-02')] });
    await approve(f, f.mgr, r.requestId);
    const rows = await sql<{ action: string; actor_person_id: string; occurred_at: Date; blob: string }[]>`
      select action, actor_person_id, occurred_at, coalesce(before::text,'') || coalesce(after::text,'') as blob
      from audit_log where org_id = ${f.orgId} and entity_id = ${r.requestId} order by recorded_at, id`;
    expect(rows.map((x) => x.actor_person_id)).toEqual([f.workerId, f.managerA1Id]);
    for (const row of rows) {
      expect(row.occurred_at).toBeInstanceOf(Date);
      expect(row.blob).toContain(f.workerId);
      expect(row.blob).toContain('2026-03-02');
      expect(row.blob).toContain('sick');
      expect(row.blob).not.toContain(NOTE);
    }
  });

  it('void needs a reason (blank refused, request stays approved); rejecting a non-pending request is LEAVE_NOT_PENDING', async () => {
    const f = await fixture('a24c');
    const r = await record(f, f.mgr);
    await refusedAny(asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: r.requestId, reason: '   ' } as never)));
    await refusedAny(asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: r.requestId } as never)));
    expect(await statusOf(f, r.requestId)).toBe('approved');
    await refused(
      asOrg(f.orgId, (tx) => rejectLeave(tx, f.mgr, { requestId: r.requestId, reason: 'late' } as never)),
      'LEAVE_NOT_PENDING',
    );
    await asOrg(f.orgId, (tx) => voidLeave(tx, f.mgr, { requestId: r.requestId, reason: 'entered in error' } as never));
    expect(await statusOf(f, r.requestId)).toBe('voided');
  });
});

// =====================================================================================

describe('T-436 case 25 - the grid shows kind and Paid/Unpaid per leave date', () => {
  it('each leave date carries its kind and paid flag (paid SIL vs unpaid), rest days marked, not leave', async () => {
    const f = await fixture('g25');
    await record(f, f.mgr, { leaveType: 'sil', days: [day('2026-03-02')] });
    await record(f, f.mgr, { leaveType: 'unpaid_other', days: [day('2026-03-03')] });
    await record(f, f.mgr, { leaveType: 'sil', days: [day('2026-03-04', 'rest_day')] });
    const grid = (await asOrg(f.orgId, (tx) =>
      leaveGrid(tx, f.mgr, { storeId: f.storeA, from: '2026-03-01', to: '2026-03-31' } as never))) as {
      date: string; leaveType: string; kind: string; paid: boolean; clash?: boolean;
    }[];
    const byDate = new Map(grid.map((g) => [g.date, g]));
    expect(byDate.get('2026-03-02')).toMatchObject({ leaveType: 'sil', kind: 'leave', paid: true });
    expect(byDate.get('2026-03-03')).toMatchObject({ leaveType: 'unpaid_other', kind: 'leave', paid: false });
    expect(byDate.get('2026-03-04')).toMatchObject({ kind: 'rest_day', paid: false });
    expect(byDate.get('2026-03-02')!.clash ?? false).toBe(false); // no punches there
  });
});
