import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-271 — DEF-301, bible §13 row 189. `docs/tasks/271-def-301-constraint-message-lookup.md`.
 *
 * ⭐ THE DELIVERABLE. Every one of the 26 `CONSTRAINT_MESSAGES` keys, provoked for REAL against
 * `shareat_test_laneb` — never a synthetic `Error` — and run through `errorMessage()`. This file is
 * written and run TWICE: once against the OLD substring-search `errorMessage` (must be green — these
 * 26 already work today) and once after the four-line change to a structural lookup on
 * `resolveConstraintName` (must still be green, byte for byte). Both real runs are pasted into the
 * READY report as the before/after table; this file does not diff them itself, because only one
 * implementation exists in the tree at a time.
 *
 * ⛔ Never construct a synthetic `new Error('...constraint "x"...')` here — that has no
 * `constraint_name` and would exercise the fallback path this task is about, proving the opposite of
 * what it appears to prove (the trap named in the spec).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { CONSTRAINT_MESSAGES, errorMessage } from '../../src/lib/constraint-messages';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end();
});

// ---------------------------------------------------------------------------------------------
// The before/after table. Each row is captured from a REAL provoked error, never a synthetic one.
// ---------------------------------------------------------------------------------------------
type Row = { key: string; constraintName: string | null; raw: string; message: string; matchesMapped: boolean };
const rows: Row[] = [];

function record(key: string, err: unknown): Row {
  const raw = err instanceof Error ? err.message : String(err);
  const constraintName = (err as { constraint_name?: unknown } | null)?.constraint_name;
  const row: Row = {
    key,
    constraintName: typeof constraintName === 'string' ? constraintName : null,
    raw,
    message: errorMessage(err),
    matchesMapped: false,
  };
  row.matchesMapped = row.message === CONSTRAINT_MESSAGES[key];
  rows.push(row);
  return row;
}

/** Runs `fn`, expecting it to throw a real Postgres error. Fails loudly if it does not. */
async function provoke(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a real constraint violation, but the statement succeeded');
}

afterAll(() => {
  const header = 'key | constraint_name | errorMessage() | matches CONSTRAINT_MESSAGES';
  const lines = rows.map(
    (r) => `${r.key} | ${r.constraintName ?? '(null)'} | ${JSON.stringify(r.message)} | ${r.matchesMapped}`,
  );
  // eslint-disable-next-line no-console
  console.log(`\n=== T-271 before/after table (${rows.length} rows) ===\n${header}\n${lines.join('\n')}\n`);
});

// =================================================================================================
// pay_runs (1), pay_rates (2), payslips (1), attendance_days (1)
// =================================================================================================
describe('T-271 — pay_runs / pay_rates / payslips / attendance_days', () => {
  let orgId: string;
  let storeId: string;
  let personId: string;
  let employmentId: string;
  let officeAccountId: string;
  let configId: string;

  beforeAll(async () => {
    const code = uid('t271-payroll');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    orgId = org!.id;
    await seedChartOfAccounts(sql, orgId);
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, ${'Store'}) returning id`;
    storeId = store!.id;
    const [office] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${storeId}
        and instrument = 'cash' and custodian = 'office' and is_foundation`;
    officeAccountId = office!.id;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
    personId = person!.id;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${uid('sc')}, '2026-01-01', 'regular', ${personId}) returning id`;
    employmentId = emp!.id;
    const [cfg] = await sql<{ id: string }[]>`
      insert into store_attendance_config (org_id, store_id, effective_from) values (${orgId}, ${storeId}, '2026-01-01') returning id`;
    configId = cfg!.id;
  });

  it('pay_runs_no_overlapping_posted_period', async () => {
    await sql`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
      values (${orgId}, ${storeId}, '2026-01-01', '2026-01-15', 'posted', ${officeAccountId}, now(), ${personId}, ${personId})`;
    const err = await provoke(() =>
      sql`
        insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
        values (${orgId}, ${storeId}, '2026-01-10', '2026-01-25', 'posted', ${officeAccountId}, now(), ${personId}, ${personId})`,
    );
    const row = record('pay_runs_no_overlapping_posted_period', err);
    expect(row.constraintName).toBe('pay_runs_no_overlapping_posted_period');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.pay_runs_no_overlapping_posted_period);
  });

  it('pay_rates_amount_positive_check', async () => {
    const err = await provoke(() =>
      sql`
        insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
        values (${orgId}, ${employmentId}, 'daily', 0, '2026-02-01', ${personId})`,
    );
    const row = record('pay_rates_amount_positive_check', err);
    expect(row.constraintName).toBe('pay_rates_amount_positive_check');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.pay_rates_amount_positive_check);
  });

  it('pay_rates_employment_from_unique', async () => {
    await sql`
      insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
      values (${orgId}, ${employmentId}, 'daily', '500', '2026-03-01', ${personId})`;
    const err = await provoke(() =>
      sql`
        insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
        values (${orgId}, ${employmentId}, 'daily', '600', '2026-03-01', ${personId})`,
    );
    const row = record('pay_rates_employment_from_unique', err);
    expect(row.constraintName).toBe('pay_rates_employment_from_unique');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.pay_rates_employment_from_unique);
  });

  it('payslips_run_employment_unique', async () => {
    const [rate] = await sql<{ id: string }[]>`
      insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
      values (${orgId}, ${employmentId}, 'daily', '500', '2026-04-01', ${personId}) returning id`;
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, money_account_id, created_by)
      values (${orgId}, ${storeId}, '2026-04-01', '2026-04-15', ${officeAccountId}, ${personId}) returning id`;
    const payslip = {
      run_id: run!.id,
      org_id: orgId,
      employment_id: employmentId,
      person_id: personId,
      pay_rate_id: rate!.id,
      days_worked: '1',
      basic_pay: '500',
      gross_pay: '500',
      net_pay: '500',
    };
    await sql`insert into payslips ${sql(payslip)}`;
    const err = await provoke(() => sql`insert into payslips ${sql(payslip)}`);
    const row = record('payslips_run_employment_unique', err);
    expect(row.constraintName).toBe('payslips_run_employment_unique');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.payslips_run_employment_unique);
  });

  it('attendance_days_frozen_by_pay_run_fk', async () => {
    const nonExistentPayRun = crypto.randomUUID();
    const err = await provoke(() =>
      sql`
        insert into attendance_days
          (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
           status, frozen_at, frozen_by_pay_run_id)
        values
          (${orgId}, ${storeId}, ${personId}, ${employmentId}, '2026-01-05', ${configId}, 'exact',
           'open', now(), ${nonExistentPayRun})`,
    );
    const row = record('attendance_days_frozen_by_pay_run_fk', err);
    expect(row.constraintName).toBe('attendance_days_frozen_by_pay_run_fk');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.attendance_days_frozen_by_pay_run_fk);
  });
});

// =================================================================================================
// store_attendance_config — 18 CHECK constraints, one fixture row + 18 targeted single-field-invalid
// inserts. Every override besides the one under test stays at the column DEFAULT, which already
// satisfies every other CHECK on this table — isolating each row to exactly one violation.
// =================================================================================================
describe('T-271 — store_attendance_config (18 checks)', () => {
  let orgId: string;
  let storeId: string;

  beforeAll(async () => {
    const code = uid('t271-config');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, ${'Store'}) returning id`;
    storeId = store!.id;
  });

  async function insertConfig(effectiveFrom: string, overrides: Record<string, unknown>) {
    return sql`
      insert into store_attendance_config ${sql({ org_id: orgId, store_id: storeId, effective_from: effectiveFrom, ...overrides })}`;
  }

  const cases: Array<[string, Record<string, unknown>]> = [
    ['store_attendance_config_charge_rate_check', { late_policy: 'charge_per_minute', late_charge_per_minute: 0 }],
    ['store_attendance_config_half_day_below_required_check', { half_day_hours: 10 }],
    ['store_attendance_config_positive_hours_check', { half_day_hours: 0 }],
    ['store_attendance_config_grace_non_negative_check', { late_grace_minutes: -1 }],
    // `overtime_mode` other than 'multiplier' also trips `fixed_ot_needs_amount_check` unless a
    // fixed hourly rate is present — set one so only `overtime_mode_check` itself is isolated.
    ['store_attendance_config_overtime_mode_check', { overtime_mode: 'bogus', overtime_fixed_hourly: '10' }],
    ['store_attendance_config_fixed_ot_needs_amount_check', { overtime_mode: 'fixed', overtime_fixed_hourly: null }],
    ['store_attendance_config_fixed_ot_positive_check', { overtime_fixed_hourly: 0 }],
    ['store_attendance_config_holiday_multipliers_check', { holiday_regular_multiplier: '0.5' }],
    ['store_attendance_config_period_type_check', { payroll_period_type: 'bogus' }],
    ['store_attendance_config_cutoff_day_check', { semi_monthly_cutoff_day: 28 }],
    // `payout_mode` other than 'lag' also trips `fixed_days_needed_check` unless payout_days is
    // non-empty — supply one valid day so only `payout_mode_check` itself is isolated.
    ['store_attendance_config_payout_mode_check', { payout_mode: 'bogus', payout_days: [15] }],
    ['store_attendance_config_fixed_days_needed_check', { payout_mode: 'fixed_days' }],
    ['store_attendance_config_anchor_window_check', { anchor_window_minutes: 100 }],
    ['store_attendance_config_night_window_check', { night_diff_start_hour: 25 }],
    ['store_attendance_config_time_mode_check', { time_mode: 'bogus' }],
    ['store_attendance_config_late_policy_check', { late_policy: 'bogus' }],
  ];

  let day = 1;
  for (const [key, overrides] of cases) {
    it(key, async () => {
      const effectiveFrom = `2026-05-${String(day++).padStart(2, '0')}`;
      const err = await provoke(() => insertConfig(effectiveFrom, overrides));
      const row = record(key, err);
      expect(row.constraintName).toBe(key);
      expect(row.message).toBe(CONSTRAINT_MESSAGES[key]);
    });
  }

  // Array-typed columns handled with raw literals rather than the `sql(object)` helper.
  it('store_attendance_config_allowed_hours_check', async () => {
    const effectiveFrom = `2026-05-${String(day++).padStart(2, '0')}`;
    const err = await provoke(
      () => sql`
        insert into store_attendance_config (org_id, store_id, effective_from, allowed_shift_start_hours)
        values (${orgId}, ${storeId}, ${effectiveFrom}, ARRAY[9,9])`,
    );
    const row = record('store_attendance_config_allowed_hours_check', err);
    expect(row.constraintName).toBe('store_attendance_config_allowed_hours_check');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.store_attendance_config_allowed_hours_check);
  });

  it('store_attendance_config_payout_days_range_check', async () => {
    const effectiveFrom = `2026-05-${String(day++).padStart(2, '0')}`;
    const err = await provoke(
      () => sql`
        insert into store_attendance_config (org_id, store_id, effective_from, payout_days)
        values (${orgId}, ${storeId}, ${effectiveFrom}, ARRAY[35])`,
    );
    const row = record('store_attendance_config_payout_days_range_check', err);
    expect(row.constraintName).toBe('store_attendance_config_payout_days_range_check');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.store_attendance_config_payout_days_range_check);
  });
});

// =================================================================================================
// sales_channels — 3 keys. Provocations mirror the existing, already-proven pattern in
// packages/domain/tests/integration/sales-channels-admin.test.ts:383-399.
// =================================================================================================
describe('T-271 — sales_channels', () => {
  let orgId: string;
  let storeId: string;

  beforeAll(async () => {
    const code = uid('t271-sc');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, ${'Store'}) returning id`;
    storeId = store!.id;
  });

  it('sales_channels_non_remitted_needs_receivable_check', async () => {
    const err = await provoke(
      () => sql`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily)
        values (${orgId}, ${storeId}, ${uid('Channel')}, false)`,
    );
    const row = record('sales_channels_non_remitted_needs_receivable_check', err);
    expect(row.constraintName).toBe('sales_channels_non_remitted_needs_receivable_check');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.sales_channels_non_remitted_needs_receivable_check);
  });

  it('sales_channels_wastage_type_mode_check', async () => {
    const err = await provoke(
      () => sql`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily, wastage_type_mode)
        values (${orgId}, ${storeId}, ${uid('Channel')}, true, 'both')`,
    );
    const row = record('sales_channels_wastage_type_mode_check', err);
    expect(row.constraintName).toBe('sales_channels_wastage_type_mode_check');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.sales_channels_wastage_type_mode_check);
  });

  it('sales_channels_org_id_store_id_name_unique', async () => {
    const name = uid('Foodpanda');
    await sql`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, ${name}, true)`;
    // Same name, different case and trailing space — the unique index normalises both away
    // (T-230's own sentence: "Foodpanda" and "foodpanda " are the same channel twice).
    const err = await provoke(
      () => sql`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily)
        values (${orgId}, ${storeId}, ${`${name.toLowerCase()} `}, true)`,
    );
    const row = record('sales_channels_org_id_store_id_name_unique', err);
    expect(row.constraintName).toBe('sales_channels_org_id_store_id_name_unique');
    expect(row.message).toBe(CONSTRAINT_MESSAGES.sales_channels_org_id_store_id_name_unique);
  });
});

it('sanity: every CONSTRAINT_MESSAGES key was exercised above', () => {
  const exercised = new Set(rows.map((r) => r.key));
  const missing = Object.keys(CONSTRAINT_MESSAGES).filter((k) => !exercised.has(k));
  expect(missing).toEqual([]);
  expect(rows.length).toBe(26);
});
