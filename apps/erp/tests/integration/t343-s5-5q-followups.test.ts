import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S5.5q — DEF-463, DEF-464, DEF-465, DEF-467.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5q.
 *
 * ⛔ TESTER, not BUILDER. S5.5q is now built and every leg below is green; each "was red before
 * this fix" note records the pre-fix failure that leg originally pinned.
 * - A1/A2/A1n/A2n/A3n (DEF-463): before this fix, `settings/attendance/actions.ts`'s
 *   `int()`/`intOrNull()` silently fell back to their default/`null` on a non-finite typed value,
 *   never refusing. Verified directly before writing this file.
 * - F1/F1b/F1n (DEF-464): before this fix, `createAsset` (`capitalize.ts:115-121`) threw a plain
 *   `Error` naming the raw (possibly `NaN`) value.
 * - Y1/Y2/Y3/Y1n (DEF-465): before this fix, no year guard existed in
 *   `preview13thMonthRun`/`post13thMonthRun`. Y1/Y2's pre-fix text was OBSERVED, not presumed — see
 *   each test's own comment for the verbatim result.
 * - T1/T2/T3/T1n (DEF-467): before this fix, `updateTermsAction` wrote through the repo directly
 *   with no domain check; the DB's own CHECK/type errors surfaced instead.
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

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));

// fixed-assets/actions.ts is the one file here importing the bare `@/...` specifier the root
// vitest.config.mts never resolves — forwarded to the real module, per s5-5p precedent.
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, fixedAssetsRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { getLiveConfig, preview13thMonthRun, post13thMonthRun, seedAttendanceConfig, createAsset } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { ASSET_CREATE_RULES, ASSET_TERMS_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../helpers/rule-sentence';
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

async function orgWithAdmin(hint: string) {
  const code = uid(`s55q-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  return { orgId, storeId, admin: actor(orgId, adminId) };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// =================================================================================================
// A1/A2/A1n/A2n/A3n — updateAttendanceConfigAction (DEF-463)
// =================================================================================================

async function attendanceFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  await asOrg(f.orgId, (tx) => seedAttendanceConfig(tx, { orgId: f.orgId, storeId: f.storeId, effectiveFrom: '2026-01-01' }));
  return f;
}

/**
 * Every field `updateAttendanceConfigAction` reads, at the seeded row's own defaults
 * (`packages/db/schema/attendance-config.ts`) — the real page pre-fills the form from the live
 * config, so a real submission never sends `''` for a raw numeric-string field the way an
 * intentionally-partial FormData would. Only `overrides` changes anything under test.
 */
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

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

describe('A1 (DEF-463) — lateGraceMinutes="abc" refuses by name', () => {
  it(
    'was red before this fix: "Saved…" banner, grace silently written as 0',
    async () => {
      const f = await attendanceFixture('a1');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');

      const to = await expectRedirectTo(() =>
        updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: 'abc' })),
      );
      const params = paramsOf(to);
      expect(params.get('error'), `redirect URL was: ${to}`).toBe('The late grace minutes — "abc" is not a number.');
      const live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
      expect(live.lateGraceMinutes, 'nothing should have changed').toBe(0);
    },
    30000,
  );
});

describe('A2 (DEF-463) — autoClockOutHour="abc" refuses by name', () => {
  it(
    'was red before this fix: no error, autoClockOutHour silently written as null (auto-clear switched off)',
    async () => {
      const f = await attendanceFixture('a2');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');

      const to = await expectRedirectTo(() =>
        updateAttendanceConfigAction(attendanceFormData(f, { autoClockOutHour: 'abc' })),
      );
      const params = paramsOf(to);
      expect(params.get('error'), `redirect URL was: ${to}`).toBe('The auto clock-out hour — "abc" is not a number.');
      const live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
      expect(live.autoClockOutHour, 'nothing should have changed').toBeNull();
    },
    30000,
  );
});

describe('A1n/A2n (⛔ green, must stay unedited) — blank and ordinary numeric values', () => {
  it('lateGraceMinutes="" saves 0; autoClockOutHour="" saves null; lateGraceMinutes="5" saves 5', async () => {
    const f = await attendanceFixture('a1n');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');

    const to1 = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, {})));
    expect(paramsOf(to1).get('error')).toBeNull();
    let live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
    expect(live.lateGraceMinutes).toBe(0);
    expect(live.autoClockOutHour).toBeNull();

    const to2 = await expectRedirectTo(() =>
      updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: '5', effectiveFrom: '2026-07-01' })),
    );
    expect(paramsOf(to2).get('error')).toBeNull();
    live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
    expect(live.lateGraceMinutes).toBe(5);
  });
});

describe('A3n (RULED FLIP, S5.5w item 5 / Ian Q2 landed) — lateGraceMinutes spaces-only now REFUSES', () => {
  it(
    'lateGraceMinutes="   ": wanted a refusal, nothing changed — was green: saved 0 silently ' +
      '(blank meant "not decided" but the fallback default looked like a real zero)',
    async () => {
      const f = await attendanceFixture('a3n-lategrace');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');

      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: '   ' })));
      expect(paramsOf(to).get('error')).toBe('The late grace minutes — enter a whole number, 0 or more.');
    },
  );

  it('⛔ green, unedited — autoClockOutHour="   " (spaces-only) still saves null ("never")', async () => {
    const f = await attendanceFixture('a3n-autoclockout');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');

    const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { autoClockOutHour: '   ' })));
    expect(paramsOf(to).get('error')).toBeNull();
    const live = await asOrg(f.orgId, (tx) => getLiveConfig(tx, { storeId: f.storeId }));
    expect(live.autoClockOutHour).toBeNull();
  });
});

// =================================================================================================
// F1/F1b/F1n — createAssetAction (DEF-464)
// =================================================================================================

async function assetsFixture(hint: string) {
  const code = uid(`s55q-fa-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
  }
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  return { orgId, storeId, admin: actor(orgId, adminId) };
}

function assetFormData(f: { storeId: string }, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('name', 'Chest freezer');
  fd.set('category', 'appliances');
  fd.set('acquiredOn', '2026-01-15');
  fd.set('cost', '120000.00');
  fd.set('interval', 'monthly');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

async function assetCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from fixed_assets where org_id = ${orgId}`;
  return Number(row!.count);
}

const lifeSentence = (typed: string) => `The useful life — "${typed}" is not a whole number of months from 1 to 1200.`; // T-374 S5 (was: "…must be a whole number of months, 1 or more.")
const LIFE_BLANK_SENTENCE = 'The useful life — enter a whole number of months from 1 to 1200.';

describe('F1 (DEF-464) — usefulLifeMonths="abc" should refuse by name, never print NaN', () => {
  it('wanted: the human sentence, no NaN — was red before this fix: the screen showed "…got NaN." verbatim (plain Error, unsanitised)', async () => {
    const f = await assetsFixture('f1');
    ACTOR_HOLDER.actor = f.admin;
    const { createAssetAction } = await import('../../src/app/fixed-assets/actions');

    const before = await assetCountFor(f.orgId);
    const to = await expectRedirectTo(() => createAssetAction(assetFormData(f, { usefulLifeMonths: 'abc' })));
    const params = paramsOf(to);
    const error = params.get('error');
    expectRuleSentence(error, ASSET_CREATE_RULES.usefulLifeMonths, 'abc');
    expect(error).not.toContain('NaN');
    const after = await assetCountFor(f.orgId);
    expect(after, 'no asset should have been created').toBe(before);
  });

  it('F1b: usefulLifeMonths="0" — wanted: the same human sentence, no "0" leaking through — was red before this fix: the screen showed "…got 0." verbatim', async () => {
    const f = await assetsFixture('f1b');
    ACTOR_HOLDER.actor = f.admin;
    const { createAssetAction } = await import('../../src/app/fixed-assets/actions');

    const before = await assetCountFor(f.orgId);
    const to = await expectRedirectTo(() => createAssetAction(assetFormData(f, { usefulLifeMonths: '0' })));
    const params = paramsOf(to);
    expectRuleSentence(params.get('error'), ASSET_CREATE_RULES.usefulLifeMonths, '0');
    const after = await assetCountFor(f.orgId);
    expect(after, 'no asset should have been created').toBe(before);
  });

  it('F1n (⛔ green, unedited) — blank usefulLifeMonths creates the asset on the policy default', async () => {
    const f = await assetsFixture('f1n');
    ACTOR_HOLDER.actor = f.admin;
    const { createAssetAction } = await import('../../src/app/fixed-assets/actions');

    const before = await assetCountFor(f.orgId);
    const to = await expectRedirectTo(() => createAssetAction(assetFormData(f, {})));
    const params = paramsOf(to);
    expect(params.get('error'), `redirect URL was: ${to}`).toBeNull();
    const after = await assetCountFor(f.orgId);
    expect(after).toBe(before + 1);
  });
});

// =================================================================================================
// T1/T2/T3/T1n — updateTermsAction (DEF-467)
// =================================================================================================

async function existingAsset(f: Awaited<ReturnType<typeof assetsFixture>>): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId: f.storeId,
      name: 'Chest freezer',
      category: 'appliances',
      acquiredOn: '2026-01-15',
      cost: '120000.00',
      usefulLifeMonths: 24,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}

function termsFormData(assetId: string, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('assetId', assetId);
  fd.set('name', 'Chest freezer');
  fd.set('category', 'appliances');
  fd.set('usefulLifeMonths', '24');
  fd.set('interval', 'monthly');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

async function unmappedConstraintCountFor(orgId: string, reasonCode: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from prerequisite_refusals where org_id = ${orgId} and reason_code = ${reasonCode}`;
  return Number(row!.count);
}

describe('T1 (DEF-467) — updateTermsAction usefulLifeMonths="" should refuse before ever reaching the DB', () => {
  it('wanted: the human sentence, unchanged term, no unmapped-constraint row — was red before this fix: the generic fallback sentence, and a row WAS recorded (measured via the fixed_assets_useful_life_positive_check CHECK, unmapped, hit through withOrgPrincipal\'s auto-record chokepoint)', async () => {
    const f = await assetsFixture('t1');
    const assetId = await existingAsset(f);
    ACTOR_HOLDER.actor = f.admin;
    const { updateTermsAction } = await import('../../src/app/fixed-assets/actions');

    const before = await unmappedConstraintCountFor(f.orgId, 'fixed_assets_useful_life_positive_check');
    const to = await expectRedirectTo(() => updateTermsAction(termsFormData(assetId, { usefulLifeMonths: '' })));
    const params = paramsOf(to);
    expectRuleSentence(params.get('error'), ASSET_TERMS_RULES.usefulLifeMonths, '');
    const [row] = await sql<{ useful_life_months: number; needs_review: boolean }[]>`
      select useful_life_months, needs_review from fixed_assets where id = ${assetId}`;
    expect(row!.useful_life_months, 'the term must be unchanged').toBe(24);
    const after = await unmappedConstraintCountFor(f.orgId, 'fixed_assets_useful_life_positive_check');
    expect(after, 'wanted: refused before the DB is ever touched — no new row').toBe(before);
  });

  it('T2: usefulLifeMonths="abc" — wanted: the human sentence, not silently coerced — was red before this fix: a raw 22P02 refusal, not this sentence', async () => {
    const f = await assetsFixture('t2');
    const assetId = await existingAsset(f);
    ACTOR_HOLDER.actor = f.admin;
    const { updateTermsAction } = await import('../../src/app/fixed-assets/actions');

    const to = await expectRedirectTo(() => updateTermsAction(termsFormData(assetId, { usefulLifeMonths: 'abc' })));
    const params = paramsOf(to);
    expectRuleSentence(params.get('error'), ASSET_TERMS_RULES.usefulLifeMonths, 'abc');
    const [row] = await sql<{ useful_life_months: number }[]>`select useful_life_months from fixed_assets where id = ${assetId}`;
    expect(row!.useful_life_months).toBe(24);
  });

  it('T3: usefulLifeMonths="1.5" — wanted: the human sentence, not silently truncated — was red before this fix: a raw integer-type 22P02 refusal, not this sentence', async () => {
    const f = await assetsFixture('t3');
    const assetId = await existingAsset(f);
    ACTOR_HOLDER.actor = f.admin;
    const { updateTermsAction } = await import('../../src/app/fixed-assets/actions');

    const to = await expectRedirectTo(() => updateTermsAction(termsFormData(assetId, { usefulLifeMonths: '1.5' })));
    const params = paramsOf(to);
    expectRuleSentence(params.get('error'), ASSET_TERMS_RULES.usefulLifeMonths, '1.5');
    const [row] = await sql<{ useful_life_months: number }[]>`select useful_life_months from fixed_assets where id = ${assetId}`;
    expect(row!.useful_life_months).toBe(24);
  });

  it('T1n (⛔ green, unedited) — usefulLifeMonths="36" saves, clears needsReview, redirects ok=terms', async () => {
    const f = await assetsFixture('t1n');
    const assetId = await existingAsset(f);
    ACTOR_HOLDER.actor = f.admin;
    const { updateTermsAction } = await import('../../src/app/fixed-assets/actions');

    const to = await expectRedirectTo(() => updateTermsAction(termsFormData(assetId, { usefulLifeMonths: '36' })));
    const params = paramsOf(to);
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe('terms');
    const [row] = await sql<{ useful_life_months: number; needs_review: boolean }[]>`
      select useful_life_months, needs_review from fixed_assets where id = ${assetId}`;
    expect(row!.useful_life_months).toBe(36);
    expect(row!.needs_review).toBe(false);
  });
});

// =================================================================================================
// Y1/Y2/Y3/Y1n — preview13thMonthRun / post13thMonthRun (DEF-465)
// =================================================================================================

async function payrollFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return { ...f, moneyAccountId: drawer!.id };
}

function post13thFormData(f: { storeId: string; moneyAccountId: string }, year: string): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('year', year);
  fd.set('moneyAccountId', f.moneyAccountId);
  return fd;
}

const YEAR_SENTENCE = 'The year must be a whole number from 2020 to 2100.';

describe('Y1 (DEF-465) — post13thMonthRunAction with year="" (a forged post; the screen sends a hidden previewed year)', () => {
  it(
    'wanted: refused by name, nothing written — was red before this fix: OBSERVED VERBATIM (not presumed) — ' +
      '`error` = "nothing to pay for 0 — no employment at this store has posted basic pay for that year." ' +
      "(Number('') === 0 reached post13thMonthRun as year: 0; the roster had no payslips for year 0, so " +
      'preview.payouts was empty and the "nothing to pay" branch fired, not a year-shaped refusal at all)',
    async () => {
      const f = await payrollFixture('y1');
      ACTOR_HOLDER.actor = f.admin;
      const { post13thMonthRunAction } = await import('../../src/app/payroll/thirteenth-month/actions');

      const to = await expectRedirectTo(() => post13thMonthRunAction(post13thFormData(f, '')));
      const params = paramsOf(to);
      expect(params.get('error'), `redirect URL was: ${to}`).toBe(YEAR_SENTENCE);
      const [row] = await sql<{ count: string }[]>`select count(*)::text as count from thirteenth_month_runs where org_id = ${f.orgId}`;
      expect(Number(row!.count), 'nothing should have been written').toBe(0);
    },
  );
});

describe('Y2 (DEF-465) — post13thMonthRun called directly with year: NaN (a forged post, bypassing the screen entirely)', () => {
  it(
    'wanted: refused by name, nothing written — was red before this fix: OBSERVED VERBATIM (not presumed, and NOT ' +
      'the spec\'s own prediction of "a raw database date error — preview queries \'NaN-01-01\' first") — ' +
      '`post13thMonthRun: nothing to pay for NaN — no employment at this store has posted basic pay for that year.` ' +
      '— a NaN year never reached a date literal at all: `basicPayEarnedInYear`/`hasPostedSeparationInYear` compare ' +
      'against it and the postgres driver serialises a bare JS NaN as SQL NULL, so every row-match was vacuously ' +
      'false — same empty-roster shape as Y1, just "NaN" where Y1 has "0", never a crash',
    async () => {
      const f = await payrollFixture('y2');
      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) =>
          post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: NaN, moneyAccountId: f.moneyAccountId }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected year: NaN to be refused at all').toBeInstanceOf(Error);
      const err = caught as Error & { userMessage?: string };
      expect(err.userMessage, 'wanted: a presentable RefusalError, not a plain Error').toBe(YEAR_SENTENCE);
      const [row] = await sql<{ count: string }[]>`select count(*)::text as count from thirteenth_month_runs where org_id = ${f.orgId}`;
      expect(Number(row!.count), 'nothing should have been written').toBe(0);
    },
  );
});

describe('Y3 (DEF-465) — preview13thMonthRun with 2019 and 2101 (out of the 2020-2100 range)', () => {
  it('wanted: refused by name — was red before this fix: an empty preview, not a refusal (silently accepted)', async () => {
    const f = await payrollFixture('y3');
    for (const year of [2019, 2101]) {
      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year }));
      } catch (err) {
        caught = err;
      }
      const err = caught as (Error & { userMessage?: string }) | undefined;
      expect(err, `year ${year}: expected a refusal`).toBeInstanceOf(Error);
      expect(err?.userMessage, `year ${year}`).toBe(YEAR_SENTENCE);
    }
  });
});

describe('Y1n (⛔ green, unedited) — preview13thMonthRun with 2020 and 2026 (in range) does not throw', () => {
  it('resolves normally for both boundary-valid years', async () => {
    const f = await payrollFixture('y1n');
    for (const year of [2020, 2026]) {
      await expect(
        asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year })),
        `year ${year}`,
      ).resolves.toBeDefined();
    }
  });
});
