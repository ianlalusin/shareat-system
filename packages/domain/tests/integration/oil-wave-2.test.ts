import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-213 — OIL wave 2, the operational detectors. `docs/tasks/213-oil-wave-2-operational-detectors.md`.
 *
 * ⭐ Same invariant as T-135: every kind gets a test that makes its condition true and proves it
 * fires, AND a test proving it stays quiet otherwise.
 *
 * Two of the eight are corrected from the phase-6 plan's original one-line sketches against the
 * real schema — `expenseCategoryUnpostable` and `expenseInvoiceVoidedAfterLink` — see the task
 * spec for why. `expenseInvoiceVoidedAfterLink`'s "fires" fixture deliberately writes the voided
 * status with a raw UPDATE rather than through `voidInvoice`, because `voidInvoice` itself cascades
 * to void every linked expense atomically — this detector exists as insurance against exactly that
 * invariant breaking some other way, the same reason `trialBalanceDrift` exists despite per-entry
 * balance already being enforced by a CHECK.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, findingsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { postEntry } from '../../src/ledger/post-entry';

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

interface Fixture {
  orgId: string;
  storeId: string;
  staffId: string;
  adminId: string;
  locationId: string;
}

/** One org, one store, a chart of accounts, an open 2026-01 period, one operating location. */
async function fixture(hint: string): Promise<Fixture> {
  const code = uid(`oil2-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [staff] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [type] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'MAIN', 'Main', ${type!.id}, 'operating', true, ${staff!.id})
    returning id`;
  return { orgId, storeId, staffId: staff!.id, adminId: admin!.id, locationId: loc!.id };
}

/** A verified supplier invoice, and the expense linking it — everything expenseCategoryUnpostable
 *  and expenseInvoiceVoidedAfterLink need, without exercising createExpense/verifyInvoice's own
 *  business rules (segregation of duties, photo evidence) — this file tests the DETECTOR, not AP. */
async function expenseAgainstVerifiedInvoice(
  f: Fixture,
  opts: { businessDate: string; accountCode: string | null },
): Promise<{ expenseId: string; invoiceId: string; categoryId: string }> {
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.staffId}) returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices
      (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
       attested_supplier, attested_invoice, attested_items, attested_price, created_by)
    values (${f.orgId}, ${f.storeId}, ${supplier!.id}, ${opts.businessDate}, '500.00', 'verified',
      ${f.adminId}, now(), true, true, true, true, ${f.staffId})
    returning id`;
  const [category] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${f.orgId}, 'OPEX', ${uid('cat')}, ${opts.accountCode})
    returning id`;
  const [expense] = await sql<{ id: string }[]>`
    insert into expenses
      (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id,
       particulars, status, created_by)
    values (${f.orgId}, ${f.storeId}, ${opts.businessDate}, '500.00', ${category!.id}, ${supplier!.id},
      ${invoice!.id}, 'fixture expense', 'draft', ${f.staffId})
    returning id`;
  return { expenseId: expense!.id, invoiceId: invoice!.id, categoryId: category!.id };
}

/** The photo gate. `storage_path` must match `^orgs/{uuid}/` — the schema checks the shape. */
async function proofFile(f: Fixture): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${f.orgId}, ${'orgs/' + f.orgId + '/' + uid('proof') + '.jpg'}, 'image/jpeg', 1024, 'abc123', 'receipt_photo', ${f.staffId})
    returning id`;
  return file!.id;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// -------------------------------------------------------------------------------------
describe('T-213 salesDayUnposted', () => {
  it('fires on a POS-sourced day still open past the threshold', async () => {
    const f = await fixture('sdu-fire');
    await sql`
      insert into sales_days
        (org_id, store_id, business_date, status, pos_sourced, pos_sourced_at,
         total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', 'open', true, now(), '100.00', '100.00', '0.00', ${f.staffId})`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.salesDayUnposted(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('salesDayUnposted');
  });

  it('stays silent once the day is verified', async () => {
    const f = await fixture('sdu-quiet');
    await sql`
      insert into sales_days
        (org_id, store_id, business_date, status, pos_sourced, pos_sourced_at,
         total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', 'verified', true, now(), '100.00', '100.00', '0.00', ${f.staffId})`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.salesDayUnposted(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 expenseCategoryUnpostable', () => {
  it('fires on an old draft whose category has no mapped account', async () => {
    const f = await fixture('ecu-fire');
    await expenseAgainstVerifiedInvoice(f, { businessDate: '2026-01-01', accountCode: null });
    const found = await asOrg(f.orgId, (tx) => findingsRepo.expenseCategoryUnpostable(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('expenseCategoryUnpostable');
  });

  it('stays silent once the category has a mapped account', async () => {
    const f = await fixture('ecu-quiet');
    await expenseAgainstVerifiedInvoice(f, { businessDate: '2026-01-01', accountCode: '6900' });
    const found = await asOrg(f.orgId, (tx) => findingsRepo.expenseCategoryUnpostable(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 expenseInvoiceVoidedAfterLink', () => {
  it('fires when a linked invoice is voided out from under a live expense', async () => {
    const f = await fixture('eiv-fire');
    const { invoiceId } = await expenseAgainstVerifiedInvoice(f, {
      businessDate: '2026-01-01',
      accountCode: '6900',
    });
    // ⚠️ Deliberately a raw UPDATE, not voidInvoice — see this file's header comment.
    await sql`update supplier_invoices set status = 'voided', voided_by = ${f.adminId}, voided_at = now(),
      void_reason = 'fixture' where id = ${invoiceId}`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.expenseInvoiceVoidedAfterLink(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('expenseInvoiceVoidedAfterLink');
  });

  it('stays silent while the invoice stands verified', async () => {
    const f = await fixture('eiv-quiet');
    await expenseAgainstVerifiedInvoice(f, { businessDate: '2026-01-01', accountCode: '6900' });
    const found = await asOrg(f.orgId, (tx) => findingsRepo.expenseInvoiceVoidedAfterLink(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 receiptPriceSpike', () => {
  async function deliveryWithLine(
    f: Fixture,
    itemId: string,
    supplierId: string,
    deliveredOn: string,
    unitCost: string,
  ): Promise<void> {
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, status, received_at, received_by, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${supplierId}, ${deliveredOn}, ${await proofFile(f)}, 'received', now(), ${f.staffId}, ${f.staffId})
      returning id`;
    await sql`
      insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost)
      values (${d!.id}, '1', ${itemId}, '10', '10', 'kg', '1', ${unitCost})`;
  }

  it('fires when a receipt costs well above the trailing median', async () => {
    const f = await fixture('rps-fire');
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.staffId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('item')}, 'Pork', 'raw_material', 'kg', ${f.staffId}) returning id`;
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      await deliveryWithLine(f, item!.id, supplier!.id, day, '100.0000');
    }
    await deliveryWithLine(f, item!.id, supplier!.id, '2026-01-10', '500.0000');
    const found = await asOrg(f.orgId, (tx) => findingsRepo.receiptPriceSpike(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('receiptPriceSpike');
  });

  it('stays silent when costs are stable', async () => {
    const f = await fixture('rps-quiet');
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.staffId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('item')}, 'Pork', 'raw_material', 'kg', ${f.staffId}) returning id`;
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      await deliveryWithLine(f, item!.id, supplier!.id, day, '100.0000');
    }
    const found = await asOrg(f.orgId, (tx) => findingsRepo.receiptPriceSpike(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 newVendorFirstPurchase', () => {
  it('fires on a supplier’s first received delivery', async () => {
    const f = await fixture('nvf-fire');
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.staffId}) returning id`;
    await sql`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, status, received_at, received_by, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${supplier!.id}, '2026-01-05', ${await proofFile(f)}, 'received', now(), ${f.staffId}, ${f.staffId})`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.newVendorFirstPurchase(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('newVendorFirstPurchase');
  });

  it('stays silent on a supplier’s second delivery', async () => {
    const f = await fixture('nvf-quiet');
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.staffId}) returning id`;
    await sql`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, status, received_at, received_by, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${supplier!.id}, '2026-01-01', ${await proofFile(f)}, 'received', now(), ${f.staffId}, ${f.staffId})`;
    await sql`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, status, received_at, received_by, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${supplier!.id}, '2026-01-05', ${await proofFile(f)}, 'received', now(), ${f.staffId}, ${f.staffId})`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.newVendorFirstPurchase(tx, f.orgId));
    // Only the FIRST delivery is the finding — the second must not also appear.
    const forThisSupplier = found.filter((r) => r.key.length > 0);
    expect(forThisSupplier.length).toBeLessThanOrEqual(1);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 advanceUnliquidated', () => {
  async function post(f: Fixture, legs: { code: string; debit?: string; credit?: string; party?: string }[], key: string) {
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: '2026-01-10',
        sourceType: 'manual_journal',
        sourceId: key,
        idempotencyKey: key,
        memo: 'fixture',
        postedBy: f.staffId,
        lines: legs.map((l) => ({
          accountCode: l.code,
          storeId: f.storeId,
          ...(l.debit ? { debit: l.debit } : {}),
          ...(l.credit ? { credit: l.credit } : {}),
          ...(l.party ? { partyType: 'employee', partyId: l.party } : {}),
        })),
      }),
    );
  }

  it('fires on an open 1230 balance not sourced from a cash_requests row', async () => {
    const f = await fixture('adv-fire');
    // A salary-advance-shaped posting — 1230 debited directly, no cash_requests row at all.
    await post(f, [{ code: '1230', debit: '3000.00', party: f.staffId }, { code: '1110', credit: '3000.00' }], uid('adv'));
    const found = await asOrg(f.orgId, (tx) => findingsRepo.advanceUnliquidated(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('advanceUnliquidated');
  });

  it('stays silent once the balance is repaid to zero', async () => {
    const f = await fixture('adv-quiet');
    await post(f, [{ code: '1230', debit: '3000.00', party: f.staffId }, { code: '1110', credit: '3000.00' }], uid('adv'));
    await post(f, [{ code: '1110', debit: '3000.00' }, { code: '1230', credit: '3000.00', party: f.staffId }], uid('adv-repay'));
    const found = await asOrg(f.orgId, (tx) => findingsRepo.advanceUnliquidated(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 usageRecordMissing', () => {
  it('fires on a verified day with no POS mapping and no usage record at all', async () => {
    const f = await fixture('urm-fire');
    await sql`
      insert into sales_days
        (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', 'verified', '100.00', '100.00', '0.00', ${f.staffId})`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.usageRecordMissing(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('usageRecordMissing');
  });

  it('stays silent once any usage record exists for that day', async () => {
    const f = await fixture('urm-quiet');
    await sql`
      insert into sales_days
        (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', 'verified', '100.00', '100.00', '0.00', ${f.staffId})`;
    await sql`
      insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, created_by)
      values (${f.orgId}, ${f.storeId}, ${f.locationId}, 'usage', '2026-01-01', ${f.staffId})`;
    const found = await asOrg(f.orgId, (tx) => findingsRepo.usageRecordMissing(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------
describe('T-213 meatSlabStale', () => {
  async function slabLayer(f: Fixture, itemId: string, remaining: string, receivedAt: string): Promise<void> {
    const [mv] = await sql<{ id: string }[]>`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${f.orgId}, ${f.storeId}, ${f.locationId}, ${itemId}, ${receivedAt}, '20', 'receipt', 'fixture', ${itemId}, ${f.staffId})
      returning id`;
    await sql`
      insert into stock_layers (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id, movement_id)
      values (${f.orgId}, ${f.storeId}, ${itemId}, ${receivedAt}, '20', '300.0000', ${remaining}, 'delivery', ${itemId}, ${mv!.id})`;
  }

  it('fires on an open meat_slab layer past the freshness window', async () => {
    const f = await fixture('mss-fire');
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('item')}, 'Pork Slab', 'meat_slab', 'kg', ${f.staffId}) returning id`;
    await slabLayer(f, item!.id, '20', '2025-12-01T00:00:00Z');
    const found = await asOrg(f.orgId, (tx) => findingsRepo.meatSlabStale(tx, f.orgId));
    expect(found.map((r) => r.kind)).toContain('meatSlabStale');
  });

  it('stays silent once the layer is fully consumed', async () => {
    const f = await fixture('mss-quiet');
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('item')}, 'Pork Slab', 'meat_slab', 'kg', ${f.staffId}) returning id`;
    await slabLayer(f, item!.id, '0', '2025-12-01T00:00:00Z');
    const found = await asOrg(f.orgId, (tx) => findingsRepo.meatSlabStale(tx, f.orgId));
    expect(found).toHaveLength(0);
  });
});
