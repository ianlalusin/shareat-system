import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-431 - "Everything unpaid". docs/tasks/431-unpaid-liabilities-view.md, cases 1-21 (case 22 = the page test).
 * TESTER file. Read-only view: nothing it reads may be written by it.
 *
 * ⭐ PINNED CONTRACT (the spec fixes the numbers, not the object; the BUILDER must return exactly this shape):
 *
 *   getUnpaidLiabilities(tx, actor, { storeId?: string }): Promise<UnpaidLiabilities>   // exported from '@shareat/domain'
 *   UnpaidLiabilities = {
 *     kinds: UnpaidKind[]   // ALWAYS six, in this order, ids:
 *                           // 'supplier_invoices' | 'recurring_drafts' | 'register' | 'loans' | 'wages' | 'other_ledger'
 *     banners: { accountCode: string; storeId: string; amount: string }[]   // one per NON-ZERO "Unmatched in the books" leftover
 *     totals: { booked: string; notYetBooked: string; grand: string; excludesWages: boolean }
 *       // booked = kinds 1,3,4,6 (all-stores total leaves out the internal 2150 lines) · notYetBooked = kinds 2,5
 *       // grand = booked + notYetBooked · excludesWages = true when the viewer lacks run_payroll
 *   }
 *   UnpaidKind = {
 *     id: string; title: string
 *     visible: boolean              // false only for 'wages' when the viewer lacks run_payroll at the store
 *     unavailableReason?: string    // 'wages' when previewPayRun cannot compute (no attendance config)
 *     needsReviewDays?: number      // 'wages': days needing review, counted and not included
 *     lines: UnpaidLine[]
 *     unmatched: { accountCode: string; storeId: string; amount: string }[]   // leftover = ledger balance - the kind's lines
 *     withheld?: { accountCode: string; storeId: string }[]   // 'other_ledger': 2300 non-zero but viewer lacks run_payroll; NO amount
 *     subtotal: string | null       // null when not visible
 *   }
 *   UnpaidLine = { storeId: string; name: string; counterparty: string | null; dueOn: string | null; amount: string;
 *                  href: string; accountCode?: string; tag?: string; internal?: boolean }
 *   ('counterparty' for a 2150 line is the OTHER store's name; 'tag' on a recurring-born invoice is
 *    'from recurring: <template name>'.)
 *
 * Leftover sign: the sign of (liability-side ledger balance - the kind's lines); only |amount| is asserted for the cross-store loan case.
 * Spec note for the orchestrator: case 12 says the 2400 leftover shows "at both stores"; with both sides filtered on
 * jl.store_id (the spec's own rule) the dock lands at store B, so only B has a leftover. This file asserts B only.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { apRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  chargeLiability,
  createLiability,
  createLoan,
  createRecurringTemplate,
  createSupplier,
  disburseLoan,
  getUnpaidLiabilities,
  payLiability,
  postPayRun,
  previewPayRun,
  recordExpenseForInvoice,
  recordInvoice,
  recordLoanPayment,
  recordPayment,
  reverseLoanEntry,
  runRecurringExpenses,
  setPayRate,
  verifyInvoice,
  voidExpense,
  voidInvoice,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { seedStatutoryRates } from './_fixtures/statutory-rates';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const NOW = Date.parse('2026-09-20T02:00:00Z');

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

interface Line {
  storeId: string; name: string; counterparty: string | null; dueOn: string | null; amount: string; href: string;
  accountCode?: string; tag?: string; internal?: boolean;
}
interface Kind {
  id: string; title: string; visible: boolean; unavailableReason?: string; needsReviewDays?: number;
  lines: Line[]; unmatched: { accountCode: string; storeId: string; amount: string }[];
  withheld?: { accountCode: string; storeId: string }[]; subtotal: string | null;
}
interface Result {
  kinds: Kind[]; banners: { accountCode: string; storeId: string; amount: string }[];
  totals: { booked: string; notYetBooked: string; grand: string; excludesWages: boolean };
}

const KIND_ORDER = ['supplier_invoices', 'recurring_drafts', 'register', 'loans', 'wages', 'other_ledger'];

async function fixture(hint: string, opts: { noAttendanceConfig?: boolean } = {}) {
  const code = uid(`t431-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const stores: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
  const names = { A: 'Lipa', B: 'Malvar', C: 'Tanauan' } as const;
  for (const k of ['A', 'B', 'C'] as const) {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(k)}, ${names[k]}, '2020-01-01') returning id`;
    stores[k] = s!.id;
  }
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
  }
  const mk = async (name: string, role: string, scope: string[]) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const all = [stores.A, stores.B, stores.C];
  const adminId = await mk('Admin', 'admin', all);
  const managerId = await mk('Manager', 'manager', all);
  const managerAId = await mk('Manager A', 'manager', [stores.A]);
  const staffId = await mk('Staff', 'staff', all);
  const workerId = await mk('Worker', 'staff', [stores.A]);

  for (const s of all) {
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${s}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId, storeId: s, employmentId: emp!.id, personId: staffId, setBy: managerId });
  }
  const [workerEmp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${stores.A}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${adminId}) returning id`;
  let configId: string | null = null;
  if (!opts.noAttendanceConfig) {
    for (const s of all) {
      const [c] = await sql<{ id: string }[]>`
        insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift,
                                             overtime_multiplier, night_diff_multiplier, overtime_mode, overtime_fixed_hourly)
        values (${orgId}, ${s}, '2026-01-01', '9', '1.25', '1.10', 'multiplier', null) returning id`;
      if (s === stores.A) configId = c!.id;
    }
  }
  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const [rentCat] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
  const supplier = await asOrg(orgId, (tx) =>
    createSupplier(tx, actor(orgId, managerId), { name: `${hint} Supplier`, creditTermsDays: 30 }),
  );
  const drawers: Record<string, string> = {};
  const offices: Record<string, string> = {};
  for (const [k, s] of Object.entries(stores)) {
    const [d] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${s} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
    const [o] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${s} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    drawers[k] = d!.id;
    offices[k] = o!.id;
  }
  await seedStatutoryRates(orgId, actor(orgId, adminId), all);
  const f = {
    orgId, stores, names, adminId, managerId, managerAId, staffId, workerId, workerEmpId: workerEmp!.id, configId,
    admin: actor(orgId, adminId), manager: actor(orgId, managerId), managerA: actor(orgId, managerAId), staff: actor(orgId, staffId),
    categoryId: category!.id, rentCategoryId: rentCat!.id, supplierId: supplier.id, drawers, offices,
  };
  for (const s of all) await fund(f, s, '500000.00');
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Hand journal, posted. Lines balance in total. */
async function post(
  orgId: string,
  date: string,
  sourceType: string,
  lines: { code: string; storeId: string; debit?: string; credit?: string; partyType?: string; partyId?: string }[],
) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${orgId} and starts_on <= ${date} and ends_on >= ${date}`;
  const codes = [...new Set(lines.map((l) => l.code))];
  const accts = await sql<{ id: string; code: string }[]>`
    select id, code from accounts where org_id = ${orgId} and code in ${sql(codes)}`;
  const by = new Map(accts.map((a) => [a.code, a.id]));
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, ${date}, ${period!.id}, ${sourceType}, ${crypto.randomUUID()}, 'draft') returning id`;
    let n = 0;
    for (const l of lines) {
      n += 1;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
               values (${e!.id}, ${n}, ${by.get(l.code)!}, ${l.storeId}, ${l.debit ?? '0'}, ${l.credit ?? '0'},
                       ${l.partyType ?? null}, ${l.partyId ?? null})`;
    }
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    return e!.id;
  });
}

async function fund(f: { orgId: string }, storeId: string, amount: string) {
  await post(f.orgId, '2026-01-01', 'opening_balance', [
    { code: '1130', storeId, debit: amount },
    { code: '3900', storeId, credit: amount },
  ]);
}

async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy}) returning id`;
  return row!.id;
}

/** A posted credit invoice at a store. Returns ids. */
async function creditInvoice(f: Fixture, storeId: string, amount: string, over: { dueDate?: string } = {}) {
  const fileId = await receiptFile(f.orgId, storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId, supplierId: f.supplierId, invoiceDate: '2026-01-05', dueDate: over.dueDate ?? '2026-02-05',
      totalAmount: amount, receiptFileId: fileId,
    }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId, supplierId: f.supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId,
      particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return { invoiceId: created.id, expenseId: exp.expenseId };
}

async function liabilityAt(f: Fixture, storeId: string, name: string, charge: string, paid?: string) {
  const l = await asOrg(f.orgId, (tx) =>
    createLiability(tx, f.manager, { storeId, name, category: 'accrued_expenses' }),
  );
  await asOrg(f.orgId, (tx) =>
    chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: l.id, amount: charge, againstAccountCode: '6200', on: '2026-01-31' }),
  );
  if (paid) {
    const k = (Object.keys(f.stores) as ('A' | 'B' | 'C')[]).find((x) => f.stores[x] === storeId)!;
    await asOrg(f.orgId, (tx) =>
      payLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: l.id, amount: paid, fromMoneyAccountId: f.offices[k]!, on: '2026-02-05' }),
    );
  }
  return l.id;
}

async function loanAt(f: Fixture, storeId: string, name: string, principal: string, rate = '18') {
  const k = (Object.keys(f.stores) as ('A' | 'B' | 'C')[]).find((x) => f.stores[x] === storeId)!;
  const loan = await asOrg(f.orgId, (tx) =>
    createLoan(tx, f.admin, {
      storeId, lenderName: 'Grab', name, principalAmount: principal, interestRate: rate, ratePeriod: 'month',
      interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-05-11',
    }),
  );
  await asOrg(f.orgId, (tx) =>
    disburseLoan(tx, f.admin, { requestId: crypto.randomUUID(), loanId: loan.id, amount: principal, intoMoneyAccountId: f.offices[k]!, on: '2026-05-11' }),
  );
  return { loanId: loan.id, office: f.offices[k]! };
}

const view = (f: Fixture, who: Actor, storeId?: string): Promise<Result> =>
  asOrg(f.orgId, (tx) =>
    getUnpaidLiabilities(tx, who, storeId ? { storeId } : {}),
  ) as unknown as Promise<Result>;
const kindOf = (r: Result, id: string): Kind => {
  const k = r.kinds.find((x) => x.id === id);
  if (!k) throw new Error(`no kind ${id} in result (got ${r.kinds.map((x) => x.id).join(',')})`);
  return k;
};
const everyLine = (r: Result): Line[] => r.kinds.flatMap((k) => k.lines);

async function ledger(orgId: string, code: string, storeId?: string): Promise<string> {
  const [row] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::numeric(14,2)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = ${code}
      and (${storeId ?? null}::uuid is null or jl.store_id = ${storeId ?? null})`;
  return row!.b;
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ===================================================================================================
describe('T-431 shape: six kinds, always, in spec order', () => {
  it('returns the six kinds in order even when nothing is owed', async () => {
    const f = await fixture('shape');
    const r = await view(f, f.admin);
    expect(r.kinds.map((k) => k.id)).toEqual(KIND_ORDER);
    for (const k of r.kinds.filter((x) => x.id !== 'wages')) expect(k.lines).toEqual([]);
    expect(r.banners).toEqual([]);
    expect(r.totals.grand).toBe('0.00');
  });
});

describe('kind 1 - supplier invoices unpaid', () => {
  it('1 - 8,000 credit invoice with 3,000 paid shows 5,000 and links to its invoice', async () => {
    const f = await fixture('c1');
    const { invoiceId, expenseId } = await creditInvoice(f, f.stores.A, '8000.00');
    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.stores.A, supplierId: f.supplierId, businessDate: '2026-02-01', amount: '3000.00',
        moneyAccountId: f.drawers.A!, allocations: [{ expenseId, amountApplied: '3000.00' }],
      }),
    );
    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'supplier_invoices');
    expect(k.lines).toHaveLength(1);
    expect(k.lines[0]!.amount).toBe('5000.00');
    expect(k.lines[0]!.href).toBe(`/ap/invoices/${invoiceId}`);
    expect(k.lines[0]!.storeId).toBe(f.stores.A);
    expect(k.subtotal).toBe('5000.00');
  });

  it('2 - a fully paid invoice is absent', async () => {
    const f = await fixture('c2');
    const { expenseId } = await creditInvoice(f, f.stores.A, '1000.00');
    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.stores.A, supplierId: f.supplierId, businessDate: '2026-02-01', amount: '1000.00',
        moneyAccountId: f.drawers.A!, allocations: [{ expenseId, amountApplied: '1000.00' }],
      }),
    );
    const r = await view(f, f.admin, f.stores.A);
    expect(kindOf(r, 'supplier_invoices').lines).toEqual([]);
    expect(kindOf(r, 'supplier_invoices').subtotal).toBe('0.00');
  });

  it('3 - store C: an invoice voided with markInvoiceVoided (expense stays posted) is absent, and C\'s 2110 leftover equals it', async () => {
    const f = await fixture('c3');
    const { invoiceId } = await creditInvoice(f, f.stores.C, '1234.00');
    await asOrg(f.orgId, (tx) =>
      apRepo.markInvoiceVoided(tx, f.orgId, invoiceId, { voidedBy: f.adminId, voidReason: 'Entered twice' }),
    );
    expect(await ledger(f.orgId, '2110', f.stores.C)).toBe('1234.00'); // control: the books still carry it
    const r = await view(f, f.admin, f.stores.C);
    const k = kindOf(r, 'supplier_invoices');
    expect(k.lines.find((l) => l.href.includes(invoiceId))).toBeUndefined();
    const left = k.unmatched.find((u) => u.accountCode === '2110' && u.storeId === f.stores.C);
    expect(left?.amount).toBe('1234.00');
    expect(r.banners.find((b) => b.accountCode === '2110' && b.storeId === f.stores.C)?.amount).toBe('1234.00');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('kind 2 - recurring bills drafted, not recorded', () => {
  async function draftBill(f: Fixture, name: string, over: Record<string, unknown> = {}) {
    await asOrg(f.orgId, (tx) =>
      createRecurringTemplate(tx, f.manager, {
        storeId: f.stores.A, name, categoryId: f.rentCategoryId, supplierId: f.supplierId,
        defaultAmount: '25000.00', interval: 'monthly', anchorDay: 5, startsOn: '2026-09-01', ...over,
      }),
    );
  }
  const runJob = (f: Fixture) => runRecurringExpenses({ orgId: f.orgId, nowMs: NOW, trigger: 'cron' });
  async function rowsFor(f: Fixture, name: string) {
    const [r] = await sql<{ expense_id: string; invoice_id: string; status: string }[]>`
      select d.expense_id, d.supplier_invoice_id as invoice_id, e.status
      from recurring_expense_drafts d
      join recurring_expenses t on t.id = d.recurring_expense_id
      left join expenses e on e.id = d.expense_id
      where d.org_id = ${f.orgId} and t.name = ${name}`;
    return r!;
  }
  async function postDraft(f: Fixture, name: string) {
    const row = await rowsFor(f, name);
    const fileId = await receiptFile(f.orgId, f.stores.A, f.managerId);
    await sql`update supplier_invoices set receipt_file_id = ${fileId} where id = ${row.invoice_id}`;
    await asOrg(f.orgId, (tx) =>
      verifyInvoice(tx, f.admin, row.invoice_id, { supplier: true, invoice: true, items: true, price: true }),
    );
    return row;
  }

  it('4 - a recurring draft shows once in kind 2; its invoice is not in kind 1', async () => {
    const f = await fixture('c4');
    await draftBill(f, 'Lipa branch rent');
    await runJob(f);
    const row = await rowsFor(f, 'Lipa branch rent');
    expect(row.status).toBe('draft');
    const r = await view(f, f.admin, f.stores.A);
    const k2 = kindOf(r, 'recurring_drafts');
    expect(k2.lines).toHaveLength(1);
    expect(k2.lines[0]!.href).toBe(`/expenses/${row.expense_id}`);
    expect(k2.lines[0]!.amount).toBe('25000.00');
    expect(k2.lines[0]!.name).toContain('Lipa branch rent');
    expect(kindOf(r, 'supplier_invoices').lines.find((l) => l.href.includes(row.invoice_id))).toBeUndefined();
    expect(kindOf(r, 'supplier_invoices').lines).toEqual([]);
  });

  it('5 - posted on credit: leaves kind 2, appears once in kind 1 tagged with the template; grand total unchanged', async () => {
    const f = await fixture('c5');
    await draftBill(f, 'Lipa branch rent');
    await runJob(f);
    const before = await view(f, f.admin);
    expect(before.totals.notYetBooked).toBe('25000.00');
    expect(before.totals.booked).toBe('0.00');
    expect(before.totals.grand).toBe('25000.00');

    const row = await postDraft(f, 'Lipa branch rent');
    const after = await view(f, f.admin);
    expect(kindOf(after, 'recurring_drafts').lines).toEqual([]);
    const k1 = kindOf(after, 'supplier_invoices');
    expect(k1.lines).toHaveLength(1);
    expect(k1.lines[0]!.href).toBe(`/ap/invoices/${row.invoice_id}`);
    expect(k1.lines[0]!.amount).toBe('25000.00');
    expect(k1.lines[0]!.tag).toBe('from recurring: Lipa branch rent');
    expect(after.totals.booked).toBe('25000.00');
    expect(after.totals.notYetBooked).toBe('0.00');
    expect(after.totals.grand).toBe('25000.00');
    expect(after.banners).toEqual([]);
  });

  it('6 - posted then voided, posted with cash, and a deleted draft are all absent', async () => {
    const f = await fixture('c6');
    await draftBill(f, 'Rent voided');
    await draftBill(f, 'Rent cash', { defaultMoneyAccountId: f.offices.A });
    await draftBill(f, 'Rent deleted');
    await runJob(f);

    const voided = await postDraft(f, 'Rent voided');
    await asOrg(f.orgId, (tx) => voidExpense(tx, f.admin, voided.expense_id, 'Posted in error'));
    // The job drafts the cash payment without naming the account (not this task's concern): name it, as the human approving would.
    const cashDraft = await rowsFor(f, 'Rent cash');
    await sql`update expense_payments set money_account_id = ${f.offices.A!}, account_code = 'office'
              where expense_id = ${cashDraft.expense_id}`;
    const cash = await postDraft(f, 'Rent cash');
    expect((await rowsFor(f, 'Rent cash')).status).toBe('posted'); // control: cash path posted
    const del = await rowsFor(f, 'Rent deleted');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.admin, { invoiceId: del.invoice_id, reason: 'Not needed' }));
    const delAfter = await rowsFor(f, 'Rent deleted');
    expect(delAfter.expense_id, 'control: the draft row is left dangling').toBeNull();

    const r = await view(f, f.admin, f.stores.A);
    expect(kindOf(r, 'recurring_drafts').lines).toEqual([]);
    const all = JSON.stringify(everyLine(r));
    for (const id of [voided.expense_id, cash.expense_id, voided.invoice_id, cash.invoice_id, del.invoice_id]) {
      if (id) expect(all).not.toContain(id);
    }
    expect(kindOf(r, 'supplier_invoices').lines).toEqual([]);
    expect(r.banners.filter((b) => b.accountCode === '2110')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('kinds 3 and 4 - register and loans', () => {
  it('7 - register: charged 45,000, paid 20,000 shows 25,000; a settled one is absent', async () => {
    const f = await fixture('c7');
    const id = await liabilityAt(f, f.stores.A, 'Accrued rent', '45000.00', '20000.00');
    const settledId = await liabilityAt(f, f.stores.A, 'Permit fee', '3000.00', '3000.00');
    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'register');
    expect(k.lines).toHaveLength(1);
    expect(k.lines[0]!.amount).toBe('25000.00');
    expect(k.lines[0]!.href).toBe(`/liabilities/${id}`);
    expect(k.lines[0]!.name).toContain('Accrued rent');
    expect(JSON.stringify(k.lines)).not.toContain(settledId);
  });

  it('8 - loan disbursed 50,000, 5,000 principal + 300 interest paid shows 45,000; a paid-off loan is absent', async () => {
    const f = await fixture('c8');
    const { loanId, office } = await loanAt(f, f.stores.A, 'Grab loan', '50000.00');
    const pay = await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, { loanId, amount: '5300.00', fromMoneyAccountId: office, on: '2026-05-12' }),
    );
    expect(pay.split.principal).toBe('5000.00'); // control: fixture split is as the spec says
    expect(pay.split.interest).toBe('300.00');
    const paid = await loanAt(f, f.stores.A, 'Small loan', '10000.00', '0');
    await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, { loanId: paid.loanId, amount: '10000.00', fromMoneyAccountId: paid.office, on: '2026-05-12' }),
    );
    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'loans');
    expect(k.lines).toHaveLength(1);
    expect(k.lines[0]!.amount).toBe('45000.00');
    expect(k.lines[0]!.href).toBe(`/loans/${loanId}`);
    expect(JSON.stringify(k.lines)).not.toContain(paid.loanId);
  });

  it('9 - a loan payment then its reversal: still 50,000 owed', async () => {
    const f = await fixture('c9');
    const { loanId, office } = await loanAt(f, f.stores.A, 'Grab loan', '50000.00');
    const pay = await asOrg(f.orgId, (tx) =>
      recordLoanPayment(tx, f.admin, { loanId, amount: '5300.00', fromMoneyAccountId: office, on: '2026-05-12' }),
    );
    await asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.admin, { loanId, entryId: pay.entryId, reason: 'Wrong day' }));
    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'loans');
    expect(k.lines).toHaveLength(1);
    expect(k.lines[0]!.amount).toBe('50000.00');
    expect(r.banners.filter((b) => b.accountCode === '2400')).toEqual([]);
  });

  it('11 - kinds 3 and 4 at store A leave out a liability and a loan recorded at store B', async () => {
    const f = await fixture('c11');
    const aLiab = await liabilityAt(f, f.stores.A, 'A rent', '1000.00');
    const bLiab = await liabilityAt(f, f.stores.B, 'B rent', '2000.00');
    const aLoan = await loanAt(f, f.stores.A, 'A loan', '5000.00');
    const bLoan = await loanAt(f, f.stores.B, 'B loan', '7000.00');
    const r = await view(f, f.admin, f.stores.A);
    const reg = kindOf(r, 'register').lines;
    const loans = kindOf(r, 'loans').lines;
    expect(reg.map((l) => l.href)).toEqual([`/liabilities/${aLiab}`]);
    expect(loans.map((l) => l.href)).toEqual([`/loans/${aLoan.loanId}`]);
    expect(JSON.stringify(r)).not.toContain(bLiab);
    expect(JSON.stringify(r)).not.toContain(bLoan.loanId);
    expect(reg.every((l) => l.storeId === f.stores.A)).toBe(true);
    expect(loans.every((l) => l.storeId === f.stores.A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('reconciliation', () => {
  it('10 - stores A and B are clean (leftovers exactly zero, no banner); store C (case 3) shows the banner', async () => {
    const f = await fixture('c10');
    for (const s of [f.stores.A, f.stores.B]) {
      await creditInvoice(f, s, '1000.00');
      await liabilityAt(f, s, `Rent ${s.slice(0, 4)}`, '500.00');
      await loanAt(f, s, `Loan ${s.slice(0, 4)}`, '2000.00');
    }
    const { invoiceId } = await creditInvoice(f, f.stores.C, '777.00');
    await asOrg(f.orgId, (tx) =>
      apRepo.markInvoiceVoided(tx, f.orgId, invoiceId, { voidedBy: f.adminId, voidReason: 'Entered twice' }),
    );
    const r = await view(f, f.admin);
    // control: every kind actually has lines for A and B, so a "clean" result is not an empty one
    expect(kindOf(r, 'supplier_invoices').lines.filter((l) => l.storeId === f.stores.A)).toHaveLength(1);
    expect(kindOf(r, 'register').lines.filter((l) => l.storeId === f.stores.B)).toHaveLength(1);
    expect(kindOf(r, 'loans').lines.filter((l) => l.storeId === f.stores.B)).toHaveLength(1);

    const clean = [f.stores.A, f.stores.B];
    for (const k of r.kinds) {
      for (const u of k.unmatched.filter((x) => clean.includes(x.storeId))) expect(u.amount, `${k.id} @ ${u.storeId}`).toBe('0.00');
    }
    expect(r.banners.filter((b) => clean.includes(b.storeId))).toEqual([]);
    expect(r.banners.find((b) => b.storeId === f.stores.C && b.accountCode === '2110')?.amount).toBe('777.00');
    // kinds are not summed org-wide before comparing: C's leftover must not leak into A or B
    expect(r.banners).toHaveLength(1);
  });

  it('12 - DEF-145: a loan docked from store B\'s payout leaves a non-zero 2400 leftover and a banner at B', async () => {
    const f = await fixture('c12');
    const { loanId } = await loanAt(f, f.stores.A, 'Platform loan', '50000.00');
    await post(f.orgId, '2026-05-20', 'channel_settlement', [
      { code: '2400', storeId: f.stores.B, debit: '2000.00', partyType: 'loan', partyId: loanId },
      { code: '1130', storeId: f.stores.B, credit: '2000.00' },
    ]);
    const r = await view(f, f.admin, f.stores.B);
    const left = kindOf(r, 'loans').unmatched.find((u) => u.accountCode === '2400' && u.storeId === f.stores.B);
    expect(left, 'a leftover line at B').toBeDefined();
    expect(Math.abs(Number(left!.amount))).toBe(2000);
    const banner = r.banners.find((b) => b.accountCode === '2400' && b.storeId === f.stores.B);
    expect(banner, 'a banner naming 2400 and the amount').toBeDefined();
    expect(Math.abs(Number(banner!.amount))).toBe(2000);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('kind 6 - other amounts owed in the books', () => {
  const other = (r: Result) => kindOf(r, 'other_ledger');

  it('13 - 2150: Lipa owes Malvar 650 -> shown at Lipa, badged internal, nothing at Malvar, out of the grand total', async () => {
    const f = await fixture('c13');
    await post(f.orgId, '2026-02-10', 'expense', [
      { code: '6600', storeId: f.stores.A, debit: '650.00' },
      { code: '2150', storeId: f.stores.A, credit: '650.00', partyType: 'store', partyId: f.stores.B },
      { code: '1250', storeId: f.stores.B, debit: '650.00', partyType: 'store', partyId: f.stores.A },
      { code: '1130', storeId: f.stores.B, credit: '650.00' },
    ]);
    await post(f.orgId, '2026-02-11', 'expense', [
      { code: '6600', storeId: f.stores.A, debit: '1200.00' },
      { code: '2130', storeId: f.stores.A, credit: '1200.00', partyType: 'employee', partyId: f.workerId },
    ]);
    const r = await view(f, f.admin);
    const due = other(r).lines.filter((l) => l.accountCode === '2150');
    expect(due).toHaveLength(1);
    expect(due[0]!.storeId).toBe(f.stores.A);
    expect(due[0]!.amount).toBe('650.00');
    expect(due[0]!.internal).toBe(true);
    expect(due[0]!.counterparty).toContain('Malvar');
    expect(other(r).lines.filter((l) => l.storeId === f.stores.B && l.accountCode === '2150')).toEqual([]);
    expect(r.totals.booked).toBe('1200.00');
    expect(r.totals.grand).toBe('1200.00');
    expect(other(r).subtotal, 'kind 6 subtotal leaves out the internal 2150 line').toBe('1200.00');
    expect(other(r).lines.filter((l) => l.accountCode === '2130')[0]!.internal).not.toBe(true);
    // Ruling (16 Oct): in a SINGLE-store view 2150 counts in that store's kind-6 subtotal and totals; only the all-stores grand total leaves it out.
    const atLipa = await view(f, f.admin, f.stores.A);
    expect(other(atLipa).subtotal).toBe('1850.00');
    expect(atLipa.totals.booked).toBe('1850.00');
    expect(atLipa.totals.grand).toBe('1850.00');
    const atMalvar = await view(f, f.admin, f.stores.B);
    expect(other(atMalvar).lines.filter((l) => l.accountCode === '2150')).toEqual([]);
  });

  it('14 - 2130: 1,200 owed to staff is a kind-6 line carrying account 2130', async () => {
    const f = await fixture('c14');
    await post(f.orgId, '2026-02-11', 'expense', [
      { code: '6600', storeId: f.stores.A, debit: '1200.00' },
      { code: '2130', storeId: f.stores.A, credit: '1200.00', partyType: 'employee', partyId: f.workerId },
    ]);
    const r = await view(f, f.admin, f.stores.A);
    const line = other(r).lines.find((l) => l.accountCode === '2130');
    expect(line?.amount).toBe('1200.00');
    expect(line?.storeId).toBe(f.stores.A);
    expect(line?.href).toBe(`/reports/trial-balance?store=${f.stores.A}`);
  });

  it('15 - 2250 is absent (zero today); a 2900 suspense balance never appears', async () => {
    const f = await fixture('c15');
    // 2900 is seeded RESERVED (DEF-161) and cannot be posted to; activate it so a balance can exist to be left out.
    await sql`update accounts set status = 'active' where org_id = ${f.orgId} and code = '2900'`;
    await post(f.orgId, '2026-02-12', 'manual', [
      { code: '6600', storeId: f.stores.A, debit: '777.00' },
      { code: '2900', storeId: f.stores.A, credit: '777.00' },
    ]);
    expect(await ledger(f.orgId, '2900', f.stores.A)).toBe('777.00'); // control
    const r = await view(f, f.admin);
    expect(other(r).lines.filter((l) => l.accountCode === '2250' || l.accountCode === '2900')).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('777.00');
    expect(r.totals.grand).toBe('0.00');
  });

  it('16 - a 2210 opening balance appears in kind 6 equal to its ledger balance', async () => {
    const f = await fixture('c16');
    await post(f.orgId, '2026-01-02', 'opening_balance', [
      { code: '3900', storeId: f.stores.A, debit: '3000.00' },
      { code: '2210', storeId: f.stores.A, credit: '3000.00' },
    ]);
    const r = await view(f, f.admin, f.stores.A);
    const line = other(r).lines.find((l) => l.accountCode === '2210');
    expect(line?.amount).toBe(await ledger(f.orgId, '2210', f.stores.A));
    expect(line?.amount).toBe('3000.00');
  });

  it('23 - 2300 (ruling): shown to a payroll holder when non-zero; a manager without run_payroll sees no amount, only that it is withheld', async () => {
    const f = await fixture('c23');
    await post(f.orgId, '2026-02-12', 'manual', [
      { code: '6100', storeId: f.stores.A, debit: '18500.00' },
      { code: '2300', storeId: f.stores.A, credit: '18500.00' },
    ]);
    const admin = await view(f, f.admin, f.stores.A);
    expect(other(admin).lines.find((l) => l.accountCode === '2300')?.amount).toBe('18500.00');

    const mgr = await view(f, f.manager, f.stores.A);
    expect(other(mgr).lines.filter((l) => l.accountCode === '2300')).toEqual([]);
    expect(JSON.stringify(mgr)).not.toContain('18500');
    expect(other(mgr).withheld?.some((w) => w.accountCode === '2300' && w.storeId === f.stores.A)).toBe(true);
    expect(mgr.totals.excludesWages).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('kind 5 - wages worked, not yet paid', () => {
  const period = { periodStart: '2026-01-01', periodEnd: '2026-01-15' };
  async function addDay(f: Fixture, shiftDay: string, status = 'verified') {
    await sql`
      insert into attendance_days
        (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
         status, computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
      values (${f.orgId}, ${f.stores.A}, ${f.workerId}, ${f.workerEmpId}, ${shiftDay}, ${f.configId!},
              'exact', ${status}, 540, false, 0, 0, 0, false, null)`;
  }
  async function wagesFixture(hint: string) {
    const f = await fixture(hint);
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.workerEmpId, storeId: f.stores.A, basis: 'daily', amount: '500.00', effectiveFrom: '2026-01-01' }));
    await addDay(f, '2026-01-05');
    await addDay(f, '2026-01-06');
    // An advance on 1230 so net differs from gross.
    await post(f.orgId, '2026-01-02', 'cashrequest', [
      { code: '1230', storeId: f.stores.A, debit: '200.00', partyType: 'employee', partyId: f.workerId },
      { code: '1130', storeId: f.stores.A, credit: '200.00' },
    ]);
    return f;
  }
  const preview = (f: Fixture) =>
    asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.stores.A, periodStart: '2026-01-01', periodEnd: '2026-12-31' }));

  it('17 - payroll holder: kind 5 = previewPayRun totalNet per person (not gross); after postPayRun it is gone', async () => {
    const f = await wagesFixture('c17');
    await addDay(f, '2026-01-07', 'needs_review');
    const p = await preview(f);
    expect(p.totalNet, 'control: net differs from gross').not.toBe(p.totalGross);

    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'wages');
    expect(k.visible).toBe(true);
    expect(k.lines).toHaveLength(1);
    expect(k.lines[0]!.name).toBe('Worker');
    expect(k.lines[0]!.amount).toBe(p.totalNet);
    expect(k.lines[0]!.href).toMatch(/^\/payroll\?(.*&)?store=/);
    expect(k.subtotal).toBe(p.totalNet);
    expect(k.needsReviewDays).toBe(1);
    expect(r.totals.notYetBooked).toBe(p.totalNet);
    expect(r.totals.excludesWages).toBe(false);

    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.stores.A, ...period, moneyAccountId: f.offices.A! }));
    const after = await view(f, f.admin, f.stores.A);
    expect(kindOf(after, 'wages').lines).toEqual([]);
    expect(kindOf(after, 'wages').subtotal).toBe('0.00');
  });

  it('18 - manager without run_payroll: kind 5 hidden; no amount or person name anywhere; grand total excludes it', async () => {
    const f = await wagesFixture('c18');
    await creditInvoice(f, f.stores.A, '900.00');
    const p = await preview(f);
    const r = await view(f, f.manager, f.stores.A);
    const k = kindOf(r, 'wages');
    expect(k.visible).toBe(false);
    expect(k.lines).toEqual([]);
    expect(k.subtotal).toBeNull();
    const json = JSON.stringify(r);
    expect(json).not.toContain('Worker');
    expect(json).not.toContain(p.totalNet);
    expect(json).not.toContain(p.totalGross);
    expect(r.totals.excludesWages).toBe(true);
    expect(r.totals.notYetBooked).toBe('0.00');
    expect(r.totals.grand).toBe('900.00');
  });

  it('21 - no attendance config: kind 5 gives the reason, the other kinds still render', async () => {
    const f = await fixture('c21', { noAttendanceConfig: true });
    await creditInvoice(f, f.stores.A, '900.00');
    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'wages');
    expect(k.unavailableReason ?? '').toMatch(/attendance/i);
    expect(k.lines).toEqual([]);
    expect(kindOf(r, 'supplier_invoices').lines).toHaveLength(1);
    expect(r.totals.booked).toBe('900.00');
  });

  it('20 - running the view twice writes nothing (journal, expenses, drafts, frozen days, audit log)', async () => {
    const f = await wagesFixture('c20');
    await asOrg(f.orgId, (tx) =>
      createRecurringTemplate(tx, f.manager, {
        storeId: f.stores.A, name: 'Rent', categoryId: f.rentCategoryId, supplierId: f.supplierId,
        defaultAmount: '1000.00', interval: 'monthly', anchorDay: 5, startsOn: '2026-09-01',
      }));
    await creditInvoice(f, f.stores.A, '900.00');
    const counts = async () => {
      const [row] = await sql<Record<string, number>[]>`
        select (select count(*) from journal_entries where org_id = ${f.orgId})::int as je,
               (select count(*) from expenses where org_id = ${f.orgId})::int as ex,
               (select count(*) from recurring_expense_drafts where org_id = ${f.orgId})::int as dr,
               (select count(*) from attendance_days where org_id = ${f.orgId} and frozen_at is not null)::int as frozen,
               (select count(*) from audit_log where org_id = ${f.orgId})::int as au`;
      return row!;
    };
    const before = await counts();
    const first = await view(f, f.admin);
    const second = await view(f, f.admin);
    expect(await counts()).toEqual(before);
    expect(second).toEqual(first);
    expect(kindOf(first, 'wages').lines).toHaveLength(1); // control: payroll really ran its preview
  });
});

// ---------------------------------------------------------------------------------------------------
describe('who sees what', () => {
  it('19 - a person holding only store A asking for store B gets nothing from B; staff are refused', async () => {
    const f = await fixture('c19');
    await creditInvoice(f, f.stores.A, '100.00');
    const { invoiceId: bInvoice } = await creditInvoice(f, f.stores.B, '200.00');
    const bLiab = await liabilityAt(f, f.stores.B, 'B only', '300.00');

    for (const ask of [f.stores.B, undefined]) {
      const out = await view(f, f.managerA, ask).then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );
      if ('e' in out) {
        expect(out.e).toBeInstanceOf(AuthorizationError);
      } else {
        const json = JSON.stringify(out.v);
        expect(json).not.toContain(bInvoice);
        expect(json).not.toContain(bLiab);
        expect(everyLine(out.v).every((l) => l.storeId === f.stores.A)).toBe(true);
      }
    }
    // control: the same person can read their own store
    const own = await view(f, f.managerA, f.stores.A);
    expect(kindOf(own, 'supplier_invoices').lines).toHaveLength(1);

    await expect(view(f, f.staff, f.stores.A)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(view(f, f.staff)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('gaps found by the audit', () => {
  it('24 - a 2xxx ledger line with NO store: shown in the all-stores view as its own "no store" line, not a null link, no spurious banner, totals add up', async () => {
    const f = await fixture('c24');
    await post(f.orgId, '2026-01-02', 'opening_balance', [
      { code: '3900', storeId: null as unknown as string, debit: '3000.00' },
      { code: '2210', storeId: null as unknown as string, credit: '3000.00' },
    ]);
    await post(f.orgId, '2026-02-11', 'expense', [
      { code: '6600', storeId: f.stores.A, debit: '1200.00' },
      { code: '2130', storeId: f.stores.A, credit: '1200.00', partyType: 'employee', partyId: f.workerId },
    ]);
    const r = await view(f, f.admin);
    const noStore = kindOf(r, 'other_ledger').lines.find((l) => l.accountCode === '2210');
    expect(noStore, 'the no-store balance is listed').toBeDefined();
    expect(noStore!.storeId).toBeNull();
    expect(noStore!.amount).toBe('3000.00');
    expect(noStore!.href).not.toMatch(/null|undefined/);
    expect(r.banners).toEqual([]);
    const sumLines = everyLine(r).filter((l) => !l.internal).reduce((t, l) => t + Math.round(Number(l.amount) * 100), 0);
    expect(r.totals.grand).toBe((sumLines / 100).toFixed(2));
    expect(r.totals.grand).toBe('4200.00');
  });

  it('25 - a non-config failure in the payroll preview never reaches the page as raw text; the other kinds still render', async () => {
    const f = await fixture('c25');
    // An hourly rate makes previewPayRun throw "only a daily basis has a compute path": a plain Error, not a config problem.
    await asOrg(f.orgId, (tx) =>
      setPayRate(tx, f.admin, { employmentId: f.workerEmpId, storeId: f.stores.A, basis: 'hourly', amount: '60.00', effectiveFrom: '2026-01-01' }));
    await sql`
      insert into attendance_days
        (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
         status, computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
      values (${f.orgId}, ${f.stores.A}, ${f.workerId}, ${f.workerEmpId}, '2026-01-05', ${f.configId!},
              'exact', 'verified', 540, false, 0, 0, 0, false, null)`;
    await creditInvoice(f, f.stores.A, '900.00');
    const r = await view(f, f.admin, f.stores.A);
    const k = kindOf(r, 'wages');
    expect(k.unavailableReason ?? '').toMatch(/could not be loaded/i);
    expect(JSON.stringify(k)).not.toMatch(/daily basis|compute path|previewPayRun/i);
    expect(k.lines).toEqual([]);
    expect(kindOf(r, 'supplier_invoices').lines).toHaveLength(1);
    expect(r.totals.booked).toBe('900.00');
  });
});
