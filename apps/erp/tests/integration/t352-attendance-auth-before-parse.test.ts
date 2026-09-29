import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-352 (DEF-478) — auth-before-parse legs W1-W11 and the order guard G1.
 * `docs/tasks/352-def-478-attendance-parse-after-authorize.md` §Legs.
 *
 * ⛔ TESTER, not BUILDER. Before T-352, `settings/attendance/actions.ts` and
 * `attendance/[dayId]/actions.ts` parsed every field BEFORE `supersedeConfig`/`recordAdjustment`'s
 * own `authorize()`, so a non-holder submitting a malformed field saw the FIELD sentence instead of
 * the authorization refusal (DEF-478). Every W-leg below compares the same non-holder's redirect
 * `error` for a fully-valid form against the same-shaped malformed one — never a hard-coded
 * authorization sentence (T-351 W1 precedent, `t351-review-followups.test.ts:212-236`) — and checks
 * the malformed field's own sentence never leaks into it.
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

// Copied shape, t343-s5-5t-followups.test.ts:36-56 — ONE holder object backs both
// `requireActor` (settings/attendance) and `requireSession` (attendance/[dayId]).
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null; sessionId: string } = {
  actor: null,
  sessionId: '',
};
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: ACTOR_HOLDER.sessionId })),
}));

// The bare `@/...` specifier the root vitest.config.mts never resolves — forwarded to the real
// module, per s5-5p/s5-5q/s5-5t precedent.
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createEmployment, getLiveConfig, seedAttendanceConfig, seedCanonicalPositions, toShiftDay } from '@shareat/domain';

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
const errorOf = (to: string) => new URL(to, 'http://localhost').searchParams.get('error');

// =================================================================================================
// W1-W8, G1 — settings/attendance/actions.ts: updateAttendanceConfigAction.
// Fixture/attendanceFormData shape: t343-s5-5q-followups.test.ts:97-143.
// =================================================================================================

async function configFixture(hint: string) {
  const code = uid(`t352w-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  // The non-holder. CAPABILITY-MATRIX.md:152 — `manage_store_settings` is ✗ for staff.
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Floor Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${storeId}, 'manual')`;

  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));

  return { orgId, storeId, admin: actor(orgId, admin!.id), staff: actor(orgId, staff!.id) };
}
type ConfigFixture = Awaited<ReturnType<typeof configFixture>>;

async function configRowCount(storeId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from store_attendance_config where store_id = ${storeId}`;
  return Number(row!.count);
}

/** Verbatim shape, t343-s5-5q-followups.test.ts:109-143 — the seeded row's own defaults. */
function attendanceFormData(f: { storeId: string }, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('effectiveFrom', '2026-06-01');
  fd.set('requiredHoursPerShift', '9');
  fd.set('halfDayHours', '5');
  fd.set('allowedShiftStartHours', '9,10,11,14,15,16,17,18');
  fd.set('anchorWindowMinutes', '30');
  fd.set('timeMode', 'open');
  fd.set('defaultWorkHours', '8');
  fd.set('defaultBreakHours', '1');
  fd.set('nightDiffStartHour', '22');
  fd.set('nightDiffEndHour', '6');
  fd.set('nightDiffMultiplier', '1.10');
  fd.set('overtimeMode', 'multiplier');
  fd.set('overtimeMultiplier', '1.25');
  fd.set('holidayRegularMultiplier', '2.00');
  fd.set('holidaySpecialNonWorkingMultiplier', '1.30');
  fd.set('holidaySpecialWorkingMultiplier', '1.50');
  fd.set('latePolicy', 'record_only');
  fd.set('lateChargePerMinute', '0');
  fd.set('lateInfractionPoints', '1');
  fd.set('lateGraceMinutes', '0');
  fd.set('earlyOutGraceMinutes', '0');
  fd.set('undertimeGraceMinutes', '0');
  fd.set('payrollPeriodType', 'semi_monthly');
  fd.set('semiMonthlyCutoffDay', '15');
  fd.set('payoutMode', 'lag');
  fd.set('payoutLagDays', '0');
  fd.set('payoutDays', '');
  fd.set('autoClockOutHour', '');
  fd.set('maxShiftHours', '16');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

/** The W-leg shape: the SAME non-holder gets the SAME `error` for a fully-valid form and for the
 * malformed one — never a hard-coded authorization sentence (§Legs). */
async function assertSameAuthRefusal(
  f: ConfigFixture,
  baselineOverrides: Record<string, string>,
  malformedOverrides: Record<string, string>,
  forbiddenSubstring: string | null,
): Promise<void> {
  const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
  ACTOR_HOLDER.actor = f.staff;
  const before = await configRowCount(f.storeId);

  const toValid = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, baselineOverrides)));
  const toMalformed = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, malformedOverrides)));

  const baseline = errorOf(toValid);
  const malformed = errorOf(toMalformed);
  // Audit F7 — without this, a baseline/malformed pair that are BOTH null (e.g. the auth gate
  // silently stopped firing and both submissions "succeeded") would still satisfy `malformed ===
  // baseline` and pass green.
  expect(baseline, `no error at all on the baseline submission — redirect URL was: ${toValid}`).not.toBeNull();
  expect(malformed, `redirect URL was: ${toMalformed}`).toBe(baseline);
  if (forbiddenSubstring) {
    expect(malformed, 'the field sentence must never leak past the auth gate').not.toContain(forbiddenSubstring);
  }
  // Audit F4 — row count alone would pass if a supersede got far enough to retire the old row
  // before failing; the spec's own "nothing written" also names the live row's own effectiveFrom
  // (matches the domain file's assertConfigUnchanged).
  expect(await configRowCount(f.storeId), 'nothing written').toBe(before);
  const live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
  expect(live.effectiveFrom, 'still the seeded row').toBe('2026-01-01');
}

describe('W1 — config · dec2, requiredHoursPerShift="1,5"', () => {
  it('non-holder: equals the baseline auth refusal; ⛔ no "required hours" — target (holder) today: The required hours / shift — "1,5" is not a valid number. Use at most two decimal places.', async () => {
    const f = await configFixture('w1');
    await assertSameAuthRefusal(f, {}, { requiredHoursPerShift: '1,5' }, 'required hours');
  });
});

describe('W2 — config · whole number, malformed, lateGraceMinutes="abc"', () => {
  it('non-holder: equals the baseline; ⛔ no "late grace" — target (holder) today: The late grace minutes — "abc" is not a number.', async () => {
    const f = await configFixture('w2');
    await assertSameAuthRefusal(f, {}, { lateGraceMinutes: 'abc' }, 'late grace');
  });
});

describe('W3 — config · whole number, out of range, anchorWindowMinutes="70"', () => {
  it('non-holder: equals the baseline; ⛔ no "anchor window" — target (holder) today: The anchor window — "70" is not a whole number from 0 to 60.', async () => {
    const f = await configFixture('w3');
    await assertSameAuthRefusal(f, {}, { anchorWindowMinutes: '70' }, 'anchor window');
  });
});

describe('W4 — config · whole number, blank (row 235), lateGraceMinutes=""', () => {
  it('non-holder: equals the baseline — target (holder) today: The late grace minutes — enter a whole number, 0 or more.', async () => {
    const f = await configFixture('w4');
    await assertSameAuthRefusal(f, {}, { lateGraceMinutes: '' }, null);
  });
});

describe('W5 — config · whole-or-null, autoClockOutHour="abc"', () => {
  it('non-holder: equals the baseline; ⛔ no "auto clock-out" — target (holder) today: The auto clock-out hour — "abc" is not a number.', async () => {
    const f = await configFixture('w5');
    await assertSameAuthRefusal(f, {}, { autoClockOutHour: 'abc' }, 'auto clock-out');
  });
});

describe('W6 — config · money, fixed OT, overtimeMode="fixed" + overtimeFixedHourly="1,5"', () => {
  it('non-holder: equals the SAME-SHAPE baseline (fixed mode, a valid amount); ⛔ no "overtime fixed hourly" — target (holder) today: The overtime fixed hourly — "1,5" is not a valid amount. Use at most two decimal places.', async () => {
    const f = await configFixture('w6');
    await assertSameAuthRefusal(
      f,
      { overtimeMode: 'fixed', overtimeFixedHourly: '50.00' },
      { overtimeMode: 'fixed', overtimeFixedHourly: '1,5' },
      'overtime fixed hourly',
    );
  });
});

describe('W7 — config · money, late charge, lateChargePerMinute="1,5"', () => {
  it('non-holder: equals the baseline; ⛔ no "late charge" — target (holder) today: the late-charge "not a valid amount" sentence', async () => {
    const f = await configFixture('w7');
    await assertSameAuthRefusal(f, {}, { lateChargePerMinute: '1,5' }, 'late charge');
  });
});

describe('W8 — config · effective date, effectiveFrom="not-a-date"', () => {
  it('non-holder: equals the baseline — target (holder) today: whatever errorMessage renders for parseBusinessDate\'s raw throw (measured: \'Invalid business date: "not-a-date" (expected YYYY-MM-DD)\')', async () => {
    const f = await configFixture('w8');
    await assertSameAuthRefusal(f, {}, { effectiveFrom: 'not-a-date' }, null);
  });
});

describe('G1 (guard, R2 parse order) — ADMIN, requiredHoursPerShift="1,5" AND lateGraceMinutes="abc"', () => {
  it('the required-hours sentence wins — it is first in parseConfigChanges\'s ordered table, same order the action built `changes` in today', async () => {
    const f = await configFixture('g1');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
    const to = await expectRedirectTo(() =>
      updateAttendanceConfigAction(attendanceFormData(f, { requiredHoursPerShift: '1,5', lateGraceMinutes: 'abc' })),
    );
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(
      'The required hours / shift — "1,5" is not a valid number. Use at most two decimal places.',
    );
  });
});

// =================================================================================================
// W9-W11 — attendance/[dayId]/actions.ts: approveOvertimeAction, setStartAnchorAction,
// approveEarlyOutAction. Fixture/dayFormData/adjustmentCountFor shape:
// t343-s5-5t-followups.test.ts:107-151.
// =================================================================================================

async function dayFixture(hint: string) {
  const code = uid(`t352d-${hint}`);
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

  // The non-holder. CAPABILITY-MATRIX.md:143 — `manage_attendance` is ✗ for staff.
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

  return { orgId, storeId, admin: admin_, employment, staff: actor(orgId, staffId), staffSessionId: staffSession!.id };
}
type DayFixture = Awaited<ReturnType<typeof dayFixture>>;

const DAY = toShiftDay(new Date());

/** Verbatim shape, t343-s5-5t-followups.test.ts:136-143. */
function dayFormData(f: DayFixture, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('dayId', f.employment.id); // dayId is only echoed into the redirect path; any string does
  fd.set('employmentId', f.employment.id);
  fd.set('shiftDay', DAY);
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

/** Verbatim shape, t343-s5-5t-followups.test.ts:145-151. */
async function adjustmentCountFor(f: DayFixture, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${f.employment.id} and shift_day = ${DAY} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

async function assertSameAuthRefusalForDay(
  f: DayFixture,
  actionName: 'approveOvertimeAction' | 'setStartAnchorAction' | 'approveEarlyOutAction',
  kind: string,
  field: string,
  baselineValue: string,
  malformedValue: string,
  forbiddenSubstring: string | null,
): Promise<void> {
  const actions = await import('../../src/app/attendance/[dayId]/actions');
  const action = (actions as Record<string, (fd: FormData) => Promise<void>>)[actionName]!;
  ACTOR_HOLDER.actor = f.staff;
  ACTOR_HOLDER.sessionId = f.staffSessionId;
  const before = await adjustmentCountFor(f, kind);

  const toValid = await expectRedirectTo(() => action(dayFormData(f, { [field]: baselineValue })));
  const toMalformed = await expectRedirectTo(() => action(dayFormData(f, { [field]: malformedValue })));

  const baseline = errorOf(toValid);
  const malformed = errorOf(toMalformed);
  // Same F7 risk as the config-side helper: a baseline/malformed pair that are BOTH null would
  // still satisfy equality and pass green.
  expect(baseline, `no error at all on the baseline submission — redirect URL was: ${toValid}`).not.toBeNull();
  expect(malformed, `redirect URL was: ${toMalformed}`).toBe(baseline);
  if (forbiddenSubstring) {
    expect(malformed, 'the field sentence must never leak past the auth gate').not.toContain(forbiddenSubstring);
  }
  expect(await adjustmentCountFor(f, kind), 'nothing written').toBe(before);
}

describe('W9 — adjustment · minutes, malformed, approveOvertimeAction, approvedOtMinutes="abc"', () => {
  it('non-holder: equals the baseline for "30"; ⛔ no "minutes to pay" — target (holder) today: The minutes to pay — "abc" is not a whole number of minutes from 0 to 99999.', async () => {
    const f = await dayFixture('w9');
    await assertSameAuthRefusalForDay(f, 'approveOvertimeAction', 'overtime_approved', 'approvedOtMinutes', '30', 'abc', 'minutes to pay');
  });
});

describe('W10 — adjustment · minutes, blank (DEF-471), setStartAnchorAction, chosenAnchorMinute=""', () => {
  it('non-holder: equals the baseline for "60"; ⛔ no "paid-from" — target (holder) today: The paid-from minute — enter a whole number of minutes (0 to 99999).', async () => {
    const f = await dayFixture('w10');
    await assertSameAuthRefusalForDay(f, 'setStartAnchorAction', 'start_anchor', 'chosenAnchorMinute', '60', '', 'paid-from');
  });
});

describe('W11 — adjustment · minutes, third box, approveEarlyOutAction, effectiveOutMinute="8:30"', () => {
  it('non-holder: equals the baseline for a valid minute; ⛔ no "paid-until" — target (holder) today: The paid-until minute — "8:30" is not a whole number of minutes from 0 to 99999.', async () => {
    const f = await dayFixture('w11');
    await assertSameAuthRefusalForDay(f, 'approveEarlyOutAction', 'early_out_approved', 'effectiveOutMinute', '90', '8:30', 'paid-until');
  });
});
