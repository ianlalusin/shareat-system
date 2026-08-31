import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-195 — the attendance day review screen. **DEF-113.**
 *
 * ⛔ Before this task `recordAdjustment` had **no caller outside tests**. The six adjustment kinds
 * T-158 shipped were unreachable from the running app, so overtime could never be approved, a
 * `needs_review` day could never be resolved — and `payableDays` excludes those, so *nothing would
 * ever pay them* — and `/payroll` pointed managers at a screen that did not exist.
 *
 * ⚠️ **These tests seed PUNCHES, never `attendance_days` directly.** `recordAdjustment`
 * re-adjudicates in the same transaction and re-adjudication derives the day from punches, so a
 * fixture that inserts days would have them recomputed to zero underneath it. The payroll tests do
 * the opposite for an equally good reason: there, a day is an INPUT.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, attendanceConfigRepo, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  adjudicateDay,
  attendanceDayDetail,
  attendanceReviewQueue,
  attendanceRoster,
  createEmployment,
  recordAdjustment,
  recordPunch,
  seedAttendanceConfig,
  parseShiftDay,
  seedCanonicalPositions,
  shiftDayRange,
  supersedeConfig,
  toShiftDay,
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
  const code = uid(`rv-${hint}`);
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
  return {
    orgId, storeId: store!.id, admin: a, adminPersonId: admin!.id,
    workerId: worker!.id, employment, sessionId,
  };
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

async function dayFrom(f: Fixture, inAt: Date, outAt: Date | null) {
  await addPunch(f, inAt, 'in');
  if (outAt) await addPunch(f, outAt, 'out');
  return asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId: f.employment.id, shiftDay: DAY }));
}

const RANGE = { from: DAY, to: DAY };
const queue = (f: Fixture) =>
  asOrg(f.orgId, (tx) => attendanceReviewQueue(tx, f.admin, { storeId: f.storeId, ...RANGE }));
const roster = (f: Fixture) =>
  asOrg(f.orgId, (tx) => attendanceRoster(tx, f.admin, { storeId: f.storeId, ...RANGE }));

// =====================================================================================

describe('T-195 — the queue says WHY each day is waiting', () => {
  it('⭐ a HELD zero-credit day is queued, and named as held', async () => {
    // A 3-hour stint: below the 5h half-day bar, so no day is credited and the whole of it is
    // raised as pending overtime. T-194 holds this day out of the pay run entirely.
    const f = await fixture('held');
    const day = await dayFrom(f, at(14), at(17));
    expect(day.computedMinutes).toBe(0);
    expect(day.pendingOtMinutes).toBeGreaterThan(0);

    const q = await queue(f);
    expect(q).toHaveLength(1);
    expect(q[0]!.reasons).toContain('held_zero_credit');
    expect(q[0]!.personName).toBe('Maria Santos');
  });

  it('⭐ a day with unapproved overtime is queued as such', async () => {
    // A full shift that ran long — a day IS credited, so this is not "held", just unpaid overtime.
    const f = await fixture('unapprovedot');
    const day = await dayFrom(f, at(14), at(1));
    expect(day.computedMinutes).toBeGreaterThan(0);
    expect(day.pendingOtMinutes).toBeGreaterThan(0);

    const q = await queue(f);
    expect(q[0]!.reasons).toContain('unapproved_overtime');
    expect(q[0]!.reasons).not.toContain('held_zero_credit');
  });

  it('⛔ an OPEN day — clocked in, never out — is queued', async () => {
    const f = await fixture('open');
    const day = await dayFrom(f, at(14), null);
    expect(day.status).toBe('open');
    expect((await queue(f))[0]!.reasons).toContain('open');
  });

  it('⭐ a settled day drops OUT of the queue but stays in the roster', async () => {
    const f = await fixture('settled');
    await dayFrom(f, at(14), at(23));
    // A clean 9-hour shift: a full day, no overtime, nothing outstanding.
    expect(await queue(f)).toHaveLength(0);
    expect(await roster(f)).toHaveLength(1);
  });

  it('⭐ deciding the overtime clears the day from the queue', async () => {
    const f = await fixture('cleared');
    const day = await dayFrom(f, at(14), at(1));
    expect(await queue(f)).toHaveLength(1);

    await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: DAY,
        kind: 'overtime_approved',
        approvedOtMinutes: day.pendingOtMinutes,
        sessionId: f.sessionId,
      }),
    );
    expect(await queue(f)).toHaveLength(0);
  });

  it('⭐ approving ZERO also clears it — a decision, not an absence', async () => {
    const f = await fixture('zerodecision');
    await dayFrom(f, at(14), at(1));
    await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: DAY,
        kind: 'overtime_approved',
        approvedOtMinutes: 0,
        sessionId: f.sessionId,
      }),
    );
    expect(await queue(f)).toHaveLength(0);
  });
});

describe('T-195 — the decision surface', () => {
  it('⭐ returns the RAW punches, so the screen can render them read-only', async () => {
    const f = await fixture('evidence');
    const day = await dayFrom(f, at(14), at(23));
    const detail = await asOrg(f.orgId, (tx) => attendanceDayDetail(tx, f.admin, day.id));
    expect(detail!.punches).toHaveLength(2);
    expect(detail!.punches.map((p) => p.assertedIntent).sort()).toEqual(['in', 'out']);
    // ⭐ The engine narrates its own reasoning; that narration IS most of the screen.
    expect(detail!.day.explain.length).toBeGreaterThan(0);
  });

  it('⭐ reports the LIVE decisions, so a manager cannot make a second one blind', async () => {
    const f = await fixture('live');
    const day = await dayFrom(f, at(14), at(1));
    let detail = await asOrg(f.orgId, (tx) => attendanceDayDetail(tx, f.admin, day.id));
    expect(detail!.day.approvedOtMinutes).toBeNull();
    expect(detail!.day.hasHalfDayOverride).toBe(false);

    await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id, shiftDay: DAY, kind: 'overtime_approved',
        approvedOtMinutes: 30, sessionId: f.sessionId,
      }),
    );
    detail = await asOrg(f.orgId, (tx) => attendanceDayDetail(tx, f.admin, day.id));
    expect(detail!.day.approvedOtMinutes).toBe(30);
  });

  it('⛔ a FROZEN day is reported locked, with a reason rather than an exception', async () => {
    const f = await fixture('frozen');
    const day = await dayFrom(f, at(14), at(23));
    const [acct] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'cash' and custodian = 'office' and is_foundation`;
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, money_account_id, status,
                            created_by, posted_at, posted_by)
      values (${f.orgId}, ${f.storeId}, ${DAY}, ${DAY}, ${acct!.id}, 'posted',
              ${f.adminPersonId}, now(), ${f.adminPersonId})
      returning id`;
    await sql`update attendance_days set frozen_at = now(), frozen_by_pay_run_id = ${run!.id}
              where id = ${day.id}`;

    const detail = await asOrg(f.orgId, (tx) => attendanceDayDetail(tx, f.admin, day.id));
    expect(detail!.frozen).toBe(true);
    expect(detail!.lockedReason).toMatch(/frozen/i);
    // ⛔ And a frozen day is never in the queue — there is nothing left to decide.
    expect(await queue(f)).toHaveLength(0);
  });

  it('⛔ nobody adjudicates their own day — the screen is told, and the service refuses', async () => {
    const f = await fixture('ownday');
    const day = await dayFrom(f, at(14), at(23));
    // The worker, looking at their own day. `manage_attendance` is granted so the block under test
    // is the self-adjudication rule, not a missing capability.
    await sql`insert into person_roles (person_id, org_id, role) values (${f.workerId}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.workerId}, ${f.storeId})`;
    const theirs = actor(f.orgId, f.workerId);

    const detail = await asOrg(f.orgId, (tx) => attendanceDayDetail(tx, theirs, day.id));
    expect(detail!.lockedReason).toMatch(/your own/i);

    const theirSession = await makeSession(f.orgId, f.workerId, f.storeId);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, theirs, {
          employmentId: f.employment.id, shiftDay: DAY, kind: 'verify', sessionId: theirSession,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('⛔ DEF-113 closed — the decisions finally reach payroll', () => {
  it('⭐⭐ verifying a needs_review day is the ONLY thing that can ever make it payable', async () => {
    // A day with no clock-out and a late-arriving correction is `needs_review`, and
    // `resolveStatus` refuses to promote it on recompute — by design. Nothing but a manager's
    // decision can move it, and until T-195 no manager could make one.
    const f = await fixture('verify');
    const day = await dayFrom(f, at(14), null);
    expect(day.status).toBe('open');

    await addPunch(f, at(23), 'out');
    const recomputed = await asOrg(f.orgId, (tx) =>
      adjudicateDay(tx, { employmentId: f.employment.id, shiftDay: DAY }),
    );
    expect(recomputed.status).toBe('computed');

    const { day: verified } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id, shiftDay: DAY, kind: 'verify', sessionId: f.sessionId,
      }),
    );
    expect(verified.status).toBe('verified');
    expect(await queue(f)).toHaveLength(0);
  });

  it('⭐⭐⭐ approved overtime flows through to what payroll would pay', async () => {
    const f = await fixture('topayroll');
    const day = await dayFrom(f, at(14), at(1));
    const worked = day.pendingOtMinutes;
    expect(worked).toBeGreaterThan(0);

    await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id, shiftDay: DAY, kind: 'overtime_approved',
        approvedOtMinutes: worked, sessionId: f.sessionId,
      }),
    );

    // The same join payroll reads. Before DEF-113 was fixed this could never be non-null,
    // because nothing in the app could write the row.
    const [row] = await sql<{ approved: number | null }[]>`
      select adj.approved_ot_minutes as approved
      from attendance_days d
      left join attendance_adjustments adj
        on adj.employment_id = d.employment_id and adj.shift_day = d.shift_day
       and adj.kind = 'overtime_approved' and adj.superseded_by_adjustment_id is null
      where d.id = ${day.id}`;
    expect(row!.approved).toBe(worked);
  });
});

// =====================================================================================

/**
 * ⭐ **T-197 / DEF-112 — the short-shift rule, now ON by default.**
 *
 * The raw v1 capture shows all three operating stores carrying `shortShiftHalfDayOt: true` against
 * a v1 default of `false`, so each turned it on deliberately. v2 shipped `false`, which reversed
 * live practice rather than preserving it — 51.5 days a month on the 560-session corpus.
 *
 * ⛔ This could not have shipped before T-195: turning it on converts those days into PENDING
 * overtime, and until the review screen existed nobody could approve any of it.
 */
describe('⭐ T-197 — a short shift is a half day, and its remainder waits for a decision', () => {
  it('a newly seeded store gets the rule ON', async () => {
    const f = await fixture('t197default');
    const cfg = await asOrg(f.orgId, (tx) => attendanceConfigRepo.findLive(tx, f.storeId));
    expect(cfg!.shortShiftHalfDayOt).toBe(true);
  });

  it('⭐ 7 hours against a 9-hour shift is a HALF DAY plus 2h of pending overtime', async () => {
    // Ian's model, in his own words: "5hr is set halfday, 9hr for wholeday, a 7 hour duty is
    // halfday plus provisional 2 hour OT to be approved by manager."
    const f = await fixture('t197short');
    const day = await dayFrom(f, at(14), at(21));
    expect(day.isHalfDay).toBe(true);
    expect(day.computedMinutes).toBe(300); // the 5h half-day block, not the 7h worked
    expect(day.pendingOtMinutes).toBe(120); // the remaining 2h, waiting on a manager
  });

  it('⛔ and that overtime is queued, not silently paid', async () => {
    const f = await fixture('t197queued');
    await dayFrom(f, at(14), at(21));
    const q = await queue(f);
    expect(q).toHaveLength(1);
    expect(q[0]!.reasons).toContain('unapproved_overtime');
    expect(q[0]!.approvedOtMinutes).toBeNull(); // nobody decided — pays NOTHING (DEF-109)
  });

  it('⭐⭐ approving it through the review path settles the day', async () => {
    const f = await fixture('t197approve');
    await dayFrom(f, at(14), at(21));
    await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id, shiftDay: DAY,
        kind: 'overtime_approved', approvedOtMinutes: 120, sessionId: f.sessionId,
      }),
    );
    expect(await queue(f)).toHaveLength(0);
  });

  it('⚠️ a store that supersedes its config to OFF still gets the old behaviour', async () => {
    // ⭐ The default decides only the UNCHOSEN case. An explicit choice still wins, and it is
    // effective-dated rather than an in-place edit — T-155's immutability, which refused this
    // task's first-draft migration by name.
    const f = await fixture('t197override');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        // ⚠️ Strictly AFTER the seed's own 2026-01-01, and before DAY, so it is the policy that
        // governs the test's shift day. `supersedeConfig` refuses an equal date by name: "two
        // policies claiming the same day cannot both be the answer."
        effectiveFrom: parseShiftDay('2026-02-01'),
        changes: { shortShiftHalfDayOt: false },
      }),
    );
    const day = await dayFrom(f, at(14), at(21));
    expect(day.isHalfDay).toBe(false);
    expect(day.computedMinutes).toBe(420); // the full 7h, as before
  });
});
