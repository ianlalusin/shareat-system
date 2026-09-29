import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-352 (DEF-478) — domain-direct legs D1-D8.
 * `docs/tasks/352-def-478-attendance-parse-after-authorize.md` §Legs, "Domain-direct legs".
 *
 * ⛔ TESTER, not BUILDER. `supersedeConfig`/`recordAdjustment` now parse their raw-string fields
 * AFTER `authorize()` (T-352), so a typed caller that bypasses the ERP screen entirely gets the
 * same sentences a screen submission would. Every "was red today" note records the PRE-FIX result;
 * these calls do not compile against pre-T352 signatures (M3: typecheck may be red in this file
 * only, between RED and the builder's READY).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createEmployment,
  getLiveConfig,
  recordAdjustment,
  recordPunch,
  seedAttendanceConfig,
  seedCanonicalPositions,
  supersedeConfig,
  toShiftDay,
} from '@shareat/domain';

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

// =================================================================================================
// D1-D6 — supersedeConfig. Fixture shape from packages/domain/tests/integration/attendance-config.test.ts.
// =================================================================================================

async function configFixture(hint: string) {
  const code = uid(`t352d-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));

  return { orgId, storeId, admin: actor(orgId, admin!.id) };
}
type ConfigFixture = Awaited<ReturnType<typeof configFixture>>;

async function configRowCount(storeId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from store_attendance_config where store_id = ${storeId}`;
  return Number(row!.count);
}

/** "Nothing written" for a config leg (§Legs): row count unchanged AND the live row is still the
 * seeded '2026-01-01' one — a supersede that got far enough to retire the old row before failing
 * would pass the count check (still 1 or 2, depending where it failed) but fail this one. */
async function assertConfigUnchanged(f: ConfigFixture, before: number): Promise<void> {
  expect(await configRowCount(f.storeId), 'row count unchanged').toBe(before);
  const live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
  expect(live.effectiveFrom, 'still the seeded row').toBe('2026-01-01');
}

describe('D1 — supersedeConfig, changes.lateGraceMinutes="abc"', () => {
  it('rejects with userMessage \'The late grace minutes — "abc" is not a number.\'; nothing written — was red today: a raw Postgres 22P02, no userMessage', async () => {
    const f = await configFixture('d1');
    const before = await configRowCount(f.storeId);
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: '2026-06-01',
          changes: { lateGraceMinutes: 'abc' },
        }),
      ),
    ).rejects.toMatchObject({ userMessage: 'The late grace minutes — "abc" is not a number.' });
    await assertConfigUnchanged(f, before);
  });
});

describe('D2 — supersedeConfig, changes.halfDayHours="100"', () => {
  it('rejects with userMessage \'The half-day hours has to be at most 99.99.\'; nothing written — was red today: a raw 22003 numeric overflow', async () => {
    const f = await configFixture('d2');
    const before = await configRowCount(f.storeId);
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: '2026-06-01',
          changes: { halfDayHours: '100' },
        }),
      ),
    ).rejects.toMatchObject({ userMessage: 'The half-day hours has to be at most 99.99.' });
    await assertConfigUnchanged(f, before);
  });
});

describe('D3 (row 235) — autoClockOutHour: spaces-only and a literal null both mean "never"', () => {
  it('both are REAL transitions from a real hour, not null-from-null (audit F3: the seeded row already has autoClockOutHour null, so passing null straight away would "pass" even if null were silently ignored) — was red today: the spaces-only call is a raw 22P02', async () => {
    const f = await configFixture('d3');

    const r0 = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: '2026-06-01',
        changes: { autoClockOutHour: '22' },
      }),
    );
    expect(r0.autoClockOutHour, 'setup: a real hour, so the next step is a genuine transition').toBe(22);

    const r1 = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: '2026-07-01',
        changes: { autoClockOutHour: '   ' },
      }),
    );
    expect(r1.autoClockOutHour, 'spaces-only means "never" — a real transition from 22').toBeNull();

    const r2 = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: '2026-08-01',
        changes: { autoClockOutHour: '22' },
      }),
    );
    expect(r2.autoClockOutHour, 'reset to a real hour before the next transition').toBe(22);

    const r3 = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: '2026-09-01',
        changes: { autoClockOutHour: null },
      }),
    );
    expect(r3.autoClockOutHour, 'an explicit null ALSO means "never" — a real transition from 22, not null-from-null').toBeNull();
  });
});

describe('D4 (⛔ guard — a VALUE, not a digit run) — lateGraceMinutes="000015" saves 15', () => {
  it('saves 15, not refused for the leading zeros', async () => {
    const f = await configFixture('d4');
    const r = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: '2026-06-01',
        changes: { lateGraceMinutes: '000015' },
      }),
    );
    expect(r.lateGraceMinutes).toBe(15);
  });
});

describe('D5 (⛔ guard — existing typed callers unaffected) — a plain number alongside a plain numeric string', () => {
  it('lateGraceMinutes as a real number, requiredHoursPerShift as its existing string shape: both save', async () => {
    const f = await configFixture('d5');
    const r = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: '2026-06-01',
        changes: { lateGraceMinutes: 15, requiredHoursPerShift: '10' },
      }),
    );
    expect(r.lateGraceMinutes).toBe(15);
    expect(Number(r.requiredHoursPerShift)).toBe(10);
  });
});

describe('D6 — lateChargePerMinute="" under latePolicy="charge_per_minute": blank becomes \'0\', then the CHECK refuses', () => {
  it('rejects naming store_attendance_config_charge_rate_check; nothing written — was red today: a raw 22P02 (empty string into numeric) — this domain-direct call does not go through errorMessage, so the raw Postgres text is what a caller sees', async () => {
    const f = await configFixture('d6');
    const before = await configRowCount(f.storeId);
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: '2026-06-01',
          changes: { latePolicy: 'charge_per_minute', lateChargePerMinute: '' },
        }),
      ),
    ).rejects.toThrow(/store_attendance_config_charge_rate_check/);
    await assertConfigUnchanged(f, before);
  });
});

// =================================================================================================
// D9 (audit F1) — table-driven: EVERY moved config field's out-of-range sentence, pinned.
//
// ⛔ Sentences below are derived from the SPEC's own documented pattern (T-352 §R4; the original
// `settings/attendance/actions.ts` wording this task moved verbatim, read directly by the tester —
// never from `config-input.ts`'s own `wholeNumberSentence`/`dec2`/`parseMoneyInput`. Importing or
// calling the code under test's own formula to build the "expected" value would make every leg here
// pin nothing — both sides would move together under a boundary mutation (audit finding: the
// auditor moved `semiMonthlyCutoffDay`'s max from 27 to 31 and 118 existing tests stayed green,
// because none of them independently named 27).
// =================================================================================================

const NO_MAX_CEILING = 99999;
const wholeNumberOutOfRange = (label: string, value: string, min: number, max: number): string =>
  `${label} — "${value}" is not a whole number from ${min} to ${max}.`;
const dec2BelowMin = (label: string, min: number): string => `${label} has to be at least ${min}.`;
const dec2AboveMax = (label: string, max = 99.99): string => `${label} has to be at most ${max}.`;
const moneyMalformed = (label: string, value: string): string =>
  `${label} — "${value}" is not a valid amount. Use at most two decimal places.`;

const FIELD_OUT_OF_RANGE_LEGS: ReadonlyArray<{ key: string; value: string; sentence: string }> = [
  { key: 'requiredHoursPerShift', value: '0.4', sentence: dec2BelowMin('The required hours / shift', 0.5) },
  { key: 'halfDayHours', value: '0.4', sentence: dec2BelowMin('The half-day hours', 0.5) },
  { key: 'anchorWindowMinutes', value: '61', sentence: wholeNumberOutOfRange('The anchor window', '61', 0, 60) },
  { key: 'defaultWorkHours', value: '100', sentence: dec2AboveMax('The default work hours') },
  { key: 'defaultBreakHours', value: '100', sentence: dec2AboveMax('The default break hours') },
  { key: 'nightDiffStartHour', value: '24', sentence: wholeNumberOutOfRange('The night diff start hour', '24', 0, 23) },
  { key: 'nightDiffEndHour', value: '24', sentence: wholeNumberOutOfRange('The night diff end hour', '24', 0, 23) },
  { key: 'nightDiffMultiplier', value: '0.5', sentence: dec2BelowMin('The night diff multiplier', 1) },
  { key: 'overtimeMultiplier', value: '0.5', sentence: dec2BelowMin('The overtime multiplier', 1) },
  { key: 'overtimeFixedHourly', value: '1,5', sentence: moneyMalformed('The overtime fixed hourly', '1,5') },
  { key: 'holidayRegularMultiplier', value: '0.5', sentence: dec2BelowMin('The regular holiday multiplier', 1) },
  {
    key: 'holidaySpecialNonWorkingMultiplier',
    value: '0.5',
    sentence: dec2BelowMin('The special non-working holiday multiplier', 1),
  },
  {
    key: 'holidaySpecialWorkingMultiplier',
    value: '0.5',
    sentence: dec2BelowMin('The special working holiday multiplier', 1),
  },
  { key: 'lateChargePerMinute', value: '1,5', sentence: moneyMalformed('The late charge per minute', '1,5') },
  {
    key: 'lateInfractionPoints',
    value: '100000',
    sentence: wholeNumberOutOfRange('The late infraction points', '100000', 0, NO_MAX_CEILING),
  },
  {
    key: 'lateGraceMinutes',
    value: '100000',
    sentence: wholeNumberOutOfRange('The late grace minutes', '100000', 0, NO_MAX_CEILING),
  },
  {
    key: 'earlyOutGraceMinutes',
    value: '100000',
    sentence: wholeNumberOutOfRange('The early-out grace minutes', '100000', 0, NO_MAX_CEILING),
  },
  {
    key: 'undertimeGraceMinutes',
    value: '100000',
    sentence: wholeNumberOutOfRange('The undertime grace minutes', '100000', 0, NO_MAX_CEILING),
  },
  {
    key: 'semiMonthlyCutoffDay',
    value: '28',
    sentence: wholeNumberOutOfRange('The semi-monthly cutoff day', '28', 1, 27),
  },
  { key: 'payoutLagDays', value: '32', sentence: wholeNumberOutOfRange('The payout lag days', '32', 0, 31) },
  {
    key: 'autoClockOutHour',
    value: '24',
    sentence: wholeNumberOutOfRange('The auto clock-out hour', '24', 0, 23),
  },
  {
    key: 'maxShiftHours',
    value: '5',
    sentence: wholeNumberOutOfRange('The max shift hours', '5', 10, NO_MAX_CEILING),
  },
];

describe('D9 (audit F1) — every moved field, out-of-range, its own userMessage — nothing written', () => {
  it.each(FIELD_OUT_OF_RANGE_LEGS.map((leg) => [leg.key, leg.value, leg.sentence] as const))(
    '%s="%s" -> %s',
    async (key, value, sentence) => {
      const f = await configFixture(`d9-${key}`);
      const before = await configRowCount(f.storeId);
      await expect(
        asOrg(f.orgId, (tx) =>
          supersedeConfig(tx, f.admin, {
            storeId: f.storeId,
            effectiveFrom: '2026-06-01',
            changes: { [key]: value } as never,
          }),
        ),
        `field ${key}`,
      ).rejects.toMatchObject({ userMessage: sentence });
      await assertConfigUnchanged(f, before);
    },
  );
});

// =================================================================================================
// D7-D8 — recordAdjustment. Fixture shape from
// packages/domain/tests/integration/attendance-adjustments.test.ts.
// =================================================================================================

async function adjustmentFixture(hint: string) {
  const code = uid(`t352dj-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${admin!.id}, ${storeId}, 'manual')`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const admin_ = actor(orgId, admin!.id);
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin_, {
      storeId,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));

  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${admin!.id}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [s] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${admin!.id}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours') returning id`;

  const shiftDay = toShiftDay(new Date(Date.now() - 24 * 3_600_000));

  // A simple, adjudicatable day — same shape as attendance-adjustments.test.ts's own `cleanDay`,
  // kept minimal because D7/D8 pin the PARSE ordering, not the adjudication outcome.
  await asOrg(orgId, (tx) =>
    recordPunch(tx, {
      clientPunchId: uid('cp'),
      employmentId: employment.id,
      occurredAt: new Date(Date.now() - 20 * 3_600_000),
      method: 'qr',
      assertedIntent: 'in',
      source: 'online',
    }),
  );
  await asOrg(orgId, (tx) =>
    recordPunch(tx, {
      clientPunchId: uid('cp'),
      employmentId: employment.id,
      occurredAt: new Date(Date.now() - 11 * 3_600_000),
      method: 'qr',
      assertedIntent: 'out',
      source: 'online',
    }),
  );

  return { orgId, storeId, admin: admin_, employment, sessionId: s!.id, shiftDay };
}
type AdjustmentFixture = Awaited<ReturnType<typeof adjustmentFixture>>;

async function liveAdjustmentCount(f: AdjustmentFixture, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${f.employment.id} and shift_day = ${f.shiftDay} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

describe('D7 — recordAdjustment, approvedOtMinutes="1.5"', () => {
  it('rejects with userMessage \'The minutes to pay — "1.5" is not a whole number of minutes from 0 to 99999.\'; nothing written — was red today: a raw 22P02', async () => {
    const f = await adjustmentFixture('d7');
    const before = await liveAdjustmentCount(f, 'overtime_approved');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: f.shiftDay,
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: '1.5',
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: 'The minutes to pay — "1.5" is not a whole number of minutes from 0 to 99999.' });
    expect(await liveAdjustmentCount(f, 'overtime_approved'), 'nothing written').toBe(before);
  });
});

describe('D8 (row 235 + ⛔ guard) — recordAdjustment, chosenAnchorMinute blank then a real number', () => {
  it('blank refuses with \'The paid-from minute — enter a whole number of minutes (0 to 99999).\', nothing written; a real 60 then saves — was red today: the blank call is a raw 22P02', async () => {
    const f = await adjustmentFixture('d8');
    const before = await liveAdjustmentCount(f, 'start_anchor');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: f.shiftDay,
          sessionId: f.sessionId,
          kind: 'start_anchor',
          chosenAnchorMinute: '',
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: 'The paid-from minute — enter a whole number of minutes (0 to 99999).' });
    expect(await liveAdjustmentCount(f, 'start_anchor'), 'nothing written').toBe(before);

    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: f.shiftDay,
        sessionId: f.sessionId,
        kind: 'start_anchor',
        chosenAnchorMinute: 60,
      } as Parameters<typeof recordAdjustment>[2]),
    );
    expect(adjustment.chosenAnchorMinute, 'a real number still saves (⛔ guard)').toBe(60);
  });
});

// =================================================================================================
// Compile-time pin (audit F2) — `supersedeConfig`'s `effectiveFrom: ShiftDay | RawShiftDay` (T-352
// F2, `config.ts`) must reject a `BusinessDate`, never just widen to `string`. Type-level only —
// never called; a `@ts-expect-error` that never runs still fails typecheck if it stops being needed
// ("Unused '@ts-expect-error' directive"), which is the assertion.
// =================================================================================================

import { toBusinessDate } from '@shareat/core';

function neverCalled_rawShiftDayRejectsBusinessDate(): void {
  const businessDate = toBusinessDate(new Date());

  void supersedeConfig(null as never, null as never, {
    storeId: 'x',
    // @ts-expect-error — RawShiftDay pins __brand to `undefined`; BusinessDate carries a real,
    // different brand literal there, so it must NOT be assignable to `effectiveFrom`. If this ever
    // stops erroring (e.g. the signature regresses to `ShiftDay | string`), typecheck reports
    // "Unused '@ts-expect-error' directive" and the pin itself goes red — see F2's worktree proof.
    effectiveFrom: businessDate,
    changes: {},
  });

  // Positive control: a plain, unbranded string literal DOES compile — proves the directive above
  // is catching the BusinessDate brand specifically, not merely rejecting every non-ShiftDay input.
  void supersedeConfig(null as never, null as never, {
    storeId: 'x',
    effectiveFrom: '2026-01-01',
    changes: {},
  });
}
void neverCalled_rawShiftDayRejectsBusinessDate;
