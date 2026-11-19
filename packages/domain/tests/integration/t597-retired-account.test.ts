import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  chargeLiability,
  createLiability,
  createLoan,
  createSupplier,
  disburseLoan,
  payLiability,
  recordExpenseForInvoice,
  recordInvoice,
  recordLoanPayment,
  recordPayment,
  recordStatutoryPayment,
  verifyInvoice,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { asOrg as asWorldOrg, mkWorld, refusal } from './_fixtures/t193-s3-world';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ orgId, personId });

async function fundAccount(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [target] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 1, ${target!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staffId: string;
  managerId: string;
  adminId: string;
  staffFloatId: string;
  officeSafeId: string;
  otherOfficeSafeId: string;
  drawerId: string;
  categoryId: string;
  supplierId: string;
  supplier2Id: string;
  fileId: string;
  holder: string;
  manager: Actor;
  admin: Actor;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t415-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${`${name} ${hint}`}) returning id`)[0]!.id;
  const storeId = await mkStore('A');
  const otherStoreId = await mkStore('B');

  const person = async (name: string, role: 'staff' | 'manager' | 'admin') => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const staffId = await person(`${hint} Ana`, 'staff');
  const managerId = await person(`${hint} Manager`, 'manager');
  const adminId = await person(`${hint} Admin`, 'admin');
  const grant = async (sid: string) => {
    const [employment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${sid}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId, storeId: sid, employmentId: employment!.id, personId: staffId, setBy: managerId });
  };
  await grant(storeId);
  await grant(otherStoreId);

  const account = async (sid: string, custodian: 'staff' | 'office' | 'cashier') => {
    const [row] = await sql<{ id: string }[]>`
      select id from money_accounts where org_id = ${orgId} and store_id = ${sid} and custodian = ${custodian} and instrument = 'cash' order by created_at limit 1`;
    return row!.id;
  };
  await fundAccount(orgId, storeId, '1130', '500000.00');
  await fundAccount(orgId, otherStoreId, '1130', '500000.00');

  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actorOf(orgId, managerId);
  const supplier = await asPerson(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
  const supplier2 = await asPerson(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier Two`, creditTermsDays: 30 }));
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/${hint}.jpg`}, 'image/jpeg', 1024, ${`sum-${code}`}, ${staffId}) returning id`;
  return {
    orgId, storeId, otherStoreId, staffId, managerId, adminId,
    staffFloatId: await account(storeId, 'staff'),
    officeSafeId: await account(storeId, 'office'),
    otherOfficeSafeId: await account(otherStoreId, 'office'),
    drawerId: await account(storeId, 'cashier'),
    categoryId: category!.id, supplierId: supplier.id, supplier2Id: supplier2.id, fileId: file!.id,
    holder: `${hint} Ana`, manager, admin: actorOf(orgId, adminId),
  };
}

/** The refusal's `userMessage`; a marker when the call SUCCEEDED. */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? (err as Error).message;
  }
  return '<<NO REFUSAL - THE CALL SUCCEEDED>>';
}
const RETIRED = /^".+" is retired\. Choose another account to pay from\.$/;
const retire = (id: string) => sql`update money_accounts set is_active = false where id = ${id}`;
const entriesFor = async (sourceId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where source_id = ${sourceId}`)[0]!.n);

// ---------------------------------------------------------------------------------------------------------------------
// DEF-895 / DEF-905 - nothing is paid OUT of a retired account. Per caller: a live funded account posts; the same account retired is refused.
// ---------------------------------------------------------------------------------------------------------------------
async function apBill(f: Fixture, amount: string): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('ap')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.staffId}) returning id`;
  const created = await asPerson(f.orgId, (tx) =>
    recordInvoice(tx, actorOf(f.orgId, f.staffId), { storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: file!.id }),
  );
  await asPerson(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asPerson(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, { requireItemised: false /* legacy fixture: lineless invoice */,
      storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId,
      particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return exp.expenseId;
}

describe('DEF-895 - recordPayment (AP)', () => {
  const payFrom = (f: Fixture, expenseId: string, from: string) =>
    asPerson(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        requestId: crypto.randomUUID(), storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15', amount: '1000.00',
        moneyAccountId: from, allocations: [{ expenseId, amountApplied: '1000.00' }],
      }),
    );
  const posted = async (orgId: string) =>
    Number((await sql<{ n: string }[]>`select count(*)::text n from ap_payments where org_id = ${orgId} and status = 'posted'`)[0]!.n);

  it('a live funded account pays', async () => {
    const f = await setup('d895a');
    await payFrom(f, await apBill(f, '1000.00'), f.officeSafeId);
    expect(await posted(f.orgId)).toBe(1);
  });
  it('the same account retired is refused with the sentence; no payment row', async () => {
    const f = await setup('d895b');
    const bill = await apBill(f, '1000.00');
    await retire(f.officeSafeId);
    expect(await messageOf(payFrom(f, bill, f.officeSafeId))).toMatch(RETIRED);
    expect(await posted(f.orgId)).toBe(0);
  });
});

describe('DEF-895 - recordLoanPayment', () => {
  async function loanOn(f: Fixture): Promise<string> {
    const loan = await asPerson(f.orgId, (tx) =>
      createLoan(tx, f.admin, {
        storeId: f.storeId, lenderName: 'Grab', name: 'Cash advance', principalAmount: '200000.00', interestRate: '2', ratePeriod: 'month',
        interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-01-05',
      }),
    );
    await asPerson(f.orgId, (tx) => disburseLoan(tx, f.admin, { requestId: crypto.randomUUID(), loanId: loan.id, amount: '200000.00', intoMoneyAccountId: f.officeSafeId, on: '2026-01-05' }));
    return loan.id;
  }
  const payLoan = (f: Fixture, loanId: string) =>
    asPerson(f.orgId, (tx) => recordLoanPayment(tx, f.admin, { requestId: crypto.randomUUID(), loanId, amount: '2355.56', fromMoneyAccountId: f.officeSafeId, on: '2026-01-06' }));

  it('a live funded account pays', async () => {
    const f = await setup('d895c');
    const loanId = await loanOn(f);
    await payLoan(f, loanId);
    expect(await entriesFor(loanId)).toBe(2); // disbursement + payment
  });
  it('the same account retired is refused with the sentence; no entry', async () => {
    const f = await setup('d895d');
    const loanId = await loanOn(f);
    await retire(f.officeSafeId);
    expect(await messageOf(payLoan(f, loanId))).toMatch(RETIRED);
    expect(await entriesFor(loanId)).toBe(1); // the disbursement only
  });
});

describe('DEF-905 - payLiability', () => {
  async function owed(f: Fixture): Promise<string> {
    const created = await asPerson(f.orgId, (tx) => createLiability(tx, f.manager, { storeId: f.storeId, name: 'Accrued rent', category: 'accrued_expenses' }));
    await asPerson(f.orgId, (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: created.id, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-20' }));
    return created.id;
  }
  const payIt = (f: Fixture, id: string) =>
    asPerson(f.orgId, (tx) => payLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: id, amount: '1000.00', fromMoneyAccountId: f.officeSafeId, on: '2026-01-25' }));

  it('a live funded account pays', async () => {
    const f = await setup('d905a');
    const id = await owed(f);
    expect((await payIt(f, id)).settled).toBe(true);
  });
  it('the same account retired is refused with the sentence; no entry beyond the charge', async () => {
    const f = await setup('d905b');
    const id = await owed(f);
    await retire(f.officeSafeId);
    expect(await messageOf(payIt(f, id))).toMatch(RETIRED);
    expect(await entriesFor(id)).toBe(1);
  });
});

describe('DEF-895 - recordStatutoryPayment', () => {
  const input = (w: Awaited<ReturnType<typeof mkWorld>>, from: string) => ({
    paymentId: crypto.randomUUID(), agency: 'sss' as const, month: '2026-10-01', paidOn: '2026-11-10', moneyAccountId: from,
    referenceNo: uid('PRN'), lines: [{ storeId: w.lipa, amount: '3180.00' }],
  });
  const payments = async (orgId: string) =>
    Number((await sql<{ n: string }[]>`select count(*)::text n from statutory_payments where org_id = ${orgId}`)[0]!.n);

  it('a live funded account pays', async () => {
    const w = await mkWorld(sql, 'd895e');
    await asWorldOrg(w.orgId, (tx) => recordStatutoryPayment(tx, w.admin, input(w, w.lipaOffice)));
    expect(await payments(w.orgId)).toBe(1);
  });
  it('the same account retired is refused with the sentence; no payment row', async () => {
    const w = await mkWorld(sql, 'd895f');
    await retire(w.lipaOffice);
    const r = await refusal(asWorldOrg(w.orgId, (tx) => recordStatutoryPayment(tx, w.admin, input(w, w.lipaOffice))), 'a payment from a retired account');
    expect(r.userMessage).toMatch(RETIRED);
    expect(await payments(w.orgId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// T-613 A: an expense paid from a retired account is refused at approval. C: a re-sent payment after the account is retired
// returns the original answer, not the retired refusal.
// ---------------------------------------------------------------------------------------------------------------------
describe('T-613 DEF-932 - approving an expense funded from a retired account', () => {
  async function invoiceFor(f: Fixture, amount: string): Promise<string> {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('x')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.staffId}) returning id`;
    const created = await asPerson(f.orgId, (tx) =>
      recordInvoice(tx, actorOf(f.orgId, f.staffId), { storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: file!.id }),
    );
    await asPerson(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
    return created.id;
  }
  const paidFrom = (f: Fixture, invoiceId: string, from: string) =>
    asPerson(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, { requireItemised: false /* legacy fixture: lineless invoice */,
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId,
        particulars: 'Stock purchase', payments: [{ method: 'cash', amount: '1000.00', moneyAccountId: from }],
      }),
    );
  const postedExpenses = async (orgId: string) =>
    Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where org_id = ${orgId} and source_type = 'expense_payment'`)[0]!.n);

  it('a live funded account pays', async () => {
    const f = await setup('d932a');
    await paidFrom(f, await invoiceFor(f, '1000.00'), f.officeSafeId);
    expect(await postedExpenses(f.orgId)).toBe(1);
  });
  it('the same account retired is refused with the sentence; nothing posts', async () => {
    const f = await setup('d932b');
    const invoice = await invoiceFor(f, '1000.00');
    await retire(f.officeSafeId);
    expect(await messageOf(paidFrom(f, invoice, f.officeSafeId))).toMatch(RETIRED);
    expect(await postedExpenses(f.orgId)).toBe(0);
  });
});

describe('T-613 DEF-934 - a re-sent payment after the account is retired answers with the original', () => {
  it('payLiability: the same request id replays; a NEW request id is still refused as retired', async () => {
    const f = await setup('d934a');
    const created = await asPerson(f.orgId, (tx) => createLiability(tx, f.manager, { storeId: f.storeId, name: 'Accrued rent', category: 'accrued_expenses' }));
    await asPerson(f.orgId, (tx) => chargeLiability(tx, f.manager, { requestId: crypto.randomUUID(), liabilityId: created.id, amount: '1000.00', againstAccountCode: '6200', on: '2026-01-20' }));
    const requestId = crypto.randomUUID();
    const pay = (id: string, amount = '600.00') =>
      asPerson(f.orgId, (tx) => payLiability(tx, f.manager, { requestId: id, liabilityId: created.id, amount, fromMoneyAccountId: f.officeSafeId, on: '2026-01-25' }));
    const first = await pay(requestId);
    await retire(f.officeSafeId);
    const again = await pay(requestId);
    expect(again.entryId).toBe(first.entryId);
    expect(await entriesFor(created.id)).toBe(2); // the charge and ONE payment
    expect(await messageOf(pay(crypto.randomUUID(), '300.00'))).toMatch(RETIRED);
  });
  it('recordPayment (AP): the same request id replays the original after the account is retired', async () => {
    const f = await setup('d934b');
    const bill = await apBill(f, '1000.00');
    const requestId = crypto.randomUUID();
    const pay = (id: string) =>
      asPerson(f.orgId, (tx) =>
        recordPayment(tx, f.manager, {
          requestId: id, storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15', amount: '1000.00',
          moneyAccountId: f.officeSafeId, allocations: [{ expenseId: bill, amountApplied: '1000.00' }],
        }),
      );
    const first = await pay(requestId);
    await retire(f.officeSafeId);
    const again = await pay(requestId);
    expect(again.paymentId).toBe(first.paymentId);
  });
});
