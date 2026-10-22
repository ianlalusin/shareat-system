import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-190 S3 - the pay run with statutory contributions and withholding. `docs/tasks/190-payroll-statutory.md`, cases 1-14 and 16-21
 * (case 15 is the schema file, `packages/db/tests/integration/t190-statutory-schema.test.ts`).
 *
 * Money path. Every figure is the spec's. RED until migration 0206 and the S2/S3 code land: the first failure in most cases is a missing
 * table or column (`statutory_rates`, `persons.sss_no`, `payslips.sss_ee`...), which is the right reason.
 *
 * NAMES THE TESTER FIXED (the builder implements these; the figures are the spec's, the spellings are not):
 *  - tables/columns come from the spec's Schema section verbatim. The rate-row ids on a payslip are `sss_rate_id`, `philhealth_rate_id`,
 *    `pagibig_rate_id` (spec: "the rate row ids used").
 *  - fixtures insert reference rows RAW (as the table owner) with `confirmed_at` set, in this shape: statutory_rates(org_id, agency,
 *    effective_from, ee_rate, er_rate, base_kind, floor, ceiling, step, low_threshold, low_ee_rate, ec_threshold, ec_low, ec_high,
 *    source_ref, confirmed_at, confirmed_by); withholding_brackets(org_id, frequency, effective_from, "over", base_tax, rate, source_ref,
 *    confirmed_at, confirmed_by) with frequency in monthly|semi_monthly|weekly; minimum_wages(org_id, store_id, effective_from,
 *    daily_rate, wage_order_ref, confirmed_at, confirmed_by). Nullable: step, low_*, ec_*, floor/ceiling where not applicable.
 *  - domain: addStatutoryRate(tx, actor, {agency, effectiveFrom, eeRate, erRate, baseKind, floor, ceiling, step?, lowThreshold?, lowEeRate?,
 *    ecThreshold?, ecLow?, ecHigh?, sourceRef}) -> {id};  confirmStatutoryRate(tx, actor, {id}) -> void.  Both need `manage_payroll_rates`
 *    (admin yes, manager AuthorizationError) and write audit_log (entity_id = the row id).
 *  - previewPayRun: each slip also carries sssEe, philhealthEe, pagibigEe, withholding, sssEr, sssEc, philhealthEr, pagibigEr, taxablePay,
 *    isMwe, skippedAgencies; the preview carries `unconfirmedRates: string[]` (each names the agency / "minimum wage" / "withholding")
 *    and `missingGovernmentIds: { personId, personName, agency }[]`.
 *  - every refusal is a RefusalError (from @shareat/db) whose message or userMessage names what is missing / unconfirmed / the person.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  addMinimumWage,
  addStatutoryRate,
  addWithholdingBracketSet,
  confirmStatutoryRate,
  setGovernmentIds,
  post13thMonthRun,
  postPayRun,
  previewPayRun,
  setPayRate,
  voidPayRun,
} from '@shareat/domain';

import * as domainAll from '@shareat/domain';
/** Named by the tester (audit gap 6); not exported yet, hence the cast. */
const { discardWithholdingBracketSet, discardMinimumWage } = domainAll as unknown as {
  discardWithholdingBracketSet: (tx: Tx, a: Actor, i: { frequency: 'monthly' | 'semi_monthly' | 'weekly'; effectiveFrom: string }) => Promise<unknown>;
  discardMinimumWage: (tx: Tx, a: Actor, i: { id: string }) => Promise<unknown>;
};

const sql = postgres(url, { max: 8 });
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

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================================================
// fixtures

type Agency = 'sss' | 'philhealth' | 'pagibig';
type Frequency = 'monthly' | 'semi_monthly' | 'weekly';

async function fixture(
  hint: string,
  cfg: { frequency?: Frequency; overtimeMode?: string; overtimeFixedHourly?: string | null } = {},
) {
  const code = uid(`t190-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open'
              from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
  const [config] = await sql<{ id: string }[]>`
    insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier,
                                         night_diff_multiplier, overtime_mode, overtime_fixed_hourly, holiday_regular_multiplier,
                                         payroll_period_type)
    values (${orgId}, ${storeId}, '2026-01-01', '9', '1.25', '1.10', ${cfg.overtimeMode ?? 'multiplier'},
            ${cfg.overtimeFixedHourly ?? null}, '2.00', ${cfg.frequency ?? 'semi_monthly'}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const workerId = await mk('Worker', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${adminId}) returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return {
    orgId, storeId, configId: config!.id, adminId, managerId, workerId, employmentId: emp!.id, officeAccountId: office!.id,
    admin: actor(orgId, adminId), manager: actor(orgId, managerId), worker: actor(orgId, workerId),
    frequency: cfg.frequency ?? ('semi_monthly' as Frequency),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const SPEC: Record<Agency, Record<string, string | null>> = {
  sss: { ee_rate: '0.05', er_rate: '0.10', base_kind: 'gross', floor: '5000', ceiling: '35000', step: '500', low_threshold: null, low_ee_rate: null, ec_threshold: '15000', ec_low: '10', ec_high: '30' },
  philhealth: { ee_rate: '0.025', er_rate: '0.025', base_kind: 'basic', floor: '10000', ceiling: '100000', step: null, low_threshold: null, low_ee_rate: null, ec_threshold: null, ec_low: null, ec_high: null },
  pagibig: { ee_rate: '0.02', er_rate: '0.02', base_kind: 'basic', floor: '0', ceiling: '10000', step: null, low_threshold: '1500', low_ee_rate: '0.01', ec_threshold: null, ec_low: null, ec_high: null },
};

async function insertRate(
  f: Fixture, agency: Agency, effectiveFrom = '2026-01-01', over: Record<string, string | null> = {}, confirmed = true,
): Promise<string> {
  const r = { ...SPEC[agency], ...over };
  const [row] = await sql<{ id: string }[]>`
    insert into statutory_rates (org_id, agency, effective_from, ee_rate, er_rate, base_kind, floor, ceiling, step, low_threshold,
                                 low_ee_rate, ec_threshold, ec_low, ec_high, source_ref, confirmed_at, confirmed_by)
    values (${f.orgId}, ${agency}, ${effectiveFrom}, ${r.ee_rate!}, ${r.er_rate!}, ${r.base_kind!}, ${r.floor as string}, ${r.ceiling as string}, ${r.step as string},
            ${r.low_threshold as string}, ${r.low_ee_rate as string}, ${r.ec_threshold as string}, ${r.ec_low as string}, ${r.ec_high as string}, 'T-190 test fixture',
            ${confirmed ? new Date() : null}, ${confirmed ? f.adminId : null})
    returning id`;
  return row!.id;
}

const BRACKETS: Record<Frequency, [string, string, string][]> = {
  semi_monthly: [['0', '0', '0'], ['10417', '0', '0.15'], ['16667', '937.50', '0.20'], ['33333', '4270.70', '0.25'], ['83333', '16770.70', '0.30'], ['333333', '91770.70', '0.35']],
  monthly: [['0', '0', '0'], ['20833', '0', '0.15'], ['33333', '2500', '0.20'], ['66667', '10833.33', '0.25'], ['166667', '40833.33', '0.30'], ['666667', '200833.33', '0.35']],
  weekly: [['0', '0', '0'], ['4808', '0', '0.15'], ['7692', '432.60', '0.20'], ['15385', '1971.20', '0.25'], ['38462', '7740.45', '0.30'], ['153846', '42355.65', '0.35']],
};

async function insertBrackets(f: Fixture, frequency: Frequency, confirmed = true) {
  // A confirmed set is closed to further rows (audit gap 1): insert the whole set UNCONFIRMED, then confirm it.
  for (const [over, baseTax, rate] of BRACKETS[frequency]) {
    await sql`insert into withholding_brackets (org_id, frequency, effective_from, "over", base_tax, rate, source_ref)
              values (${f.orgId}, ${frequency}, '2026-01-01', ${over}, ${baseTax}, ${rate}, 'T-190 test fixture')`;
  }
  if (confirmed) {
    await sql`update withholding_brackets set confirmed_at = now(), confirmed_by = ${f.adminId}
              where org_id = ${f.orgId} and frequency = ${frequency} and effective_from = '2026-01-01'`;
  }
}

async function insertMinimumWage(f: Fixture, storeId: string, dailyRate = '695.00', confirmed = true) {
  await sql`insert into minimum_wages (org_id, store_id, effective_from, daily_rate, wage_order_ref, confirmed_at, confirmed_by)
            values (${f.orgId}, ${storeId}, '2026-01-01', ${dailyRate}, 'T-190 test fixture', ${confirmed ? new Date() : null},
                    ${confirmed ? f.adminId : null})`;
}

async function giveNumbers(f: Fixture, which: Agency[] = ['sss', 'philhealth', 'pagibig'], personId = f.workerId) {
  await sql`update persons set
              sss_no = ${which.includes('sss') ? '1234567890' : null},
              philhealth_no = ${which.includes('philhealth') ? '123456789012' : null},
              pagibig_no = ${which.includes('pagibig') ? '210987654321' : null},
              tin = '123456789'
            where id = ${personId}`;
}

/** An org with the full confirmed 2026 table, a rate for the worker, and (by default) all three numbers on file. */
async function ready(
  hint: string,
  o: {
    rate?: string; frequency?: Frequency; overtimeMode?: string; overtimeFixedHourly?: string | null; numbers?: Agency[];
    skipRates?: Agency[]; unconfirmed?: Agency[]; brackets?: Frequency[]; bracketsConfirmed?: boolean; minWage?: string | null;
    minWageConfirmed?: boolean;
  } = {},
) {
  const f = await fixture(hint, o);
  for (const a of ['sss', 'philhealth', 'pagibig'] as Agency[]) {
    if (o.skipRates?.includes(a)) continue;
    await insertRate(f, a, '2026-01-01', {}, !o.unconfirmed?.includes(a));
  }
  for (const fr of o.brackets ?? (['semi_monthly', 'monthly', 'weekly'] as Frequency[])) {
    await insertBrackets(f, fr, o.bracketsConfirmed ?? true);
  }
  if (o.minWage !== null) await insertMinimumWage(f, f.storeId, o.minWage ?? '695.00', o.minWageConfirmed ?? true);
  await giveNumbers(f, o.numbers);
  await asOrg(f.orgId, (tx) =>
    setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: o.rate ?? '800.00', effectiveFrom: '2026-01-01' }));
  return f;
}

/** An adjudicated day, inserted directly - for payroll a day is an INPUT. */
async function addDay(
  f: { orgId: string; storeId: string; workerId: string; employmentId: string; configId: string },
  shiftDay: string,
  over: Partial<{ ot: number; hol: number; holType: string }> = {},
) {
  await sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status,
                                 computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
    values (${f.orgId}, ${f.storeId}, ${f.workerId}, ${f.employmentId}, ${shiftDay}, ${f.configId}, 'exact', 'verified', 540, false,
            ${over.ot ?? 0}, 0, ${over.hol ?? 0}, ${over.holType ? true : false}, ${over.holType ?? null})`;
}
const dates = (ym: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `${ym}-${String(from + i).padStart(2, '0')}`);
async function addDays(f: Parameters<typeof addDay>[0], ds: string[]) {
  for (const d of ds) await addDay(f, d);
}

async function approveOt(f: Fixture, shiftDay: string, minutes: number) {
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${f.adminId}, 'pin', ${f.storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [sess] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${f.adminId}, ${cred!.id}, 'pin', ${f.storeId}, now() + interval '12 hours') returning id`;
  await sql`
    insert into attendance_adjustments (org_id, store_id, employment_id, shift_day, kind, approved_ot_minutes, decided_by_session_id, decided_by_person_id)
    values (${f.orgId}, ${f.storeId}, ${f.employmentId}, ${shiftDay}, 'overtime_approved', ${minutes}, ${sess!.id}, ${f.adminId})`;
}

async function advance(f: Fixture, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-01-01'`;
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

type Period = { periodStart: string; periodEnd: string };
const H1: Period = { periodStart: '2026-01-01', periodEnd: '2026-01-15' };
const H2: Period = { periodStart: '2026-01-16', periodEnd: '2026-01-31' };

const post = (f: Fixture, p: Period) =>
  asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, ...p, moneyAccountId: f.officeAccountId }));
const preview = (f: Fixture, p: Period) => asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...p }));

interface Slip {
  sss_ee: string; philhealth_ee: string; pagibig_ee: string; withholding: string; sss_er: string; sss_ec: string;
  philhealth_er: string; pagibig_er: string; taxable_pay: string; net_pay: string; gross_pay: string; advance_recovered: string;
  is_mwe: boolean; skipped_agencies: string[]; sss_rate_id: string | null; run_id: string;
}
async function slips(runId: string): Promise<Slip[]> {
  return sql<Slip[]>`
    select sss_ee::text, philhealth_ee::text, pagibig_ee::text, withholding::text, sss_er::text, sss_ec::text, philhealth_er::text,
           pagibig_er::text, taxable_pay::text, net_pay::text, gross_pay::text, advance_recovered::text, is_mwe, skipped_agencies,
           sss_rate_id::text, run_id::text
    from payslips where run_id = ${runId} order by created_at`;
}
async function legsOf(runId: string): Promise<Record<string, { debit: string; credit: string }>> {
  const rows = await sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, sum(l.debit)::text as debit, sum(l.credit)::text as credit
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    join payslips p on p.id::text = e.source_id::text
    where p.run_id = ${runId} and e.source_type = 'payrollpayslip' and e.status <> 'draft'
    group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, { debit: r.debit, credit: r.credit }]));
}
/** A refusal's whole text (raw + sentence), or null when the call succeeded. Fails the test if something that is not a RefusalError was thrown. */
async function refusalText(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e, `expected a RefusalError, got: ${String((e as Error)?.message ?? e)}`).toBeInstanceOf(RefusalError);
    const r = e as RefusalError;
    return `${r.message} ${r.userMessage}`;
  }
}
const runCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from pay_runs where org_id = ${orgId}`)[0]!.n);

// =====================================================================================================================

describe('T-190 - the first half: 13 days x 800 (cases 1 and 3)', () => {
  it('case 1: SSS 525/1,050/EC 10, PhilHealth 260/260, Pag-IBIG 200/200, taxable 9,415.00, withholding 0, net 9,415.00; the preview says the same  [mutant: v1 4.5% -> 472.50]', async () => {
    const f = await ready('c1');
    await addDays(f, dates('2026-01', 1, 13));
    const p = await preview(f, H1);
    const s = p.slips[0]!;
    expect([s.sssEe, s.sssEr, s.sssEc, s.philhealthEe, s.philhealthEr, s.pagibigEe, s.pagibigEr, s.taxablePay, s.withholding, s.netPay])
      .toEqual(['525.00', '1050.00', '10.00', '260.00', '260.00', '200.00', '200.00', '9415.00', '0.00', '9415.00']);
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({
      sss_ee: '525.00', sss_er: '1050.00', sss_ec: '10.00', philhealth_ee: '260.00', philhealth_er: '260.00',
      pagibig_ee: '200.00', pagibig_er: '200.00', taxable_pay: '9415.00', withholding: '0.00', net_pay: '9415.00',
      gross_pay: '10400.00', is_mwe: false, skipped_agencies: [],
    });
  });

  it('case 3: Dr 6100 10,400 / 6110 1,060 / 6120 260 / 6130 200; Cr 2210 1,585 / 2220 520 / 2230 400 / cash 9,415; no 2240; balances at 11,920; expense = gross + employer share  [mutant: employee share also debited -> expense 985 too high]', async () => {
    const f = await ready('c3');
    await addDays(f, dates('2026-01', 1, 13));
    const out = await post(f, H1);
    const l = await legsOf(out.runId);
    expect(Object.keys(l).sort()).toEqual(['1130', '2210', '2220', '2230', '6100', '6110', '6120', '6130']);
    expect(l['6100']).toMatchObject({ debit: '10400.00' });
    expect(l['6110']).toMatchObject({ debit: '1060.00' });
    expect(l['6120']).toMatchObject({ debit: '260.00' });
    expect(l['6130']).toMatchObject({ debit: '200.00' });
    expect(l['2210']).toMatchObject({ credit: '1585.00' });
    expect(l['2220']).toMatchObject({ credit: '520.00' });
    expect(l['2230']).toMatchObject({ credit: '400.00' });
    expect(l['1130']).toMatchObject({ credit: '9415.00' });
    expect(l['2240']).toBeUndefined();
    const debits = ['6100', '6110', '6120', '6130'].reduce((n, c) => n + Number(l[c]!.debit), 0);
    const credits = ['2210', '2220', '2230', '1130'].reduce((n, c) => n + Number(l[c]!.credit), 0);
    expect(debits.toFixed(2)).toBe('11920.00'); // gross 10,400 + employer 1,520, never more
    expect(credits.toFixed(2)).toBe('11920.00');
  });
});

describe('T-190 - month-to-date true-up (cases 2, 4, 5, 19)', () => {
  it('case 2: second half, same pay -> SSS ee 525 and EC 20 (the DIFFERENCE), PhilHealth 260, Pag-IBIG 0, net 9,615.00  [mutant: period base -> Pag-IBIG 200 again]', async () => {
    const f = await ready('c2');
    await addDays(f, dates('2026-01', 1, 13));
    await addDays(f, dates('2026-01', 16, 13));
    await post(f, H1);
    const out = await post(f, H2);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({
      sss_ee: '525.00', sss_er: '1050.00', sss_ec: '20.00', philhealth_ee: '260.00', philhealth_er: '260.00',
      pagibig_ee: '0.00', pagibig_er: '0.00', net_pay: '9615.00',
    });
  });

  it('case 4: 20,000 first half -> withholding 1,264.10 on taxable 18,300.00, net 17,035.90  [mutant: tax on gross -> 1,604.10]', async () => {
    const f = await ready('c4', { rate: '20000.00' });
    await addDay(f, '2026-01-05');
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({ sss_ee: '1000.00', philhealth_ee: '500.00', pagibig_ee: '200.00', taxable_pay: '18300.00', withholding: '1264.10', net_pay: '17035.90' });
    const l = await legsOf(out.runId);
    expect(l['2240']).toMatchObject({ credit: '1264.10' });
  });

  it('case 5: second half (month-to-date 40,000) -> SSS ee 1,750 - 1,000 = 750.00 at the ceiling  [mutant: ceiling dropped -> 1,000.00]', async () => {
    const f = await ready('c5', { rate: '20000.00' });
    await addDay(f, '2026-01-05');
    await addDay(f, '2026-01-20');
    await post(f, H1);
    const out = await post(f, H2);
    const [r] = await slips(out.runId);
    expect(r!.sss_ee).toBe('750.00');
  });

  it('case 19: weekly store, five paydays of 4,000 -> SSS ee 250/150/200/200/200, PhilHealth 250/0/50/100/100, Pag-IBIG 80/80/40/0/0, withholding 0  [mutant: true-up only on the 2nd run -> weeks 3-5 zero]', async () => {
    const f = await ready('c19', { rate: '4000.00', frequency: 'weekly' });
    const weeks: Period[] = [
      { periodStart: '2025-12-28', periodEnd: '2026-01-03' }, { periodStart: '2026-01-04', periodEnd: '2026-01-10' },
      { periodStart: '2026-01-11', periodEnd: '2026-01-17' }, { periodStart: '2026-01-18', periodEnd: '2026-01-24' },
      { periodStart: '2026-01-25', periodEnd: '2026-01-31' },
    ];
    await addDays(f, ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23', '2026-01-30']);
    const got: Slip[] = [];
    for (const w of weeks) got.push((await slips((await post(f, w)).runId))[0]!);
    expect(got.map((s) => s.sss_ee)).toEqual(['250.00', '150.00', '200.00', '200.00', '200.00']);
    expect(got.map((s) => s.philhealth_ee)).toEqual(['250.00', '0.00', '50.00', '100.00', '100.00']);
    expect(got.map((s) => s.pagibig_ee)).toEqual(['80.00', '80.00', '40.00', '0.00', '0.00']);
    expect(got.map((s) => s.withholding)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']);
  });
});

describe('T-190 - minimum wage earners (cases 6 and 7)', () => {
  /** 13 days; four of them regular holidays worked 9h (each adds one daily rate); two approved overtime hours at a flat peso rate. */
  async function mweFixture(hint: string, rate: string, otHourly: string) {
    const f = await ready(hint, { rate, overtimeMode: 'fixed', overtimeFixedHourly: otHourly });
    for (const d of dates('2026-01', 1, 13)) {
      if (d <= '2026-01-04') await addDay(f, d, { hol: 540, holType: 'regular' });
      else if (d === '2026-01-05') await addDay(f, d, { ot: 120 });
      else await addDay(f, d);
    }
    await approveOt(f, '2026-01-05', 120);
    return f;
  }

  it('case 6: rate 695 = the store minimum -> gross 12,815, SSS 650 (on gross), PhilHealth 250, Pag-IBIG 180.70, withholding 0.00, MWE flagged  [mutant: MWE ignored -> 197.60]', async () => {
    const f = await mweFixture('c6', '695.00', '500.00');
    const p = await preview(f, H1);
    expect(p.slips[0]!.grossPay).toBe('12815.00'); // fixture sanity: 9,035 + 2,780 holiday + 1,000 overtime
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({ gross_pay: '12815.00', sss_ee: '650.00', philhealth_ee: '250.00', pagibig_ee: '180.70', withholding: '0.00', is_mwe: true, net_pay: '11734.30' });
  });

  it('case 7: rate 696 is ONE PESO above the minimum -> not MWE, gross 12,828, Pag-IBIG 180.96, taxable 11,747.04, withholding 199.51  [mutant: comparison loosened -> 0.00]', async () => {
    const f = await mweFixture('c7', '696.00', '498.00');
    const p = await preview(f, H1);
    expect(p.slips[0]!.grossPay).toBe('12828.00'); // 9,048 + 2,784 + 996 (same total as the spec's 9,048 + 2,780 + 1,000)
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({
      gross_pay: '12828.00', sss_ee: '650.00', philhealth_ee: '250.00', pagibig_ee: '180.96', taxable_pay: '11747.04',
      withholding: '199.51', is_mwe: false, net_pay: '11547.53',
    });
  });
});

describe('T-190 - advance, low pay, shortfall (cases 8, 9, 18)', () => {
  it('case 8: statutory BEFORE the advance - 1,600 pay, 2,000 owed -> 532 withheld, 1,068.00 recovered, net 0.00, 932.00 still on 1230  [mutant: advance first]', async () => {
    const f = await ready('c8');
    await addDays(f, ['2026-01-05', '2026-01-06']);
    await advance(f, '2000.00');
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({ sss_ee: '250.00', philhealth_ee: '250.00', pagibig_ee: '32.00', advance_recovered: '1068.00', net_pay: '0.00' });
    const [bal] = await sql<{ b: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and a.code = '1230' and l.party_id = ${f.workerId} and e.status <> 'draft'`;
    expect(bal!.b).toBe('932.00');
  });

  it('case 9: one day at 700 in the month -> Pag-IBIG low band: ee 1% = 7.00, er 2% = 14.00  [mutant: er at 1%]', async () => {
    const f = await ready('c9', { rate: '700.00' });
    await addDay(f, '2026-01-05');
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect([r!.pagibig_ee, r!.pagibig_er]).toEqual(['7.00', '14.00']);
  });

  it('case 18: one day at 400 -> SSS cut to 146.00, PhilHealth 250.00, Pag-IBIG 4.00, net 0.00; employer SSS 500 + EC 10, PhilHealth 250, Pag-IBIG 8 post in full  [mutant: proportional scale 198.41 / employer cut]', async () => {
    const f = await ready('c18', { rate: '400.00' });
    await addDay(f, '2026-01-05');
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({
      sss_ee: '146.00', philhealth_ee: '250.00', pagibig_ee: '4.00', net_pay: '0.00', taxable_pay: '0.00',
      sss_er: '500.00', sss_ec: '10.00', philhealth_er: '250.00', pagibig_er: '8.00',
    });
    const l = await legsOf(out.runId);
    expect(l['6100']).toMatchObject({ debit: '400.00' });
    expect(l['6110']).toMatchObject({ debit: '510.00' });
    expect(l['6120']).toMatchObject({ debit: '250.00' });
    expect(l['6130']).toMatchObject({ debit: '8.00' });
    expect(l['2210']).toMatchObject({ credit: '656.00' }); // 146 employee + 500 + 10
    expect(l['2220']).toMatchObject({ credit: '500.00' });
    expect(l['2230']).toMatchObject({ credit: '12.00' });
    expect(l['1130']).toBeUndefined(); // net 0 - no cash line
  });

  it('case 18b: the cut part is RETRIED by the next run of the month - 400 (SSS cut to 146), then 10,400 -> SSS monthly on 10,800 (MSC 11,000) 550 - 146 = 404.00', async () => {
    const f = await ready('c18b', { rate: '400.00' });
    await addDay(f, '2026-01-05');
    await post(f, H1);
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '10400.00', effectiveFrom: '2026-01-16' }));
    await addDay(f, '2026-01-20');
    const out = await post(f, H2);
    const [r] = await slips(out.runId);
    expect(r!.sss_ee).toBe('404.00');
  });
});

describe('T-190 - one person, voids, locks (cases 10, 11, 21)', () => {
  it('case 10: one person at TWO stores in the same month is ONE contributor - Pag-IBIG 200 at A, 0 at B, SSS 525 at B (month-to-date 20,800)  [mutant: month-to-date per employment -> 400]', async () => {
    const a = await ready('c10');
    await addDays(a, dates('2026-01', 1, 13));
    // Store B in the same org, same person.
    const [sb] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${a.orgId}, ${uid('b')}, 'Store B') returning id`;
    const storeB = sb!.id;
    const [cfgB] = await sql<{ id: string }[]>`
      insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier, night_diff_multiplier)
      values (${a.orgId}, ${storeB}, '2026-01-01', '9', '1.25', '1.10') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${a.adminId}, ${storeB}), (${a.workerId}, ${storeB})`;
    const [empB] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${a.orgId}, ${a.workerId}, ${storeB}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${a.adminId}) returning id`;
    const [officeB] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${storeB} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    await insertMinimumWage(a, storeB);
    const b = { ...a, storeId: storeB, configId: cfgB!.id, employmentId: empB!.id, officeAccountId: officeB!.id };
    await asOrg(a.orgId, (tx) => setPayRate(tx, a.admin, { employmentId: b.employmentId, storeId: storeB, basis: 'daily', amount: '800.00', effectiveFrom: '2026-01-01' }));
    await addDays(b, dates('2026-01', 1, 13));

    const [sa] = await slips((await post(a, H1)).runId);
    const [sB] = await slips((await post(b, H1)).runId);
    expect(sa!.pagibig_ee).toBe('200.00');
    expect(sB!.pagibig_ee).toBe('0.00');
    expect(sB!.sss_ee).toBe('525.00');
  });

  it('case 11: void case 1\'s run, re-run it -> the same deductions again  [mutant: month-to-date counts voided payslips -> all zero]', async () => {
    const f = await ready('c11');
    await addDays(f, dates('2026-01', 1, 13));
    const first = await post(f, H1);
    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: first.runId, reason: 'wrong period' }));
    const second = await post(f, H1);
    const [r] = await slips(second.runId);
    expect(r).toMatchObject({ sss_ee: '525.00', sss_er: '1050.00', sss_ec: '10.00', philhealth_ee: '260.00', pagibig_ee: '200.00', net_pay: '9415.00' });
  });

  describe('case 21 - the person lock', () => {
    /** Holds `persons ... for update` on a separate connection until `release()`. */
    async function holdLock(personId: string) {
      let release!: () => void;
      let acquired!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const got = new Promise<void>((r) => (acquired = r));
      const held = sql.begin(async (tx) => {
        await tx`select id from persons where id = ${personId} for update`;
        acquired();
        await gate;
      });
      await got;
      return { release, held };
    }
    const pendingAfter = async (p: Promise<unknown>, ms: number) => {
      let done = false;
      p.then(() => (done = true), () => (done = true));
      await new Promise((r) => setTimeout(r, ms));
      return !done;
    };

    it('a POST waits for the person\'s lock, then runs  [mutant: post without the lock finishes while it is held]', async () => {
      const f = await ready('c21a');
      await addDays(f, dates('2026-01', 1, 13));
      const lock = await holdLock(f.workerId);
      const p = post(f, H1);
      expect(await pendingAfter(p, 800), 'postPayRun did not wait for the person lock').toBe(true);
      lock.release();
      await lock.held;
      const out = await p;
      expect((await slips(out.runId))[0]!.sss_ee).toBe('525.00');
    });

    it('a VOID waits for the person\'s lock, then runs  [mutant: void without the lock]', async () => {
      const f = await ready('c21b');
      await addDays(f, dates('2026-01', 1, 13));
      const out = await post(f, H1);
      const lock = await holdLock(f.workerId);
      const v = asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'lock test' }));
      expect(await pendingAfter(v, 800), 'voidPayRun did not wait for the person lock').toBe(true);
      lock.release();
      await lock.held;
      expect((await v).reversed).toBe(1);
    });

    it('a void queued BEFORE a post for the same person: the post\'s month-to-date sees the void\'s result - one deduction, not two, not none', async () => {
      const f = await ready('c21c');
      await addDays(f, dates('2026-01', 1, 13));
      await addDays(f, dates('2026-01', 16, 13));
      const a = await post(f, H1);
      const lock = await holdLock(f.workerId);
      const v = asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: a.runId, reason: 'race' }));
      await new Promise((r) => setTimeout(r, 400));
      const p = post(f, H2);
      await new Promise((r) => setTimeout(r, 400));
      lock.release();
      await lock.held;
      await v;
      const out = await p;
      const [r] = await slips(out.runId);
      // With A voided, B is the month's only deducted payslip: the full monthly figure on its own base.
      expect([r!.sss_ee, r!.philhealth_ee, r!.pagibig_ee]).toEqual(['525.00', '260.00', '200.00']);
    });
  });
});

describe('T-190 - rate rows: effective dating, confirmation, refusals (cases 12, 13, 20)', () => {
  it('case 12: a 6% SSS row from 2026-07-01 - June uses 5% (525.00), July uses 6% (630.00), each payslip keeps ITS row id  [mutant: newest row regardless of date]', async () => {
    const f = await ready('c12');
    const julyRow = await insertRate(f, 'sss', '2026-07-01', { ee_rate: '0.06' });
    const [juneRow] = await sql<{ id: string }[]>`select id from statutory_rates where org_id = ${f.orgId} and agency = 'sss' and effective_from = '2026-01-01'`;
    await addDays(f, dates('2026-06', 1, 13));
    await addDays(f, dates('2026-07', 1, 13));
    const june = (await slips((await post(f, { periodStart: '2026-06-01', periodEnd: '2026-06-15' })).runId))[0]!;
    const july = (await slips((await post(f, { periodStart: '2026-07-01', periodEnd: '2026-07-15' })).runId))[0]!;
    expect([june.sss_ee, july.sss_ee]).toEqual(['525.00', '630.00']);
    expect([june.sss_rate_id, july.sss_rate_id]).toEqual([juneRow!.id, julyRow]);
  });

  it('case 13: an unconfirmed SSS row - preview WORKS and warns, post refuses naming SSS and writes nothing; once an admin confirms it, post succeeds  [mutant: post ignores confirmed_at]', async () => {
    const f = await ready('c13', { skipRates: ['sss'] });
    await addDays(f, dates('2026-01', 1, 13));
    const added = await asOrg(f.orgId, (tx) =>
      addStatutoryRate(tx, f.admin, {
        agency: 'sss', effectiveFrom: '2026-01-01', eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000',
        step: '500', ecThreshold: '15000', ecLow: '10', ecHigh: '30', sourceRef: 'SSS Circular 2024-006',
      }));
    const audit = async () =>
      Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${f.orgId} and entity_id = ${added.id}`)[0]!.n);
    expect(await audit(), 'adding a rate wrote no audit_log row').toBeGreaterThanOrEqual(1);

    const p = await preview(f, H1);
    expect(p.slips).toHaveLength(1);
    expect(p.slips[0]!.sssEe).toBe('525.00');
    expect(p.unconfirmedRates.join(' ')).toMatch(/sss/i);

    const text = await refusalText(post(f, H1));
    expect(text, 'post accepted an unconfirmed rate').not.toBeNull();
    expect(text).toMatch(/sss/i);
    expect(await runCount(f.orgId)).toBe(0);

    const before = await audit();
    await asOrg(f.orgId, (tx) => confirmStatutoryRate(tx, f.admin, { id: added.id }));
    expect(await audit(), 'confirming a rate wrote no audit_log row').toBeGreaterThan(before);
    const out = await post(f, H1);
    expect((await slips(out.runId))[0]!.sss_ee).toBe('525.00');
  });

  it('case 13: an unconfirmed MINIMUM WAGE refuses the post naming the minimum wage; preview warns', async () => {
    const f = await ready('c13mw', { minWageConfirmed: false });
    await addDays(f, dates('2026-01', 1, 13));
    expect((await preview(f, H1)).unconfirmedRates.join(' ')).toMatch(/minimum wage/i);
    const text = await refusalText(post(f, H1));
    expect(text, 'post accepted an unconfirmed minimum wage').not.toBeNull();
    expect(text).toMatch(/minimum wage/i);
    expect(await runCount(f.orgId)).toBe(0);
  });

  it('case 13: an unconfirmed WITHHOLDING table refuses the post naming withholding', async () => {
    const f = await ready('c13wh', { bracketsConfirmed: false });
    await addDays(f, dates('2026-01', 1, 13));
    expect((await preview(f, H1)).unconfirmedRates.join(' ')).toMatch(/withholding/i);
    const text = await refusalText(post(f, H1));
    expect(text).not.toBeNull();
    expect(text).toMatch(/withholding/i);
  });

  it('case 13: a MANAGER adding OR confirming a rate is refused (manage_payroll_rates is admin-only); the row stays unconfirmed', async () => {
    const f = await ready('c13mgr', { skipRates: ['sss'] });
    await expect(
      asOrg(f.orgId, (tx) =>
        addStatutoryRate(tx, f.manager, {
          agency: 'sss', effectiveFrom: '2026-01-01', eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', sourceRef: 'x',
        })),
    ).rejects.toThrow(AuthorizationError);
    const unconfirmed = await insertRate(f, 'sss', '2026-01-01', {}, false);
    await expect(asOrg(f.orgId, (tx) => confirmStatutoryRate(tx, f.manager, { id: unconfirmed }))).rejects.toThrow(AuthorizationError);
    const [row] = await sql<{ confirmed_at: Date | null }[]>`select confirmed_at from statutory_rates where id = ${unconfirmed}`;
    expect(row!.confirmed_at).toBeNull();
  });

  it('case 20: a store with NO minimum-wage row - preview and post both refuse, naming the minimum wage  [mutant: treated as non-MWE silently]', async () => {
    const f = await ready('c20mw', { minWage: null });
    await addDays(f, dates('2026-01', 1, 13));
    for (const call of [() => preview(f, H1), () => post(f, H1)]) {
      const text = await refusalText(call());
      expect(text, 'a missing minimum wage was not refused').not.toBeNull();
      expect(text).toMatch(/minimum wage/i);
    }
    expect(await runCount(f.orgId)).toBe(0);
  });

  it('case 20: a weekly store whose org has NO weekly withholding brackets - preview and post both refuse, naming withholding and weekly  [mutant: treated as taxable]', async () => {
    const f = await ready('c20wk', { frequency: 'weekly', rate: '4000.00', brackets: ['semi_monthly', 'monthly'] });
    await addDay(f, '2026-01-02');
    const week = { periodStart: '2025-12-28', periodEnd: '2026-01-03' };
    for (const call of [() => preview(f, week), () => post(f, week)]) {
      const text = await refusalText(call());
      expect(text, 'missing weekly brackets were not refused').not.toBeNull();
      expect(text).toMatch(/withholding/i);
      expect(text).toMatch(/weekly/i);
    }
    expect(await runCount(f.orgId)).toBe(0);
  });

  it('case 20: no Pag-IBIG contribution row for the period - refused, naming Pag-IBIG (never zero)', async () => {
    const f = await ready('c20pi', { skipRates: ['pagibig'] });
    await addDays(f, dates('2026-01', 1, 13));
    const text = await refusalText(preview(f, H1));
    expect(text).not.toBeNull();
    expect(text).toMatch(/pag-?ibig/i);
  });
});

describe('T-190 - the 13th month (case 14)', () => {
  /** A prior posted regular run whose basic pay sums to `basic`, inserted as an INPUT (thirteenth-month.test.ts does the same). */
  async function withEarnings(hint: string, basic: string) {
    const f = await fixture(hint);
    await giveNumbers(f);
    const [rate] = await sql<{ id: string }[]>`
      insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
      values (${f.orgId}, ${f.employmentId}, 'daily', '500.00', '2026-01-01', ${f.adminId}) returning id`;
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', '2026-01-15', 'posted', ${f.officeAccountId}, now(), ${f.adminId}, ${f.adminId}) returning id`;
    await sql`insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
              values (${run!.id}, ${f.orgId}, ${f.employmentId}, ${f.workerId}, ${rate!.id}, '1', ${basic}, ${basic}, '0', ${basic})`;
    return f;
  }
  const run13 = (f: Fixture) =>
    asOrg(f.orgId, (tx) => post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId: f.officeAccountId }));
  const codesOf = async (f: Fixture) =>
    (await sql<{ code: string }[]>`
      select distinct a.code from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and e.source_type = 'thirteenthmonthpayout' order by a.code`).map((r) => r.code);

  it('YTD 12,000 posts with NO statutory lines and no rate rows needed (guard: 6140 / cash only)  [mutant: 13th month routed through contributions -> SSS ee > 0]', async () => {
    const f = await withEarnings('c14a', '144000.00');
    const out = await run13(f);
    expect(out.totalNet).toMatch(/12,?000\.00/);
    expect(await codesOf(f)).toEqual(['1130', '6140']);
  });

  it('exactly 90,000.00 posts exempt (basic 1,080,000.00 / 12)', async () => {
    const f = await withEarnings('c14b', '1080000.00');
    await run13(f);
    expect(await codesOf(f)).toEqual(['1130', '6140']);
  });

  it('90,000.01 refuses, naming the person, and posts nothing (basic 1,080,000.12 / 12)', async () => {
    const f = await withEarnings('c14c', '1080000.12');
    const text = await refusalText(run13(f));
    expect(text, '90,000.01 of 13th month was not refused').not.toBeNull();
    expect(text).toMatch(/Worker/);
    expect(await codesOf(f)).toEqual([]);
  });
});

describe('T-190 - missing government numbers (cases 16 and 17)', () => {
  it('case 16: no SSS no. - SSS ee/er/EC 0, no 2210 and NO 6110 line, PhilHealth and Pag-IBIG as case 1, taxable 9,940.00, net 9,940.00, skipped_agencies = [sss]; the preview lists the gap  [mutant: SSS deducted anyway, or only the employee share skipped]', async () => {
    const f = await ready('c16', { numbers: ['philhealth', 'pagibig'] });
    await addDays(f, dates('2026-01', 1, 13));
    const p = await preview(f, H1);
    expect(p.missingGovernmentIds).toEqual([expect.objectContaining({ personId: f.workerId, personName: 'Worker', agency: 'sss' })]);
    expect(p.slips[0]!.skippedAgencies).toEqual(['sss']);
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r).toMatchObject({
      sss_ee: '0.00', sss_er: '0.00', sss_ec: '0.00', philhealth_ee: '260.00', philhealth_er: '260.00', pagibig_ee: '200.00', pagibig_er: '200.00',
      taxable_pay: '9940.00', net_pay: '9940.00', skipped_agencies: ['sss'],
    });
    const l = await legsOf(out.runId);
    expect(l['2210']).toBeUndefined();
    expect(l['6110']).toBeUndefined();
    expect(l['6100']).toMatchObject({ debit: '10400.00' });
  });

  it('case 17: the number arrives after the first half - NO back-deduction: second half SSS ee 525 / er 1,050 / EC 10 on the deducted base only; the first slip still says skipped  [mutant: month-to-date includes the skipped half -> ee 1,050]', async () => {
    const f = await ready('c17', { numbers: ['philhealth', 'pagibig'] });
    await addDays(f, dates('2026-01', 1, 13));
    await addDays(f, dates('2026-01', 16, 13));
    const first = await post(f, H1);
    await giveNumbers(f); // all three now on file
    const second = await post(f, H2);
    const [r] = await slips(second.runId);
    expect(r).toMatchObject({ sss_ee: '525.00', sss_er: '1050.00', sss_ec: '10.00', philhealth_ee: '260.00', pagibig_ee: '0.00', skipped_agencies: [] });
    const [a] = await slips(first.runId);
    expect(a).toMatchObject({ sss_ee: '0.00', skipped_agencies: ['sss'] }); // an old payslip never changes when the number is added
  });
});


// =====================================================================================================================
// Audit gaps (coordinator, 17 Oct)

const auditCount = async (orgId: string, like: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${orgId} and (coalesce(before::text, '') || ' ' || coalesce(after::text, '')) ilike ${like}`)[0]!.n);

describe('T-190 audit gap 1 - a confirmed bracket set is closed', () => {
  it('adding a row to an existing CONFIRMED (frequency, effective_from) set is refused with a RefusalError and the set is unchanged', async () => {
    const f = await ready('g1');
    const n = async () => Number((await sql<{ n: string }[]>`select count(*)::text as n from withholding_brackets where org_id = ${f.orgId} and frequency = 'semi_monthly' and effective_from = '2026-01-01'`)[0]!.n);
    const before = await n();
    const text = await refusalText(
      asOrg(f.orgId, (tx) => addWithholdingBracketSet(tx, f.admin, { frequency: 'semi_monthly', effectiveFrom: '2026-01-01', rows: [{ over: '999999', baseTax: '0', rate: '0.40' }], sourceRef: 'extra row' })),
    );
    expect(text, 'a row was added to a confirmed set').not.toBeNull();
    expect(await n()).toBe(before);
  });
});

describe('T-190 audit gap 2 - no new table may be dated into a period already paid', () => {
  async function paid(hint: string) {
    const f = await ready(hint);
    await addDays(f, dates('2026-01', 1, 13));
    await post(f, H1); // latest posted period_end = 2026-01-15
    return f;
  }
  it('a statutory rate effective on or before the latest posted period_end is refused; a later one is accepted', async () => {
    const f = await paid('g2a');
    const add = (effectiveFrom: string) =>
      asOrg(f.orgId, (tx) => addStatutoryRate(tx, f.admin, { agency: 'pagibig', effectiveFrom, eeRate: '0.02', erRate: '0.02', baseKind: 'basic', floor: '0', ceiling: '10000', sourceRef: 'late' }));
    expect(await refusalText(add('2025-12-01')), 'a rate dated before a paid period was accepted').not.toBeNull();
    await expect(add('2026-02-01')).resolves.toBeDefined();
  });
  it('a minimum wage effective on or before the latest posted period_end is refused (2026-01-15 refused, 2026-01-16 accepted)', async () => {
    const f = await paid('g2b');
    const add = (effectiveFrom: string) => asOrg(f.orgId, (tx) => addMinimumWage(tx, f.admin, { storeId: f.storeId, effectiveFrom, dailyRate: '720.00', wageOrderRef: 'late' }));
    expect(await refusalText(add('2026-01-15')), 'a minimum wage dated into a paid period was accepted').not.toBeNull();
    await expect(add('2026-01-16')).resolves.toBeDefined();
  });
  it('a bracket set effective on or before the latest posted period_end is refused; a later one is accepted', async () => {
    const f = await paid('g2c');
    const add = (effectiveFrom: string) =>
      asOrg(f.orgId, (tx) => addWithholdingBracketSet(tx, f.admin, { frequency: 'weekly', effectiveFrom, rows: [{ over: '0', baseTax: '0', rate: '0' }], sourceRef: 'late' }));
    expect(await refusalText(add('2026-01-10')), 'a bracket set dated into a paid period was accepted').not.toBeNull();
    await expect(add('2026-02-01')).resolves.toBeDefined();
  });
});

describe('T-190 audit gap 3 - setGovernmentIds is audited by FIELD NAME, never by number', () => {
  const FIELDS = /sss_no|philhealth_no|pagibig_no|\btin\b/g;
  const rowsFor = async (f: Fixture) =>
    sql<{ t: string }[]>`select (coalesce(before::text, '') || ' ' || coalesce(after::text, '')) as t from audit_log
                         where org_id = ${f.orgId} and entity_id = ${f.workerId} order by recorded_at, id`;
  it('setting SSS no. and TIN writes one audit row naming exactly sss_no and tin, with neither number in it; clearing SSS no. is audited too', async () => {
    const f = await ready('g3', { numbers: [] });
    await sql`update persons set tin = null where id = ${f.workerId}`;
    const base = { personId: f.workerId, storeId: f.storeId };
    await asOrg(f.orgId, (tx) => setGovernmentIds(tx, f.admin, { ...base, sssNo: '1234567890', tin: '987654321' }));
    const set = await rowsFor(f);
    expect(set, 'setting government numbers wrote no audit row').toHaveLength(1);
    expect([...new Set(set[0]!.t.match(FIELDS) ?? [])].sort()).toEqual(['sss_no', 'tin']);
    expect(set[0]!.t).not.toMatch(/1234567890|987654321/);

    await asOrg(f.orgId, (tx) => setGovernmentIds(tx, f.admin, { ...base, sssNo: '', tin: '987654321' }));
    const all = await rowsFor(f);
    expect(all, 'clearing a number wrote no audit row').toHaveLength(2);
    expect([...new Set(all[1]!.t.match(FIELDS) ?? [])]).toEqual(['sss_no']);
    expect(all[1]!.t).not.toMatch(/1234567890|987654321/);
  });
});

describe('T-440 S1 (T-S1-12, T-S1-15) - setGovernmentIds takes its checks from the shared rule set', () => {
  const stored = async (f: Fixture) =>
    (await sql<{ sss_no: string | null; philhealth_no: string | null; pagibig_no: string | null; tin: string | null }[]>`
      select sss_no, philhealth_no, pagibig_no, tin from persons where id = ${f.workerId}`)[0]!;
  const attempt = async (f: Fixture, over: Record<string, string>) => {
    try {
      await asOrg(f.orgId, (tx) => setGovernmentIds(tx, f.admin, { personId: f.workerId, storeId: f.storeId, ...over }));
      return undefined;
    } catch (e) {
      return e as Error & { userMessage?: string };
    }
  };

  it('"123" is refused with the rule-set sentence and nothing is stored', async () => {
    const f = await ready('t440a', { numbers: [] });
    await sql`update persons set sss_no = null, philhealth_no = null, pagibig_no = null, tin = null where id = ${f.workerId}`;
    const err = await attempt(f, { sssNo: '123' });
    expect(err?.name).toBe('RefusalError');
    expect(err?.userMessage).toBe('The SSS number must be 10 digits.');
    expect(await stored(f)).toEqual({ sss_no: null, philhealth_no: null, pagibig_no: null, tin: null });
  });

  it('the other three sentences are unchanged', async () => {
    const f = await ready('t440b', { numbers: [] });
    expect((await attempt(f, { philhealthNo: '123' }))?.userMessage).toBe('The PhilHealth number must be 12 digits.');
    expect((await attempt(f, { pagibigNo: '123' }))?.userMessage).toBe('The Pag-IBIG number must be 12 digits.');
    expect((await attempt(f, { tin: '123' }))?.userMessage).toBe('The TIN must be 9 to 12 digits.');
  });

  it('"12-3456789-0" is stored as the 10 stripped digits, never the raw input  [mutant: store raw input]', async () => {
    const f = await ready('t440c', { numbers: [] });
    await sql`update persons set sss_no = null where id = ${f.workerId}`;
    expect(await attempt(f, { sssNo: '12-3456789-0', philhealthNo: '1234 5678 9012', pagibigNo: '', tin: ' 123-456-789 ' })).toBeUndefined();
    const row = await stored(f);
    expect(row.sss_no).toBe('1234567890');
    expect(row.philhealth_no).toBe('123456789012');
    expect(row.pagibig_no).toBeNull();
    expect(row.tin).toBe('123456789');
  });

  it('no echo (A5): a refused government number appears in neither the raw diagnostic nor the sentence  [mutant: the diagnostic interpolates the value]', async () => {
    const f = await ready('t440d', { numbers: [] });
    for (const [field, value] of [['sssNo', '1234567x90'], ['philhealthNo', '98765432109z'], ['pagibigNo', '5555-66z7'], ['tin', '31415926535q']] as const) {
      const err = await attempt(f, { [field]: value });
      expect(err?.name, field).toBe('RefusalError');
      expect(err?.message, `${field} raw diagnostic`).not.toContain(value);
      expect(err?.userMessage, `${field} sentence`).not.toContain(value);
      expect(err?.message, `${field} raw diagnostic (stripped form)`).not.toContain(value.replace(/[\s-]/g, ''));
    }
  });
});

describe('T-190 audit gap 5 - MWE is decided on the rate in force at period_end', () => {
  it("a raise to 700 on 14 Jan (last shift 13 Jan at 695, period_end 15 Jan) makes the slip NOT MWE  [mutant: last worked day's rate]", async () => {
    const f = await ready('g5', { rate: '695.00' });
    await asOrg(f.orgId, (tx) => setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: '700.00', effectiveFrom: '2026-01-14' }));
    await addDays(f, dates('2026-01', 1, 13));
    const out = await post(f, H1);
    const [r] = await slips(out.runId);
    expect(r!.gross_pay).toBe('9035.00'); // the days are still paid at 695
    expect(r!.is_mwe, "judged on the last worked day's rate, not the rate at period_end").toBe(false);
  });
});

describe('T-190 audit gap 6 - discarding an unconfirmed table', () => {
  it('an UNCONFIRMED bracket set is discarded (rows gone, audited); a CONFIRMED set cannot be', async () => {
    const f = await ready('g6a', { brackets: ['semi_monthly'] });
    await asOrg(f.orgId, (tx) => addWithholdingBracketSet(tx, f.admin, { frequency: 'weekly', effectiveFrom: '2026-03-01', rows: [{ over: '0', baseTax: '0', rate: '0' }, { over: '4808', baseTax: '0', rate: '0.15' }], sourceRef: 'draft' }));
    const n = async (fr: string, from: string) =>
      Number((await sql<{ n: string }[]>`select count(*)::text as n from withholding_brackets where org_id = ${f.orgId} and frequency = ${fr} and effective_from = ${from}`)[0]!.n);
    expect(await n('weekly', '2026-03-01')).toBe(2);
    const before = await auditCount(f.orgId, '%discard%');
    await asOrg(f.orgId, (tx) => discardWithholdingBracketSet(tx, f.admin, { frequency: 'weekly', effectiveFrom: '2026-03-01' }));
    expect(await n('weekly', '2026-03-01')).toBe(0);
    expect(await auditCount(f.orgId, '%discard%'), 'the discard was not audited').toBeGreaterThan(before);

    const text = await refusalText(asOrg(f.orgId, (tx) => discardWithholdingBracketSet(tx, f.admin, { frequency: 'semi_monthly', effectiveFrom: '2026-01-01' })));
    expect(text, 'a confirmed set was discarded').not.toBeNull();
    expect(await n('semi_monthly', '2026-01-01')).toBe(6);
  });
  it('an UNCONFIRMED minimum wage is discarded (gone, audited); a CONFIRMED one cannot be', async () => {
    const f = await ready('g6b');
    const mw = await asOrg(f.orgId, (tx) => addMinimumWage(tx, f.admin, { storeId: f.storeId, effectiveFrom: '2026-03-01', dailyRate: '720.00', wageOrderRef: 'draft' }));
    const before = await auditCount(f.orgId, '%discard%');
    await asOrg(f.orgId, (tx) => discardMinimumWage(tx, f.admin, { id: mw.id }));
    expect(await sql`select 1 from minimum_wages where id = ${mw.id}`).toHaveLength(0);
    expect(await auditCount(f.orgId, '%discard%'), 'the discard was not audited').toBeGreaterThan(before);

    const [confirmed] = await sql<{ id: string }[]>`select id from minimum_wages where org_id = ${f.orgId} and effective_from = '2026-01-01'`;
    const text = await refusalText(asOrg(f.orgId, (tx) => discardMinimumWage(tx, f.admin, { id: confirmed!.id })));
    expect(text, 'a confirmed minimum wage was discarded').not.toBeNull();
    expect(await sql`select 1 from minimum_wages where id = ${confirmed!.id}`).toHaveLength(1);
  });
});
