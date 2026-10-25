import { sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { createExpense } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { postEntry } from '../../../src/ledger/post-entry';

/**
 * T-475 S1 (TESTER) - one fixture for the AP live-check integration tests. A fresh org per call (fresh ids, runs on any `_test`
 * database), a store, an admin who LOGS the invoices, a second admin who VERIFIES them, a manager, a floor-staff member who
 * holds nothing, and a SECOND org with its own supplier (for the no-leak tests). `employments.staff_code` is not used: the
 * people are role + store-scope rows, as in t376-s1-verify-override-web.test.ts.
 */
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
export const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

export type Fixture = Awaited<ReturnType<typeof ap475Fixture>>;

export async function ap475Fixture(sql: postgres.Sql, hint: string) {
  const code = uid(`t475-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('malvar')}, 'Malvar') returning id`;
  const store2Id = store2!.id;

  const person = async (name: string, role: 'manager' | 'admin' | 'staff', scope: string[] = [storeId]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await person('Admin Logger', 'admin');
  const verifierId = await person('Admin Verifier', 'admin');
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Floor Staff', 'staff');
  const otherStoreStaffId = await person('Malvar Staff', 'staff', [store2Id]);

  const cashRow = async (st: string) =>
    (await sql<{ id: string; gl_account_code: string }[]>`
      select id, gl_account_code from money_accounts where store_id = ${st} and instrument = 'cash' and custodian = 'cashier' and is_foundation`)[0]!;
  const cash = await cashRow(storeId);
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: cash.gl_account_code, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
    }),
  );

  const supplier = async (o: { name?: string; vatStatus?: 'vat_registered' | 'non_vat' | null; status?: string; creditTermsDays?: number | null } = {}) =>
    (await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by, vat_status, status, credit_terms_days)
      values (${orgId}, ${o.name ?? uid('Pork Co')}, ${adminId}, ${o.vatStatus ?? 'vat_registered'}, ${o.status ?? 'active'}, ${o.creditTermsDays === undefined ? 30 : o.creditTermsDays})
      returning id`)[0]!.id;
  const file = async (st: string = storeId) =>
    (await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${st}, 'receipt_photo', ${`orgs/${orgId}/stores/${st}/receipt_photo/${uid('r')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${adminId})
      returning id`)[0]!.id;
  const category = async (name = 'Cost of Goods Sold — General') =>
    (await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = ${name}`)[0]!.id;
  const unmappedCategory = async () =>
    (await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('Mystery Spend')}, null) returning id`)[0]!.id;
  const catId = await category();
  const supplierId = await supplier();
  const receiptId = await file();

  /** A raw pending (or verified) invoice. `createdBy` defaults to the logging admin. */
  const invoice = async (o: {
    on?: string; total?: string; status?: 'pending' | 'verified'; supplierId?: string; storeId?: string; invoiceNo?: string | null; receiptFileId?: string | null; createdBy?: string;
  } = {}) =>
    (await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, receipt_file_id, created_by,
                                     verified_by, verified_at, attested_supplier, attested_invoice, attested_items, attested_price)
      values (${orgId}, ${o.storeId ?? storeId}, ${o.supplierId ?? supplierId}, ${o.invoiceNo ?? null}, ${o.on ?? '2026-01-10'}, ${o.total ?? '5000.00'},
              ${o.status ?? 'pending'}, ${o.receiptFileId === undefined ? receiptId : o.receiptFileId}, ${o.createdBy ?? adminId},
              ${o.status === 'verified' ? managerId : null}, ${o.status === 'verified' ? sql`now()` : null},
              ${o.status === 'verified'}, ${o.status === 'verified'}, ${o.status === 'verified'}, ${o.status === 'verified'})
      returning id`)[0]!.id;

  /** A draft expense against an invoice, created through the real domain function. */
  const draft = async (invoiceId: string, o: { on?: string; amount?: string; categoryId?: string; particulars?: string; supplierId?: string; payments?: Parameters<typeof createExpense>[2]['payments'] } = {}) => {
    const made = await asOrg(orgId, (tx) =>
      createExpense(tx, actorOf(orgId, adminId), {
        storeId, supplierId: o.supplierId ?? supplierId, supplierInvoiceId: invoiceId, businessDate: o.on ?? '2026-01-10', categoryId: o.categoryId ?? catId,
        particulars: o.particulars ?? `Pork ${uid('d')}`,
        payments: o.payments ?? [{ method: 'cash', amount: o.amount ?? '100.00', moneyAccountId: cash.id }],
      }),
    );
    return made.id;
  };
  // A lock needs the whole year locked (a DB rule: no open period in a locked year), so 'locked' locks every period of the org.
  const setPeriod = (start: string, status: 'open' | 'closed' | 'locked') =>
    status === 'locked'
      ? sql`update fiscal_periods set status = 'locked' where org_id = ${orgId}`
      : sql`update fiscal_periods set status = ${status} where org_id = ${orgId} and starts_on = ${start}`;

  // A second org with its own supplier + invoice, for the no-leak tests.
  const [org2] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Other ${code}`}, ${`${code}-b`}) returning id`;
  const other = { orgId: org2!.id };

  return {
    sql, orgId, storeId, store2Id, adminId, verifierId, managerId, staffId, otherStoreStaffId, cashId: cash.id, categoryId: catId, supplierId, receiptId,
    admin: actorOf(orgId, adminId), verifier: actorOf(orgId, verifierId), manager: actorOf(orgId, managerId), staff: actorOf(orgId, staffId),
    otherStoreStaff: actorOf(orgId, otherStoreStaffId),
    supplier, file, category, unmappedCategory, invoice, draft, setPeriod, other,
  };
}
