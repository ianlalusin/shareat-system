import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-191 — 13th-month pay. `docs/tasks/191-thirteenth-month-pay.md`.
 *
 * ⭐ The thing under test is the SUM, the YEAR BOUNDARY, and the POSTING PATTERN — not attendance
 * correctness, which `payroll.test.ts` already covers. So these fixtures insert `pay_runs` /
 * `payslips` DIRECTLY with a chosen `basicPay`, the same "a day is an INPUT, not a thing to
 * derive" philosophy `payroll.test.ts`'s `addDay` uses, applied one layer up: **a payslip is an
 * input here.**
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { post13thMonthRun, preview13thMonthRun, void13thMonthRun } from '@shareat/domain';

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
  const code = uid(`t191-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgId}, '2026-01-01', '2026-12-31', 'open')`;

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
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${uid('sc')}, '2026-01-01', 'regular', ${adminId}) returning id`;
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

/** A posted (or voided/draft) regular pay period, inserted directly as an INPUT — see this
 *  file's top comment. `personId`/`employmentId` default to the fixture's worker. */
async function postedPeriod(
  f: Fixture,
  input: {
    periodStart: string;
    periodEnd: string;
    basicPay: string;
    status?: 'draft' | 'posted' | 'voided';
    employmentId?: string;
    personId?: string;
  },
): Promise<{ runId: string; payslipId: string }> {
  const status = input.status ?? 'posted';
  // ⭐ A voided run WAS posted — posted_at/posted_by SURVIVE a void (pay_runs_posted_shape_check
  // only exempts 'draft'; pay_runs_void_shape_check additionally requires voided_at/void_reason
  // whenever status = 'voided'). Matches the real lifecycle, not a shortcut for the fixture.
  const wasPosted = status === 'posted' || status === 'voided';
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id,
                          posted_at, posted_by, voided_at, void_reason, created_by)
    values (${f.orgId}, ${f.storeId}, ${input.periodStart}, ${input.periodEnd}, ${status},
            ${f.officeAccountId},
            ${wasPosted ? new Date() : null}, ${wasPosted ? f.adminId : null},
            ${status === 'voided' ? new Date() : null}, ${status === 'voided' ? 'Test fixture void' : null},
            ${f.adminId})
    returning id`;
  const runId = run!.id;
  const [slip] = await sql<{ id: string }[]>`
    insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked,
                          basic_pay, gross_pay, advance_recovered, net_pay)
    values (${runId}, ${f.orgId}, ${input.employmentId ?? f.employmentId},
            ${input.personId ?? f.workerId}, ${f.payRateId}, '1',
            ${input.basicPay}, ${input.basicPay}, '0', ${input.basicPay})
    returning id`;
  return { runId, payslipId: slip!.id };
}

/** Puts an advance on 1230 against the worker, the way a cash request would — same pattern
 *  `payroll.test.ts`'s own `advance()` helper uses. */
async function advance(f: Fixture, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  const [adv] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1230'`;
  const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-02', ${period!.id}, 'cashrequest', ${uid('adv')}, 'draft') returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 1, ${adv!.id}, ${f.storeId}, ${amount}, '0', 'employee', ${f.workerId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${cash!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-191 — the sum, the year boundary, and the posting pattern', () => {
  it('⭐ sums basic pay across MULTIPLE posted regular runs, gross = sum / 12', async () => {
    const f = await fixture('sum');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await postedPeriod(f, { periodStart: '2026-02-01', periodEnd: '2026-02-15', basicPay: '6000.00' });
    const pv = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(pv.payouts).toHaveLength(1);
    expect(pv.payouts[0]!.basicPayEarned).toBe('12000.00');
    expect(pv.payouts[0]!.grossPay).toBe('1000.00'); // 12000 / 12
  });

  it('⛔ a VOIDED run\'s basic pay is EXCLUDED from the sum', async () => {
    const f = await fixture('voided');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await postedPeriod(f, { periodStart: '2026-02-01', periodEnd: '2026-02-15', basicPay: '6000.00', status: 'voided' });
    const pv = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(pv.payouts[0]!.basicPayEarned).toBe('6000.00');
  });

  it('⛔ payslips from ANOTHER YEAR are excluded — the year boundary', async () => {
    const f = await fixture('year');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '6000.00' });
    await postedPeriod(f, { periodStart: '2025-12-16', periodEnd: '2025-12-31', basicPay: '9999.00' });
    await postedPeriod(f, { periodStart: '2027-01-01', periodEnd: '2027-01-15', basicPay: '9999.00' });
    const pv = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(pv.payouts[0]!.basicPayEarned).toBe('6000.00');
  });

  it('an employment with NO payslips that year is excluded from the payout list, not paid ₱0', async () => {
    const f = await fixture('none');
    // No postedPeriod calls at all — the worker earned nothing in 2026.
    const pv = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(pv.payouts).toHaveLength(0);
  });

  it('advance netting: capped at gross, net = gross - advanceRecovered', async () => {
    const f = await fixture('advance');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    await advance(f, '600.00');
    const pv = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(pv.payouts[0]!.grossPay).toBe('1000.00');
    expect(pv.payouts[0]!.advanceRecovered).toBe('600.00');
    expect(pv.payouts[0]!.netPay).toBe('400.00');
  });

  it('⛔ self-dealing: an ADMIN posting their OWN employment\'s payout is refused', async () => {
    const f = await fixture('self');
    // ⚠️ `run_payroll` is admin-only, so a plain staff poster is refused on ROLE before the
    // self-dealing check ever runs. The case this block exists for is specifically an ADMIN
    // whose own employment is in the payout list — same reasoning postPayRun's own comment
    // states: "Rank is not the only control... an admin paying themselves is exactly the case."
    const [selfEmp] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${f.orgId}, ${f.adminId}, ${f.storeId}, ${uid('sc-self')}, '2026-01-01', 'regular', ${f.adminId})
      returning id`;
    await postedPeriod(f, {
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      basicPay: '12000.00',
      employmentId: selfEmp!.id,
      personId: f.adminId,
    });
    await expect(
      asOrg(f.orgId, (tx) =>
        post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeAccountId }),
      ),
    ).rejects.toThrow(/pays your own employment/);
  });

  it('⛔ double-post: a second run for the same (store, year) is refused while the first stands', async () => {
    const f = await fixture('double');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    await asOrg(f.orgId, (tx) =>
      post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeAccountId }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeAccountId }),
      ),
    ).rejects.toThrow();
  });

  it('post then void: reverses the journal entries, frees the year to be posted again', async () => {
    const f = await fixture('void');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    const { runId } = await asOrg(f.orgId, (tx) =>
      post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeAccountId }),
    );
    const voided = await asOrg(f.orgId, (tx) =>
      void13thMonthRun(tx, f.admin, { runId, reason: 'Test correction' }),
    );
    expect(voided.reversed).toBe(1);

    // The year is payable again.
    const second = await asOrg(f.orgId, (tx) =>
      post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeAccountId }),
    );
    expect(second.payouts).toBe(1);
  });

  it('an ENDED employment (resigned mid-year) with posted payslips still appears — owed regardless of separation', async () => {
    const f = await fixture('ended');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    await sql`update employments set employment_status = 'resigned', ended_on = '2026-06-30' where id = ${f.employmentId}`;
    const pv = await asOrg(f.orgId, (tx) => preview13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026 }));
    expect(pv.payouts).toHaveLength(1);
    expect(pv.payouts[0]!.grossPay).toBe('1000.00');
  });

  it('a manager may not post — `run_payroll` denies a manager, same as regular payroll', async () => {
    const f = await fixture('manager');
    await postedPeriod(f, { periodStart: '2026-01-01', periodEnd: '2026-01-15', basicPay: '12000.00' });
    const [mgr] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Manager') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${mgr!.id}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${mgr!.id}, ${f.storeId})`;
    await expect(
      asOrg(f.orgId, (tx) =>
        post13thMonthRun(tx, actor(f.orgId, mgr!.id), {
          storeId: f.storeId,
          year: 2026,
          moneyAccountId: f.officeAccountId,
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });
});
