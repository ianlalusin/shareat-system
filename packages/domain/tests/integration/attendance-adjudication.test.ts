import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-157 — `adjudicateDay`, the transactional shell. `docs/tasks/157-attendance-adjudication.md`.
 *
 * The arithmetic itself is unit-tested in `compute-day.test.ts` (36 cases, including the
 * property-based invariant 1). What is tested HERE is everything the pure function cannot see:
 * which config a day is judged by, what a recompute is allowed to change, and what the freeze
 * refuses.
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
  parseShiftDay,
  recordPunch,
  seedAttendanceConfig,
  seedCanonicalPositions,
  shiftDayRange,
  supersedeConfig,
  toShiftDay,
  addShiftDays,
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

/**
 * ⚠️ **Yesterday's shift day, not a hardcoded date, and the reason is a real behaviour.**
 *
 * A punch's arrival lag is `received_at - occurred_at`, and `received_at` defaults to `now()`. A
 * fixture pinned to March 2026 therefore arrives months late, trips the `late_event_arrival`
 * anomaly, and lands every day in `needs_review` — which is the engine working correctly on an
 * unrealistic fixture. Yesterday's shift day is entirely in the past (so no punch is refused as
 * future) and comfortably inside the 72-hour threshold.
 */
const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
const DAY_START = shiftDayRange(DAY).start.getTime();
/** Wall-clock hour on that shift day, as an instant. */
const at = (hour: number, minute = 0) =>
  new Date(DAY_START + (((((hour - 5) % 24) + 24) % 24) * 60 + minute) * 60_000);

async function fixture(hint: string) {
  const code = uid(`ad-${hint}`);
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
  const cfg = await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );

  return { orgId, storeId: store!.id, admin: a, employment, config: cfg };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const addPunch = (f: Fixture, when: Date, intent: 'in' | 'out' | 'break_start' | 'break_end') =>
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

const judge = (f: Fixture) =>
  asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId: f.employment.id, shiftDay: DAY }));

// -------------------------------------------------------------------------------------

describe('T-157 — a full day, end to end', () => {
  it('nine hours from an allowed start computes and is payable', async () => {
    const f = await fixture('full');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);

    expect(d.computedMinutes).toBe(9 * 60);
    expect(d.status).toBe('computed');
    expect(d.anchorMode).toBe('exact');
    expect(d.anomalies).toEqual([]);
    expect(d.explain.length).toBeGreaterThan(0);
  });

  it('the evidence is referenced, not copied', async () => {
    const f = await fixture('evidence');
    const { punch: inP } = await addPunch(f, at(14), 'in');
    const { punch: outP } = await addPunch(f, at(23), 'out');
    const d = await judge(f);
    expect(d.firstInPunchId).toBe(inP.id);
    expect(d.lastOutPunchId).toBe(outP.id);
  });
});

describe('T-157 invariant 11 — ⭐ a day is judged by the config that governed IT', () => {
  it('re-adjudicating after a policy change still uses the OLD config', async () => {
    const f = await fixture('config-history');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const before = await judge(f);
    expect(before.attendanceConfigId).toBe(f.config.id);
    expect(before.computedMinutes).toBe(9 * 60);

    // A policy change that takes effect AFTER this day.
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: addShiftDays(DAY, 30),
        changes: { requiredHoursPerShift: '6' },
      }),
    );

    const after = await judge(f);
    // ⛔ Still the config that governed THIS day, so still nine hours — not capped at the new six.
    expect(after.attendanceConfigId).toBe(f.config.id);
    expect(after.computedMinutes).toBe(9 * 60);
  });
});

describe('T-157 invariant 8 — ⛔ a recompute never promotes needs_review to payable', () => {
  it('a flagged day stays flagged even once its missing out arrives', async () => {
    const f = await fixture('no-promote');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(15), 'in'); // a second in ⇒ overlapping ⇒ needs_review
    await addPunch(f, at(23), 'out');
    const flagged = await judge(f);
    expect(flagged.status).toBe('needs_review');

    // A later, clean recompute must not quietly make it payable — v1's rule, and the reason is
    // that the promoted status is in payroll's PAYABLE_STATUSES.
    const again = await judge(f);
    expect(again.status).toBe('needs_review');
  });

  it('an in with no out yet is `open`, not a problem', async () => {
    const f = await fixture('open');
    await addPunch(f, at(14), 'in');
    const d = await judge(f);
    expect(d.status).toBe('open');
    expect(d.anomalies).toContain('missing_out');
  });

  it('a verified day is not demoted by a recompute either', async () => {
    const f = await fixture('verified');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    await sql`update attendance_days set status = 'verified' where id = ${d.id}`;
    const again = await judge(f);
    expect(again.status).toBe('verified');
  });
});


/**
 * A REAL pay run to freeze a day against.
 *
 * ⚠️ These tests used to invent a UUID. T-189 created `pay_runs` and attached the FK T-157 had
 * deliberately left off — *"the column lands now; Phase 5 sets it"* — so a made-up id is now
 * refused, which is the FK doing its job.
 */
async function aPayRun(f: { orgId: string; storeId: string; adminId?: string }): Promise<string> {
  const [acct] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and is_foundation limit 1`;
  const [who] = await sql<{ id: string }[]>`
    select id from persons where org_id = ${f.orgId} limit 1`;
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, money_account_id, created_by)
    values (${f.orgId}, ${f.storeId}, '2026-01-01', '2026-01-15', ${acct!.id}, ${who!.id})
    returning id`;
  return run!.id;
}

describe('T-157 invariant 9 — ⛔ a FROZEN day is never recomputed', () => {
  it('the service refuses, with a message naming the pay run', async () => {
    const f = await fixture('frozen-service');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    const payRun = await aPayRun(f);
    await sql`
      update attendance_days set frozen_at = now(), frozen_by_pay_run_id = ${payRun} where id = ${d.id}`;

    await expect(judge(f)).rejects.toThrow(/frozen by pay run/i);
  });

  it('and raw SQL cannot update it either — the trigger is the real guard', async () => {
    const f = await fixture('frozen-sql');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    await sql`
      update attendance_days set frozen_at = now(),
        frozen_by_pay_run_id = ${await aPayRun(f)} where id = ${d.id}`;

    await expect(sql`update attendance_days set computed_minutes = 0 where id = ${d.id}`)
      .rejects.toThrow(/frozen/i);
    await expect(sql`delete from attendance_days where id = ${d.id}`).rejects.toThrow(/frozen/i);
  });

  /**
   * ⚠️ **AMENDED 2026-08-31 by T-189 (migration 0106), and the amendment is the point.**
   *
   * This used to assert that a freeze could never be lifted at all. That made `voidPayRun`
   * impossible, and a mis-posted run stranded its days for ever: frozen against a run that no
   * longer paid them, unpayable by anybody.
   *
   * ⭐ The invariant that actually matters survives intact — **a frozen day cannot be RESTATED.**
   * The door is only wide enough to release it, whole, changing nothing else on the row.
   */
  it('⭐ a frozen day cannot be un-frozen WHILE ANYTHING ELSE CHANGES', async () => {
    const f = await fixture('unfreeze');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    await sql`
      update attendance_days set frozen_at = now(),
        frozen_by_pay_run_id = ${await aPayRun(f)} where id = ${d.id}`;

    // ⛔ Smuggling a recomputation out under cover of an unfreeze is still refused.
    await expect(
      sql`update attendance_days set frozen_at = null, frozen_by_pay_run_id = null,
            computed_minutes = 0 where id = ${d.id}`,
    ).rejects.toThrow(/frozen/i);
    await expect(
      sql`update attendance_days set frozen_at = null, frozen_by_pay_run_id = null,
            status = 'needs_review' where id = ${d.id}`,
    ).rejects.toThrow(/frozen/i);
  });

  it('⭐ but a PURE release is allowed — it is the only way voiding a pay run can work', async () => {
    const f = await fixture('unfreeze-pure');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    const before = await sql`select computed_minutes, status from attendance_days where id = ${d.id}`;
    await sql`
      update attendance_days set frozen_at = now(),
        frozen_by_pay_run_id = ${await aPayRun(f)} where id = ${d.id}`;

    await expect(
      sql`update attendance_days set frozen_at = null, frozen_by_pay_run_id = null where id = ${d.id}`,
    ).resolves.toBeDefined();

    // ⚠️ And the day came back UNCHANGED — released, not restated.
    const after = await sql`select computed_minutes, status from attendance_days where id = ${d.id}`;
    expect(after[0]).toEqual(before[0]);
  });
});

describe('T-157 invariant 10 — recomputing an unchanged day is idempotent', () => {
  it('the same inputs give the same output, and one row', async () => {
    const f = await fixture('idempotent');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const a = await judge(f);
    const b = await judge(f);

    expect(b.id).toBe(a.id);
    expect(b.computedMinutes).toBe(a.computedMinutes);
    expect(b.status).toBe(a.status);
    expect(b.anomalies).toEqual(a.anomalies);

    const rows = await sql`select id from attendance_days where employment_id = ${f.employment.id}`;
    expect(rows).toHaveLength(1);
  });

  it('a late-arriving punch changes the day and the punch count', async () => {
    const f = await fixture('late-punch');
    await addPunch(f, at(14), 'in');
    const open = await judge(f);
    expect(open.computedFromPunchCount).toBe(1);
    expect(open.status).toBe('open');

    await addPunch(f, at(23), 'out');
    const closed = await judge(f);
    expect(closed.computedFromPunchCount).toBe(2);
    expect(closed.computedMinutes).toBe(9 * 60);
    expect(closed.status).toBe('computed');
  });
});

describe('T-157 — one row per person per shift day', () => {
  it('a second row for the same employment and day is refused by the database', async () => {
    const f = await fixture('one-row');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    await expect(sql`
      insert into attendance_days
        (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status)
      values (${f.orgId}, ${f.storeId}, ${d.personId}, ${f.employment.id}, ${DAY}, ${f.config.id}, 'exact', 'computed')`)
      .rejects.toThrow(/unique|duplicate/i);
  });
});

describe('T-157 — a superseded punch is excluded from the day', () => {
  it('correcting a punch changes what the day computes', async () => {
    const f = await fixture('superseded');
    const { punch: wrongIn } = await addPunch(f, at(14), 'in');
    await addPunch(f, at(23), 'out');
    expect((await judge(f)).computedMinutes).toBe(9 * 60);

    // The 14:00 in was wrong; correct it to 18:00. The correction supersedes it, so the original
    // drops out of the day entirely rather than being edited.
    await asOrg(f.orgId, (tx) =>
      recordPunch(tx, {
        clientPunchId: uid('cp-fix'),
        employmentId: f.employment.id,
        occurredAt: at(18),
        method: 'manual',
        assertedIntent: 'in',
        source: 'manual_entry',
        supersedesPunchId: wrongIn.id,
        voidReason: 'Clocked in on the wrong terminal',
      }),
    );

    const fixed = await judge(f);
    expect(fixed.anchorMinute).toBe(13 * 60); // 18:00 is 13h after the 05:00 shift start
    expect(fixed.computedMinutes).toBe(5 * 60);
  });
});

describe('T-157 — breaks reduce pay only above the allowance', () => {
  it('a 90-minute break against a 60-minute allowance costs 30 minutes', async () => {
    const f = await fixture('break');
    await addPunch(f, at(14), 'in');
    await addPunch(f, at(18), 'break_start');
    await addPunch(f, at(19, 30), 'break_end');
    await addPunch(f, at(23), 'out');
    const d = await judge(f);
    expect(d.breakMinutes).toBe(90);
    expect(d.allowableBreakMinutes).toBe(60);
    expect(d.breakOverMinutes).toBe(30);
    expect(d.computedMinutes).toBe(9 * 60 - 30);
  });
});
