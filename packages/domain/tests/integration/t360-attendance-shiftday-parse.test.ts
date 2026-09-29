import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-360 (DEF-488) — domain-direct legs D1-D13 + the compile pin.
 * `docs/tasks/360-def-488-attendance-shiftday-parse.md` §Legs, "Domain-direct".
 *
 * ⛔ TESTER, not BUILDER. `recordAdjustment`'s `shiftDay` is parsed with `parseShiftDayInput`
 * (new, `adjustments.ts`) directly after `authorize()` and the self-adjudication check (R3), so a
 * malformed value gets a sentence instead of a raw Postgres error. Every "was red today" note
 * records the PRE-FIX result. Fixture shape copied from
 * `t352-attendance-parse-in-domain.test.ts` (`adjustmentFixture` :322, `liveAdjustmentCount` :385)
 * and the self-adjudication fixture shape from `attendance-adjustments.test.ts:190-205`.
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
  recordAdjustment,
  recordPunch,
  seedAttendanceConfig,
  seedCanonicalPositions,
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

/** A real, live session row — attendance-adjustments.test.ts:60-69, verbatim shape. */
async function makeSession(orgId: string, personId: string, storeId: string): Promise<string> {
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [s] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${personId}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours') returning id`;
  return s!.id;
}

// =================================================================================================
// Fixture — adjustmentFixture, t352-attendance-parse-in-domain.test.ts:322-382, verbatim shape.
// `configEffectiveFrom` is a T-360 addition: D12 tests a shift day (2024-02-29) before the
// precedent's default '2026-01-01' config start, so `adjudicateDay`'s own `getConfigForShiftDay`
// (adjudicate.ts:126) would refuse it with "No attendance config governed…" — a setup failure, not
// the leap-year behaviour D12 exists to pin. Parameterised rather than silently narrowed.
// =================================================================================================
async function adjustmentFixture(hint: string, configEffectiveFrom = '2026-01-01') {
  const code = uid(`t360dj-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeId}, 'manual')`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const admin_ = actor(orgId, adminId);
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin_, {
      storeId,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: configEffectiveFrom }));

  const sessionId = await makeSession(orgId, adminId, storeId);
  const shiftDay = toShiftDay(new Date(Date.now() - 24 * 3_600_000));

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

  return { orgId, storeId, adminId, admin: admin_, workerId: worker!.id, employment, sessionId, shiftDay };
}
type AdjustmentFixture = Awaited<ReturnType<typeof adjustmentFixture>>;

/** "Nothing written" per the task doc: total rows for the EMPLOYMENT, across every shift day — a
 * malformed value cannot be filtered by `shift_day = <value>`, so counting by day would silently
 * read 0-before/0-after and pass even if something landed under a DIFFERENT (also wrong) day. */
async function totalAdjustmentCount(employmentId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments where employment_id = ${employmentId}`;
  return Number(row!.count);
}

async function liveAdjustmentCount(f: AdjustmentFixture, shiftDay: string, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${f.employment.id} and shift_day = ${shiftDay} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

const D1_SENTENCE = (v: string) => `The shift day — "${v}" is not a date. Reopen the day from the attendance list and try again.`;
const D2_SENTENCE = 'The shift day is missing. Reopen the day from the attendance list and try again.';

describe('D1 — recordAdjustment, shiftDay="not-a-date"', () => {
  it(`rejects with userMessage ${JSON.stringify(D1_SENTENCE('not-a-date'))}; nothing written — was red today: a raw Postgres error, no userMessage (record the code, expected 22007)`, async () => {
    const f = await adjustmentFixture('d1');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: 'not-a-date',
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 30,
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: D1_SENTENCE('not-a-date') });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D2 — recordAdjustment, shiftDay=""', () => {
  it(`rejects with userMessage ${JSON.stringify(D2_SENTENCE)}; nothing written — was red today: raw Postgres (record it)`, async () => {
    const f = await adjustmentFixture('d2');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: '',
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 30,
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: D2_SENTENCE });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D3 — recordAdjustment, shiftDay="2026-02-30" (calendar-impossible)', () => {
  it(`D1's sentence with "2026-02-30"; nothing written — was red today: raw 22008 (record it)`, async () => {
    const f = await adjustmentFixture('d3');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: '2026-02-30',
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 30,
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: D1_SENTENCE('2026-02-30') });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D4 — recordAdjustment, shiftDay="2026-13-01"', () => {
  it(`D1's sentence with "2026-13-01"; nothing written — was red today: raw (record it)`, async () => {
    const f = await adjustmentFixture('d4');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: '2026-13-01',
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 30,
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: D1_SENTENCE('2026-13-01') });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D5 — recordAdjustment, kind="verify", shiftDay="abc"', () => {
  it(`D1's sentence with "abc" (every kind passes the parse); nothing written — was red today: raw (record it)`, async () => {
    const f = await adjustmentFixture('d5');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: 'abc',
          sessionId: f.sessionId,
          kind: 'verify',
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: D1_SENTENCE('abc') });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D6 (green, guard) — recordAdjustment, shiftDay=toShiftDay(new Date()) (branded)', () => {
  it("saves; the row's shift_day equals it", async () => {
    const f = await adjustmentFixture('d6');
    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: f.shiftDay,
        sessionId: f.sessionId,
        kind: 'overtime_approved',
        approvedOtMinutes: 30,
      }),
    );
    expect(adjustment.shiftDay).toBe(f.shiftDay);
  });
});

describe('D7 — recordAdjustment, shiftDay="2026-09-28" (plain unbranded string)', () => {
  it("saves; shift_day = '2026-09-28' — typecheck red only (M3 window); runtime green", async () => {
    const f = await adjustmentFixture('d7');
    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: '2026-09-28',
        sessionId: f.sessionId,
        kind: 'overtime_approved',
        approvedOtMinutes: 30,
      } as Parameters<typeof recordAdjustment>[2]),
    );
    expect(adjustment.shiftDay).toBe('2026-09-28');
  });
});

describe('D8 — recordAdjustment, shiftDay=" 2026-09-28 " (padded)', () => {
  it('saves as 2026-09-28; exactly one live row for that day — record it (Postgres may trim too; if green, it is a guard)', async () => {
    const f = await adjustmentFixture('d8');
    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: ' 2026-09-28 ',
        sessionId: f.sessionId,
        kind: 'overtime_approved',
        approvedOtMinutes: 30,
      } as Parameters<typeof recordAdjustment>[2]),
    );
    expect(adjustment.shiftDay).toBe('2026-09-28');
    expect(await liveAdjustmentCount(f, '2026-09-28', 'overtime_approved')).toBe(1);
  });
});

describe('D9 (green, guard; ordering) — a STAFF non-holder, shiftDay="not-a-date"', () => {
  it('the rejection message equals the same staff\'s message for a valid day; ⛔ does not contain "shift day"; nothing written', async () => {
    const f = await adjustmentFixture('d9');
    // The non-holder — CAPABILITY-MATRIX.md:143, `manage_attendance` is ✗ for staff.
    const [staff] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Floor Staff') returning id`;
    const staffId = staff!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${staffId}, ${f.storeId}, 'manual')`;
    const staffSessionId = await makeSession(f.orgId, staffId, f.storeId);
    const staffActor = actor(f.orgId, staffId);

    const before = await totalAdjustmentCount(f.employment.id);
    const call = (shiftDay: string) =>
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, staffActor, {
          employmentId: f.employment.id,
          shiftDay,
          sessionId: staffSessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 30,
        } as Parameters<typeof recordAdjustment>[2]),
      );

    const baseline = await call(f.shiftDay).catch((e) => e);
    const malformed = await call('not-a-date').catch((e) => e);
    expect(baseline, 'expected the valid-day call to be refused too').toBeInstanceOf(Error);
    expect((malformed as { userMessage?: string }).userMessage).toBe((baseline as { userMessage?: string }).userMessage);
    expect((malformed as { userMessage?: string }).userMessage ?? '').not.toContain('shift day');
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D10 (green, guard; R3 order) — admin, approvedOtMinutes="abc" AND shiftDay="not-a-date"', () => {
  it('rejects with the minutes sentence, not the shift-day sentence', async () => {
    const f = await adjustmentFixture('d10');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: 'not-a-date',
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 'abc',
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: 'The minutes to pay — "abc" is not a whole number of minutes from 0 to 99999.' });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D11 (green, guard; R3 order) — a non-admin MANAGER adjudicating their OWN employment, shiftDay="not-a-date"', () => {
  it('rejects /your own attendance/i, not the shift-day sentence', async () => {
    const f = await adjustmentFixture('d11');
    // Promote the worker to manager over their OWN employment — attendance-adjustments.test.ts:190-198.
    await sql`update person_roles set revoked_at = now() where person_id = ${f.workerId} and org_id = ${f.orgId} and revoked_at is null`;
    await sql`insert into person_roles (person_id, org_id, role) values (${f.workerId}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${f.workerId}, ${f.storeId}, 'manual') on conflict (person_id, store_id) do nothing`;
    const workerSessionId = await makeSession(f.orgId, f.workerId, f.storeId);
    const workerActor = actor(f.orgId, f.workerId);

    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, workerActor, {
          employmentId: f.employment.id,
          shiftDay: 'not-a-date',
          sessionId: workerSessionId,
          kind: 'start_anchor',
          chosenAnchorMinute: 60,
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toThrow(/your own attendance/i);
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

describe('D12 (green, positive control; Amendment A1) — recordAdjustment, shiftDay="2024-02-29" (a real leap day)', () => {
  it("saves; the row's shift_day equals it", async () => {
    const f = await adjustmentFixture('d12', '2024-01-01');
    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.admin, {
        employmentId: f.employment.id,
        shiftDay: '2024-02-29',
        sessionId: f.sessionId,
        kind: 'overtime_approved',
        approvedOtMinutes: 30,
      } as Parameters<typeof recordAdjustment>[2]),
    );
    expect(adjustment.shiftDay).toBe('2024-02-29');
  });
});

describe('D13 (Amendment A1) — recordAdjustment, shiftDay="2026-02-29" (2026 is not a leap year)', () => {
  it('D1\'s sentence with "2026-02-29"; nothing written', async () => {
    const f = await adjustmentFixture('d13');
    const before = await totalAdjustmentCount(f.employment.id);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordAdjustment(tx, f.admin, {
          employmentId: f.employment.id,
          shiftDay: '2026-02-29',
          sessionId: f.sessionId,
          kind: 'overtime_approved',
          approvedOtMinutes: 30,
        } as Parameters<typeof recordAdjustment>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: D1_SENTENCE('2026-02-29') });
    expect(await totalAdjustmentCount(f.employment.id), 'nothing written').toBe(before);
  });
});

// =================================================================================================
// Compile-time pin (Amendment A1 §3: lives in the tester's domain-direct file, copied through the
// `void` line, t352-attendance-parse-in-domain.test.ts:449-472) — `recordAdjustment`'s
// `shiftDay: ShiftDay | RawShiftDay` must reject a `BusinessDate`, never just widen to `string`.
// Type-level only — never called; a `@ts-expect-error` that never runs still fails typecheck if it
// stops being needed ("Unused '@ts-expect-error' directive"), which is the assertion.
// =================================================================================================

import { toBusinessDate } from '@shareat/core';

function neverCalled_rawShiftDayRejectsBusinessDate(): void {
  const businessDate = toBusinessDate(new Date());

  void recordAdjustment(null as never, null as never, {
    employmentId: 'x',
    // @ts-expect-error — RawShiftDay pins __brand to `undefined`; BusinessDate carries a real,
    // different brand literal there, so it must NOT be assignable to `shiftDay`. If this ever stops
    // erroring (e.g. the signature regresses to `ShiftDay | string`), typecheck reports "Unused
    // '@ts-expect-error' directive" and the pin itself goes red.
    shiftDay: businessDate,
    kind: 'overtime_approved',
    sessionId: 'x',
  });

  // Positive control: a plain, unbranded string literal DOES compile — proves the directive above
  // is catching the BusinessDate brand specifically, not merely rejecting every non-ShiftDay input.
  void recordAdjustment(null as never, null as never, {
    employmentId: 'x',
    shiftDay: '2026-01-01',
    kind: 'overtime_approved',
    sessionId: 'x',
  });
}
void neverCalled_rawShiftDayRejectsBusinessDate;
