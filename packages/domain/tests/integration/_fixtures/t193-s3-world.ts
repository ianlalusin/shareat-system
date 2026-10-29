/**
 * T-193 S3 (TESTER) - the world `recordStatutoryPayment` is judged in. Written RAW as the table owner (no rate tables, no
 * attendance): what is OWED comes from the S2 world's `mkRun` (payslips of posted pay runs + the matching credits to 2210-2240),
 * so every figure is controlled to the centavo. Not a test file.
 *
 * October 2026 owed (period_end in October):
 *   Lipa     SSS 3,180.00 (1,585 + 1,595)   PhilHealth 1,040.00   Pag-IBIG 400.00   BIR 125.50
 *   Malvar   SSS 3,180.00 (run M1 is 26 Sep - 10 Oct, so its month is October)
 *   Rosario  SSS 1,000.00 (one run)
 * Money accounts (foundation ones, so each store's own): Lipa office safe (1130), Lipa e-wallet (1140), and
 * Malvar office safe (1130) are funded 100,000.00 each; the Lipa staff float (1120) and the Rosario office safe are NOT funded. Periods Sep 2026 - Feb 2027 open.
 * Employer numbers on file for SSS / PhilHealth / Pag-IBIG; the organization has a TIN (BIR).
 */
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { mkPerson, mkRun, type Org } from '../../../../db/tests/integration/_fixtures/t193-s2-world';

export type Sql = postgres.Sql;
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
export const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

export interface World {
  orgId: string;
  lipa: string;
  malvar: string;
  rosario: string;
  codes: { lipa: string; malvar: string; rosario: string };
  adminId: string;
  superId: string;
  managerId: string;
  staffId: string;
  admin: Actor;
  superAdmin: Actor;
  manager: Actor;
  staff: Actor;
  /** Lipa office safe, 1130, funded. */
  lipaOffice: string;
  /** Lipa e-wallet, 1140 (party money_account), funded. */
  lipaEwallet: string;
  /** Lipa staff float, 1120 (refused for payroll by name; unfunded: a 1120 line needs a cash-request party). */
  lipaFloat: string;
  /** Malvar office safe, 1130, funded. */
  malvarOffice: string;
  /** Rosario office safe, 1130, NOT funded. */
  rosarioOffice: string;
}

async function person(sql: Sql, orgId: string, stores: string[], name: string, role: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

async function foundation(sql: Sql, storeId: string, instrument: string, custodian: string, gl: string): Promise<string> {
  const [a] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = ${instrument} and custodian = ${custodian}
      and gl_account_code = ${gl} and is_foundation`;
  return a!.id;
}

/** A posted opening entry: Dr `code` (party money_account when 1140) / Cr 3900 at the same store. */
async function fund(sql: Sql, orgId: string, storeId: string, code: string, amount: string, accountId: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = '2026-09-01'`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-09-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    if (code === '1140') {
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
               values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0', 'money_account', ${accountId})`;
    } else {
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
               values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0')`;
    }
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

export async function mkWorld(sql: Sql, hint: string): Promise<World> {
  const code = uid(`t193s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code, tin) values (${`Org ${code}`}, ${code}, '123456789000') returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const codes = { lipa: uid('LP'), malvar: uid('MV'), rosario: uid('RS') };
  const store = async (c: string, name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${c}, ${name}) returning id`)[0]!.id;
  const lipa = await store(codes.lipa, 'Lipa');
  const malvar = await store(codes.malvar, 'Malvar');
  const rosario = await store(codes.rosario, 'Rosario');
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open'
              from generate_series('2026-09-01'::date, '2027-02-01'::date, interval '1 month') m`;
  const all = [lipa, malvar, rosario];
  const adminId = await person(sql, orgId, all, 'Admin', 'admin');
  const superId = await person(sql, orgId, all, 'Super', 'super_admin');
  const managerId = await person(sql, orgId, all, 'Manager', 'manager');
  const staffId = await person(sql, orgId, all, 'Staff', 'staff');

  const lipaOffice = await foundation(sql, lipa, 'cash', 'office', '1130');
  const lipaEwallet = await foundation(sql, lipa, 'ewallet', 'office', '1140');
  const lipaFloat = await foundation(sql, lipa, 'cash', 'staff', '1120');
  const malvarOffice = await foundation(sql, malvar, 'cash', 'office', '1130');
  const rosarioOffice = await foundation(sql, rosario, 'cash', 'office', '1130');
  await fund(sql, orgId, lipa, '1130', '100000.00', lipaOffice);
  await fund(sql, orgId, lipa, '1140', '100000.00', lipaEwallet);
  await fund(sql, orgId, malvar, '1130', '100000.00', malvarOffice);

  await sql`insert into statutory_employers (org_id, agency, employer_no, due_day, created_by) values
    (${orgId}, 'sss', '0300000001', 10, ${adminId}),
    (${orgId}, 'philhealth', '020000000001', 15, ${adminId}),
    (${orgId}, 'pagibig', '121000000001', 10, ${adminId})`;

  // The S2 world's pay-run builder wants this shape; `bankId` is only the pay run's own money account.
  const f: Org = { orgId, lipa, malvar, adminId, bankId: lipaOffice };
  const ana = await mkPerson(sql, f, 'Ana Lipa', lipa);
  const ben = await mkPerson(sql, f, 'Ben Malvar', malvar);
  const rita = await mkPerson(sql, f, 'Rita Rosario', rosario);
  const run = (storeId: string, start: string, end: string, slips: Parameters<typeof mkRun>[2]['slips']) =>
    mkRun(sql, f, { storeId, start, end, status: 'posted', slips });
  await run(lipa, '2026-10-01', '2026-10-15', [{ who: ana, sss: ['525.00', '1035.00', '25.00'], ph: ['260.00', '260.00'], pi: ['100.00', '100.00'] }]);
  await run(lipa, '2026-10-16', '2026-10-31', [{ who: ana, sss: ['525.00', '1045.00', '25.00'], ph: ['260.00', '260.00'], pi: ['100.00', '100.00'], wh: '125.50' }]);
  await run(malvar, '2026-09-26', '2026-10-10', [{ who: ben, sss: ['525.00', '1035.00', '25.00'] }]);
  await run(malvar, '2026-10-11', '2026-10-25', [{ who: ben, sss: ['525.00', '1045.00', '25.00'] }]);
  await run(rosario, '2026-10-01', '2026-10-31', [{ who: rita, sss: ['300.00', '650.00', '50.00'] }]);

  return {
    orgId, lipa, malvar, rosario, codes, adminId, superId, managerId, staffId,
    admin: actor(orgId, adminId), superAdmin: actor(orgId, superId), manager: actor(orgId, managerId), staff: actor(orgId, staffId),
    lipaOffice, lipaEwallet, lipaFloat, malvarOffice, rosarioOffice,
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Readers (raw, as the owner: independent of the code under test)
// -----------------------------------------------------------------------------------------------------------------
export const leg = (code: string, store: string, debit: string, credit: string, party = '-'): string =>
  `${code}|${store}|${debit}|${credit}|${party}`;
/** Expected-side helpers: D('2210','Lipa','3180.00') / C('1130','Lipa','3180.00', party). */
export const D = (code: string, store: string, amount: string, party = '-') => leg(code, store, amount, '0.00', party);
export const C = (code: string, store: string, amount: string, party = '-') => leg(code, store, '0.00', amount, party);

/** An entry's lines as sorted, comparable strings: `code|store|debit|credit|party`. `store` is the store NAME, `party` is `type:id` or `-`. */
export async function legsOf(sql: Sql, entryId: string): Promise<string[]> {
  const rows = await sql<{ code: string; store: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
    select a.code, coalesce(s.name, '-') as store, jl.debit::text, jl.credit::text, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id left join stores s on s.id = jl.store_id
    where jl.entry_id = ${entryId}`;
  return rows.map((r) => leg(r.code, r.store, r.debit, r.credit, r.party_type ? `${r.party_type}:${r.party_id}` : '-')).sort();
}

export async function count(sql: Sql, w: World, table: 'statutory_payments' | 'statutory_payment_lines' | 'period_overrides'): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from ${sql(table)} where org_id = ${w.orgId}`;
  return Number(r!.n);
}
export async function entryCount(sql: Sql, w: World): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${w.orgId} and source_type = 'statutory_payment'`;
  return Number(r!.n);
}
/** Net debit - credit of an account at a store, over non-draft entries. */
export async function balance(sql: Sql, w: World, code: string, storeId: string): Promise<string> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${w.orgId} and je.status <> 'draft' and a.code = ${code} and jl.store_id = ${storeId}`;
  return r!.b;
}
/** Σ of the debit side of 6100-6130 on one entry (the section 16.7 double count). */
export async function payrollCostDebits(sql: Sql, entryId: string): Promise<string> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.debit), 0)::numeric(14,2)::text as b from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} and a.code in ('6100', '6110', '6120', '6130')`;
  return r!.b;
}
/** Σ of posted payment lines for an agency at a store (what the repo calls paid), as numeric text. */
export async function paidLines(sql: Sql, w: World, agency: string, storeId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(l.amount), 0)::numeric(14,2)::text as t
    from statutory_payment_lines l join statutory_payments p on p.id = l.payment_id
    where p.org_id = ${w.orgId} and p.agency = ${agency} and p.status = 'posted' and l.store_id = ${storeId}`;
  return r!.t;
}

// -----------------------------------------------------------------------------------------------------------------
// Calling and judging
// -----------------------------------------------------------------------------------------------------------------
export interface PayInput {
  paymentId: string;
  agency: 'sss' | 'philhealth' | 'pagibig' | 'bir';
  month: string;
  paidOn: string;
  moneyAccountId: string;
  referenceNo: string;
  lines: { storeId: string; amount: string }[];
  penalty?: string;
  notes?: string | null;
  periodOverride?: { actor: Actor; reason: 'data_entry_error'; note?: string | null };
}

/** The fixed shape of a successful call (the tester fixes these names; the builder implements them). */
export interface PayResult {
  id: string;
  entryId: string;
  created: boolean;
}

/** A refusal carries the person-facing sentence on `userMessage` (message stays the raw diagnostic). */
export async function refusal(p: Promise<unknown>, what: string): Promise<{ name: string; message: string; userMessage: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { name?: string; message?: string; userMessage?: string };
    // A TypeError is a programming fault (or the function not existing yet), never a refusal: it must not pass for one.
    if (e.name === 'TypeError') throw err;
    return { name: String(e.name), message: String(e.message ?? err), userMessage: String(e.userMessage ?? '') };
  }
  throw new Error(`NOT REFUSED - ${what} went through (the defect this leg targets)`);
}
