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
import { insertDerivedSalesDayRow } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';

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
    // T-370 S3 (DEF-409) — a LIVE semi_monthly + fixed_days row must carry exactly two DISTINCT payout days. The
    // defaults (semi_monthly) supply the first half; one day is the violation. `payout_days` is non-empty, so
    // `fixed_days_needed_check` stays satisfied and only the new check is isolated.
    ['store_attendance_config_semi_monthly_two_days_check', { payout_mode: 'fixed_days', payout_days: [10] }],
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

  // T-369 S7 audit C — with the voided-date rule, two concurrent MANAGER re-entries of one voided date both pass the
  // existence check and the loser meets the unique index. That must read as a sentence, not as a raw 23505. The key is
  // mapped in CONSTRAINT_MESSAGES the same way as the sibling unique indexes above (NOTE: it widens the /setup allowlist
  // by one, like T-370 S3's key — the two count legs (constraint-messages.test.ts, the mechanism test) go to 28 when both land).
  it('sales_days_org_id_store_id_business_date_unique', async () => {
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Reader') returning id`;
    await sql`
      insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${orgId}, ${storeId}, '2026-03-03', 'open', '1.00', '1.00', '0.00', ${person!.id})`;
    const err = await provoke(
      () => sql`
        insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
        values (${orgId}, ${storeId}, '2026-03-03', 'open', '1.00', '1.00', '0.00', ${person!.id})`,
    );
    const row = record('sales_days_org_id_store_id_business_date_unique', err);
    expect(row.constraintName).toBe('sales_days_org_id_store_id_business_date_unique');
    expect(row.message, `a raw driver error reached the person: ${row.message}`).toBe(CONSTRAINT_MESSAGES.sales_days_org_id_store_id_business_date_unique);
    expect(row.message).toMatch(/sales day/i);
  });
});

// T-375 S4 (0185) — the four lock constraints, provoked for real on a store LINKED to POS (raw SQL, no derivation flag).
describe('T-375 S4 — the sales-day lock', () => {
  const LOCK_SENTENCE = "Sales figures for this store come only from POS and can't be changed here. A wrong sale is refunded on the POS.";
  async function linkedStore() {
    const code = uid('t375s4-lock');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    await seedChartOfAccounts(sql, orgId);
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Lipa') returning id`;
    const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Batangas') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${store!.id}, 'Walk-in', true) returning id`;
    const [wallet] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${store!.id}, 'GCash', 'ewallet', '1140', 'cashier') returning id`;
    await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
      values (${orgId}, ${store!.id}, ${uid('pos')}, 'POS store', ${ch!.id}, 'vat_inclusive', ${person!.id})`;
    return { orgId, storeId: store!.id, store2Id: store2!.id, personId: person!.id, channelId: ch!.id, walletId: wallet!.id };
  }
  const check = (key: string, err: unknown) => {
    const row = record(key, err);
    expect(row.constraintName).toBe(key);
    expect(row.message).toBe(LOCK_SENTENCE);
    expect(row.message).toBe(CONSTRAINT_MESSAGES[key]);
  };

  it('sales_days_figures_locked', async () => {
    const f = await linkedStore();
    const err = await provoke(
      () => sql`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
                values (${f.orgId}, ${f.storeId}, '2027-01-10', 1, 0, 1, ${f.personId})`,
    );
    check('sales_days_figures_locked', err);
  });

  it('sales_day_tenders_locked', async () => {
    const f = await linkedStore();
    const day = await insertDerivedSalesDayRow(sql, { orgId: f.orgId, storeId: f.storeId, businessDate: '2027-01-10', createdBy: f.personId });
    const err = await provoke(
      () => sql`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${day.id}, ${f.walletId}, '10.00')`,
    );
    check('sales_day_tenders_locked', err);
  });

  it('sales_day_channels_locked', async () => {
    const f = await linkedStore();
    const day = await insertDerivedSalesDayRow(sql, { orgId: f.orgId, storeId: f.storeId, businessDate: '2027-01-10', createdBy: f.personId });
    const err = await provoke(
      () => sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${day.id}, ${f.channelId}, '10.00')`,
    );
    check('sales_day_channels_locked', err);
  });

  it('pos_v1_store_links_store_fixed', async () => {
    const f = await linkedStore();
    const err = await provoke(() => sql`update pos_v1_store_links set store_id = ${f.store2Id} where store_id = ${f.storeId}`);
    check('pos_v1_store_links_store_fixed', err);
  });
});

// T-378 S1 - the four item unit/kind CHECKs, provoked for real (raw SQL, an out-of-list value).
describe('T-378 S1 - item unit and kind CHECKs', () => {
  const UNIT = 'Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.';
  const KIND = 'Choose what kind of item this is.';
  async function org() {
    const code = uid('t378s1-lookup');
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Requester') returning id`;
    return { orgId: o!.id, personId: p!.id };
  }
  const check = (key: string, sentence: string, err: unknown) => {
    const row = record(key, err);
    expect(row.constraintName).toBe(key);
    expect(row.message).toBe(sentence);
    expect(row.message).toBe(CONSTRAINT_MESSAGES[key]);
  };

  it('items_base_unit_check', async () => {
    const f = await org();
    const err = await provoke(() => sql`insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('C')}, ${uid('n')}, 'retail', 'box', ${f.personId})`);
    check('items_base_unit_check', UNIT, err);
  });
  it('item_requests_base_unit_check', async () => {
    const f = await org();
    const err = await provoke(() => sql`insert into item_requests (org_id, name, code, kind, base_unit, requested_by) values (${f.orgId}, ${uid('n')}, ${uid('C')}, 'retail', 'box', ${f.personId})`);
    check('item_requests_base_unit_check', UNIT, err);
  });
  it('items_kind_check', async () => {
    const f = await org();
    const err = await provoke(() => sql`insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('C')}, ${uid('n')}, 'bogus', 'pcs', ${f.personId})`);
    check('items_kind_check', KIND, err);
  });
  it('item_requests_kind_check', async () => {
    const f = await org();
    const err = await provoke(() => sql`insert into item_requests (org_id, name, code, kind, base_unit, requested_by) values (${f.orgId}, ${uid('n')}, ${uid('C')}, 'bogus', 'pcs', ${f.personId})`);
    check('item_requests_kind_check', KIND, err);
  });
});

// T-378 S2 (0186) - the item-unit history guard, provoked for real: an item with one stock movement, then a unit change.
describe('T-378 S2 - the item unit is fixed once it has history', () => {
  const FIXED_SENTENCE =
    "This item's unit can no longer change: it already has stock, counts, invoices, recipes, prices or orders recorded in its current unit, and changing it would re-read every one of them in the new unit.";
  it('items_base_unit_fixed', async () => {
    const orgCode = uid('t378s2-lock');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${orgCode}`}, ${orgCode}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('store')}, 'Store', 'multi_room') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
    const [loc] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgId}, ${store!.id}, 'MAIN', 'Main', ${lt!.id}, ${person!.id}) returning id`;
    const itemCode = uid('itm');
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${itemCode}, ${itemCode}, 'raw_material', 'kg', ${person!.id}) returning id`;
    await sql`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${orgId}, ${store!.id}, ${loc!.id}, ${item!.id}, '2026-01-20T02:00:00Z', '10', 'receipt', 'delivery', ${crypto.randomUUID()}, ${person!.id})`;
    const err = await provoke(() => sql`update items set base_unit = 'pcs' where id = ${item!.id}`);
    const row = record('items_base_unit_fixed', err);
    expect(row.constraintName).toBe('items_base_unit_fixed');
    expect(row.message).toBe(FIXED_SENTENCE);
    expect(row.message).toBe(CONSTRAINT_MESSAGES.items_base_unit_fixed);
  });
});

// T-383 S1 - the two blank CHECKs on items (0047), provoked for real. Red today: CONSTRAINT_MESSAGES has no such key, so errorMessage() returns the raw text.
describe('T-383 S1 - an item cannot be blank-named or blank-coded', () => {
  const NAME_SENTENCE = 'Give the item a name people will recognise.';
  const CODE_SENTENCE = 'Give the item a code.';
  async function blankItemOrg() {
    const orgCode = uid('t383-blank');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${orgCode}`}, ${orgCode}) returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Admin') returning id`;
    return { orgId: org!.id, personId: person!.id };
  }
  it('items_name_not_blank_check', async () => {
    const f = await blankItemOrg();
    const err = await provoke(() => sql`insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('C')}, '   ', 'retail', 'pcs', ${f.personId})`);
    const row = record('items_name_not_blank_check', err);
    expect(row.constraintName).toBe('items_name_not_blank_check');
    expect(row.message).toBe(NAME_SENTENCE);
    expect(row.message).toBe(CONSTRAINT_MESSAGES.items_name_not_blank_check);
  });
  it('items_code_not_blank_check', async () => {
    const f = await blankItemOrg();
    const err = await provoke(() => sql`insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, '', ${uid('n')}, 'retail', 'pcs', ${f.personId})`);
    const row = record('items_code_not_blank_check', err);
    expect(row.constraintName).toBe('items_code_not_blank_check');
    expect(row.message).toBe(CODE_SENTENCE);
    expect(row.message).toBe(CONSTRAINT_MESSAGES.items_code_not_blank_check);
  });
});

// T-382 (0187) - the two unlink CHECKs on pos_v1_store_links, provoked for real (raw SQL on a freshly inserted link row).
describe('T-382 - the unlink CHECKs', () => {
  async function link() {
    const code = uid('t382-lookup');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Lipa') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${store!.id}, 'Walk-in', true) returning id`;
    const [row] = await sql<{ id: string }[]>`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
      values (${orgId}, ${store!.id}, ${uid('pos')}, 'POS store', ${ch!.id}, 'vat_inclusive', ${person!.id}) returning id`;
    return { linkId: row!.id, personId: person!.id };
  }
  const check = (key: string, err: unknown) => {
    const row = record(key, err);
    expect(row.constraintName).toBe(key);
    expect(row.message).toBe(CONSTRAINT_MESSAGES[key]);
    expect(row.message).toBe(
      key === 'pos_v1_store_links_unlink_shape_check'
        ? 'An unlink needs who, when and why together.'
        : 'Say why this store is being unlinked, in under 500 characters.',
    );
  };

  it('pos_v1_store_links_unlink_shape_check', async () => {
    const f = await link();
    // unlinked_at set while unlinked_by and unlink_reason stay null: the three must be all-or-nothing.
    const err = await provoke(() => sql`update pos_v1_store_links set unlinked_at = now() where id = ${f.linkId}`);
    check('pos_v1_store_links_unlink_shape_check', err);
  });
  it('pos_v1_store_links_unlink_reason_check', async () => {
    const f = await link();
    // all three present (shape holds) but the reason is blank, so only the reason CHECK can fire.
    const err = await provoke(() => sql`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${f.personId}, unlink_reason = '   ' where id = ${f.linkId}`);
    check('pos_v1_store_links_unlink_reason_check', err);
  });
});

// T-385 S2 (0188) - D8: an UPDATE that jumps a sales day from open to verified is refused by the trigger, and the person reads
// a sentence, not the raw 23514.
describe('T-385 S2 - the verify-requires-submitted trigger', () => {
  const KEY = 'sales_days_verify_requires_submitted';
  const SENTENCE = 'A sales day can be verified only after it has been submitted.';

  it(KEY, async () => {
    const code = uid('t385-lookup');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Lipa') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const [day] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${orgId}, ${store!.id}, '2027-02-03', 'open', '1.00', '1.00', '0.00', ${person!.id}) returning id`;
    const err = await provoke(() => sql`update sales_days set status = 'verified', verified_by = ${person!.id}, verified_at = now() where id = ${day!.id}`);
    const row = record(KEY, err);
    expect(row.constraintName).toBe(KEY);
    expect(row.message, `a raw driver error reached the person: ${row.message}`).toBe(CONSTRAINT_MESSAGES[KEY]);
    expect(row.message).toBe(SENTENCE);
  });
});

// T-386 S2 (0189) - D10: re-using a number already given out under an item-code stem is refused by the trigger
// items_code_never_reused (23514, CONSTRAINT = the trigger's name), and the person reads R5's sentence, not the raw error.
describe('T-386 S2 - the item-code never-reused trigger', () => {
  const KEY = 'items_code_never_reused';
  const SENTENCE = "That code's number has already been given out under those letters. Leave the code blank to get the next free one.";

  it(KEY, async () => {
    const code = uid('t386-lookup');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into items (org_id, code, name, kind, base_unit, created_by)
              values (${orgId}, 'CHWN-001', 'Chicken wings', 'raw_material', 'kg', ${person!.id})`;
    const err = await provoke(
      () => sql`insert into items (org_id, code, name, kind, base_unit, created_by)
                values (${orgId}, 'CHWN-001', 'Chicken winglets', 'raw_material', 'kg', ${person!.id})`,
    );
    const row = record(KEY, err);
    expect(row.constraintName).toBe(KEY);
    expect(row.message, `a raw driver error reached the person: ${row.message}`).toBe(CONSTRAINT_MESSAGES[KEY]);
    expect(row.message).toBe(SENTENCE);
  });
});

it('sanity: every CONSTRAINT_MESSAGES key was exercised above', () => {
  const exercised = new Set(rows.map((r) => r.key));
  const missing = Object.keys(CONSTRAINT_MESSAGES).filter((k) => !exercised.has(k));
  expect(missing).toEqual([]);
  // 26 (T-271) + T-370 S3's semi-monthly two-days key + T-369 S7's sales-day unique key + T-375 S4's four lock keys + T-378 S1's four unit/kind keys + T-378 S2's items_base_unit_fixed + T-382's two unlink CHECK keys + T-383 S1's items blank-name and blank-code CHECK keys + T-385 S2's sales_days_verify_requires_submitted + T-386 S2's items_code_never_reused = 43 rows provoked above.
  expect(rows.length).toBe(43);
});
