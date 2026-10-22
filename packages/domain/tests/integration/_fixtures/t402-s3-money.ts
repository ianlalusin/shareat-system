import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import { createExpense, createSupplier, recordInvoice } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { asOrgOn } from './pos-s6';
import { grantEverydayPositionAccess } from './staff-everyday-access';

/**
 * T-402 S3 fixtures (tester). One org / one store with a manager, an everyday-access staff person, a funded cashier
 * drawer, a supplier and the expense category crosswalk (the same shape as ap.test.ts's fixture), plus the audit-row
 * readers the S3 tests share.
 */
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;
export const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

export async function moneyFixture(sql: postgres.Sql, hint: string) {
  const code = uid(`t402s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const adminId = await mk('Admin', 'admin');
  const staffId = await mk('Staff', 'staff');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: managerId });

  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in ('1110', '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${by.get('1110')!}, ${storeId}, '500000.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', '500000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actorOf(orgId, managerId);
  const staff = actorOf(orgId, staffId);
  const supplier = await asOrgOn(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
  return {
    orgId, storeId, managerId, adminId, staffId, manager, staff, admin: actorOf(orgId, adminId),
    drawerId: drawer!.id, categoryId: category!.id, supplierId: supplier.id,
  };
}
export type MoneyFx = Awaited<ReturnType<typeof moneyFixture>>;

async function receiptFile(sql: postgres.Sql, f: MoneyFx): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
    returning id`;
  return row!.id;
}

/** An invoice logged by STAFF and left pending (a manager verifies it: two people). */
export async function pendingInvoice(sql: postgres.Sql, f: MoneyFx, totalAmount: string): Promise<string> {
  const fileId = await receiptFile(sql, f);
  const created = await asOrgOn(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, { storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount, receiptFileId: fileId }),
  );
  return created.id;
}

/** A DRAFT cash expense against an invoice, by staff (the draft path). */
export async function draftExpense(f: MoneyFx, invoiceId: string, amount: string, particulars = 'Stock purchase') {
  return asOrgOn(f.orgId, (tx) =>
    createExpense(tx, f.staff, {
      storeId: f.storeId, businessDate: '', supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId,
      particulars, payments: [{ method: 'cash', amount, moneyAccountId: f.drawerId }],
    }),
  );
}

export interface AuditRow {
  id: string;
  action: string;
  store_id: string | null;
  actor_person_id: string | null;
  entity: string;
  entity_id: string;
  category: string;
  sensitivity: string;
  retention_class: string;
  source: string;
  device_id: string | null;
  uploaded_by_person_id: string | null;
  clock_suspect: boolean;
  occurred_at: Date;
  recorded_at: Date;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  redacted_keys: string[];
}
export const auditRows = (sql: postgres.Sql, orgId: string, action: string, entityId?: string) =>
  entityId
    ? sql<AuditRow[]>`select * from audit_log where org_id = ${orgId} and action = ${action} and entity_id = ${entityId} order by recorded_at, id`
    : sql<AuditRow[]>`select * from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at, id`;
