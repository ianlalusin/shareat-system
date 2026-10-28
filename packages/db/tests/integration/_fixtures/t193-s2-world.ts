/**
 * T-193 S2 (TESTER) - one small payroll world, written RAW as the table owner, so the repo reads are judged against figures we
 * control to the centavo (no rate tables, no attendance, no domain code). Not a test file.
 *
 * Every figure below is semi-monthly Lipa / Malvar from docs/tasks/193-statutory-remittance.md "Cases" (base month October 2026):
 * SSS per slip = ee + er + ec; PhilHealth = ee + er; Pag-IBIG = ee + er; BIR = withholding. The GL side mirrors `postPayRun`
 * (Dr 6100, Cr 2210 / 2220 / 2230 / 2240 at the run's store) so a reconciliation can be checked against real ledger lines.
 */
import postgres from 'postgres';

import { seedChartOfAccounts } from '../../../seed/chart-of-accounts';

export type Sql = postgres.Sql;
export type Agency = 'sss' | 'philhealth' | 'pagibig' | 'bir';
export const ACCOUNT: Record<Agency, string> = { sss: '2210', philhealth: '2220', pagibig: '2230', bir: '2240' };

let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

export interface Org {
  orgId: string;
  lipa: string;
  malvar: string;
  adminId: string;
  bankId: string; // money account (Lipa, 1140)
}

/** An org with its chart, two stores, an admin, a bank money account and open monthly periods Sep 2026 - Feb 2027. */
export async function mkOrg(sql: Sql, hint: string): Promise<Org> {
  const code = uid(`t193s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('LP')}, 'Lipa') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('MV')}, 'Malvar') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [m] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${orgId}, ${a!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open'
              from generate_series('2026-09-01'::date, '2027-02-01'::date, interval '1 month') m`;
  return { orgId, lipa: a!.id, malvar: b!.id, adminId: p!.id, bankId: m!.id };
}

export interface Who {
  personId: string;
  employmentId: string;
}
/** A person with one employment at `storeId` and a daily pay rate (a payslip needs both). */
export async function mkPerson(sql: Sql, f: Org, name: string, storeId: string): Promise<Who> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${f.orgId}, ${p!.id}, ${storeId}, ${`SE-${Date.now()}${++seq}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${f.adminId}) returning id`;
  await sql`insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
            values (${f.orgId}, ${e!.id}, 'daily', '800.00', '2026-01-01', ${f.adminId})`;
  return { personId: p!.id, employmentId: e!.id };
}

type Pair = [ee: string, er: string];
type Triple = [ee: string, er: string, ec: string];
export interface SlipSpec {
  who: Who;
  sss?: Triple;
  ph?: Pair;
  pi?: Pair;
  wh?: string;
  skipped?: Agency[];
}
export interface RunSpec {
  storeId: string;
  start: string;
  end: string;
  status: 'posted' | 'voided' | 'draft';
  slips: SlipSpec[];
}

const z = '0.00';

async function periodFor(sql: Sql, orgId: string, date: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on <= ${date} and ends_on >= ${date}`;
  return r!.id;
}
async function accountId(sql: Sql, orgId: string, code: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
  return r!.id;
}

export interface GlLine {
  code: string;
  storeId: string;
  debit?: string;
  credit?: string;
}
/** A POSTED, balanced journal entry (header and lines in one transaction), dated `date`. Returns the entry id. */
export async function glEntry(sql: Sql, orgId: string, date: string, sourceType: string, lines: GlLine[]): Promise<string> {
  const periodId = await periodFor(sql, orgId, date);
  const src = uid('src');
  const ids = new Map<string, string>();
  for (const l of lines) if (!ids.has(l.code)) ids.set(l.code, await accountId(sql, orgId, l.code));
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
      values (${orgId}, ${periodId}, ${date}, ${sourceType}, ${src}, ${uid('idem')}, 't193 s2 world', 'draft') returning id`;
    let n = 0;
    for (const l of lines) {
      await tx`insert into journal_lines (entry_id, account_id, line_no, debit, credit, store_id)
               values (${e!.id}, ${ids.get(l.code)!}, ${++n}, ${l.debit ?? z}, ${l.credit ?? z}, ${l.storeId})`;
    }
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    return e!.id;
  }) as Promise<string>;
}

/** A pay run with its payslips. A POSTED run also posts one accrual entry per slip (what `postPayRun` does); voided / draft post none. */
export async function mkRun(sql: Sql, f: Org, r: RunSpec): Promise<string> {
  const [moneyRun] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, created_by)
    values (${f.orgId}, ${r.storeId}, ${r.start}, ${r.end}, 'draft', ${f.bankId}, ${f.adminId}) returning id`;
  const runId = moneyRun!.id;
  const slips: { spec: SlipSpec; id: string }[] = [];
  for (const s of r.slips) {
    const sss = s.sss ?? [z, z, z];
    const ph = s.ph ?? [z, z];
    const pi = s.pi ?? [z, z];
    const wh = s.wh ?? z;
    const [row] = await sql<{ id: string }[]>`
      insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, net_pay,
                            sss_ee, philhealth_ee, pagibig_ee, withholding, sss_er, sss_ec, philhealth_er, pagibig_er, skipped_agencies)
      values (${runId}, ${f.orgId}, ${s.who.employmentId}, ${s.who.personId},
              (select id from pay_rates where employment_id = ${s.who.employmentId}), '13.00', '10400.00', '10400.00',
              ('10400.00'::numeric - ${sss[0]}::numeric - ${ph[0]}::numeric - ${pi[0]}::numeric - ${wh}::numeric),
              ${sss[0]}, ${ph[0]}, ${pi[0]}, ${wh}, ${sss[1]}, ${sss[2]}, ${ph[1]}, ${pi[1]}, ${s.skipped ?? []})
      returning id`;
    slips.push({ spec: s, id: row!.id });
  }
  if (r.status !== 'draft') {
    await sql`update pay_runs set status = 'posted', posted_at = now(), posted_by = ${f.adminId} where id = ${runId}`;
  }
  if (r.status === 'voided') {
    await sql`update pay_runs set status = 'voided', voided_at = now(), voided_by = ${f.adminId}, void_reason = 'test void' where id = ${runId}`;
  }
  if (r.status === 'posted') {
    for (const { spec } of slips) {
      const owed: Record<Agency, string> = {
        sss: sumMoney(spec.sss ?? [z, z, z]),
        philhealth: sumMoney(spec.ph ?? [z, z]),
        pagibig: sumMoney(spec.pi ?? [z, z]),
        bir: spec.wh ?? z,
      };
      const credits = (Object.keys(owed) as Agency[]).filter((a) => owed[a] !== z).map((a) => ({ code: ACCOUNT[a], storeId: r.storeId, credit: owed[a] }));
      if (credits.length === 0) continue;
      const total = sumMoney(credits.map((c) => c.credit));
      await glEntry(sql, f.orgId, r.end, 'payrollpayslip', [{ code: '6100', storeId: r.storeId, debit: total }, ...credits]);
    }
  }
  return runId;
}

/** Exact centavo sum of decimal strings, as 'n.nn'. */
export function sumMoney(parts: string[]): string {
  let c = 0n;
  for (const p of parts) {
    const [w = '0', fr = ''] = p.split('.');
    c += BigInt(w) * 100n + BigInt((fr + '00').slice(0, 2));
  }
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const s = abs.toString().padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
}

export interface PaySpec {
  agency: Agency;
  month: string;
  paidOn: string;
  ref: string;
  lines: { storeId: string; amount: string }[];
  voided?: boolean;
}
/** A statutory payment with its lines, written raw; a posted one also posts Dr 22x0 (per line store) / Cr 1130 and links the entry. */
export async function mkPayment(sql: Sql, f: Org, p: PaySpec): Promise<string> {
  const id = crypto.randomUUID();
  await sql`insert into statutory_payments (id, org_id, agency, month, paid_on, money_account_id, reference_no, created_by)
            values (${id}, ${f.orgId}, ${p.agency}, ${p.month}, ${p.paidOn}, ${f.bankId}, ${p.ref}, ${f.adminId})`;
  for (const l of p.lines) {
    await sql`insert into statutory_payment_lines (org_id, payment_id, store_id, amount) values (${f.orgId}, ${id}, ${l.storeId}, ${l.amount})`;
  }
  if (p.voided) {
    await sql`update statutory_payments set status = 'voided', void_reason = 'test void', voided_by = ${f.adminId}, voided_at = now() where id = ${id}`;
  } else {
    const total = sumMoney(p.lines.map((l) => l.amount));
    const entry = await glEntry(sql, f.orgId, p.paidOn, 'statutory_payment', [
      ...p.lines.map((l) => ({ code: ACCOUNT[p.agency], storeId: l.storeId, debit: l.amount })),
      { code: '1130', storeId: f.lipa, credit: total },
    ]);
    await sql`update statutory_payments set journal_entry_id = ${entry} where id = ${id}`;
  }
  return id;
}

export interface World extends Org {
  ana: Who; // Lipa
  ben: Who; // Malvar
  cora: Who; // Lipa, no SSS number
  runs: Record<'L1' | 'L2' | 'L3' | 'L4' | 'L5v' | 'L6d' | 'L7' | 'M1' | 'M2', string>;
  pay: Record<'P1' | 'P2' | 'P3v' | 'P4' | 'P5', string>;
}

/**
 * The shared world. October 2026 (period_end in October):
 *   Lipa    SSS 3,180.00 (Ana 1,585 + 1,595)   PhilHealth 1,340.00 (Ana 1,040 + Cora 300)   Pag-IBIG 500.00 (Ana 400 + Cora 100)   BIR 125.50
 *   Malvar  SSS 3,180.00 (Ben: run M1 is 26 Sep - 10 Oct, so its month is OCTOBER)           PhilHealth 1,040.00   Pag-IBIG 400.00   BIR none
 * November Lipa SSS 310.30 (310.00 + a 0.10 + 0.20 + 0.00 slip: float sums print 0.30000000000000004), PhilHealth 200.00.
 * January 2027 Lipa SSS 160.00. NOT owed: a voided Oct run (SSS 9,999.00), a draft Dec run (SSS 777.00).
 * Cora has no SSS number: her slip is `skipped_agencies = {sss}` with 0.00 SSS.
 * Payments: P1 Lipa SSS Oct 2,000.00; P2 SSS Oct Lipa 500.00 + Malvar 1,000.10 (one payment, two stores); P3 VOIDED Malvar SSS Oct 3,180.00;
 *   P4 PhilHealth Oct Lipa 1,340.00; P5 PhilHealth DEC 2026 Malvar 10.00 (a month with no payroll at all).
 */
export async function mkWorld(sql: Sql, hint: string): Promise<World> {
  const f = await mkOrg(sql, hint);
  const ana = await mkPerson(sql, f, 'Ana Lipa', f.lipa);
  const ben = await mkPerson(sql, f, 'Ben Malvar', f.malvar);
  const cora = await mkPerson(sql, f, 'Cora NoSss', f.lipa);
  const run = (storeId: string, start: string, end: string, status: RunSpec['status'], slips: SlipSpec[]) => mkRun(sql, f, { storeId, start, end, status, slips });
  // the voided run is created FIRST: two POSTED runs may not overlap, a voided one may overlap anything posted later
  const L5v = await run(f.lipa, '2026-10-16', '2026-10-31', 'voided', [{ who: ana, sss: ['9999.00', '0.00', '0.00'] }]);
  const L1 = await run(f.lipa, '2026-10-01', '2026-10-15', 'posted', [{ who: ana, sss: ['525.00', '1035.00', '25.00'], ph: ['260.00', '260.00'], pi: ['100.00', '100.00'] }]);
  const L2 = await run(f.lipa, '2026-10-16', '2026-10-31', 'posted', [
    { who: ana, sss: ['525.00', '1045.00', '25.00'], ph: ['260.00', '260.00'], pi: ['100.00', '100.00'], wh: '125.50' },
    { who: cora, ph: ['150.00', '150.00'], pi: ['50.00', '50.00'], skipped: ['sss'] },
  ]);
  const L3 = await run(f.lipa, '2026-11-01', '2026-11-15', 'posted', [{ who: ana, sss: ['100.00', '200.00', '10.00'], ph: ['100.00', '100.00'] }]);
  const L7 = await run(f.lipa, '2026-11-16', '2026-11-30', 'posted', [{ who: ana, sss: ['0.10', '0.20', '0.00'] }]);
  const L4 = await run(f.lipa, '2027-01-01', '2027-01-15', 'posted', [{ who: ana, sss: ['50.00', '100.00', '10.00'] }]);
  const L6d = await run(f.lipa, '2026-12-01', '2026-12-15', 'draft', [{ who: ana, sss: ['777.00', '0.00', '0.00'] }]);
  const M1 = await run(f.malvar, '2026-09-26', '2026-10-10', 'posted', [{ who: ben, sss: ['525.00', '1035.00', '25.00'], ph: ['260.00', '260.00'], pi: ['100.00', '100.00'] }]);
  const M2 = await run(f.malvar, '2026-10-11', '2026-10-25', 'posted', [{ who: ben, sss: ['525.00', '1045.00', '25.00'], ph: ['260.00', '260.00'], pi: ['100.00', '100.00'] }]);

  const P1 = await mkPayment(sql, f, { agency: 'sss', month: '2026-10-01', paidOn: '2026-11-10', ref: 'PRN-0001', lines: [{ storeId: f.lipa, amount: '2000.00' }] });
  const P2 = await mkPayment(sql, f, {
    agency: 'sss', month: '2026-10-01', paidOn: '2026-11-12', ref: 'PRN-0002',
    lines: [{ storeId: f.lipa, amount: '500.00' }, { storeId: f.malvar, amount: '1000.10' }],
  });
  const P3v = await mkPayment(sql, f, { agency: 'sss', month: '2026-10-01', paidOn: '2026-11-13', ref: 'PRN-0003', lines: [{ storeId: f.malvar, amount: '3180.00' }], voided: true });
  const P4 = await mkPayment(sql, f, { agency: 'philhealth', month: '2026-10-01', paidOn: '2026-11-14', ref: 'PH-0001', lines: [{ storeId: f.lipa, amount: '1340.00' }] });
  const P5 = await mkPayment(sql, f, { agency: 'philhealth', month: '2026-12-01', paidOn: '2026-12-20', ref: 'PH-0002', lines: [{ storeId: f.malvar, amount: '10.00' }] });
  return { ...f, ana, ben, cora, runs: { L1, L2, L3, L4, L5v, L6d, L7, M1, M2 }, pay: { P1, P2, P3v, P4, P5 } };
}
