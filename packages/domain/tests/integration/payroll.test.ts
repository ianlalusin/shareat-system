import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-189 — pay rates and the pay run. Phase 5 slice 1.
 *
 * ⭐ The thing under test is the one v1 never managed: **a payslip that actually exists**, posted,
 * with the days it paid frozen behind it. v1's payroll has produced zero across seven stores.
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
import { closeDb, payrollRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { postPayRun, previewPayRun, setPayRate, voidPayRun } from '@shareat/domain';

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

async function fixture(
  hint: string,
  cfg: { overtimeMode?: string; overtimeFixedHourly?: string | null } = {},
) {
  const code = uid(`pr-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  // 9 required hours = 8 worked + 1 paid break, the live default.
  const [config] = await sql<{ id: string }[]>`
    insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift,
                                         overtime_multiplier, night_diff_multiplier,
                                         overtime_mode, overtime_fixed_hourly)
    values (${orgId}, ${storeId}, '2026-01-01', '9', '1.25', '1.10',
            ${cfg.overtimeMode ?? 'multiplier'}, ${cfg.overtimeFixedHourly ?? null}) returning id`;

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const workerId = await mk('Worker', 'staff');

  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${uid('sc')}, '2026-01-01', 'regular', ${adminId}) returning id`;

  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation`;

  return {
    orgId, storeId, configId: config!.id, adminId, managerId, workerId,
    admin: actor(orgId, adminId), manager: actor(orgId, managerId), worker: actor(orgId, workerId),
    employmentId: emp!.id, officeAccountId: office!.id,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An adjudicated day, inserted directly — for payroll a day is an INPUT, not a thing to derive. */
async function addDay(
  f: Fixture,
  shiftDay: string,
  over: Partial<{ status: string; isHalfDay: boolean; computedMinutes: number; ot: number; nd: number; hol: number; holType: string }> = {},
) {
  const [d] = await sql<{ id: string }[]>`
    insert into attendance_days
      (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
       status, computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes,
       holiday_minutes, is_holiday, holiday_type)
    values (${f.orgId}, ${f.storeId}, ${f.workerId}, ${f.employmentId}, ${shiftDay}, ${f.configId},
            'exact', ${over.status ?? 'verified'}, ${over.computedMinutes ?? 540},
            ${over.isHalfDay ?? false}, ${over.ot ?? 0}, ${over.nd ?? 0}, ${over.hol ?? 0},
            ${over.holType ? true : false}, ${over.holType ?? null})
    returning id`;
  return d!.id;
}

/** Puts an advance on 1230 against the worker, the way a cash request would. */
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

const period = { periodStart: '2026-01-01', periodEnd: '2026-01-15' };

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-189 — the rate, effective-dated and append-only', () => {
  it('⭐ reads back the rate IN FORCE on a date, with no effective_to to maintain', async () => {
    const f = await fixture('rate');
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '500.00', effectiveFrom: '2026-01-01' }));
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '600.00', effectiveFrom: '2026-01-10' }));

    const before = await asOrg(f.orgId, (tx) => payrollRepo.rateInForceOn(tx, f.orgId, f.employmentId, '2026-01-09'));
    const after = await asOrg(f.orgId, (tx) => payrollRepo.rateInForceOn(tx, f.orgId, f.employmentId, '2026-01-10'));
    expect(before!.amount).toBe('500.00');
    expect(after!.amount).toBe('600.00');

    // ⚠️ Before any rate existed is NULL, not zero — a real state the caller must refuse.
    expect(await asOrg(f.orgId, (tx) => payrollRepo.rateInForceOn(tx, f.orgId, f.employmentId, '2025-12-31'))).toBeNull();
  });

  it('⛔ two rates for the same job on the same day are refused', async () => {
    const f = await fixture('ratedupe');
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '500.00', effectiveFrom: '2026-01-01' }));
    await expect(
      asOrg(f.orgId, (tx) =>
        setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '900.00', effectiveFrom: '2026-01-01' })),
    ).rejects.toThrow(/pay_rates_employment_from_unique/);
  });

  it('⛔ a MANAGER may not set a rate — rostering a team is not repricing it', async () => {
    const f = await fixture('rategate');
    await expect(
      asOrg(f.orgId, (tx) =>
        setPayRate(tx, f.manager, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '500.00', effectiveFrom: '2026-01-01' })),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =====================================================================================

describe('T-189 — what a run computes', () => {
  async function rated(hint: string, amount = '540.00') {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount, effectiveFrom: '2026-01-01' }));
    return f;
  }

  it('⭐ a half day pays half the daily rate', async () => {
    const f = await rated('half');
    await addDay(f, '2026-01-05');
    await addDay(f, '2026-01-06', { isHalfDay: true, computedMinutes: 300 });
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips[0]!.daysWorked).toBe(1.5);
    expect(p.slips[0]!.basicPay).toBe('810.00');
  });

  it('⭐ a mid-period raise pays the old rate before it and the new rate after', async () => {
    const f = await rated('raise', '500.00');
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '600.00', effectiveFrom: '2026-01-10' }));
    await addDay(f, '2026-01-05');
    await addDay(f, '2026-01-12');
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips[0]!.basicPay).toBe('1100.00');
  });

  it('⛔ `needs_review` days are EXCLUDED and COUNTED, never silently skipped', async () => {
    const f = await rated('review');
    await addDay(f, '2026-01-05');
    await addDay(f, '2026-01-06', { status: 'needs_review' });
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips[0]!.daysWorked).toBe(1);
    expect(p.needsReviewDays).toBe(1);
  });

  it('⛔ a day with NO rate in force is reported, never paid at zero', async () => {
    const f = await fixture('unrated');
    await addDay(f, '2026-01-05');
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips).toHaveLength(0);
    expect(p.unratedEmployments[0]!.days).toBe(1);
    await expect(
      asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId })),
    ).rejects.toThrow(/no pay rate in force/i);
  });

  it('⛔ an HOURLY basis is refused by name rather than guessed at', async () => {
    const f = await fixture('hourly');
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'hourly', amount: '60.00', effectiveFrom: '2026-01-01' }));
    await addDay(f, '2026-01-05');
    await expect(
      asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period })),
    ).rejects.toThrow(/only a daily basis has a compute path/i);
  });
});

// =====================================================================================

describe('T-189 — posting, and the seam the attendance lane left open', () => {
  async function readyToPost(hint: string) {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '540.00', effectiveFrom: '2026-01-01' }));
    const d1 = await addDay(f, '2026-01-05');
    const d2 = await addDay(f, '2026-01-06');
    return { f, dayIds: [d1, d2] };
  }

  it('⭐ posts Dr 6100 / Cr cash, and 6100 finally has something in it', async () => {
    const { f } = await readyToPost('post');
    const out = await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
    expect(out.payslips).toBe(1);

    const legs = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit, l.credit from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and e.source_type = 'payrollpayslip' order by a.code`;
    expect(legs.map((l) => l.code)).toEqual(['1130', '6100']);
    expect(legs.find((l) => l.code === '6100')!.debit).toBe('1080.00');
    expect(legs.find((l) => l.code === '1130')!.credit).toBe('1080.00');
  });

  it('⭐⭐ posting FREEZES the days it paid — the column T-157 left for this task', async () => {
    const { f, dayIds } = await readyToPost('freeze');
    const out = await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
    const rows = await sql<{ frozen_by_pay_run_id: string | null }[]>`
      select frozen_by_pay_run_id from attendance_days where id = any(${dayIds}::uuid[])`;
    expect(rows.every((r) => r.frozen_by_pay_run_id === out.runId)).toBe(true);
  });

  it('⛔ a second run cannot pay the same days — they are frozen and drop out', async () => {
    const { f } = await readyToPost('twice');
    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips).toHaveLength(0);
  });

  it('⛔⭐ two POSTED runs whose periods OVERLAP are refused BY THE DATABASE', async () => {
    // Bible §16.6: "blocked by period OVERLAP not exact bounds — the stricter and correct test."
    // A unique index on (store, start, end) would accept 1–15 beside 10–20 and pay the overlap twice.
    const { f } = await readyToPost('overlap');
    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
    await expect(sql`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id,
                            posted_at, posted_by, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-10', '2026-01-20', 'posted', ${f.officeAccountId},
              now(), ${f.adminId}, ${f.adminId})`,
    ).rejects.toThrow(/pay_runs_no_overlapping_posted_period/);
  });

  it('⭐ but a DRAFT may overlap freely — the guard is on posted runs only', async () => {
    const { f } = await readyToPost('draftoverlap');
    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
    await expect(sql`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-10', '2026-01-20', 'draft', ${f.officeAccountId}, ${f.adminId})`,
    ).resolves.toBeDefined();
  });
});

// =====================================================================================

describe('T-189 — the advance, netted from 1230', () => {
  async function withAdvance(hint: string, amount: string) {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '540.00', effectiveFrom: '2026-01-01' }));
    await addDay(f, '2026-01-05');
    await addDay(f, '2026-01-06');
    await advance(f, amount);
    return f;
  }

  it('⭐ nets what the person drew, and 1230 goes to zero', async () => {
    const f = await withAdvance('advance', '400.00');
    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));

    const [row] = await sql<{ bal: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::text as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and a.code = '1230' and l.party_id = ${f.workerId} and e.status <> 'draft'`;
    expect(row!.bal).toBe('0.00');

    const [slip] = await sql<{ advance_recovered: string; net_pay: string }[]>`
      select advance_recovered, net_pay from payslips where org_id = ${f.orgId}`;
    expect(slip!.advance_recovered).toBe('400.00');
    expect(slip!.net_pay).toBe('680.00');
  });

  it('⛔ an advance BIGGER than the pay leaves net at zero and the rest still owed', async () => {
    const f = await withAdvance('bigadvance', '5000.00');
    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));

    const [slip] = await sql<{ advance_recovered: string; net_pay: string }[]>`
      select advance_recovered, net_pay from payslips where org_id = ${f.orgId}`;
    expect(slip!.advance_recovered).toBe('1080.00');
    expect(slip!.net_pay).toBe('0.00'); // ⛔ never below zero — a payslip is not a bill

    const [row] = await sql<{ bal: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::text as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and a.code = '1230' and l.party_id = ${f.workerId} and e.status <> 'draft'`;
    expect(row!.bal).toBe('3920.00'); // still owed
  });
});

// =====================================================================================

describe('T-189 — voiding, and the one place a freeze is lifted', () => {
  it('⭐ reverses the entries and UNFREEZES the days, so the period is payable again', async () => {
    const f = await fixture('void');
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '540.00', effectiveFrom: '2026-01-01' }));
    await addDay(f, '2026-01-05');
    const out = await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));

    const v = await asOrg(f.orgId, (tx) =>
      voidPayRun(tx, f.admin, { runId: out.runId, reason: 'wrong period' }));
    expect(v.reversed).toBe(1);
    expect(v.unfrozenDays).toBe(1);

    // Payable again — a voided run did not pay, so leaving them frozen would strand the period.
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips).toHaveLength(1);

    // 6100 nets to zero once the reversal lands.
    const [row] = await sql<{ bal: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::text as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and a.code = '6100' and e.status <> 'draft'`;
    expect(row!.bal).toBe('0.00');
  });

  it('⛔ voiding needs a reason', async () => {
    const f = await fixture('voidreason');
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '540.00', effectiveFrom: '2026-01-01' }));
    await addDay(f, '2026-01-05');
    const out = await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
    await expect(
      asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: '   ' })),
    ).rejects.toThrow(/needs a reason/i);
  });
});

// =====================================================================================

describe('T-189 §8 — who may run payroll', () => {
  it('⛔ a MANAGER may not run payroll', async () => {
    const f = await fixture('gatemgr');
    await expect(
      asOrg(f.orgId, (tx) => previewPayRun(tx, f.manager, { storeId: f.storeId, ...period })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⛔⭐ an ADMIN may not post a run that pays their OWN employment', async () => {
    // Bible §16.6's third self-dealing block. ⚠️ Admins are NOT exempt: an admin paying
    // themselves is exactly the case this exists for.
    const f = await fixture('selfdeal');
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${f.orgId}, ${f.adminId}, ${f.storeId}, ${uid('sc')}, '2026-01-01', 'regular', ${f.adminId}) returning id`;
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: emp!.id, storeId: f.storeId, basis: 'daily', amount: '900.00', effectiveFrom: '2026-01-01' }));
    await sql`insert into attendance_days
      (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes)
      values (${f.orgId}, ${f.storeId}, ${f.adminId}, ${emp!.id}, '2026-01-05', ${f.configId}, 'exact', 'verified', 540)`;

    await expect(
      asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId })),
    ).rejects.toThrow(/pays your own employment/i);
  });
});


// =====================================================================================
// T-189b — Ian, 2026-08-31: OT configurable, hours in half-hour steps, holiday per type

describe('T-189b — overtime priced two ways, end to end', () => {
  async function rated(hint: string, cfg = {}) {
    const f = await fixture(hint, cfg);
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '540.00', effectiveFrom: '2026-01-01' }));
    return f;
  }

  it('⭐ FIXED mode pays a flat amount per OT hour, ignoring the daily rate', () => {
    return (async () => {
      const f = await rated('otfixed', { overtimeMode: 'fixed', overtimeFixedHourly: '80.00' });
      await addDay(f, '2026-01-05', { ot: 120 });
      const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
      expect(p.slips[0]!.otPay).toBe('160.00'); // 2h × ₱80, not 2h × 60 × 1.25
    })();
  });

  it('⛔ the DATABASE refuses `fixed` with no amount — every OT hour would price at zero', async () => {
    // ⚠️ Tested on INSERT, not UPDATE: `store_attendance_config` rows are immutable and
    // append-and-supersede, so a bad setting can only ever arrive as a NEW row.
    const f = await fixture('otbad');
    await expect(sql`
      insert into store_attendance_config (org_id, store_id, effective_from, overtime_mode)
      values (${f.orgId}, ${f.storeId}, '2026-02-01', 'fixed')`,
    ).rejects.toThrow(/fixed_ot_needs_amount/);
  });

  it('⭐ overtime is priced on STEPPED hours — 1h50m pays 1.5h, not 1.83h', async () => {
    const f = await rated('otstep');
    await addDay(f, '2026-01-05', { ot: 110 });
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips[0]!.otPay).toBe('112.50');
  });

  it('⚠️ under half an hour of overtime pays NOTHING — "no hanging minutes"', async () => {
    const f = await rated('otcrumb');
    await addDay(f, '2026-01-05', { ot: 25 });
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    expect(p.slips[0]!.otPay).toBe('0.00');
    // ⚠️ But the MINUTES are still recorded on the payslip — the fact is kept even when unpaid.
    expect(p.slips[0]!.otMinutes).toBe(25);
  });

  it('⭐ the holiday premium follows the holiday TYPE', async () => {
    const f = await rated('holtype');
    await addDay(f, '2026-01-05', { hol: 540, holType: 'regular' });
    await addDay(f, '2026-01-06', { hol: 540, holType: 'special_non_working' });
    await addDay(f, '2026-01-07', { hol: 540, holType: 'special_working' });
    const p = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
    // 540 (regular, ×2.0) + 162 (special non-working, ×1.3) + 270 (special working, ×1.5)
    expect(p.slips[0]!.holidayPay).toBe('972.00');
  });

  it('⛔ a holiday multiplier below 1 is refused — it would turn a premium into a deduction', async () => {
    const f = await fixture('holbad');
    await expect(sql`
      insert into store_attendance_config (org_id, store_id, effective_from, holiday_regular_multiplier)
      values (${f.orgId}, ${f.storeId}, '2026-02-01', '0.90')`,
    ).rejects.toThrow(/holiday_multipliers/);
  });
});
