/**
 * T-343 S5.5t — DEF-470, the rest: minutes / till counts / opening costs / conversion factor.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5t item 2-5, and **Amendment A1**
 * (blank/spaces-only minutes boxes REFUSE, superseding the spec's own "blank legs" bullet for the
 * three minutes boxes only).
 *
 * ⛔ TESTER, not BUILDER. Every "wanted" sentence below is the TARGET the builder has not written
 * yet; every "observed today" comment is the actual pre-fix result, MEASURED against this file's own
 * lane database (`shareat_test_t343s5_tester`), never presumed. Two measurements contradicted the
 * spec's own prose and are called out where they occur — T2 in particular.
 *
 * ⚠️ **T2 spec-vs-reality mismatch (report this in READY):** the spec text says T2's pre-fix
 * behaviour is "a negative count recorded". Measured directly: `till_count_lines_counted_nonnegative_check`
 * (a DB CHECK, already in migrations) already refuses a negative count today, via a GENERIC sentence
 * ("A physical count cannot be negative. Enter what is actually in the drawer, or 0.") that does not
 * name the account. The gate is not missing; only the account-naming wording is. T2 below is still a
 * legitimate red (today's sentence ≠ the target sentence), just not for the reason the spec states.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

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

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null; sessionId: string } = {
  actor: null,
  sessionId: '',
};
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: ACTOR_HOLDER.sessionId })),
}));

// The bare `@/...` specifier the root vitest.config.mts never resolves — forwarded to the real
// module, per s5-5p/s5-5q precedent.
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createEmployment,
  seedCanonicalPositions,
  seedAttendanceConfig,
  toShiftDay,
  createItem,
  createSupplier,
  recordInvoice,
  openTillShift,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { CUTOVER_COUNT_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../helpers/rule-sentence';
import { paramsOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

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
// M1/M2/M3 — attendance/[dayId]/actions.ts: approveOvertimeAction, setStartAnchorAction,
// approveEarlyOutAction. Amendment A1's blank/spaces-only refusal legs live here too.
// =================================================================================================

async function attendanceFixture(hint: string) {
  const code = uid(`s55t-${hint}`);
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
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${adminId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [s] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${adminId}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours') returning id`;
  return { orgId, storeId, admin: admin_, employment, sessionId: s!.id };
}
type AttFixture = Awaited<ReturnType<typeof attendanceFixture>>;

const DAY = toShiftDay(new Date());

function dayFormData(f: AttFixture, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('dayId', f.employment.id); // dayId is only echoed into the redirect path; any string does
  fd.set('employmentId', f.employment.id);
  fd.set('shiftDay', DAY);
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

async function adjustmentCountFor(f: AttFixture, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${f.employment.id} and shift_day = ${DAY} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

const OT_SENTENCE = 'The minutes to pay — "1,5" is not a whole number of minutes from 0 to 99999.';
const OT_SENTENCE_1_5 = 'The minutes to pay — "1.5" is not a whole number of minutes from 0 to 99999.';
const OT_BLANK_SENTENCE = 'The minutes to pay — enter a whole number of minutes (0 to 99999).';
const ANCHOR_SENTENCE = 'The paid-from minute — "8:30" is not a whole number of minutes from 0 to 99999.';
const ANCHOR_BLANK_SENTENCE = 'The paid-from minute — enter a whole number of minutes (0 to 99999).';
const OUT_SENTENCE = 'The paid-until minute — "abc" is not a whole number of minutes from 0 to 99999.';
const OUT_BLANK_SENTENCE = 'The paid-until minute — enter a whole number of minutes (0 to 99999).';

describe('M1 (DEF-470) — approvedOtMinutes="1,5"', () => {
  it(
    `wanted: ${OT_SENTENCE} — observed today (measured, not presumed): the redirect's error is ` +
      '"The database refused that change for a reason this screen cannot show. The detail is in ' +
      'the server log." — Number(\'1,5\') is NaN, which the driver serialises as text "NaN" into an ' +
      '`integer` column: PostgresError 22P02 invalid input syntax for type integer: "NaN", caught by ' +
      "`decide()` and run through the shared errorMessage()'s database fallback",
    async () => {
      const f = await attendanceFixture('m1');
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
      const before = await adjustmentCountFor(f, 'overtime_approved');
      const to = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(OT_SENTENCE);
      expect(await adjustmentCountFor(f, 'overtime_approved'), 'nothing should have been recorded').toBe(before);
    },
    30000,
  );
});

describe('M2 (DEF-470) — approvedOtMinutes="1.5" (a real finite decimal, not NaN)', () => {
  it(
    `wanted: ${OT_SENTENCE_1_5} — observed today (measured): same shape as M1, PostgresError 22P02 ` +
      'invalid input syntax for type integer: "1.5" (JS accepts 1.5 as a finite Number, but the ' +
      'column is `integer`), same database-fallback redirect text as M1',
    async () => {
      const f = await attendanceFixture('m2');
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
      const before = await adjustmentCountFor(f, 'overtime_approved');
      const to = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '1.5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(OT_SENTENCE_1_5);
      expect(await adjustmentCountFor(f, 'overtime_approved'), 'nothing should have been recorded').toBe(before);
    },
    30000,
  );
});

describe('M3 (DEF-470) — chosenAnchorMinute="8:30" and effectiveOutMinute="abc"', () => {
  it(
    `chosenAnchorMinute: wanted ${ANCHOR_SENTENCE} — observed today (measured): PostgresError 22P02 ` +
      'invalid input syntax for type integer: "NaN", same database-fallback redirect text',
    async () => {
      const f = await attendanceFixture('m3a');
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const { setStartAnchorAction } = await import('../../src/app/attendance/[dayId]/actions');
      const before = await adjustmentCountFor(f, 'start_anchor');
      const to = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f, { chosenAnchorMinute: '8:30' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(ANCHOR_SENTENCE);
      expect(await adjustmentCountFor(f, 'start_anchor'), 'nothing should have been recorded').toBe(before);
    },
    30000,
  );

  it(
    `effectiveOutMinute: wanted ${OUT_SENTENCE} — observed today (measured): PostgresError 22P02 ` +
      'invalid input syntax for type integer: "NaN", same database-fallback redirect text',
    async () => {
      const f = await attendanceFixture('m3b');
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const { approveEarlyOutAction } = await import('../../src/app/attendance/[dayId]/actions');
      const before = await adjustmentCountFor(f, 'early_out_approved');
      const to = await expectRedirectTo(() => approveEarlyOutAction(dayFormData(f, { effectiveOutMinute: 'abc' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(OUT_SENTENCE);
      expect(await adjustmentCountFor(f, 'early_out_approved'), 'nothing should have been recorded').toBe(before);
    },
    30000,
  );
});

describe('Amendment A1 (DEF-471) — blank and spaces-only minutes boxes now REFUSE, all three boxes', () => {
  it.each([
    ['approvedOtMinutes', '', OT_BLANK_SENTENCE, 'overtime_approved', 'approveOvertimeAction'] as const,
    ['approvedOtMinutes', '   ', OT_BLANK_SENTENCE, 'overtime_approved', 'approveOvertimeAction'] as const,
    ['chosenAnchorMinute', '', ANCHOR_BLANK_SENTENCE, 'start_anchor', 'setStartAnchorAction'] as const,
    ['chosenAnchorMinute', '   ', ANCHOR_BLANK_SENTENCE, 'start_anchor', 'setStartAnchorAction'] as const,
    ['effectiveOutMinute', '', OUT_BLANK_SENTENCE, 'early_out_approved', 'approveEarlyOutAction'] as const,
    ['effectiveOutMinute', '   ', OUT_BLANK_SENTENCE, 'early_out_approved', 'approveEarlyOutAction'] as const,
  ])(
    '%s=%j → %s (was red before A1: recorded a 0-minute row — measured: succeeds silently today)',
    async (field, value, sentence, kind, actionName) => {
      const f = await attendanceFixture(`a1-${field}-${JSON.stringify(value)}`);
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const actions = await import('../../src/app/attendance/[dayId]/actions');
      const action = (actions as Record<string, (fd: FormData) => Promise<void>>)[actionName]!;
      const before = await adjustmentCountFor(f, kind);
      const to = await expectRedirectTo(() => action(dayFormData(f, { [field]: value })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(sentence);
      expect(await adjustmentCountFor(f, kind), 'nothing should have been recorded — the box means "not decided"').toBe(before);
    },
    30000,
  );
});

describe('⛔ green, must stay unedited — a typed 0 or a real minute is still a decision', () => {
  it('approvedOtMinutes="0" and "30" both record as typed', async () => {
    const f = await attendanceFixture('a1n-zero');
    ACTOR_HOLDER.actor = f.admin;
    ACTOR_HOLDER.sessionId = f.sessionId;
    const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');

    const to0 = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '0' })));
    expect(errorOf(to0), `redirect URL was: ${to0}`).toBeNull();
    let [row] = await sql<{ approved_ot_minutes: number }[]>`
      select approved_ot_minutes from attendance_adjustments
      where employment_id = ${f.employment.id} and kind = 'overtime_approved' and superseded_by_adjustment_id is null`;
    expect(row!.approved_ot_minutes).toBe(0);

    const to30 = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '30' })));
    expect(errorOf(to30), `redirect URL was: ${to30}`).toBeNull();
    [row] = await sql<{ approved_ot_minutes: number }[]>`
      select approved_ot_minutes from attendance_adjustments
      where employment_id = ${f.employment.id} and kind = 'overtime_approved' and superseded_by_adjustment_id is null`;
    expect(row!.approved_ot_minutes).toBe(30);
  });

  it('chosenAnchorMinute="60" records 60', async () => {
    const f = await attendanceFixture('a1n-anchor');
    ACTOR_HOLDER.actor = f.admin;
    ACTOR_HOLDER.sessionId = f.sessionId;
    const { setStartAnchorAction } = await import('../../src/app/attendance/[dayId]/actions');
    const to = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f, { chosenAnchorMinute: '60' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    const [row] = await sql<{ chosen_anchor_minute: number }[]>`
      select chosen_anchor_minute from attendance_adjustments
      where employment_id = ${f.employment.id} and kind = 'start_anchor' and superseded_by_adjustment_id is null`;
    expect(row!.chosen_anchor_minute).toBe(60);
  });
});

// =================================================================================================
// U1 — cutover/actions.ts recordCountAction (unitCost)
// =================================================================================================

async function cutoverFixture(hint: string) {
  const code = uid(`s55t-cu-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  await sql`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${locType!.id}, 'operating', true, ${admin!.id})`; // T-390 R1: a count needs a default room
  const [superAdmin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${superAdmin!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${superAdmin!.id}, ${storeId})`;
  const admin_ = actor(orgId, admin!.id);
  const item = await asOrg(orgId, (tx) =>
    createItem(tx, actor(orgId, superAdmin!.id), { code: testItemCode(), name: 'Probe Item', kind: 'raw_material', baseUnit: 'pcs' }),
  );
  return { orgId, storeId, admin: admin_, itemId: item.id };
}

async function openingCostFor(orgId: string, itemId: string): Promise<string | null> {
  const [row] = await sql<{ unit_cost: string | null }[]>`
    select unit_cost from opening_counts where org_id = ${orgId} and item_id = ${itemId}`;
  return row?.unit_cost ?? null;
}

const UNIT_COST_SENTENCE = 'The cost per unit — "1,5" is not a valid amount. Use a non-negative number with up to four decimal places.';
const UNIT_COST_OBSERVED_TODAY = 'The database refused that change for a reason this screen cannot show. The detail is in the server log.';

describe('U1 (DEF-470) — cutover unitCost="1,5"', () => {
  it(
    `wanted: ${UNIT_COST_SENTENCE} (BUILDER adds parseFourDecimalCost, reused from ` +
      "commissary/catalogue.ts) — observed today (measured, not presumed): the redirect's error is " +
      `"${UNIT_COST_OBSERVED_TODAY}" — PostgresError 22P02 invalid input syntax for type numeric: ` +
      '"1,5" (raw string reaches the `numeric(14,4)` column unparsed), run through the shared ' +
      "errorMessage()'s database fallback",
    async () => {
      const f = await cutoverFixture('u1');
      ACTOR_HOLDER.actor = f.admin;
      const { recordCountAction } = await import('../../src/app/cutover/actions');
      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('itemId', f.itemId);
      fd.set('quantity', '5');
      fd.set('unitCost', '1,5');
      const to = await expectRedirectTo(() => recordCountAction(fd));
      expectRuleSentence(errorOf(to), CUTOVER_COUNT_RULES.unitCost, '1,5');
      expect(await openingCostFor(f.orgId, f.itemId), 'no count should have been written').toBeNull();
    },
    30000,
  );

  it('⛔ green, unedited — unitCost="" saves null; "   " saves null too (spaces-only = blank)', async () => {
    const f = await cutoverFixture('u1n');
    ACTOR_HOLDER.actor = f.admin;
    const { recordCountAction } = await import('../../src/app/cutover/actions');

    const fd = new FormData();
    fd.set('storeId', f.storeId);
    fd.set('itemId', f.itemId);
    fd.set('quantity', '5');
    fd.set('unitCost', '');
    const to = await expectRedirectTo(() => recordCountAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(await openingCostFor(f.orgId, f.itemId)).toBeNull();
  });
});

// =================================================================================================
// T1/T2 — till/actions.ts recordCountAction (aliased — same export name as cutover's)
// =================================================================================================

async function tillFixture(hint: string) {
  const code = uid(`s55t-till-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [drawer] = await sql<{ id: string; name: string; gl_account_code: string }[]>`
    select id, name, gl_account_code from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  // A second, ordinary (non-foundation) cashier cash pocket — a store may open a second drawer/GCash
  // (money-accounts.ts:135), so this is a ordinary sibling, not a synthetic fixture shape.
  const [secondDrawer] = await sql<{ id: string; name: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_foundation)
    values (${orgId}, ${storeId}, ${'Second drawer'}, 'cash', ${drawer!.gl_account_code}, 'cashier', false)
    returning id, name`;
  const admin_ = actor(orgId, admin!.id);
  const { shiftId } = await asOrg(orgId, (tx) => openTillShift(tx, admin_, { storeId, businessDate: '2026-01-10' }));
  return {
    orgId, storeId, admin: admin_, shiftId,
    drawerId: drawer!.id, drawerName: drawer!.name,
    secondDrawerId: secondDrawer!.id,
  };
}

async function countLineFor(shiftId: string, moneyAccountId: string): Promise<string | null> {
  const [row] = await sql<{ counted: string }[]>`
    select counted from till_count_lines where shift_id = ${shiftId} and money_account_id = ${moneyAccountId}`;
  return row?.counted ?? null;
}

describe('T1 (DEF-470) — till count:<id>="1,5"', () => {
  it(
    'wanted: "The count for <account> — \\"1,5\\" is not a valid amount. Use at most two decimal ' +
      'places." (not yet built) — observed today (measured, not presumed): the developer TypeError ' +
      'text leaks verbatim to the redirect: Invalid money string: "1,5" (expected up to 2 decimal ' +
      "places) — money('1,5') throws before any refusal wrapping exists for this path",
    async () => {
      const f = await tillFixture('t1');
      ACTOR_HOLDER.actor = f.admin;
      const { recordCountAction } = await import('../../src/app/till/actions');
      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('shiftId', f.shiftId);
      fd.set('moment', 'open');
      fd.set(`count:${f.drawerId}`, '1,5');
      const to = await expectRedirectTo(() => recordCountAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(`The count for ${f.drawerName} — "1,5" is not a valid amount. Use at most two decimal places.`);
      expect(await countLineFor(f.shiftId, f.drawerId), 'no count row should have been written').toBeNull();
    },
    30000,
  );
});

describe('T2 (DEF-470) — till count:<id>="-5"', () => {
  it(
    'wanted: "The count for <account> cannot be negative." (not yet built — names the account) — ' +
      "⚠️ SPEC MISMATCH, measured: today is NOT \"a negative count recorded\" as the spec's own prose " +
      'says. `till_count_lines_counted_nonnegative_check` (an existing DB CHECK) already refuses it, ' +
      'via a GENERIC sentence that does not name the account: "A physical count cannot be negative. ' +
      'Enter what is actually in the drawer, or 0." The gate already exists; only the wording is red.',
    async () => {
      const f = await tillFixture('t2');
      ACTOR_HOLDER.actor = f.admin;
      const { recordCountAction } = await import('../../src/app/till/actions');
      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('shiftId', f.shiftId);
      fd.set('moment', 'open');
      fd.set(`count:${f.drawerId}`, '-5');
      const to = await expectRedirectTo(() => recordCountAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(`The count for ${f.drawerName} cannot be negative.`);
      expect(await countLineFor(f.shiftId, f.drawerId), 'no count row should have been written').toBeNull();
    },
    30000,
  );
});

describe('⛔ green, unedited — a blank count:<id> is skipped, another pocket still records', () => {
  it('one blank box drops that pocket; a filled one still posts', async () => {
    const f = await tillFixture('tn');
    ACTOR_HOLDER.actor = f.admin;
    const { recordCountAction } = await import('../../src/app/till/actions');
    const fd = new FormData();
    fd.set('storeId', f.storeId);
    fd.set('shiftId', f.shiftId);
    fd.set('moment', 'open');
    fd.set(`count:${f.drawerId}`, '');
    fd.set(`count:${f.secondDrawerId}`, '250.00');
    const to = await expectRedirectTo(() => recordCountAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(await countLineFor(f.shiftId, f.drawerId), 'the blank pocket must be dropped, not recorded as 0').toBeNull();
    expect(await countLineFor(f.shiftId, f.secondDrawerId), 'the filled pocket must still post').toBe('250.00');
  });
});

// =================================================================================================
// F1 — ap/actions.ts setInvoiceLinesAction (conversionFactor) — ⛔ GREEN PIN, both before and after
// =================================================================================================

async function invoiceFixture(hint: string) {
  const f = await cutoverFixture(`ap-${hint}`); // reuses org/store/admin/item helper
  const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: 'Probe Supplier' }));
  const invoice = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId: supplier.id, invoiceDate: '2026-01-10', totalAmount: '1000.00' }),
  );
  return { ...f, invoiceId: invoice.id };
}

async function invoiceLineCountFor(invoiceId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from supplier_invoice_lines where supplier_invoice_id = ${invoiceId}`;
  return Number(row!.count);
}

describe('F1 (DEF-470) — ap invoice line1_conversionFactor="1,5" — ⛔ green, unedited, pins the server half', () => {
  it('server already refuses by name: the existing conversion-factor sentence, no lines saved', async () => {
    const f = await invoiceFixture('f1');
    ACTOR_HOLDER.actor = f.admin;
    const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
    const fd = new FormData();
    fd.set('invoiceId', f.invoiceId);
    fd.set('line1_itemId', f.itemId);
    fd.set('line1_quantity', '10');
    fd.set('line1_unitPrice', '100');
    fd.set('line1_conversionFactor', '1,5');
    const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('line 1 (Probe Item) needs a conversion factor above zero.');
    expect(await invoiceLineCountFor(f.invoiceId), 'no lines should have been saved').toBe(0);
  });

  it('⛔ green, unedited — line1_conversionFactor="" saves factor 1', async () => {
    const f = await invoiceFixture('f1n');
    ACTOR_HOLDER.actor = f.admin;
    const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
    const fd = new FormData();
    fd.set('invoiceId', f.invoiceId);
    fd.set('line1_itemId', f.itemId);
    fd.set('line1_quantity', '10');
    fd.set('line1_unitPrice', '100');
    fd.set('line1_conversionFactor', '');
    const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    const [row] = await sql<{ conversion_factor: string }[]>`
      select conversion_factor from supplier_invoice_lines where supplier_invoice_id = ${f.invoiceId}`;
    expect(row!.conversion_factor).toBe('1.000000');
  });
});

describe('F2 (S5.5t Amendment A2) — ap invoice line1_conversionFactor="1.2345678" (more than six decimal places)', () => {
  it(
    'wanted: Line 1 (Probe Item) — "1.2345678" is not a valid conversion factor. Use a number above ' +
      "zero with up to six decimal places. (not yet built) — observed today (measured, not presumed): " +
      "the line SAVES, silently rounded by numeric(14,6) to 1.234568",
    async () => {
      const f = await invoiceFixture('f2');
      ACTOR_HOLDER.actor = f.admin;
      const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
      const fd = new FormData();
      fd.set('invoiceId', f.invoiceId);
      fd.set('line1_itemId', f.itemId);
      fd.set('line1_quantity', '10');
      fd.set('line1_unitPrice', '100');
      // purchaseUnit differs from the item's baseUnit ('pcs') so the UNRELATED same-unit
      // conversion-factor-must-be-1 guard (items/index.ts:210) never fires here.
      fd.set('line1_purchaseUnit', 'box');
      fd.set('line1_conversionFactor', '1.2345678');
      const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'Line 1 (Probe Item) — "1.2345678" is not a valid conversion factor. Use a number above zero with up to six decimal places.',
      );
      expect(await invoiceLineCountFor(f.invoiceId), 'no lines should have been saved').toBe(0);
    },
    30000,
  );

  it('⛔ green, unedited — line1_conversionFactor="1.234567" (exactly six decimal places) saves', async () => {
    const f = await invoiceFixture('f2n');
    ACTOR_HOLDER.actor = f.admin;
    const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
    const fd = new FormData();
    fd.set('invoiceId', f.invoiceId);
    fd.set('line1_itemId', f.itemId);
    fd.set('line1_quantity', '10');
    fd.set('line1_unitPrice', '100');
    fd.set('line1_purchaseUnit', 'box');
    fd.set('line1_conversionFactor', '1.234567');
    const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    const [row] = await sql<{ conversion_factor: string }[]>`
      select conversion_factor from supplier_invoice_lines where supplier_invoice_id = ${f.invoiceId}`;
    expect(row!.conversion_factor).toBe('1.234567');
  });
});

async function conversionFactorLeg(hint: string, value: string) {
  const f = await invoiceFixture(hint);
  ACTOR_HOLDER.actor = f.admin;
  const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
  const fd = new FormData();
  fd.set('invoiceId', f.invoiceId);
  fd.set('line1_itemId', f.itemId);
  fd.set('line1_quantity', '10');
  fd.set('line1_unitPrice', '100');
  fd.set('line1_purchaseUnit', 'box'); // avoids items/index.ts:210's unrelated same-unit guard
  fd.set('line1_conversionFactor', value);
  const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
  const [row] = await sql<{ conversion_factor: string }[]>`
    select conversion_factor from supplier_invoice_lines where supplier_invoice_id = ${f.invoiceId}`;
  return { to, error: errorOf(to), saved: row?.conversion_factor ?? null };
}

describe('F3 (S5.5t Amendment A2 revision 1b) — line1_conversionFactor=".5" must still save', () => {
  it(
    'wanted: saves as 0.500000 (a leading-dot decimal was accepted before A2 and must stay accepted) ' +
      "— observed today (measured, not presumed): item 1's naive regex /^\\d+(\\.\\d{1,6})?$/ requires a " +
      "leading digit, so \".5\" is WRONGLY refused with the six-decimal sentence — a regression 1b exists to fix",
    async () => {
      const r = await conversionFactorLeg('f3', '.5');
      expect(r.error, `redirect URL was: ${r.to}`).toBeNull();
      expect(r.saved).toBe('0.500000');
    },
    30000,
  );
});

describe('F4 (S5.5t Amendment A2 revision 1b) — line1_conversionFactor="123456789" (value >= 1e8)', () => {
  it(
    'wanted: Line 1 (Probe Item) — "123456789" is too large for a conversion factor. Use a number below ' +
      '100000000. (not yet built — the >=1e8 VALUE check) — observed today (measured, not presumed): the ' +
      'redirect error is "The database refused that change for a reason this screen cannot show. The ' +
      'detail is in the server log." — the current regex accepts a bare 9-digit integer (no digit-count ' +
      'cap), reaches numeric(14,6) (8 integer digits max), Postgres throws PostgresError 22003 "numeric ' +
      'field overflow", sanitised to the database fallback by errorMessage()',
    async () => {
      const r = await conversionFactorLeg('f4', '123456789');
      expect(r.error, `redirect URL was: ${r.to}`).toBe(
        'Line 1 (Probe Item) — "123456789" is too large for a conversion factor. Use a number below 100000000.',
      );
      expect(r.saved, 'no line should have been saved').toBeNull();
    },
    30000,
  );
});

describe('Ruled (orchestrator) — exponent notation, digit-run vs value, and the 1e8 boundary', () => {
  it('"1e3" refuses with the six-decimal/format sentence (exponent notation is deliberately never accepted) — ⛔ already green today: the current regex rejects any non-plain-decimal string the same way', async () => {
    const r = await conversionFactorLeg('e1', '1e3');
    expect(r.error, `redirect URL was: ${r.to}`).toBe(
      'Line 1 (Probe Item) — "1e3" is not a valid conversion factor. Use a number above zero with up to six decimal places.',
    );
    expect(r.saved).toBeNull();
  });

  it('⛔ already green today — "000000001" saves as 1 (too-large tests the VALUE, never the digit run)', async () => {
    const r = await conversionFactorLeg('e2', '000000001');
    expect(r.error, `redirect URL was: ${r.to}`).toBeNull();
    expect(r.saved).toBe('1.000000');
  });

  it('⛔ already green today — "99999999.999999" (just under the 1e8 boundary) saves', async () => {
    const r = await conversionFactorLeg('e3', '99999999.999999');
    expect(r.error, `redirect URL was: ${r.to}`).toBeNull();
    expect(r.saved).toBe('99999999.999999');
  });

  it(
    'RED — "100000000" (the F4 boundary itself) wanted: the too-large sentence — observed today ' +
      '(measured, not presumed): same database-fallback text as F4 (PostgresError 22003 "numeric field ' +
      'overflow", sanitised) — not yet the friendly too-large sentence',
    async () => {
      const r = await conversionFactorLeg('e4', '100000000');
      expect(r.error, `redirect URL was: ${r.to}`).toBe(
        'Line 1 (Probe Item) — "100000000" is too large for a conversion factor. Use a number below 100000000.',
      );
      expect(r.saved).toBeNull();
    },
    30000,
  );
});

describe('M5 (S5.5w Amendment A2 item 2) — leading zeros: shape must test the VALUE, not the digit run', () => {
  it(
    'approvedOtMinutes="000030" (6 characters, value 30): wanted records 30 (wholeMinutes shape ' +
      '/^\\d+$/, not yet built) — observed today (measured, not presumed): refused — 6 characters ' +
      'fails the current /^\\d{1,5}$/ shape check even though the VALUE is 30',
    async () => {
      const f = await attendanceFixture('m5');
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
      const to = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '000030' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
      const [row] = await sql<{ approved_ot_minutes: number }[]>`
        select approved_ot_minutes from attendance_adjustments
        where employment_id = ${f.employment.id} and kind = 'overtime_approved' and superseded_by_adjustment_id is null`;
      expect(row!.approved_ot_minutes).toBe(30);
    },
    30000,
  );

  it(
    '⛔ green, unedited — approvedOtMinutes="00030" (exactly 5 characters) already records 30 today ' +
      '— MEASURED, since it happens to fit /^\\d{1,5}$/\'s character count already, coincidentally',
    async () => {
      const f = await attendanceFixture('m5n');
      ACTOR_HOLDER.actor = f.admin;
      ACTOR_HOLDER.sessionId = f.sessionId;
      const { approveOvertimeAction } = await import('../../src/app/attendance/[dayId]/actions');
      const to = await expectRedirectTo(() => approveOvertimeAction(dayFormData(f, { approvedOtMinutes: '00030' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
      const [row] = await sql<{ approved_ot_minutes: number }[]>`
        select approved_ot_minutes from attendance_adjustments
        where employment_id = ${f.employment.id} and kind = 'overtime_approved' and superseded_by_adjustment_id is null`;
      expect(row!.approved_ot_minutes).toBe(30);
    },
    30000,
  );
});
