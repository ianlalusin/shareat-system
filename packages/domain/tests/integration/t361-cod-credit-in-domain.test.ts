import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-361 (DEF-492) — domain-direct legs D1-D9, E1-E3.
 * `docs/tasks/361-def-492-cod-credit-rule-in-domain.md` §Legs, "Domain-direct".
 * Amendment A1/A2: `T-362` already gave suppliers a real terms writer, so fixtures here use
 * `createSupplier`/`editSupplier` (never raw SQL) wherever an `approve_supplier` actor is in
 * reach, which is everywhere in this file (the manager fixture holds it).
 *
 * ⛔ TESTER, not BUILDER. `createExpense` (R2, `expenses/create.ts`) refuses a credit payment
 * against a cash-on-delivery supplier (`credit_terms_days is null`), after the supplier-mismatch
 * refusal and before `insertExpense` — `recordExpenseForInvoice` inherits it, having no gate of
 * its own. `editExpense` (R3) holds the same rule. Every "was red today" note records the PRE-FIX
 * result. Fixture shape from `ap.test.ts:63-202` (fixture, verifiedInvoice/pendingInvoice,
 * draftExpense), adapted to create a fresh supplier per leg instead of one fixed one.
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
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createExpense, createSupplier, editExpense, editSupplier, recordExpenseForInvoice, recordInvoice, verifyInvoice } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

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
  const code = uid(`t361-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;

  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staff!.id, setBy: manager!.id });

  // A bare staff, position-grant-free — D6's non-holder (create_expense is position-granted,
  // CAPABILITY-MATRIX.md:46 — `f.staff` above already HOLDS it via the grant, so it cannot stand
  // in for a non-holder).
  const [bareStaff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Non-holder') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${bareStaff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${bareStaff!.id}, ${storeId}, 'manual')`;

  // ⛔ Segregation of duties: verifyInvoice refuses "you logged this invoice, so you cannot also
  // verify it" — a second manager verifies.
  const [verifier] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${verifier!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${verifier!.id}, ${storeId})`;

  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  return {
    orgId, storeId,
    manager: actor(orgId, manager!.id),
    staff: actor(orgId, staff!.id),
    bareStaff: actor(orgId, bareStaff!.id),
    verifier: actor(orgId, verifier!.id),
    drawerId: drawer!.id,
    categoryId: category!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function codSupplier(f: Fixture, hint: string): Promise<{ id: string; name: string }> {
  const name = `COD ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name }));
  return { id, name };
}
async function termsSupplier(f: Fixture, hint: string): Promise<{ id: string; name: string }> {
  const name = `Terms ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name, creditTermsDays: 30 }));
  return { id, name };
}

async function receiptFile(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.manager.personId}) returning id`;
  return row!.id;
}
async function pendingInvoice(f: Fixture, supplierId: string, totalAmount: string): Promise<string> {
  const fileId = await receiptFile(f);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', totalAmount, receiptFileId: fileId }),
  );
  return created.id;
}
async function verifiedInvoice(f: Fixture, supplierId: string, totalAmount: string): Promise<string> {
  const invoiceId = await pendingInvoice(f, supplierId, totalAmount);
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, invoiceId, { supplier: true, invoice: true, items: true, price: true }));
  return invoiceId;
}

async function expenseCounts(orgId: string): Promise<{ e: number; j: number }> {
  const [row] = await sql<{ e: number; j: number }[]>`
    select (select count(*) from expenses where org_id = ${orgId})::int as e,
           (select count(*) from journal_entries where org_id = ${orgId})::int as j`;
  return row!;
}

const S = (name: string) => `${name} is cash-on-delivery. Set payment terms on the supplier to pay on credit.`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

describe('D1 — createExpense, COD supplier\'s pending invoice, [{credit, 500}]', () => {
  it('rejects with S(name); nothing written — was red today: a draft is saved', async () => {
    const f = await fixture('d1');
    const cod = await codSupplier(f, 'd1');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    const before = await expenseCounts(f.orgId);
    await expect(
      asOrg(f.orgId, (tx) =>
        createExpense(tx, f.staff, {
          storeId: f.storeId, businessDate: '', supplierId: cod.id, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'D1', payments: [{ method: 'credit', amount: '500.00' }],
        }),
      ),
    ).rejects.toMatchObject({ userMessage: S(cod.name) });
    expect((await expenseCounts(f.orgId)).e, 'nothing written').toBe(before.e);
  });
});

describe('D2 — recordExpenseForInvoice, COD, verified invoice, [{credit, 500}]', () => {
  it('as D1; no journal entry — was red today: posts a 2110 credit to the supplier', async () => {
    const f = await fixture('d2');
    const cod = await codSupplier(f, 'd2');
    const invoiceId = await verifiedInvoice(f, cod.id, '1000.00');
    const before = await expenseCounts(f.orgId);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordExpenseForInvoice(tx, f.manager, {
          storeId: f.storeId, supplierId: cod.id, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'D2', payments: [{ method: 'credit', amount: '500.00' }],
        }),
      ),
    ).rejects.toMatchObject({ userMessage: S(cod.name) });
    const after = await expenseCounts(f.orgId);
    expect(after.e, 'nothing written').toBe(before.e);
    expect(after.j, 'no journal entry').toBe(before.j);
  });
});

describe('D3 — createExpense, COD, [{cash, 200, drawer}, {credit, 300}]', () => {
  it('as D1 (any credit line refuses) — was red today: saves', async () => {
    const f = await fixture('d3');
    const cod = await codSupplier(f, 'd3');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    const before = await expenseCounts(f.orgId);
    await expect(
      asOrg(f.orgId, (tx) =>
        createExpense(tx, f.staff, {
          storeId: f.storeId, businessDate: '', supplierId: cod.id, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'D3',
          payments: [{ method: 'cash', amount: '200.00', moneyAccountId: f.drawerId }, { method: 'credit', amount: '300.00' }],
        }),
      ),
    ).rejects.toMatchObject({ userMessage: S(cod.name) });
    expect((await expenseCounts(f.orgId)).e, 'nothing written').toBe(before.e);
  });
});

describe('D4 (green, guard; positive control) — recordExpenseForInvoice, TERMS, [{credit, 500}]', () => {
  it('posts; one credit payment', async () => {
    const f = await fixture('d4');
    const terms = await termsSupplier(f, 'd4');
    const invoiceId = await verifiedInvoice(f, terms.id, '1000.00');
    const { expenseId } = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: terms.id, supplierInvoiceId: invoiceId,
        categoryId: f.categoryId, particulars: 'D4', payments: [{ method: 'credit', amount: '500.00' }],
      }),
    );
    const [payment] = await sql<{ method: string }[]>`select method from expense_payments where expense_id = ${expenseId}`;
    expect(payment!.method).toBe('credit');
  });
});

describe('D5 (green, guard; positive control) — createExpense, COD, [{cash, 500, drawer}]', () => {
  it('saves a draft', async () => {
    const f = await fixture('d5');
    const cod = await codSupplier(f, 'd5');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    const { id } = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staff, {
        storeId: f.storeId, businessDate: '', supplierId: cod.id, supplierInvoiceId: invoiceId,
        categoryId: f.categoryId, particulars: 'D5', payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.drawerId }],
      }),
    );
    const [expense] = await sql<{ status: string }[]>`select status from expenses where id = ${id}`;
    expect(expense!.status).toBe('draft');
  });
});

describe('D6 (green, guard; ordering) — a STAFF non-holder, createExpense, COD, credit', () => {
  it('message equals the same non-holder\'s message for a cash line; ⛔ no "cash-on-delivery"; nothing written', async () => {
    const f = await fixture('d6');
    const cod = await codSupplier(f, 'd6');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    const before = await expenseCounts(f.orgId);
    const call = (payments: { method: string; amount: string; moneyAccountId?: string }[]) =>
      asOrg(f.orgId, (tx) =>
        createExpense(tx, f.bareStaff, {
          storeId: f.storeId, businessDate: '', supplierId: cod.id, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'D6', payments,
        } as Parameters<typeof createExpense>[2]),
      );
    const baseline = await call([{ method: 'cash', amount: '500.00', moneyAccountId: f.drawerId }]).catch((e) => e);
    const malformed = await call([{ method: 'credit', amount: '500.00' }]).catch((e) => e);
    expect(baseline, 'expected the cash-line call to be refused too').toBeInstanceOf(AuthorizationError);
    expect(malformed).toBeInstanceOf(AuthorizationError);
    expect((malformed as Error).message).toBe((baseline as Error).message);
    expect((malformed as { userMessage?: string }).userMessage ?? '').not.toContain('cash-on-delivery');
    expect((await expenseCounts(f.orgId)).e, 'nothing written').toBe(before.e);
  });
});

describe('D7 (green, guard; order guard R2) — COD supplier made INACTIVE, credit', () => {
  it('rejects /not active/i, not S(...)', async () => {
    const f = await fixture('d7');
    const cod = await codSupplier(f, 'd7');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: cod.id, status: 'inactive' }));
    await expect(
      asOrg(f.orgId, (tx) =>
        createExpense(tx, f.staff, {
          storeId: f.storeId, businessDate: '', supplierId: cod.id, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'D7', payments: [{ method: 'credit', amount: '500.00' }],
        }),
      ),
    ).rejects.toThrow(/not active/i);
  });
});

describe('D8 (green, guard; order guard R2) — supplierId ≠ the invoice\'s supplier, invoice from COD, credit', () => {
  it('rejects the mismatch sentence, not S(...)', async () => {
    const f = await fixture('d8');
    const cod = await codSupplier(f, 'd8');
    const other = await codSupplier(f, 'd8-other');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        createExpense(tx, f.staff, {
          storeId: f.storeId, businessDate: '', supplierId: other.id, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'D8', payments: [{ method: 'credit', amount: '500.00' }],
        }),
      ),
    ).rejects.toMatchObject({ userMessage: expect.stringContaining('An expense takes its supplier from its invoice') });
  });
});

describe('D9 (R2: the invoice\'s supplier is judged) — invoice from COD, then invoice from TERMS', () => {
  it('the first refuses with S(COD name), the second posts — was red today: the first posts', async () => {
    const f = await fixture('d9');
    const cod = await codSupplier(f, 'd9-cod');
    const terms = await termsSupplier(f, 'd9-terms');
    const codInvoiceId = await verifiedInvoice(f, cod.id, '1000.00');
    const termsInvoiceId = await verifiedInvoice(f, terms.id, '1000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        recordExpenseForInvoice(tx, f.manager, {
          storeId: f.storeId, supplierId: cod.id, supplierInvoiceId: codInvoiceId,
          categoryId: f.categoryId, particulars: 'D9a', payments: [{ method: 'credit', amount: '500.00' }],
        }),
      ),
    ).rejects.toMatchObject({ userMessage: S(cod.name) });

    const { expenseId } = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: terms.id, supplierInvoiceId: termsInvoiceId,
        categoryId: f.categoryId, particulars: 'D9b', payments: [{ method: 'credit', amount: '500.00' }],
      }),
    );
    const [expense] = await sql<{ status: string }[]>`select status from expenses where id = ${expenseId}`;
    expect(expense!.status).toBe('posted');
  });
});

describe('E1 — editExpense on a COD draft (cash line), payments: [{credit, 500}]', () => {
  it('S(name); the draft\'s payments are unchanged — was red today: payments replaced', async () => {
    const f = await fixture('e1');
    const cod = await codSupplier(f, 'e1');
    const invoiceId = await pendingInvoice(f, cod.id, '1000.00');
    const { id } = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staff, {
        storeId: f.storeId, businessDate: '', supplierId: cod.id, supplierInvoiceId: invoiceId,
        categoryId: f.categoryId, particulars: 'E1', payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.drawerId }],
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => editExpense(tx, f.staff, id, { payments: [{ method: 'credit', amount: '500.00' }] })),
    ).rejects.toMatchObject({ userMessage: S(cod.name) });
    const [payment] = await sql<{ method: string }[]>`select method from expense_payments where expense_id = ${id}`;
    expect(payment!.method).toBe('cash');
  });
});

describe('E2 — editExpense on a TERMS draft with a credit line, re-pointed to a COD supplier\'s invoice, no payments', () => {
  it('S(COD name); the draft still names the TERMS invoice — was red today: re-pointed', async () => {
    const f = await fixture('e2');
    const terms = await termsSupplier(f, 'e2-terms');
    const cod = await codSupplier(f, 'e2-cod');
    const termsInvoiceId = await pendingInvoice(f, terms.id, '1000.00');
    const codInvoiceId = await pendingInvoice(f, cod.id, '1000.00');
    // A DRAFT (createExpense alone, never recordExpenseForInvoice — that posts immediately, and
    // editExpense requires status='draft').
    const { id } = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staff, {
        storeId: f.storeId, businessDate: '', supplierId: terms.id, supplierInvoiceId: termsInvoiceId,
        categoryId: f.categoryId, particulars: 'E2', payments: [{ method: 'credit', amount: '500.00' }],
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => editExpense(tx, f.manager, id, { supplierId: cod.id, supplierInvoiceId: codInvoiceId })),
    ).rejects.toMatchObject({ userMessage: S(cod.name) });
    const [expense] = await sql<{ supplier_invoice_id: string }[]>`select supplier_invoice_id from expenses where id = ${id}`;
    expect(expense!.supplier_invoice_id).toBe(termsInvoiceId);
  });
});

describe('E3 (green, guard; positive control) — editExpense on a TERMS draft, payments: [{credit, 500}]', () => {
  it('saves', async () => {
    const f = await fixture('e3');
    const terms = await termsSupplier(f, 'e3');
    const invoiceId = await pendingInvoice(f, terms.id, '1000.00');
    const { id } = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staff, {
        storeId: f.storeId, businessDate: '', supplierId: terms.id, supplierInvoiceId: invoiceId,
        categoryId: f.categoryId, particulars: 'E3', payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.drawerId }],
      }),
    );
    await asOrg(f.orgId, (tx) => editExpense(tx, f.staff, id, { payments: [{ method: 'credit', amount: '500.00' }] }));
    const [payment] = await sql<{ method: string }[]>`select method from expense_payments where expense_id = ${id}`;
    expect(payment!.method).toBe('credit');
  });
});
