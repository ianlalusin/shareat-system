import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-597 DEF-889 (Ian, 18 Nov, option A) - payroll pays out under the same draw rule as every other payout (bible row 154): an office
 * safe or bank account that cannot cover the run is REFUSED, a cashier drawer that is short within its limit WARNS, and a retired
 * account is refused. Per function (postPayRun, post13thMonthRun, postSeparation): funded office posts, unfunded office refuses and
 * writes nothing, short cashier drawer posts with a warning, retired account refuses.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { post13thMonthRun, postPayRun, postSeparation } from '@shareat/domain';
import { fundAccount } from './_fixtures/fund-account';
import { seedStatutoryRates } from './_fixtures/statutory-rates';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end();
  await closeDb();
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** One store, one admin who posts, one worker who is paid, a PESO 500/day rate. The store's foundation office safe is NOT funded. */
async function fixture(hint: string) {
  const code = uid(`t597-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2026-01-01'::date, greatest('2026-12-01'::date, date_trunc('month', now() at time zone 'Asia/Manila')::date), '1 month') d`;
  const [config] = await sql<{ id: string }[]>`
    insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier, night_diff_multiplier, overtime_mode, overtime_fixed_hourly)
    values (${orgId}, ${storeId}, '2026-01-01', '9', '1.25', '1.10', 'multiplier', null) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const workerId = await mk('Worker', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', '2026-06-30', 'resigned', ${adminId}) returning id`;
  const admin = actor(orgId, adminId);
  await seedStatutoryRates(orgId, admin, [storeId]);
  const [rate] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${emp!.id}, 'daily', '500.00', '2026-01-01', ${adminId}) returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return { orgId, storeId, configId: config!.id, adminId, workerId, employmentId: emp!.id, payRateId: rate!.id, admin, officeId: office!.id, drawerId: drawer!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const fund = (f: Fixture) => fundAccount(sql, { orgId: f.orgId, storeId: f.storeId, code: '1130', amount: '10000000.00' });
const retire = (id: string) => sql`update money_accounts set is_active = false where id = ${id}`;

/** A posted regular period, inserted directly as an INPUT (the 13th month and the separation read it). */
async function postedPeriod(f: Fixture): Promise<void> {
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
    values (${f.orgId}, ${f.storeId}, '2026-01-01', '2026-01-15', 'posted', ${f.officeId}, now(), ${f.adminId}, ${f.adminId}) returning id`;
  await sql`
    insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
    values (${run!.id}, ${f.orgId}, ${f.employmentId}, ${f.workerId}, ${f.payRateId}, '1', '12000.00', '12000.00', '0', '12000.00')`;
}
/** One verified day, so previewPayRun has a slip. */
async function addDay(f: Fixture): Promise<void> {
  await sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes, is_half_day,
                                 pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
    values (${f.orgId}, ${f.storeId}, ${f.workerId}, ${f.employmentId}, '2026-01-05', ${f.configId}, 'exact', 'verified', 540, false, 0, 0, 0, false, null)`;
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? (err as Error).message;
  }
  return '<<NO REFUSAL - THE CALL SUCCEEDED>>';
}
const OFFICE_SHORT = /^".+" holds 0\.00 and this takes [\d,.]+\. Unlike a cashier drawer, this balance is complete .* record the money coming in first/;
const SHORT_WARNING = /is short [\d,.]+ against the books/;
const RETIRED = /^".+" is retired\. Choose another account to pay from\.$/;
const count = async (table: string, orgId: string) =>
  Number((await sql.unsafe<{ n: string }[]>(`select count(*)::text n from ${table} where org_id = '${orgId}'`))[0]!.n);
const payoutEntries = async (orgId: string, types: string[]) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where org_id = ${orgId} and source_type = any(${types})`)[0]!.n);

// ---------------------------------------------------------------------------------------------------------------------
describe('DEF-889 - postPayRun', () => {
  async function ready(hint: string) {
    const f = await fixture(hint);
    await addDay(f);
    return f;
  }
  const post = (f: Fixture, moneyAccountId: string) =>
    asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-01-01', periodEnd: '2026-01-15', moneyAccountId }));
  const nothingWritten = async (f: Fixture) => {
    expect(await count('pay_runs', f.orgId)).toBe(0);
    expect(await payoutEntries(f.orgId, ['payrollpayslip'])).toBe(0);
  };

  it('a funded office safe posts, with no warning', async () => {
    const f = await ready('pr-ok');
    await fund(f);
    const out = await post(f, f.officeId);
    expect(out.payslips).toBe(1);
    expect(out.warning).toBeUndefined();
  });
  it('an unfunded office safe is refused with the office sentence; no run, no entry', async () => {
    const f = await ready('pr-short');
    expect(await messageOf(post(f, f.officeId))).toMatch(OFFICE_SHORT);
    await nothingWritten(f);
  });
  it('a cashier drawer that is short within its limit posts and warns', async () => {
    const f = await ready('pr-drawer');
    const out = await post(f, f.drawerId);
    expect(out.payslips).toBe(1);
    expect(out.warning).toMatch(SHORT_WARNING);
  });
  it('a retired account is refused with the sentence; no run, no entry', async () => {
    const f = await ready('pr-retired');
    await fund(f);
    await retire(f.officeId);
    expect(await messageOf(post(f, f.officeId))).toMatch(RETIRED);
    await nothingWritten(f);
  });
});

describe('DEF-889 - post13thMonthRun', () => {
  const post = (f: Fixture, moneyAccountId: string) => asOrg(f.orgId, (tx) => post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId }));
  const nothingWritten = async (f: Fixture) => {
    expect(await count('thirteenth_month_runs', f.orgId)).toBe(0);
    expect(await count('thirteenth_month_payouts', f.orgId)).toBe(0);
    expect(await payoutEntries(f.orgId, ['thirteenthmonthpayout'])).toBe(0);
  };

  it('a funded office safe posts, with no warning', async () => {
    const f = await fixture('tm-ok');
    await postedPeriod(f);
    await fund(f);
    const out = await post(f, f.officeId);
    expect(out.payouts).toBe(1);
    expect(out.warning).toBeUndefined();
  });
  it('an unfunded office safe is refused with the office sentence; no run, no payout, no entry', async () => {
    const f = await fixture('tm-short');
    await postedPeriod(f);
    expect(await messageOf(post(f, f.officeId))).toMatch(OFFICE_SHORT);
    await nothingWritten(f);
  });
  it('a cashier drawer that is short within its limit posts and warns', async () => {
    const f = await fixture('tm-drawer');
    await postedPeriod(f);
    const out = await post(f, f.drawerId);
    expect(out.warning).toMatch(SHORT_WARNING);
  });
  it('a retired account is refused with the sentence; nothing written', async () => {
    const f = await fixture('tm-retired');
    await postedPeriod(f);
    await fund(f);
    await retire(f.officeId);
    expect(await messageOf(post(f, f.officeId))).toMatch(RETIRED);
    await nothingWritten(f);
  });
});

describe('DEF-889 - postSeparation', () => {
  const post = (f: Fixture, moneyAccountId: string) =>
    asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation', separationPayAmount: '0',
        moneyAccountId, clearanceConfirmedBy: f.adminId,
      }),
    );
  const nothingWritten = async (f: Fixture) => {
    expect(await count('separations', f.orgId)).toBe(0);
    expect(await payoutEntries(f.orgId, ['separation'])).toBe(0);
  };

  it('a funded office safe posts, with no warning', async () => {
    const f = await fixture('sp-ok');
    await postedPeriod(f);
    await fund(f);
    const out = await post(f, f.officeId);
    expect(out.warning).toBeUndefined();
  });
  it('an unfunded office safe is refused with the office sentence; no separation, no entry', async () => {
    const f = await fixture('sp-short');
    await postedPeriod(f);
    expect(await messageOf(post(f, f.officeId))).toMatch(OFFICE_SHORT);
    await nothingWritten(f);
  });
  it('a cashier drawer that is short within its limit posts and warns', async () => {
    const f = await fixture('sp-drawer');
    await postedPeriod(f);
    const out = await post(f, f.drawerId);
    expect(out.warning).toMatch(SHORT_WARNING);
  });
  it('a retired account is refused with the sentence; nothing written', async () => {
    const f = await fixture('sp-retired');
    await postedPeriod(f);
    await fund(f);
    await retire(f.officeId);
    expect(await messageOf(post(f, f.officeId))).toMatch(RETIRED);
    await nothingWritten(f);
  });
});
