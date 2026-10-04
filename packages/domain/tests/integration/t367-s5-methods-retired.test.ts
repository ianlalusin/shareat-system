import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-367 S5 (DEF-054) — `other` and `ar_collection` are retired as expense payment methods. F3a (create), F3b (edit),
 * F3d (approve a LEGACY row), F3e (the AP path). `docs/tasks/367-ap-ar-money.md` §S5, R-1/R-2/R-5/R-8.
 *
 * ⛔ TESTER. After migration 0182 the CHECK ALSO refuses these rows, so "nothing written" passes even without the
 * guard (R-1/R-2). Every refusal leg therefore asserts (1) the EXACT domain sentence and (2) the error is NOT a
 * Postgres 23514 / "violates check constraint". Each has a positive control that saves. At HEAD the retired methods
 * are accepted at create/edit, so the reds fail on `NOT REFUSED`.
 *
 * ⚠️ SPEC DEFECT: the spec writes `payment #0:` for the approve-time refusal, but `routing.ts` numbers payments from 1
 * (`fundingLine(payment, i + 1, …)`), so the first payment is `payment #1:`. F3d pins the real, 1-based numbering.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { approveExpense, createExpense, editExpense, recordExpenseForInvoice } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const SENTENCE = {
  ar_collection: 'That payment method is no longer used. A platform fee is recorded on the channel settlement.',
  other: "'Other' is no longer a payment method. Choose how the money actually left: cash, online, credit or reimbursable.",
} as const;

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t367s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const storeId = store!.id;
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await person('Staff', 'staff');
  const managerId = await person('Manager', 'manager');
  const adminId = await person('Admin', 'admin');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: adminId });
  const [drawer] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Cashier drawer', 'cash', '1110', 'cashier') returning id`;
  // fund the drawer with an opening-balance entry so approving a cash expense does not trip the overdraw block
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1110'`;
    const [eq] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${storeId}, '50000.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${eq!.id}, ${storeId}, '0', '50000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Supplier', ${staffId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${hint}.jpg`}, 'image/jpeg', 1024, ${`sum-${code}`}, ${staffId}) returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
                                   attested_supplier, attested_invoice, attested_items, attested_price)
    values (${orgId}, ${storeId}, ${supplier!.id}, '2026-01-01', '99999999.00', 'verified', ${file!.id}, ${managerId}, now(), ${staffId}, true, true, true, true) returning id`;
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Bank Fees'`;
  return {
    orgId, storeId, staffId, managerId, drawerId: drawer!.id, supplierId: supplier!.id, invoiceId: invoice!.id, categoryId: cat!.id,
    staff: actor(orgId, staffId), manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const cashLine = (f: Fixture, amount = '100.00') => ({ method: 'cash' as const, amount, moneyAccountId: f.drawerId });
const input = (f: Fixture, payments: unknown[]) =>
  ({ storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: f.invoiceId, businessDate: '2026-01-01', categoryId: f.categoryId, particulars: 'Bank fee', payments }) as never;
const create = (f: Fixture, payments: unknown[]) => asPerson(f.orgId, (tx) => createExpense(tx, f.staff, input(f, payments)));

const counts = async (orgId: string) => {
  const [e] = await sql<{ n: string }[]>`select count(*)::text n from expenses where org_id = ${orgId}`;
  const [p] = await sql<{ n: string }[]>`select count(*)::text n from expense_payments ep join expenses e on e.id = ep.expense_id where e.org_id = ${orgId}`;
  return { expenses: Number(e!.n), payments: Number(p!.n) };
};

/** Asserts a refusal that is the DOMAIN's sentence — never saved, never a raw 23514. */
async function refusedWith(p: Promise<unknown>, sentence: string, what: string) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (err === undefined) throw new Error(`NOT REFUSED — ${what} was accepted instead (the defect DEF-054 targets)`);
  const e = err as { message?: string; userMessage?: string; code?: string };
  const all = `${e.message ?? ''} | ${e.userMessage ?? ''}`;
  expect(all, `the refusal must not be a Postgres CHECK violation — ${all}`).not.toMatch(/23514|violates check constraint|expense_payments_method_check/);
  expect(e.code).not.toBe('23514');
  expect(e.userMessage ?? `NO userMessage — raw: ${e.message}`).toContain(sentence);
}

describe('F3a — createExpense refuses a retired method with the domain sentence, before any write', () => {
  it("one 'ar_collection' line -> its sentence, no 23514, zero expenses and zero payments", async () => {
    const f = await fixture('f3a-ar');
    await refusedWith(create(f, [{ method: 'ar_collection', amount: '100.00' }]), SENTENCE.ar_collection, "an 'ar_collection' expense");
    expect(await counts(f.orgId)).toEqual({ expenses: 0, payments: 0 });
  });

  it("one 'other' line -> its sentence, no 23514, zero rows", async () => {
    const f = await fixture('f3a-other');
    await refusedWith(create(f, [{ method: 'other', amount: '100.00' }]), SENTENCE.other, "an 'other' expense");
    expect(await counts(f.orgId)).toEqual({ expenses: 0, payments: 0 });
  });

  it("a cash + 'other' mix -> the 'other' sentence, no 23514, zero rows (the guard sees every line)", async () => {
    const f = await fixture('f3a-mix');
    await refusedWith(create(f, [cashLine(f, '50.00'), { method: 'other', amount: '50.00' }]), SENTENCE.other, "a cash + 'other' expense");
    expect(await counts(f.orgId)).toEqual({ expenses: 0, payments: 0 });
  });

  it('+control: a cash line alone saves — one expense, one payment', async () => {
    const f = await fixture('f3a-ok');
    await create(f, [cashLine(f)]);
    expect(await counts(f.orgId)).toEqual({ expenses: 1, payments: 1 });
  });
});

describe('F3b — editExpense refuses a retired method with the domain sentence; the draft is unchanged', () => {
  it("replacing a cash line with 'other' -> the 'other' sentence, no 23514, the payments are still the one cash line", async () => {
    const f = await fixture('f3b');
    const { id } = await create(f, [cashLine(f)]);
    await refusedWith(
      asPerson(f.orgId, (tx) => editExpense(tx, f.staff, id, { payments: [{ method: 'other', amount: '100.00' }] } as never)),
      SENTENCE.other,
      "an edit to an 'other' payment",
    );
    const rows = await sql<{ method: string; amount: string }[]>`select method, amount::text from expense_payments where expense_id = ${id}`;
    expect(rows).toEqual([{ method: 'cash', amount: '100.00' }]);
  });

  it("an edit to 'ar_collection' -> its sentence, no 23514", async () => {
    const f = await fixture('f3b-ar');
    const { id } = await create(f, [cashLine(f)]);
    await refusedWith(
      asPerson(f.orgId, (tx) => editExpense(tx, f.staff, id, { payments: [{ method: 'ar_collection', amount: '100.00' }] } as never)),
      SENTENCE.ar_collection,
      "an edit to an 'ar_collection' payment",
    );
  });

  it('+control: an edit that replaces the cash line with another cash line saves (amount 120.00)', async () => {
    const f = await fixture('f3b-ok');
    const { id } = await create(f, [cashLine(f)]);
    await asPerson(f.orgId, (tx) => editExpense(tx, f.staff, id, { payments: [cashLine(f, '120.00')] } as never));
    const rows = await sql<{ amount: string }[]>`select amount::text from expense_payments where expense_id = ${id}`;
    expect(rows).toEqual([{ amount: '120.00' }]);
  });
});

describe('F3b2 — on a cash-on-delivery supplier the RETIRED-method sentence wins over the COD sentence (guard order)', () => {
  const COD = /is cash-on-delivery/;
  it("edit to ['other', 'credit'] -> the 'other' sentence (not the COD one, not 23514); payments unchanged", async () => {
    const f = await fixture('f3b2');
    const [s] = await sql<{ n: string | null }[]>`select credit_terms_days::text n from suppliers where id = ${f.supplierId}`;
    expect(s!.n, 'fixture precondition: the supplier is cash-on-delivery (credit_terms_days null)').toBeNull();
    const { id } = await create(f, [cashLine(f, '100.00')]);
    let err: unknown;
    try {
      await asPerson(f.orgId, (tx) =>
        editExpense(tx, f.staff, id, { payments: [{ method: 'other', amount: '50.00' }, { method: 'credit', amount: '50.00' }] } as never));
    } catch (e) {
      err = e;
    }
    if (err === undefined) throw new Error("NOT REFUSED — an edit to ['other','credit'] was accepted");
    const e = err as { message?: string; userMessage?: string };
    expect(e.userMessage ?? `NO userMessage — raw: ${e.message}`, 'must not be the COD sentence').not.toMatch(COD);
    expect(`${e.message} ${e.userMessage}`).not.toMatch(/23514|violates check constraint/);
    expect(e.userMessage).toContain(SENTENCE.other);
    expect(await sql`select method from expense_payments where expense_id = ${id}`).toEqual([{ method: 'cash' }]);
  });

  it("+control: the same edit to ['cash'] saves on that COD supplier", async () => {
    const f = await fixture('f3b2-ok');
    const { id } = await create(f, [cashLine(f, '100.00')]);
    await asPerson(f.orgId, (tx) => editExpense(tx, f.staff, id, { payments: [cashLine(f, '100.00')] } as never));
    expect((await sql`select method from expense_payments where expense_id = ${id}`).length).toBe(1);
  });
});

describe('F3d — approving a LEGACY draft that holds a retired method is refused by routing (the second layer)', () => {
  /** ONE fixture transaction: drop the CHECK, insert the legacy draft, re-ADD the SAME definition NOT VALID. DDL is
   * transactional, so the DB never commits without the CHECK (R-8). Works at HEAD (re-adds the 6-value CHECK) and after 0182. */
  async function legacyDraft(f: Fixture, method: string, moneyAccountId: string | null = null): Promise<string> {
    return sql.begin(async (tx) => {
      const [def] = await tx<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'expense_payments_method_check' and conrelid = 'expense_payments'::regclass`;
      const check = def!.def.replace(/\s+NOT VALID$/i, '');
      await tx.unsafe('alter table expense_payments drop constraint expense_payments_method_check');
      const [e] = await tx<{ id: string }[]>`
        insert into expenses (org_id, store_id, business_date, category_id, supplier_id, supplier_invoice_id, particulars, total_amount, status, created_by)
        values (${f.orgId}, ${f.storeId}, '2026-01-01', ${f.categoryId}, ${f.supplierId}, ${f.invoiceId}, 'legacy row', '100.00', 'draft', ${f.staffId}) returning id`;
      await tx`insert into expense_payments (expense_id, method, amount, money_account_id) values (${e!.id}, ${method}, '100.00', ${moneyAccountId})`;
      await tx.unsafe(`alter table expense_payments add constraint expense_payments_method_check ${check} not valid`);
      return e!.id;
    });
  }
  const statusOf = async (id: string) =>
    (await sql<{ status: string; je: string | null }[]>`select status, journal_entry_id::text as je from expenses where id = ${id}`)[0]!;

  for (const method of ['other', 'ar_collection'] as const) {
    it(`'${method}' draft -> approveExpense refused with "payment #1: " + its sentence; no journal entry; still draft`, async () => {
      const f = await fixture(`f3d-${method}`);
      const id = await legacyDraft(f, method);
      let err: unknown;
      try {
        await asPerson(f.orgId, (tx) => approveExpense(tx, f.manager, id));
      } catch (e) {
        err = e;
      }
      if (err === undefined) throw new Error(`NOT REFUSED — a legacy '${method}' draft was approved`);
      expect(String((err as Error).message)).toContain(`payment #1: ${SENTENCE[method]}`);
      expect(await statusOf(id)).toEqual({ status: 'draft', je: null });
    });
  }

  it('+control: a cash draft made by the same fixture approves and posts', async () => {
    const f = await fixture('f3d-ok');
    const id = await legacyDraft(f, 'cash', f.drawerId);
    await asPerson(f.orgId, (tx) => approveExpense(tx, f.manager, id));
    const row = await statusOf(id);
    expect(row.status).toBe('posted');
    expect(row.je).not.toBeNull();
  });
});

describe('F3e — the AP path (recordExpenseForInvoice) carries the domain sentence to an AP caller', () => {
  const record = (f: Fixture, payments: unknown[]) =>
    asPerson(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: f.invoiceId, categoryId: f.categoryId, particulars: 'Bank fee', payments,
      } as never),
    );

  it("an 'other' line -> the 'other' sentence, no 23514, nothing written", async () => {
    const f = await fixture('f3e');
    await refusedWith(record(f, [{ method: 'other', amount: '100.00' }]), SENTENCE.other, "an AP 'other' expense");
    expect(await counts(f.orgId)).toEqual({ expenses: 0, payments: 0 });
  });

  it('+control: a cash line records and posts', async () => {
    const f = await fixture('f3e-ok');
    const r = (await record(f, [cashLine(f)])) as { expenseId: string };
    expect((await sql<{ status: string }[]>`select status from expenses where id = ${r.expenseId}`)[0]!.status).toBe('posted');
  });
});
