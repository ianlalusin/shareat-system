/**
 * T-343 S5.5w — DEF-472 census, the rest. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §"S5.5w — build" items 3-5, TESTER paths note.
 *
 * ⛔ TESTER, not BUILDER. Every "wanted" sentence is the TARGET the builder has not written yet;
 * every "observed today" comment is the actual pre-fix result, MEASURED against this file's own
 * lane database (`shareat_test_t343s5_tester`), never presumed.
 *
 * ⚠️ Spec-vs-reality mismatch, measured (report this in READY, T2-in-S5.5t style): the census says
 * IntField '70' (anchor window) is a NEW red the builder's range check fixes. Measured: an
 * `anchorWindowMinutes` value of 70 is ALREADY refused today, by an EXISTING mapped DB CHECK
 * (`store_attendance_config_anchor_window_check` -> "The anchor window must be between 0 and 60
 * minutes.", `constraint-messages.ts:60`) — the gate already exists; only the WORDING changes (to
 * name the typed value and say "whole number from 0 to 60").
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

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createItem,
  createSupplier,
  recordInvoice,
  recordOpeningCount,
  createPrepaidItem,
  seedAttendanceConfig,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
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
// Quantity comma-leg — ap/actions.ts setInvoiceLinesAction, line quantity
// =================================================================================================

async function orgFixture(hint: string, opts: { superAdmin?: boolean } = {}) {
  const code = uid(`s55w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  let superActor: Actor | undefined;
  if (opts.superAdmin) {
    const [sa] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${sa!.id}, ${orgId}, 'super_admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${sa!.id}, ${storeId})`;
    superActor = actor(orgId, sa!.id);
  }
  return { orgId, storeId, admin: actor(orgId, admin!.id), superActor };
}

async function invoiceFixture(hint: string) {
  const f = await orgFixture(hint, { superAdmin: true });
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superActor!, { code: uid('SKU'), name: 'Probe Item', kind: 'raw_material', baseUnit: 'kg' }),
  );
  const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: 'Probe Supplier' }));
  const invoice = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId: supplier.id, invoiceDate: '2026-01-10', totalAmount: '1000.00' }),
  );
  return { ...f, itemId: item.id, invoiceId: invoice.id };
}

async function invoiceLineCountFor(invoiceId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from supplier_invoice_lines where supplier_invoice_id = ${invoiceId}`;
  return Number(row!.count);
}

describe('Q1 (S5.5w) — ap invoice line1_quantity="1,5"', () => {
  it(
    'wanted: Line 1\'s quantity — "1,5" is not a valid quantity. Use at most three decimal places. ' +
      '(BUILDER routes it through parseQuantityInput, not yet built) — observed today (measured, ' +
      'not presumed): Number(\'1,5\') is NaN, which fails the plain `!(qty > 0)` guard first',
    async () => {
      const f = await invoiceFixture('q1');
      ACTOR_HOLDER.actor = f.admin;
      const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
      const fd = new FormData();
      fd.set('invoiceId', f.invoiceId);
      fd.set('line1_itemId', f.itemId);
      fd.set('line1_quantity', '1,5');
      fd.set('line1_purchaseUnit', 'box');
      fd.set('line1_unitPrice', '100');
      const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        "Line 1's quantity — \"1,5\" is not a valid quantity. Use at most three decimal places.",
      );
      expect(await invoiceLineCountFor(f.invoiceId), 'no lines should have been saved').toBe(0);
    },
    30000,
  );
});

// =================================================================================================
// Cutover quantity negative guard
// =================================================================================================

async function cutoverFixture(hint: string) {
  const f = await orgFixture(hint, { superAdmin: true });
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superActor!, { code: uid('SKU'), name: 'Cutover Item', kind: 'raw_material', baseUnit: 'kg' }),
  );
  return { ...f, itemId: item.id };
}

async function openingQuantityFor(orgId: string, itemId: string): Promise<string | null> {
  const [row] = await sql<{ quantity: string | null }[]>`select quantity from opening_counts where org_id = ${orgId} and item_id = ${itemId}`;
  return row?.quantity ?? null;
}

describe('C1 (S5.5w) — cutover recordOpeningCount quantity="-5"', () => {
  it(
    'wanted: A count cannot be negative. (BUILDER converts the plain `< 0` guard to refuse(), not ' +
      'yet built) — observed today (measured, not presumed): a plain, function-prefixed Error',
    async () => {
      const f = await cutoverFixture('c1');
      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) => recordOpeningCount(tx, f.admin, { storeId: f.storeId, itemId: f.itemId, quantity: '-5' }));
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected a negative quantity to be refused at all').toBeInstanceOf(Error);
      const err = caught as Error & { userMessage?: string };
      expect(err.userMessage, 'wanted a presentable RefusalError — was red: a plain Error, no userMessage').toBe(
        'A count cannot be negative.',
      );
      expect(await openingQuantityFor(f.orgId, f.itemId), 'no count should have been written').toBeNull();
    },
    30000,
  );
});

// =================================================================================================
// Prepaid legs — totalCost, coverageMonths (create, no range guard today)
// =================================================================================================

function prepaidFormData(f: { storeId: string }, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('name', 'Fire insurance 2026');
  fd.set('category', 'insurance');
  fd.set('coverageStartDate', '2026-01-01');
  fd.set('coverageMonths', '12');
  fd.set('totalCost', '24000.00');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}
async function prepaidItemCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from prepaid_items where org_id = ${orgId}`;
  return Number(row!.count);
}

describe('P1 (S5.5w) — prepaid create totalCost="1,5"', () => {
  it(
    'wanted: The total cost — "1,5" is not a valid amount. Use at most two decimal places. (BUILDER ' +
      'parses via parseMoneyInput first, not yet built) — observed today (measured, not presumed): ' +
      "Number('1,5') is NaN, NaN < threshold is false, so the guard passes and the raw string " +
      'reaches the insert, producing a raw Postgres error, sanitised to the database fallback',
    async () => {
      const f = await orgFixture('p1');
      ACTOR_HOLDER.actor = f.admin;
      const { createPrepaidItemAction } = await import('../../src/app/prepaid/actions');
      const before = await prepaidItemCountFor(f.orgId);
      const to = await expectRedirectTo(() => createPrepaidItemAction(prepaidFormData(f, { totalCost: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'The total cost — "1,5" is not a valid amount. Use at most two decimal places.',
      );
      expect(await prepaidItemCountFor(f.orgId), 'no item should have been created').toBe(before);
    },
    30000,
  );
});

describe('P2 (S5.5w) — prepaid create coverageMonths blank', () => {
  it(
    'wanted: The coverage — enter a whole number of months from 1 to 120. (BUILDER\'s wholeMonths ' +
      'helper, not yet built) — observed today (measured, not presumed): Number(\'\') is 0, which is ' +
      'not caught by any app-level guard and reaches the unmapped prepaid_items_coverage_months_check',
    async () => {
      const f = await orgFixture('p2');
      ACTOR_HOLDER.actor = f.admin;
      const { createPrepaidItemAction } = await import('../../src/app/prepaid/actions');
      const before = await prepaidItemCountFor(f.orgId);
      const to = await expectRedirectTo(() => createPrepaidItemAction(prepaidFormData(f, { coverageMonths: '' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The coverage — enter a whole number of months from 1 to 120.');
      expect(await prepaidItemCountFor(f.orgId), 'no item should have been created').toBe(before);
    },
    30000,
  );
});

describe('P3 (S5.5w) — prepaid create coverageMonths="1,5"', () => {
  it(
    'wanted: The coverage — "1,5" is not a whole number of months from 1 to 120. — observed today ' +
      "(measured, not presumed): Number('1,5') is NaN, reaches the unmapped CHECK the same way blank does",
    async () => {
      const f = await orgFixture('p3');
      ACTOR_HOLDER.actor = f.admin;
      const { createPrepaidItemAction } = await import('../../src/app/prepaid/actions');
      const before = await prepaidItemCountFor(f.orgId);
      const to = await expectRedirectTo(() => createPrepaidItemAction(prepaidFormData(f, { coverageMonths: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The coverage — "1,5" is not a whole number of months from 1 to 120.');
      expect(await prepaidItemCountFor(f.orgId), 'no item should have been created').toBe(before);
    },
    30000,
  );
});

describe('⛔ green, unedited — prepaid create totalCost="" / coverageMonths="24" (a valid whole number) behave as today', () => {
  it('coverageMonths="24" creates the item (green pin — this value was never the problem)', async () => {
    const f = await orgFixture('p-green');
    ACTOR_HOLDER.actor = f.admin;
    const { createPrepaidItemAction } = await import('../../src/app/prepaid/actions');
    const before = await prepaidItemCountFor(f.orgId);
    const to = await expectRedirectTo(() => createPrepaidItemAction(prepaidFormData(f, { coverageMonths: '24' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(await prepaidItemCountFor(f.orgId)).toBe(before + 1);
  });
});

// =================================================================================================
// Attendance settings — IntField (comma/decimal/range/blank) and dec2 (NumField)
// =================================================================================================

async function attendanceFixture(hint: string) {
  const f = await orgFixture(hint);
  await asOrg(f.orgId, (tx) => seedAttendanceConfig(tx, { orgId: f.orgId, storeId: f.storeId, effectiveFrom: '2026-01-01' }));
  return f;
}

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
async function anchorWindowFor(f: { orgId: string; storeId: string }): Promise<number> {
  const [row] = await sql<{ anchor_window_minutes: number }[]>`
    select anchor_window_minutes from store_attendance_config where store_id = ${f.storeId} and revoked_at is null`;
  return row!.anchor_window_minutes;
}
async function halfDayHoursFor(f: { orgId: string; storeId: string }): Promise<string> {
  const [row] = await sql<{ half_day_hours: string }[]>`
    select half_day_hours from store_attendance_config where store_id = ${f.storeId} and superseded_at is null`;
  return row!.half_day_hours;
}

describe('⛔ green, unedited — anchorWindowMinutes="1,5" already gets S5.5q\'s "is not a number" sentence (order is load-bearing)', () => {
  it('measured: Number(\'1,5\') is NaN, so int()\'s existing finiteness check fires first — this leg is unaffected by S5.5w', async () => {
    const f = await attendanceFixture('int-comma');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
    const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { anchorWindowMinutes: '1,5' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The anchor window — "1,5" is not a number.');
  });
});

describe('I1 (S5.5w) — anchorWindowMinutes="1.5" (finite, non-integer)', () => {
  it(
    'wanted: The anchor window — "1.5" is not a whole number from 0 to 60. (not yet built) — ' +
      "observed today (measured, not presumed): Math.trunc(1.5) silently saves 1",
    async () => {
      const f = await attendanceFixture('i1');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { anchorWindowMinutes: '1.5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The anchor window — "1.5" is not a whole number from 0 to 60.');
    },
    30000,
  );
});

describe('I2 (S5.5w) — anchorWindowMinutes="70" (out of range) — ⚠️ SPEC MISMATCH, see file header', () => {
  it(
    'wanted: The anchor window — "70" is not a whole number from 0 to 60. — observed today (measured, ' +
      'not presumed): ALREADY refused, by the existing mapped DB CHECK, with different wording: ' +
      '"The anchor window must be between 0 and 60 minutes."',
    async () => {
      const f = await attendanceFixture('i2');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { anchorWindowMinutes: '70' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The anchor window — "70" is not a whole number from 0 to 60.');
    },
    30000,
  );
});

describe('Q2 (Ian ruled) — blank IntField refuses; autoClockOutHour stays "never"', () => {
  it(
    'lateGraceMinutes="" wanted: The late grace minutes — enter a whole number from 0 to 60000, or ' +
      'more. — observed today (measured, not presumed): saves the fallback default (0) silently, ok banner',
    async () => {
      const f = await attendanceFixture('q2-blank');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: '' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The late grace minutes — enter a whole number, 0 or more.');
    },
    30000,
  );

  it(
    'lateGraceMinutes="   " (spaces-only = blank) same refusal',
    async () => {
      const f = await attendanceFixture('q2-spaces');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: '   ' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The late grace minutes — enter a whole number, 0 or more.');
    },
    30000,
  );

  it('⛔ green, unedited — autoClockOutHour="" still saves null ("never")', async () => {
    const f = await attendanceFixture('q2-autoclockout');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
    const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { autoClockOutHour: '' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
  });
});

describe('D1 (S5.5w) — dec2 field requiredHoursPerShift', () => {
  it(
    'blank wanted: The required hours / shift — enter a number. — observed today (measured, not ' +
      'presumed): the raw empty string reaches numeric(4,2), a raw Postgres syntax error, sanitised ' +
      'to the database fallback',
    async () => {
      const f = await attendanceFixture('d1-blank');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { requiredHoursPerShift: '' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The required hours / shift — enter a number.');
    },
    30000,
  );

  it(
    'malformed "1,5" wanted: ...is not a valid number. Use at most two decimal places. — observed ' +
      'today (measured, not presumed): raw Postgres syntax error, sanitised to the database fallback',
    async () => {
      const f = await attendanceFixture('d1-malformed');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { requiredHoursPerShift: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'The required hours / shift — "1,5" is not a valid number. Use at most two decimal places.',
      );
    },
    30000,
  );

  it(
    'below-min "0.3" wanted: ...has to be at least 0.5. — observed today (measured, not presumed): ' +
      '0.3 is > 0, so it passes the ONLY check that exists today (store_attendance_config_positive_' +
      'hours_check) and saves silently, below the future minimum — halfDayHours dropped to "0.1" in ' +
      'this fixture so the unrelated half_day_below_required CHECK does not also fire',
    async () => {
      const f = await attendanceFixture('d1-min');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() =>
        updateAttendanceConfigAction(attendanceFormData(f, { requiredHoursPerShift: '0.3', halfDayHours: '0.1' })),
      );
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The required hours / shift has to be at least 0.5.');
    },
    30000,
  );
});

describe('D3/D4/D5/D6 (S5.5w Amendment A3 item 1) — dec2 widened to /^(?=.*\\d)\\d*(?:\\.\\d{0,2})?$/, checked against the numeric(4,2) ceiling 99.99', () => {
  it('D3 halfDayHours=".5" saves 0.5 (builder landed — was red: refused by the old digit-capped shape)', async () => {
    const f = await attendanceFixture('d3');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
    const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { halfDayHours: '.5' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(await halfDayHoursFor(f)).toBe('0.50');
  });

  it('D4 halfDayHours="005" saves 5 (builder landed — was red: refused by the old digit-capped shape)', async () => {
    const f = await attendanceFixture('d4');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
    const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { halfDayHours: '005' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(await halfDayHoursFor(f)).toBe('5.00');
  });

  it('D5 halfDayHours="100" → "The half-day hours has to be at most 99.99." (builder landed — was red: wrong-reason shape refusal)', async () => {
    const f = await attendanceFixture('d5');
    ACTOR_HOLDER.actor = f.admin;
    const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
    const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { halfDayHours: '100' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The half-day hours has to be at most 99.99.');
  });

  it(
    '⛔ green, unedited — D6 requiredHoursPerShift="8." saves 8 — ⚠️ SPEC MISMATCH: the landed regex ' +
      'is /^(?=.*\\d)\\d*(?:\\.\\d{0,2})?$/ (note \\d{0,2}, not \\d{1,2}), which already allows a trailing ' +
      'dot with zero fraction digits — this is not a not-yet-built widening, it already saves today',
    async () => {
      const f = await attendanceFixture('d6');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { requiredHoursPerShift: '8.' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    },
  );
});

describe('O1 (S5.5w Amendment A3 item 2) — overtimeMode="fixed" + blank overtimeFixedHourly — ⚠️ SPEC MISMATCH, see below', () => {
  it(
    'wanted (Ian, 2026-09-28): "Enter the fixed hourly overtime rate, or pick a different overtime ' +
      'mode." — observed today (measured, not presumed): ALREADY refused, but by the pre-existing ' +
      'mapped DB CHECK store_attendance_config_fixed_ot_needs_amount_check, with DIFFERENT wording: ' +
      '"A flat overtime rate needs a peso amount — a fixed mode with no amount would price every ' +
      'overtime hour at zero." — today\'s code (actions.ts:172-175) never refuses in JS for a blank ' +
      'rate; the ternary silently sets null and the CHECK catches it at the DB, already through ' +
      'errorMessage() and already named (constraint-messages.ts:44-46) — so this is a WORDING leg, ' +
      'not a not-yet-refused one, and no new config row is written either way',
    async () => {
      const f = await attendanceFixture('o1');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() =>
        updateAttendanceConfigAction(attendanceFormData(f, { overtimeMode: 'fixed', overtimeFixedHourly: '' })),
      );
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'A flat overtime rate needs a peso amount — a fixed mode with no amount would price every overtime hour at zero.',
      );
    },
    30000,
  );
});

// =================================================================================================
// S5.5w Amendment A1 (7896e2a post-commit /code-review) — parseFourDecimalCost overflow/narrowing,
// same-unit check ordering, trim-on-persist.
// =================================================================================================

async function recordOpeningCountCaught(
  f: Awaited<ReturnType<typeof cutoverFixture>>,
  overrides: { quantity: string; unitCost: string },
): Promise<(Error & { userMessage?: string }) | undefined> {
  let caught: unknown;
  try {
    await asOrg(f.orgId, (tx) =>
      recordOpeningCount(tx, f.admin, { storeId: f.storeId, itemId: f.itemId, quantity: overrides.quantity, unitCost: overrides.unitCost }),
    );
  } catch (err) {
    caught = err;
  }
  return caught as (Error & { userMessage?: string }) | undefined;
}

describe('C1 (S5.5w Amendment A1 item 1) — cutover unitCost="12345678901.5" (11 integer digits)', () => {
  it(
    'wanted: The cost per unit — "12345678901.5" is too large. Use a number below 10000000000. ' +
      '(the integer-digit cap, not yet built) — observed today (measured, not presumed): the ' +
      "current pattern has no digit-count cap, so it reaches numeric(14,4) (10 integer digits max) " +
      'and a raw Postgres numeric overflow is thrown',
    async () => {
      const f = await cutoverFixture('c1-amendment');
      const err = await recordOpeningCountCaught(f, { quantity: '5', unitCost: '12345678901.5' });
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage, 'wanted the too-large sentence — was red: no userMessage (a raw driver error)').toBe(
        'The cost per unit — "12345678901.5" is too large. Use a number below 10000000000.',
      );
      expect(await openingQuantityFor(f.orgId, f.itemId), 'no count should have been written').toBeNull();
    },
    30000,
  );

  it('⛔ green, unedited — "9999999999.9999" (10 integer digits, at the boundary) saves', async () => {
    const f = await cutoverFixture('c1n');
    const err = await recordOpeningCountCaught(f, { quantity: '5', unitCost: '9999999999.9999' });
    expect(err, `unexpected refusal: ${err?.userMessage ?? err?.message}`).toBeUndefined();
  });
});

describe('C2 (S5.5w Amendment A1 item 1b) — cutover unitCost=".5" (leading-dot decimal)', () => {
  it(
    '⛔ green — saves as 0.5000 (RULED FLIP: builder\'s item 1b widened MANUAL_COST_PATTERN to ' +
      '/^(?=.*\\d)\\d*(?:\\.\\d{0,4})?$/, confirmed landed) — was red: the narrower pattern refused it',
    async () => {
      const f = await cutoverFixture('c2');
      const err = await recordOpeningCountCaught(f, { quantity: '5', unitCost: '.5' });
      expect(err, `unexpected refusal: ${err?.userMessage ?? err?.message}`).toBeUndefined();
      expect(await openingQuantityFor(f.orgId, f.itemId), 'quantity still records').toBe('5.000');
      const [row] = await sql<{ unit_cost: string }[]>`select unit_cost from opening_counts where org_id = ${f.orgId} and item_id = ${f.itemId}`;
      expect(row!.unit_cost).toBe('0.5000');
    },
    30000,
  );
});

// A second caller of the SAME shared parseFourDecimalCost — deliveries/documents.ts's unitCost —
// benefits from the same widening/capping. A trimmed, self-contained fixture (not deliveries.test.ts's
// full multi-room/PO harness, which one line's assertion does not need).
async function deliveryUnitCostAttempt(
  hint: string,
  unitCost: string,
): Promise<{ orgId: string; deliveryId: string } | (Error & { userMessage?: string })> {
  const { createDeliveryDocument } = await import('../../../../packages/domain/src/deliveries/documents');
  const { grantEverydayPositionAccess } = await import(
    '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access'
  );
  const code = uid(`s55w-deliv-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, 'multi_room') returning id`;
  const storeId = store!.id;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: staffEmployment!.id, personId: staff!.id, setBy: staff!.id });
  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [kitchen] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${locType!.id}, 'operating', true, ${staff!.id}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${uid('SKU')}, 'Probe Item', 'raw_material', 'kg', ${staff!.id}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/proof.jpg`}, 'image/jpeg', 1024, ${uid('chk')}, 'receipt_photo', ${staff!.id}) returning id`;
  const staffActor = actor(orgId, staff!.id);
  try {
    const result = await asOrg(orgId, (tx) =>
      createDeliveryDocument(tx, staffActor, {
        storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-01-10',
        proofFileId: file!.id,
        lines: [
          {
            itemId: item!.id,
            orderedQuantity: '10',
            purchaseUnit: 'kg',
            conversionFactor: '1',
            unitCost,
            locationId: kitchen!.id,
          },
        ],
      }),
    );
    return { orgId, deliveryId: result.deliveryId as string };
  } catch (err) {
    return err as Error & { userMessage?: string };
  }
}

describe('C2 sibling — deliveries/documents.ts unitCost=".5" (same shared parseFourDecimalCost)', () => {
  // T-351 (DEF-483), ruled TESTER edit: measured directly (run-with-db, this lane) — the S5.5w
  // Amendment A1 widening already landed in 0944455, so the delivery saves today. The
  // `instanceof Error` branch this test used to need is gone; it proved nothing either way.
  it('saves as 0.5000', async () => {
    const result = await deliveryUnitCostAttempt('c2-sibling', '.5');
    expect(result, 'expected the delivery to save, not refuse').not.toBeInstanceOf(Error);
    const { deliveryId } = result as { deliveryId: string };
    const [line] = await sql<{ unit_cost: string }[]>`select unit_cost from delivery_lines where delivery_id = ${deliveryId}`;
    expect(line!.unit_cost).toBe('0.5000');
  }, 30000);
});

describe('C1 sibling — deliveries/documents.ts unitCost="12345678901.5" (same shared overflow cap)', () => {
  it(
    'wanted: Line 1: the unit cost — "12345678901.5" is too large. Use a number below 10000000000. ' +
      '(not yet built) — observed today (measured, not presumed): a raw Postgres numeric overflow, ' +
      'no userMessage — same shape as C1',
    async () => {
      const result = await deliveryUnitCostAttempt('c1-sibling', '12345678901.5');
      expect(result, 'expected a refusal at all').toBeInstanceOf(Error);
      const err = result as Error & { userMessage?: string };
      expect(err.userMessage).toBe('Line 1: the unit cost — "12345678901.5" is too large. Use a number below 10000000000.');
      const [count] = await sql<{ c: string }[]>`select count(*)::text as c from delivery_lines where unit_cost::text like '12345678901%'`;
      expect(count!.c, 'no line should have been saved').toBe('0');
    },
    30000,
  );

  it('⛔ green, unedited — "9999999999.9999" (10 integer digits, at the boundary) saves', async () => {
    const result = await deliveryUnitCostAttempt('c1n-sibling', '9999999999.9999');
    expect(result, `unexpected refusal: ${result instanceof Error ? (result.userMessage ?? result.message) : ''}`).not.toBeInstanceOf(
      Error,
    );
  });
});

describe('SU1 (S5.5w Amendment A1 item 2) — same-unit line gets the "must be 1" sentence, not the six-decimal one', () => {
  it(
    'purchaseUnit = item\'s base unit, conversionFactor="1.2345678": wanted the same-unit sentence ' +
      '(same-unit check moved before format/magnitude, not yet built) — observed today (measured, ' +
      'not presumed): the six-decimal-places sentence fires first, since the same-unit check ' +
      'currently runs AFTER it',
    async () => {
      const f = await invoiceFixture('su1');
      ACTOR_HOLDER.actor = f.admin;
      const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
      const fd = new FormData();
      fd.set('invoiceId', f.invoiceId);
      fd.set('line1_itemId', f.itemId);
      fd.set('line1_quantity', '10');
      fd.set('line1_unitPrice', '100');
      fd.set('line1_purchaseUnit', 'kg'); // f.itemId's own baseUnit (invoiceFixture creates it 'kg')
      fd.set('line1_conversionFactor', '1.2345678');
      const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'line 1 (Probe Item) is billed in kg, which is already the item\'s own unit — the conversion factor must be 1, not 1.2345678.',
      );
      expect(await invoiceLineCountFor(f.invoiceId), 'no lines should have been saved').toBe(0);
    },
    30000,
  );
});

describe('T1 (S5.5w Amendment A1 item 3) — conversionFactor=" 2 " (untrimmed) saves trimmed', () => {
  it(
    'wanted: saves as 2.000000 (trim-on-persist, not yet built) — observed today (measured, not ' +
      'presumed): saves the UNTRIMMED raw string, not "2.000000"',
    async () => {
      const f = await invoiceFixture('t1');
      ACTOR_HOLDER.actor = f.admin;
      const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
      const fd = new FormData();
      fd.set('invoiceId', f.invoiceId);
      fd.set('line1_itemId', f.itemId);
      fd.set('line1_quantity', '10');
      fd.set('line1_unitPrice', '100');
      fd.set('line1_purchaseUnit', 'box'); // differs from baseUnit 'kg' — avoids the same-unit guard
      fd.set('line1_conversionFactor', ' 2 ');
      const to = await expectRedirectTo(() => setInvoiceLinesAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
      const [row] = await sql<{ conversion_factor: string }[]>`
        select conversion_factor from supplier_invoice_lines where supplier_invoice_id = ${f.invoiceId}`;
      expect(row!.conversion_factor, 'wanted trimmed "2.000000"').toBe('2.000000');
    },
    30000,
  );
});

describe('W1/W2 (S5.5w Amendment A2 item 1) — int() must test the VALUE, not the digit run', () => {
  it(
    'W1 lateGraceMinutes="000001": wanted saves as 1 (shape /^\\d+$/, not yet built) — observed ' +
      'today (measured, not presumed): refused — the current shape check /^\\d{1,5}$/ counts ' +
      'characters, and "000001" is 6 characters even though its VALUE is 1',
    async () => {
      const f = await attendanceFixture('w1');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: '000001' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
      const live = await sql<{ late_grace_minutes: number }[]>`
        select late_grace_minutes from store_attendance_config where org_id = ${f.orgId} and store_id = ${f.storeId} and superseded_at is null`;
      expect(live[0]!.late_grace_minutes).toBe(1);
    },
    30000,
  );

  it(
    'W2 lateGraceMinutes="100000": wanted "The late grace minutes — \\"100000\\" is not a whole ' +
      'number from 0 to 99999." (the no-max-gets-99999 ceiling, not yet built) — observed today ' +
      '(measured, not presumed): refused for the WRONG reason — "...is not a whole number, 0 or ' +
      'more." (today\'s message never names 99999 because `max` is not yet defaulted)',
    async () => {
      const f = await attendanceFixture('w2');
      ACTOR_HOLDER.actor = f.admin;
      const { updateAttendanceConfigAction } = await import('../../src/app/settings/attendance/actions');
      const to = await expectRedirectTo(() => updateAttendanceConfigAction(attendanceFormData(f, { lateGraceMinutes: '100000' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The late grace minutes — "100000" is not a whole number from 0 to 99999.');
    },
    30000,
  );
});
