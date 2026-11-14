import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-555 - a deduction agreement is not recoverable before its signing date (audit M-002).
 * docs/tasks/555-agreement-not-recoverable-before-signed.md. An agreement counts only when signed_on <= the payout date
 * (pay run period end, separation date, 13th-month year end). A future signing date is refused at the writer; a row that
 * already carries one is simulated here by moving signed_on with SQL.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { agree, chargeEntry, scanFor } from './_fixtures/t519-agreements';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { addDays, toBusinessDate } from '@shareat/core/datetime';
import { money } from '@shareat/core/money';
import { RefusalError } from '../../src/shared/refusal';
import { recordOwnerSelfAgreement } from '../../src/payroll/deduction-agreements';
import {
  agreedRecoverable, applyDeductionRecovery, post13thMonthRun, postPayRun, postSeparation, preview13thMonthRun,
  previewSeparation, recordDeductionAgreement, seedAttendanceConfig, seedCanonicalPositions,
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

async function fixture(hint: string) {
  const code = uid(`t555-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const storeId = s!.id;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId], '645.00');
  const workerId = await mk('Worker', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', null, 'regular', ${adminId}) returning id`;
  const employmentId = emp!.id;
  const [rate] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${employmentId}, 'daily', '1000.00', '2026-01-01', ${adminId}) returning id`;
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${storeId} order by effective_from desc limit 1`;
  const day = (shiftDay: string) => sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes)
    values (${orgId}, ${storeId}, ${workerId}, ${employmentId}, ${shiftDay}, ${cfg!.id}, 'exact', 'verified', 540)`;
  /** A posted regular pay period inserted as an input (basic 12,000.00 -> 13th month 1,000.00), same shape as separation.test.ts. */
  const postedPeriod = async () => {
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
      values (${orgId}, ${storeId}, '2026-01-01', '2026-01-15', 'posted', ${office!.id}, now(), ${adminId}, ${adminId}) returning id`;
    await sql`insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
              values (${run!.id}, ${orgId}, ${employmentId}, ${workerId}, ${rate!.id}, '1', '12000.00', '12000.00', '0', '12000.00')`;
  };
  return { orgId, storeId, officeId: office!.id, adminId, workerId, employmentId, day, postedPeriod, admin: actor(orgId, adminId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An agreement recorded through the writer, then its signing date moved (a mistyped row already in the table). */
async function agreementSignedOn(f: Fixture, signedOn: string, amount = '600.00', limit = amount) {
  const charge = await chargeEntry(sql, f, f.workerId, '600.00');
  const a = await agree(sql, f, f.admin, f.workerId, charge, { amount, perPayrollLimit: limit });
  await sql`update staff_deduction_agreements set signed_on = ${signedOn} where id = ${a.id}`;
  return { ...a, charge };
}

const WEEK = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const payRun = (f: Fixture) =>
  asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-01-01', periodEnd: '2026-01-15', moneyAccountId: f.officeId }));
const slipRecovered = async (f: Fixture) =>
  (await sql<{ r: string }[]>`select advance_recovered::text as r from payslips where org_id = ${f.orgId}`)[0]!.r;
const recoveryRows = async (f: Fixture) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from staff_deduction_recoveries where org_id = ${f.orgId}`)[0]!.n);

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-555 - readers: an agreement counts only on or after its signing date', () => {
  it('payroll: signed after the period end -> agreedRecoverable is 0 and the payslip recovers nothing', async () => {
    const f = await fixture('pay');
    for (const d of WEEK) await f.day(d);
    await agreementSignedOn(f, '2026-01-20');
    expect(await asOrg(f.orgId, (tx) => agreedRecoverable(tx, f.orgId, f.workerId, money('5000.00'), '2026-01-15'))).toBe('0.00');
    await payRun(f);
    expect(await slipRecovered(f)).toBe('0.00');
    expect(await recoveryRows(f)).toBe(0);
  });

  it('payroll boundary: signed ON the period end day -> recoverable', async () => {
    const f = await fixture('payedge');
    for (const d of WEEK) await f.day(d);
    await agreementSignedOn(f, '2026-01-15');
    await payRun(f);
    expect(Number(await slipRecovered(f))).toBeGreaterThan(0);
    expect(await recoveryRows(f)).toBe(1);
  });

  it('separation: signed after the separation date -> nothing; signed on that day -> the agreed amount', async () => {
    const f = await fixture('sep');
    await f.postedPeriod();
    await agreementSignedOn(f, '2026-07-05', '250.00');
    const pv = () =>
      asOrg(f.orgId, (tx) => previewSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30' }));
    expect((await pv()).agreedRecoverable).toBe('0.00');
    await sql`update staff_deduction_agreements set signed_on = '2026-06-30' where org_id = ${f.orgId}`;
    expect((await pv()).agreedRecoverable).toBe('250.00');
  });

  it('separation: the final pay itself recovers nothing from a future-dated agreement', async () => {
    const f = await fixture('sepost');
    await f.postedPeriod();
    await agreementSignedOn(f, '2026-07-05', '250.00');
    const out = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation', separationPayAmount: '0', moneyAccountId: f.officeId, clearanceConfirmedBy: f.adminId }));
    expect(out.netPay).toBe('1000.00');
    expect(await recoveryRows(f)).toBe(0);
  });

  it('13th month: signed after Dec 31 of the year -> nothing; signed on Dec 31 -> the agreed amount', async () => {
    const f = await fixture('13th');
    await f.postedPeriod();
    await agreementSignedOn(f, '2027-01-05', '400.00');
    const pv = (x: Fixture) => asOrg(x.orgId, (tx) => preview13thMonthRun(tx, x.admin, { storeId: x.storeId, year: 2026 }));
    expect((await pv(f)).payouts[0]!.advanceRecovered).toBe('0.00');
    await asOrg(f.orgId, (tx) => post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeId }));
    expect(await recoveryRows(f)).toBe(0);
    const g = await fixture('13thedge');
    await g.postedPeriod();
    await agreementSignedOn(g, '2026-12-31', '400.00');
    expect((await pv(g)).payouts[0]!.advanceRecovered).toBe('400.00');
  });

  it('apply: spending with a date before the signing never touches the agreement', async () => {
    const f = await fixture('apply');
    const a = await agreementSignedOn(f, '2026-01-20');
    const spend = (on: string) => asOrg(f.orgId, (tx) => applyDeductionRecovery(tx, f.orgId, f.workerId, a.charge, money('100.00'), on));
    await expect(spend('2026-01-10')).rejects.toBeInstanceOf(RefusalError);
    expect(await recoveryRows(f)).toBe(0);
    await spend('2026-01-20');
    expect(await recoveryRows(f)).toBe(1);
  });
});

describe('T-555 - writer: the signing date cannot be in the future', () => {
  const rec = async (f: Fixture, signedOn: string) => {
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    return asOrg(f.orgId, async (tx) =>
      recordDeductionAgreement(tx, f.admin, {
        personId: f.workerId, storeId: f.storeId, sourceEntryId: charge, amount: '100.00', perPayrollLimit: '100.00',
        noticeGivenAt: '2026-01-03', employeeExplanation: 'none given', signedOn, evidenceFileId: await scanFor(sql, f, f.adminId),
      }));
  };

  it('refuses tomorrow (business clock), accepts today', async () => {
    const f = await fixture('writer');
    const today = toBusinessDate();
    const err = await rec(f, addDays(today, 1)).catch((e) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toContain('The signing date cannot be in the future.');
    await expect(rec(f, today)).resolves.toHaveProperty('id');
  });
});

describe('T-555 - owner self-agreement: an entry dated later is signed today, never in the future', () => {
  it('on = tomorrow -> signed_on is today; on = a past date is kept', async () => {
    const f = await fixture('ownerself');
    const today = toBusinessDate();
    const run = async (on: string) => {
      const entry = await chargeEntry(sql, f, f.workerId, '300.00', 'owner_pay_recovery');
      await asOrg(f.orgId, (tx) =>
        recordOwnerSelfAgreement(tx, actor(f.orgId, f.workerId), { personId: f.workerId, storeId: f.storeId, sourceEntryId: entry, amount: money('300.00'), on }));
      const [row] = await sql<{ signed_on: string; notice: string }[]>`
        select signed_on::text, notice_given_at::text as notice from staff_deduction_agreements where source_entry_id = ${entry}`;
      return row!;
    };
    expect(await run(addDays(today, 5))).toEqual({ signed_on: today, notice: today });
    expect(await run('2026-01-04')).toEqual({ signed_on: '2026-01-04', notice: '2026-01-04' });
  });
});
