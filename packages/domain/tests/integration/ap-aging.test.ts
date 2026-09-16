import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-209b — docs/tasks/209-reporting-read-model-and-statements.md.
 *
 * The regression case this file exists to carry: `getApAgingReport`'s bucketed total and its
 * independent control-account balance (`apRepo.orgAgingTotal`, summed straight off
 * `journal_lines`) must reconcile to the centavo, and must keep reconciling as the underlying
 * facts change (a payment), not merely agree once at a hand-picked moment.
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
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createSupplier,
  recordInvoice,
  verifyInvoice,
  recordExpenseForInvoice,
  recordPayment,
  getApAgingReport,
} from '@shareat/domain';
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
  const code = uid(`apaging-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  const [store2] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint + '2')}, ${`Store ${hint} 2`}) returning id
  `;
  const store2Id = store2!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id
  `;
  const [staff] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  for (const s of [storeId, store2Id]) {
    await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${s})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${s})`;
  }
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${uid('SE')}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: staff!.id, setBy: manager!.id,
  });
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  const category = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'
  `;
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, actor(orgId, manager!.id), { name: `${hint} Supplier` }));

  return {
    orgId, storeId, store2Id, managerId: manager!.id, staffId: staff!.id,
    manager: actor(orgId, manager!.id), staff: actor(orgId, staff!.id),
    drawerId: drawer!.id, categoryId: category[0]!.id, supplierId: supplier.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id
  `;
  return row!.id;
}

/** Records, verifies, and credit-expenses one invoice at the given store, returns its expense id. */
async function creditInvoiceAt(
  f: Fixture,
  storeId: string,
  amount: string,
  opts: { invoiceDate?: string; dueDate?: string | null } = {},
): Promise<{ invoiceId: string; expenseId: string }> {
  const fileId = await receiptFile(f.orgId, storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId,
      supplierId: f.supplierId,
      invoiceDate: opts.invoiceDate ?? '2026-01-01',
      dueDate: opts.dueDate ?? null,
      totalAmount: amount,
      receiptFileId: fileId,
    }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId,
      supplierId: f.supplierId,
      supplierInvoiceId: created.id,
      categoryId: f.categoryId,
      particulars: 'Stock purchase',
      payments: [{ method: 'credit', amount }],
    }),
  );
  return { invoiceId: created.id, expenseId: exp.expenseId };
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getApAgingReport', () => {
  it('reconciles to the control account after an ordinary credit posting', async () => {
    const f = await fixture('basic');
    await creditInvoiceAt(f, f.storeId, '900.00', { invoiceDate: '2026-01-01', dueDate: '2026-01-01' });

    const report = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    expect(report.reconciles, `total (${report.totals.total}) must equal control balance (${report.controlBalance})`).toBe(true);
    expect(report.controlBalance).toBe('900.00');
    expect(report.totals.total).toBe('900.00');
  });

  it('places a 45-day-old item in the 31-60 bucket, matching apRepo.aging()', async () => {
    const f = await fixture('bucket');
    await creditInvoiceAt(f, f.storeId, '900.00', { invoiceDate: '2026-01-01', dueDate: '2026-01-01' });

    const report = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    const row = report.rows.find((r) => r.supplierId === f.supplierId);
    expect(row?.d31to60).toBe('900.00');
    expect(row?.current).toBe('0.00');
    expect(row?.total).toBe('900.00');
  });

  it('totals.total equals the sum of every row and every bucket column', async () => {
    const f = await fixture('sum');
    await creditInvoiceAt(f, f.storeId, '900.00', { invoiceDate: '2026-01-01', dueDate: '2026-01-01' });
    await creditInvoiceAt(f, f.storeId, '400.00', { invoiceDate: '2026-02-10', dueDate: '2026-02-10' });

    const report = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    const rowSum = report.rows.reduce((t, r) => t + Number(r.total), 0).toFixed(2);
    const bucketSum = (
      Number(report.totals.current) +
      Number(report.totals.d1to30) +
      Number(report.totals.d31to60) +
      Number(report.totals.d61to90) +
      Number(report.totals.d90plus)
    ).toFixed(2);
    expect(report.totals.total).toBe('1300.00');
    expect(report.totals.total).toBe(rowSum);
    expect(report.totals.total).toBe(bucketSum);
  });

  it('a partial payment reduces totals.total and controlBalance together', async () => {
    const f = await fixture('partial');
    const { expenseId } = await creditInvoiceAt(f, f.storeId, '1000.00', { invoiceDate: '2026-01-01' });

    const before = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));
    expect(before.totals.total).toBe('1000.00');
    expect(before.reconciles).toBe(true);

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId,
        supplierId: f.supplierId,
        businessDate: '2026-02-01',
        amount: '400.00',
        moneyAccountId: f.drawerId,
        allocations: [{ expenseId, amountApplied: '400.00' }],
      }),
    );

    const after = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));
    expect(after.totals.total).toBe('600.00');
    expect(after.controlBalance).toBe('600.00');
    expect(after.reconciles, 'both independent paths must move together, not just agree at zero').toBe(true);
  });

  it('storeId narrows both the rows and the control balance to that store alone', async () => {
    const f = await fixture('store');
    await creditInvoiceAt(f, f.storeId, '500.00', { invoiceDate: '2026-01-01' });
    await creditInvoiceAt(f, f.store2Id, '300.00', { invoiceDate: '2026-01-01' });

    const store1Report = await asOrg(f.orgId, (tx) =>
      getApAgingReport(tx, { orgId: f.orgId, storeId: f.storeId, asOfDate: '2026-02-15' }),
    );
    const orgReport = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    expect(store1Report.totals.total).toBe('500.00');
    expect(store1Report.controlBalance).toBe('500.00');
    expect(store1Report.reconciles).toBe(true);
    expect(store1Report.rows.every((r) => r.storeId === f.storeId)).toBe(true);
    expect(orgReport.totals.total).toBe('800.00');
    expect(orgReport.controlBalance).toBe('800.00');
  });

  it('no open items produces a reconciling empty report, not a crash', async () => {
    const f = await fixture('empty');
    const report = await asOrg(f.orgId, (tx) => getApAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));
    expect(report.rows).toEqual([]);
    expect(report.totals.total).toBe('0.00');
    expect(report.controlBalance).toBe('0.00');
    expect(report.reconciles).toBe(true);
  });
});
