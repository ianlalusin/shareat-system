import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-370 S3 (DEF-409) — the WEB legs W1/W2: the attendance settings form refuses a one-day semi-monthly cycle.
 * `docs/tasks/370-owner-cap-dates.md` tests W1/W2.
 *
 *   W1: `updateAttendanceConfigAction` with payoutDays = "10, 2 5" (T-374 S5: was dropped to [10] by parseIntList -> SEMI_MONTHLY_TWO_DAYS; now the token "2 5" is refused by name before the two-days rule)
 *   W2 (control): "10,25" -> the ok banner.
 *
 * ⛔ TESTER. Harness and the form shape are `t352-attendance-auth-before-parse.test.ts`'s (one RedirectSignal, one session
 * holder, the real `@/lib/constraint-messages`), over the REAL domain and a REAL Postgres. Extra legs beyond the spec's two,
 * all about what the PERSON sees: the exact sentence in the banner, no row written on refusal, and a typed "10,10" (which
 * parseIntList de-duplicates to [10]) refused the same way.
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

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null; sessionId: string } = { actor: null, sessionId: '' };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: ACTOR_HOLDER.sessionId })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedAttendanceConfig } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });
const TWO_DAYS = 'A semi-monthly store pays on exactly two different days of the month. Enter two payout days, for example 10,25.';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => new URL(to, 'http://localhost').searchParams.get(k);

async function fixture(hint: string) {
  const code = uid(`t370w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));
  return { orgId, storeId, admin: actor(orgId, admin!.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const rowCount = async (storeId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from store_attendance_config where store_id = ${storeId}`)[0]!.n);
const liveDays = async (storeId: string) => (await sql<{ payout_days: number[]; payout_mode: string }[]>`select payout_days, payout_mode from store_attendance_config where store_id = ${storeId} and superseded_at is null`)[0];

/** Verbatim shape, t352-attendance-auth-before-parse.test.ts:109-155 — the seeded row's own defaults. */
function form(f: Fixture, overrides: Record<string, string> = {}): FormData {
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
  fd.set('payoutMode', 'fixed_days');
  fd.set('payoutLagDays', '0');
  fd.set('payoutDays', '10,25');
  fd.set('autoClockOutHour', '');
  fd.set('maxShiftHours', '16');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}
async function submit(f: Fixture, fd: FormData): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
  return expectRedirectTo(() => updateAttendanceConfigAction(fd));
}

describe('W1 — a one-day semi-monthly cycle typed into the form is refused, in words', () => {
  it('payoutDays "10, 2 5" (T-374 S5: the token "2 5" is refused by name, no longer dropped to [10]) -> ?error = the token sentence, no ok banner; no row written', async () => {
    const f = await fixture('w1');
    const before = await rowCount(f.storeId);
    const to = await submit(f, form(f, { payoutDays: '10, 2 5' }));
    expect(param(to, 'ok'), `the one-day cycle was SAVED: ${param(to, 'ok')}`).toBeNull();
    expect(param(to, 'error')).toBe('Payout days — "2 5" is not a whole number from 1 to 31.');
    expect(await rowCount(f.storeId), 'a refused save wrote a row').toBe(before);
  });

  it('payoutDays "10,10" (de-duplicated to [10]) and "10" are refused the same way', async () => {
    const f = await fixture('w1b');
    for (const typed of ['10,10', '10']) {
      const to = await submit(f, form(f, { payoutDays: typed }));
      expect(param(to, 'error'), `payoutDays=${JSON.stringify(typed)}`).toBe(TWO_DAYS);
    }
    expect(await rowCount(f.storeId)).toBe(1);
  });

  it('a 17-day cycle ("10,27") is refused with the gap sentence in the banner (no raw function text, no id)', async () => {
    const f = await fixture('w1c');
    const to = await submit(f, form(f, { payoutDays: '10,27' }));
    expect(param(to, 'error')).toBe(
      'This semi-monthly pay cycle can run 17 days between paydays. The Labor Code (Art. 103) allows at most 16. ' +
        'Change the payout days or the cutoff day, for example payout days 10,25 with cutoff 15.',
    );
    expect(await rowCount(f.storeId)).toBe(1);
  });
});

describe('W2 (control) — a valid cycle saves', () => {
  it('payoutDays "10,25" -> the ok banner ("Saved. The new policy takes effect from 2026-06-01."), and the live row carries [10,25]', async () => {
    const f = await fixture('w2');
    const to = await submit(f, form(f, { payoutDays: '10,25' }));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toBe('Saved. The new policy takes effect from 2026-06-01.');
    expect(await liveDays(f.storeId)).toMatchObject({ payout_mode: 'fixed_days', payout_days: [10, 25] });
  });
});
