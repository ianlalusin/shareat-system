import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-192 — separation, final pay, clearance (first slice). `docs/tasks/192-separation-final-pay-clearance.md`.
 *
 * ⭐ The thing under test that matters most is §2.3's fix: a posted separation must exclude that
 * employment from the ANNUAL 13th-month run, or December pays it twice.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { agree, chargeEntry, creditEntry } from './_fixtures/t519-agreements';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { postSeparation, preview13thMonthRun, previewSeparation, reverseEntry, voidSeparation } from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`t192-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, greatest('2026-12-01'::date, date_trunc('month', now() at time zone 'Asia/Manila')::date), '1 month') d`;

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const workerId = await mk('Worker', 'staff');

  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', '2026-06-30', 'resigned', ${adminId}) returning id`;
  const employmentId = emp!.id;

  const [rate] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${employmentId}, 'daily', '500.00', '2026-01-01', ${adminId}) returning id`;

  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation`;

  return {
    orgId, storeId, adminId, workerId, employmentId, payRateId: rate!.id,
    admin: actor(orgId, adminId), worker: actor(orgId, workerId),
    officeAccountId: office!.id,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A posted regular pay period — same "a payslip is an input" fixture shape as
 *  `thirteenth-month.test.ts`'s `postedPeriod`. */
async function postedPeriod(
  f: Fixture,
  input: { periodStart: string; periodEnd: string; basicPay: string },
): Promise<void> {
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id,
                          posted_at, posted_by, created_by)
    values (${f.orgId}, ${f.storeId}, ${input.periodStart}, ${input.periodEnd}, 'posted',
            ${f.officeAccountId}, now(), ${f.adminId}, ${f.adminId})
    returning id`;
  await sql`
    insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked,
                          basic_pay, gross_pay, advance_recovered, net_pay)
    values (${run!.id}, ${f.orgId}, ${f.employmentId}, ${f.workerId}, ${f.payRateId}, '1',
            ${input.basicPay}, ${input.basicPay}, '0', ${input.basicPay})`;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-192 — separation, final pay, clearance', () => {
  it('⭐ prices the pro-rated 13th month THROUGH the separation date, not the whole year', async () => {
    const f = await fixture('prorate');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    // After the separation date — must NOT be counted.
    await postedPeriod(f, { periodStart: '2026-08-01', periodEnd: '2026-08-15', basicPay: '6000.00' });
    const pv = await asOrg(f.orgId, (tx) =>
      previewSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30' }),
    );
    expect(pv.thirteenthMonthBasicPayEarned).toBe('6000.00');
    expect(pv.thirteenthMonthGross).toBe('500.00');
  });

  it('⛔ THE FIX: a posted separation excludes that employment from the ANNUAL 13th-month run', async () => {
    const f = await fixture('exclude');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId,
        employmentId: f.employmentId,
        separationDate: '2026-06-30',
        cause: 'resignation',
        separationPayAmount: '0',
        moneyAccountId: f.officeAccountId,
        clearanceConfirmedBy: f.adminId,
      }),
    );
    const annual = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(annual.payouts.find((p) => p.employmentId === f.employmentId)).toBeUndefined();
  });

  it('advance netting: capped at gross total, net = gross - advanceRecovered', async () => {
    const f = await fixture('advance');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    // T-519: recovery needs a signed agreement over a real charge entry.
    await agree(sql, f, f.admin, f.workerId, await chargeEntry(sql, f, f.workerId, '600.00'), { amount: '600.00' });
    const result = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId,
        employmentId: f.employmentId,
        separationDate: '2026-06-30',
        cause: 'resignation',
        separationPayAmount: '0',
        moneyAccountId: f.officeAccountId,
        clearanceConfirmedBy: f.adminId,
      }),
    );
    // gross = 1000.00 (12000/12), advance 600 recovered, net 400.
    expect(result.netPay).toBe('400.00');
  });

  it('T-519 gate: a charge with NO agreement recovers 0 in final pay and stays on 1230', async () => {
    const f = await fixture('t519gate');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    await chargeEntry(sql, f, f.workerId, '600.00');
    const pv = await asOrg(f.orgId, (tx) =>
      previewSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30' }));
    expect(pv.outstandingAdvance).toBe('600.00'); // still owed
    expect(pv.agreedRecoverable).toBe('0.00');
    const result = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation', separationPayAmount: '0', moneyAccountId: f.officeAccountId, clearanceConfirmedBy: f.adminId }));
    expect(result.netPay).toBe('1000.00');
  });

  it('T-519: an agreed 250.00 recovers exactly 250.00 in final pay (no 20% cap), completes, and voiding the separation reopens it', async () => {
    const f = await fixture('t519agreed');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    const a = await agree(sql, f, f.admin, f.workerId, await chargeEntry(sql, f, f.workerId, '600.00'), { amount: '250.00', perPayrollLimit: '10.00' });
    const result = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation', separationPayAmount: '0', moneyAccountId: f.officeAccountId, clearanceConfirmedBy: f.adminId }));
    expect(result.netPay).toBe('750.00');
    const st = async () => (await sql<{ status: string }[]>`select status from staff_deduction_agreements where id = ${a.id}`)[0]!.status;
    expect(await st()).toBe('completed');
    await asOrg(f.orgId, (tx) => voidSeparation(tx, f.admin, { id: result.id, reason: 'test' }));
    expect(await st()).toBe('active');
  });

  it('separationPayAmount defaults to 0 and is NOT auto-computed from cause — redundancy at ₱0 succeeds', async () => {
    const f = await fixture('zero');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    const result = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId,
        employmentId: f.employmentId,
        separationDate: '2026-06-30',
        cause: 'redundancy',
        separationPayAmount: '0',
        moneyAccountId: f.officeAccountId,
        clearanceConfirmedBy: f.adminId,
      }),
    );
    expect(result.netPay).toBe('500.00'); // just the pro-rated 13th month, no auto separation pay
  });

  it('⛔ refuses without clearance confirmed', async () => {
    const f = await fixture('noclear');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await expect(
      asOrg(f.orgId, (tx) =>
        postSeparation(tx, f.admin, {
          storeId: f.storeId,
          employmentId: f.employmentId,
          separationDate: '2026-06-30',
          cause: 'resignation',
          separationPayAmount: '0',
          moneyAccountId: f.officeAccountId,
          clearanceConfirmedBy: '',
        }),
      ),
    ).rejects.toThrow(/clearance must be confirmed/);
  });

  it('⛔ self-dealing refused, same shape as postPayRun/post13thMonthRun', async () => {
    const f = await fixture('self');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await expect(
      asOrg(f.orgId, (tx) =>
        postSeparation(tx, f.worker, {
          storeId: f.storeId,
          employmentId: f.employmentId,
          separationDate: '2026-06-30',
          cause: 'resignation',
          separationPayAmount: '0',
          moneyAccountId: f.officeAccountId,
          clearanceConfirmedBy: f.adminId,
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('one posted separation per employment — a second post is refused while the first stands', async () => {
    const f = await fixture('double');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId,
        employmentId: f.employmentId,
        separationDate: '2026-06-30',
        cause: 'resignation',
        separationPayAmount: '0',
        moneyAccountId: f.officeAccountId,
        clearanceConfirmedBy: f.adminId,
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        previewSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30' }),
      ),
    ).rejects.toThrow(/already has a posted separation/);
  });

  it('void frees the employment to be posted again — a correction', async () => {
    const f = await fixture('void');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    const first = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId,
        employmentId: f.employmentId,
        separationDate: '2026-06-30',
        cause: 'resignation',
        separationPayAmount: '0',
        moneyAccountId: f.officeAccountId,
        clearanceConfirmedBy: f.adminId,
      }),
    );
    const voided = await asOrg(f.orgId, (tx) => voidSeparation(tx, f.admin, { id: first.id, reason: 'Wrong cause entered' }));
    expect(voided.reversed).toBe(true);

    const second = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, {
        storeId: f.storeId,
        employmentId: f.employmentId,
        separationDate: '2026-06-30',
        cause: 'redundancy',
        separationPayAmount: '0',
        moneyAccountId: f.officeAccountId,
        clearanceConfirmedBy: f.adminId,
      }),
    );
    expect(second.id).not.toBe(first.id);
  });
});

describe('T-519 audit fixes - the agreement needs a live charge and a live 1230 balance', () => {
  it('probe: charge 600, agreed 600, charge reversed -> final pay recovers 0 and 1230 is not driven negative', async () => {
    const f = await fixture('t519rev');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    const charge = await chargeEntry(sql, f, f.workerId, '600.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '600.00' });
    await asOrg(f.orgId, (tx) => reverseEntry(tx, { entryId: charge, reason: 'test', reversedBy: f.adminId }));
    const pv = await asOrg(f.orgId, (tx) =>
      previewSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30' }));
    expect(pv.agreedRecoverable).toBe('0.00');
    const result = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation', separationPayAmount: '0', moneyAccountId: f.officeAccountId, clearanceConfirmedBy: f.adminId }));
    expect(result.netPay).toBe('1000.00');
  });

  it('the live 1230 balance caps final-pay recovery: agreed 600, 550 paid back outside payroll -> recovers 50', async () => {
    const f = await fixture('t519bal');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    await agree(sql, f, f.admin, f.workerId, await chargeEntry(sql, f, f.workerId, '600.00'), { amount: '600.00' });
    await creditEntry(sql, f, f.workerId, '550.00');
    const result = await asOrg(f.orgId, (tx) =>
      postSeparation(tx, f.admin, { storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation', separationPayAmount: '0', moneyAccountId: f.officeAccountId, clearanceConfirmedBy: f.adminId }));
    expect(result.netPay).toBe('950.00');
  });
});
