import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-360 (DEF-488) — web legs W1-W5. `docs/tasks/360-def-488-attendance-shiftday-parse.md` §Legs, "Web".
 *
 * ⛔ TESTER, not BUILDER. Harness copied from `t352-attendance-auth-before-parse.test.ts`:
 * `RedirectSignal` (:26-35), `ACTOR_HOLDER`/`requireSession` mock (:39-46), `dayFixture` (:272-303)
 * and `dayFormData` (:309-316). ⛔ NOT copied: the `@/lib/constraint-messages` vi.mock-forward
 * (t352 :50-52) — that existed only because the root `vitest.config.mts` had no `@` alias; T-348
 * added one, so `@/lib/constraint-messages` now resolves directly and the forward would be dead
 * weight (orchestrator, 2026-09-29).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

// Copied shape, t352-attendance-auth-before-parse.test.ts:39-46 — ONE holder object backs
// `requireSession` (attendance/[dayId]/actions.ts's only session dependency).
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null; sessionId: string } = {
  actor: null,
  sessionId: '',
};
vi.mock('../../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: ACTOR_HOLDER.sessionId })),
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createEmployment, seedAttendanceConfig, seedCanonicalPositions, toShiftDay } from '@shareat/domain';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const errorOf = (to: string) => paramsOf(to).get('error');
const okOf = (to: string) => paramsOf(to).get('ok');

// =================================================================================================
// Fixture — dayFixture, t352-attendance-auth-before-parse.test.ts:272-303, verbatim shape.
// =================================================================================================
async function dayFixture(hint: string) {
  const code = uid(`t360w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeId}, 'manual')`;
  const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const admin_ = actor(orgId, adminId);
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin_, { storeId, personId: worker!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
  );
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));

  const [adminCred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${adminId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [adminSession] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${adminId}, ${adminCred!.id}, 'pin', ${storeId}, now() + interval '12 hours') returning id`;

  // The non-holder — CAPABILITY-MATRIX.md:143, `manage_attendance` is ✗ for staff.
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Floor Staff') returning id`;
  const staffId = staff!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staffId}, ${storeId}, 'manual')`;
  const [staffCred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${staffId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [staffSession] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${staffId}, ${staffCred!.id}, 'pin', ${storeId}, now() + interval '12 hours') returning id`;

  return {
    orgId,
    storeId,
    admin: admin_,
    adminSessionId: adminSession!.id,
    employment,
    staff: actor(orgId, staffId),
    staffSessionId: staffSession!.id,
  };
}
type DayFixture = Awaited<ReturnType<typeof dayFixture>>;

const DAY = toShiftDay(new Date());

/** Verbatim shape, t352-attendance-auth-before-parse.test.ts:309-316. */
function dayFormData(f: DayFixture, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('dayId', f.employment.id); // dayId is only echoed into the redirect path; any string does
  fd.set('employmentId', f.employment.id);
  fd.set('shiftDay', DAY);
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

/** "Nothing written": total rows for the employment across every shift day (Amendment, see the
 * domain-direct file's own note) — a malformed `shiftDay` cannot be filtered by day. */
async function totalAdjustmentCountFor(employmentId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments where employment_id = ${employmentId}`;
  return Number(row!.count);
}

async function liveAdjustmentCountForDay(employmentId: string, shiftDay: string, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${employmentId} and shift_day = ${shiftDay} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

const D1_SENTENCE = (v: string) => `The shift day — "${v}" is not a date. Reopen the day from the attendance list and try again.`;
const D2_SENTENCE = 'The shift day is missing. Reopen the day from the attendance list and try again.';

describe('W1 — approveOvertimeAction, admin, shiftDay="not-a-date"', () => {
  it(`redirect error is D1's sentence; nothing written — was red today: the generic database fallback (record the exact text)`, async () => {
    const f = await dayFixture('w1');
    const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
    ACTOR_HOLDER.actor = f.admin;
    ACTOR_HOLDER.sessionId = f.adminSessionId;
    const before = await totalAdjustmentCountFor(f.employment.id);

    const to = await expectRedirectTo(() =>
      approveOvertimeAction(dayFormData(f, { shiftDay: 'not-a-date', approvedOtMinutes: '30' })),
    );
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(D1_SENTENCE('not-a-date'));
    expect(await totalAdjustmentCountFor(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('W2 — verifyDayAction, admin, shiftDay=""', () => {
  it(`redirect error is D2's sentence; nothing written — record it`, async () => {
    const f = await dayFixture('w2');
    const { verifyDayAction } = await import('../../src/app/attendance/[dayId]/actions');
    ACTOR_HOLDER.actor = f.admin;
    ACTOR_HOLDER.sessionId = f.adminSessionId;
    const before = await totalAdjustmentCountFor(f.employment.id);

    const to = await expectRedirectTo(() => verifyDayAction(dayFormData(f, { shiftDay: '' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(D2_SENTENCE);
    expect(await totalAdjustmentCountFor(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('W3 (green, guard; the ordering leg) — approveOvertimeAction, staff non-holder, shiftDay="not-a-date"', () => {
  it('error === the same staff\'s error for a valid shiftDay; ⛔ no "shift day"; nothing written', async () => {
    const f = await dayFixture('w3');
    const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
    ACTOR_HOLDER.actor = f.staff;
    ACTOR_HOLDER.sessionId = f.staffSessionId;
    const before = await totalAdjustmentCountFor(f.employment.id);

    const toValid = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '30' })));
    const baseline = errorOf(toValid); // one jar slot: read each redirect as it happens (T-380)
    const toMalformed = await expectRedirectTo(() =>
      approveOvertimeAction(dayFormData(f, { shiftDay: 'not-a-date', approvedOtMinutes: '30' })),
    );
    const malformed = errorOf(toMalformed);
    expect(baseline, `no error at all on the baseline submission — redirect URL was: ${toValid}`).not.toBeNull();
    expect(malformed, `redirect URL was: ${toMalformed}`).toBe(baseline);
    expect(malformed ?? '', 'the field sentence must never leak past the auth gate').not.toContain('shift day');
    expect(await totalAdjustmentCountFor(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('W4 (green, guard; the ordering leg) — setStartAnchorAction, staff, shiftDay="2026-02-30"', () => {
  it('as W3: error === the same staff\'s error for a valid shiftDay; nothing written', async () => {
    const f = await dayFixture('w4');
    const { setStartAnchorAction } = await import('../../src/app/attendance/[dayId]/actions');
    ACTOR_HOLDER.actor = f.staff;
    ACTOR_HOLDER.sessionId = f.staffSessionId;
    const before = await totalAdjustmentCountFor(f.employment.id);

    const toValid = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f, { chosenAnchorMinute: '60' })));
    const baseline = errorOf(toValid); // one jar slot: read each redirect as it happens (T-380)
    const toMalformed = await expectRedirectTo(() =>
      setStartAnchorAction(dayFormData(f, { shiftDay: '2026-02-30', chosenAnchorMinute: '60' })),
    );
    const malformed = errorOf(toMalformed);
    expect(baseline, `no error at all on the baseline submission — redirect URL was: ${toValid}`).not.toBeNull();
    expect(malformed, `redirect URL was: ${toMalformed}`).toBe(baseline);
    expect(malformed ?? '', 'the field sentence must never leak past the auth gate').not.toContain('shift day');
    expect(await totalAdjustmentCountFor(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('W5 (green, guard) — approveOvertimeAction, admin, the valid DAY, minutes 30', () => {
  it('the ok redirect; one live row', async () => {
    const f = await dayFixture('w5');
    const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
    ACTOR_HOLDER.actor = f.admin;
    ACTOR_HOLDER.sessionId = f.adminSessionId;

    const to = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '30' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(okOf(to), `redirect URL was: ${to}`).not.toBeNull();
    expect(await liveAdjustmentCountForDay(f.employment.id, DAY, 'overtime_approved')).toBe(1);
  });
});
