import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-158 — manager adjustments. `docs/tasks/158-attendance-adjustments.md`.
 *
 * ⭐ The controls here are only real because T-138 exists. Every one of them turns on knowing WHO
 * acted, and v1 takes that as a client-supplied parameter on ~24 server actions (landmine #17) —
 * so in v1 "you cannot adjudicate your own attendance" is a sentence, not a control.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  adjudicateDay,
  createEmployment,
  isStartDecisionMaterial,
  listAdjustments,
  recordAdjustment,
  recordPunch,
  seedAttendanceConfig,
  seedCanonicalPositions,
  shiftDayRange,
  toShiftDay,
  type DayPolicy,
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

const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
const DAY_START = shiftDayRange(DAY).start.getTime();
const at = (hour: number, minute = 0) =>
  new Date(DAY_START + (((((hour - 5) % 24) + 24) % 24) * 60 + minute) * 60_000);
const minuteOf = (hour: number) => ((((hour - 5) % 24) + 24) % 24) * 60;

/** A real, live session row — the thing every attribution in this file hangs on. */
async function makeSession(orgId: string, personId: string, storeId: string): Promise<string> {
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [s] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${personId}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours')
    returning id`;
  return s!.id;
}

async function fixture(hint: string) {
  const code = uid(`aj-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const a = actor(orgId, admin!.id);
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, a, {
      storeId: store!.id,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  const sessionId = await makeSession(orgId, admin!.id, store!.id);

  return { orgId, storeId: store!.id, admin: a, adminPersonId: admin!.id, workerId: worker!.id, employment, sessionId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const addPunch = (f: Fixture, when: Date, intent: 'in' | 'out') =>
  asOrg(f.orgId, (tx) =>
    recordPunch(tx, {
      clientPunchId: uid('cp'),
      employmentId: f.employment.id,
      occurredAt: when,
      method: 'qr',
      assertedIntent: intent,
      source: 'online',
    }),
  );

const adjust = (f: Fixture, over: Record<string, unknown>, who?: Actor, session?: string) =>
  asOrg(f.orgId, (tx) =>
    recordAdjustment(tx, who ?? f.admin, {
      employmentId: f.employment.id,
      shiftDay: DAY,
      sessionId: session ?? f.sessionId,
      ...(over as { kind: 'verify' }),
    }),
  );

async function cleanDay(hint: string) {
  const f = await fixture(hint);
  await addPunch(f, at(14, 20), 'in');
  await addPunch(f, at(23), 'out');
  await asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId: f.employment.id, shiftDay: DAY }));
  return f;
}

// -------------------------------------------------------------------------------------

describe('T-158 invariants 1 & 12 — one live decision per kind, superseding re-adjudicates', () => {
  it('a second decision of the same kind supersedes rather than duplicating', async () => {
    const f = await cleanDay('supersede');
    await adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(14) });
    const { day } = await adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(15) });

    const live = await sql`
      select id from attendance_adjustments
      where employment_id = ${f.employment.id} and kind = 'start_anchor'
        and superseded_by_adjustment_id is null`;
    expect(live).toHaveLength(1);

    const all = await asOrg(f.orgId, (tx) =>
      listAdjustments(tx, { employmentId: f.employment.id, shiftDay: DAY }),
    );
    expect(all).toHaveLength(2);

    // ⭐ And the day now reflects the NEW anchor, not the old one.
    expect(day.anchorMinute).toBe(minuteOf(15));
  });

  it('the day is re-adjudicated in the SAME transaction as the decision', async () => {
    const f = await cleanDay('same-tx');
    const { day } = await adjust(f, { kind: 'early_out_approved', effectiveOutMinute: minuteOf(23) });
    const [row] = await sql<{ computed_minutes: number }[]>`
      select computed_minutes from attendance_days where id = ${day.id}`;
    expect(row!.computed_minutes).toBe(day.computedMinutes);
  });
});

describe('T-158 invariants 2 & 3 — append-only, and attribution comes from the session', () => {
  it('raw SQL cannot UPDATE or DELETE a decision', async () => {
    const f = await cleanDay('immutable');
    const { adjustment } = await adjust(f, { kind: 'half_day_override', isHalfDay: true, reason: 'Sent home' });
    await expect(sql`update attendance_adjustments set reason = 'x' where id = ${adjustment.id}`)
      .rejects.toThrow(/immutable/i);
    await expect(sql`delete from attendance_adjustments where id = ${adjustment.id}`)
      .rejects.toThrow(/never deleted/i);
  });

  it('the decision names the session and the person it was made under', async () => {
    const f = await cleanDay('attribution');
    const { adjustment } = await adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(14) });
    expect(adjustment.decidedBySessionId).toBe(f.sessionId);
    expect(adjustment.decidedByPersonId).toBe(f.adminPersonId);
  });

  it('a void and a half-day override both REQUIRE a reason', async () => {
    const f = await cleanDay('reason');
    await expect(adjust(f, { kind: 'void' })).rejects.toThrow(/reason|check/i);
    await expect(adjust(f, { kind: 'half_day_override', isHalfDay: true })).rejects.toThrow(/reason|check/i);
  });
});

describe('T-158 invariants 4 & 5 — self-dealing, and the deputy', () => {
  it('⛔ a manager cannot adjudicate their OWN attendance', async () => {
    const f = await cleanDay('self');
    // Give the worker a manager role and their own employment, then have them try.
    await sql`insert into person_roles (person_id, org_id, role) values (${f.workerId}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.workerId}, ${f.storeId})`;
    const s = await makeSession(f.orgId, f.workerId, f.storeId);

    await expect(
      adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(14) }, actor(f.orgId, f.workerId), s),
    ).rejects.toThrow(/your own attendance/i);
  });

  it('an ADMIN may adjudicate their own, and the row records who did', async () => {
    const f = await fixture('admin-self');
    // The admin is also an employee here.
    const own = await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId,
        personId: f.adminPersonId,
        employmentStatus: 'regular',
        startedOn: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      recordPunch(tx, {
        clientPunchId: uid('cp'),
        employmentId: own.id,
        occurredAt: at(14),
        method: 'qr',
        assertedIntent: 'in',
        source: 'online',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      recordPunch(tx, {
        clientPunchId: uid('cp'),
        employmentId: own.id,
        occurredAt: at(23),
        method: 'qr',
        assertedIntent: 'out',
        source: 'online',
      }),
    );

    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: own.id,
        shiftDay: DAY,
        sessionId: f.sessionId,
        kind: 'half_day_override',
        isHalfDay: true,
        reason: 'Left early, agreed',
      }),
    );
    expect(adjustment.decidedByPersonId).toBe(f.adminPersonId);
  });

  it('⭐ a granted non-manager CAN adjudicate — v1’s attendanceManager deputy, as a person_grant', async () => {
    // Discovery 15 §1 flagged this delegation as "not itself named in the phase description —
    // confirm it survives". It survives, and it needs no new mechanism: T-121's person_grants is
    // exactly "an admin handing one extra capability to one person without changing their role".
    const f = await cleanDay('deputy');
    const [cashier] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Senior Cashier') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${cashier!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${cashier!.id}, ${f.storeId})`;
    const s = await makeSession(f.orgId, cashier!.id, f.storeId);

    // Without the grant: refused.
    await expect(
      adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(14) }, actor(f.orgId, cashier!.id), s),
    ).rejects.toThrow();

    // With it: allowed.
    await sql`
      insert into person_grants (person_id, grant_name) values (${cashier!.id}, 'manage_attendance')`;
    const { adjustment } = await adjust(
      f,
      { kind: 'start_anchor', chosenAnchorMinute: minuteOf(14) },
      actor(f.orgId, cashier!.id),
      s,
    );
    expect(adjustment.decidedByPersonId).toBe(cashier!.id);
  });

  it('...and the grant buys ONLY attendance, nothing else', async () => {
    const f = await cleanDay('deputy-scope');
    const [cashier] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Senior Cashier') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${cashier!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${cashier!.id}, ${f.storeId})`;
    await sql`insert into person_grants (person_id, grant_name) values (${cashier!.id}, 'manage_attendance')`;

    // ⭐ Hiring is `enrol_staff`, which was NOT granted. Widening one capability must never grant
    // an unrelated one — landmine #9, and bible §7 rule 2.
    await expect(
      asOrg(f.orgId, (tx) =>
        createEmployment(tx, actor(f.orgId, cashier!.id), {
          storeId: f.storeId,
          personId: cashier!.id,
          employmentStatus: 'regular',
          startedOn: '2026-02-01',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('T-158 invariant 6 — ⛔ C1, the inverting combination is refused at creation', () => {
  it('an early-out approval before an existing start anchor is refused, naming both', async () => {
    const f = await cleanDay('c1');
    await adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(18) });
    await expect(
      adjust(f, { kind: 'early_out_approved', effectiveOutMinute: minuteOf(17) }),
    ).rejects.toThrow(/ends at or before it starts/i);
  });

  it('and the same pair in the other order is refused too', async () => {
    const f = await cleanDay('c1-reverse');
    await adjust(f, { kind: 'early_out_approved', effectiveOutMinute: minuteOf(17) });
    await expect(
      adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(18) }),
    ).rejects.toThrow(/ends at or before it starts/i);
  });

  it('a valid pair is accepted', async () => {
    const f = await cleanDay('c1-ok');
    await adjust(f, { kind: 'start_anchor', chosenAnchorMinute: minuteOf(14) });
    const { day } = await adjust(f, { kind: 'early_out_approved', effectiveOutMinute: minuteOf(23) });
    expect(day.computedMinutes).toBe(9 * 60);
  });
});

describe('T-158 invariants 8 & 9 — the freeze, and what "verified" is allowed to mean', () => {
  it('adjusting a frozen day is refused', async () => {
    const f = await cleanDay('frozen');
    // ⚠️ A REAL pay run — T-189 attached the FK T-157 deliberately left off, so an invented
    // uuid is now refused by the database before the freeze is even set.
    const [acct] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId} and is_foundation limit 1`;
    const [who] = await sql<{ id: string }[]>`
      select id from persons where org_id = ${f.orgId} limit 1`;
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, money_account_id, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', '2026-01-15', ${acct!.id}, ${who!.id})
      returning id`;
    await sql`
      update attendance_days set frozen_at = now(), frozen_by_pay_run_id = ${run!.id}
      where employment_id = ${f.employment.id}`;
    await expect(adjust(f, { kind: 'verify' })).rejects.toThrow(/frozen/i);
  });

  it('⚠️ a day with an unresolved anomaly cannot be verified', async () => {
    const f = await fixture('verify-anomaly');
    await addPunch(f, at(14), 'in'); // no out ⇒ missing_out
    await asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId: f.employment.id, shiftDay: DAY }));
    await expect(adjust(f, { kind: 'verify' })).rejects.toThrow(/unresolved anomalies/i);
  });

  it('a clean day CAN be verified', async () => {
    const f = await cleanDay('verify-ok');
    const { adjustment } = await adjust(f, { kind: 'verify' });
    expect(adjustment.kind).toBe('verify');
  });
});

describe('T-158 §4 — ⭐ the materiality gate: do not ask what cannot change money', () => {
  const policy = (over: Partial<DayPolicy> = {}): DayPolicy => ({
    requiredMinutes: 9 * 60,
    halfDayMinutes: 5 * 60,
    shortShiftHalfDayOt: false,
    allowedShiftStartHours: [14, 15],
    lateGraceMinutes: 0,
    earlyOutGraceMinutes: 0,
    undertimeGraceMinutes: 0,
    nightDiffEnabled: true,
    nightDiffStartHour: 22,
    nightDiffEndHour: 6,
    allowableBreakMinutes: 60,
    anchorWindowMinutes: 30,
    ...over,
  });

  it('a day that is a FULL shift from either anchor is NOT material', () => {
    // 52% of flagged sessions at one branch looked exactly like this. Asking is noise.
    const material = isStartDecisionMaterial({
      day: { anchorMinute: minuteOf(14), endMinute: minuteOf(2) },
      policy: policy(),
      lateCostsMoney: false,
    });
    expect(material).toBe(false);
  });

  it('a day whose paid minutes differ between the anchors IS material', () => {
    const material = isStartDecisionMaterial({
      day: { anchorMinute: minuteOf(14), endMinute: minuteOf(20) },
      policy: policy(),
      lateCostsMoney: false,
    });
    expect(material).toBe(true);
  });

  it('a full-either-way day becomes material when lateness actually costs money', () => {
    const material = isStartDecisionMaterial({
      day: { anchorMinute: minuteOf(14), endMinute: minuteOf(2) },
      policy: policy(),
      lateCostsMoney: true,
    });
    expect(material).toBe(true);
  });

  it('a day already on the last allowed start is never material — there is nowhere to move', () => {
    const material = isStartDecisionMaterial({
      day: { anchorMinute: minuteOf(15), endMinute: minuteOf(2) },
      policy: policy(),
      lateCostsMoney: true,
    });
    expect(material).toBe(false);
  });
});

describe('T-158 invariant 11 — a voided day contributes nothing and its punches survive', () => {
  it('void records the decision and leaves the evidence alone', async () => {
    const f = await cleanDay('void');
    const before = await sql`select id from attendance_punches where employment_id = ${f.employment.id}`;
    const { adjustment } = await adjust(f, { kind: 'void', reason: 'Duplicate of the day before' });
    expect(adjustment.kind).toBe('void');
    const after = await sql`select id from attendance_punches where employment_id = ${f.employment.id}`;
    expect(after).toHaveLength(before.length);
  });
});
