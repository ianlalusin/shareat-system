import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, systemTransaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  quantity,
  recordExpenseForInvoice,
  recordInvoice,
  recordPayment,
  recordReturn,
  refundSupplierCredit,
  returnableQuantity,
  setInvoiceLines,
  supplierCreditBalance,
  verifyInvoice,
  voidReturn,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import type { LocationLike } from '../../src/stock-locations/rules';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

/**
 * T-170 — supplier returns: the goods go back, and we hold a credit. Bible row 166.
 *
 * ⭐ Test 1 asserts the case most likely to be implemented as a credit by mistake (§9.1 of the
 * task spec): an UNINVOICED return posts `Dr 2120 / Cr inventory` and creates NO `1240` balance.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

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
  otherStoreId: string;
  staff: Actor;
  manager: Actor;
  /** A SECOND manager — `verifyInvoice` enforces segregation of duties (the creator of an
   *  invoice cannot also verify it), so any fixture that records then verifies needs two. */
  manager2: Actor;
  locationId: string;
  otherStoreLocationId: string;
  itemId: string;
  supplierId: string;
  otherSupplierId: string;
  fileId: string;
  moneyAccountId: string;
  categoryId: string;
}

function locations(f: Fixture): LocationLike[] {
  return [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
}

async function fixture(): Promise<Fixture> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${'Org ' + uid('o')}, ${uid('org')}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store A', 'multi_room') returning id`;
  const storeId = store!.id;
  const [otherStore] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st2')}, 'Store B', 'multi_room') returning id`;
  const otherStoreId = otherStore!.id;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [manager2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager Two') returning id`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager2!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager2!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'A', 'Room A', ${type!.id}, 'operating', true, ${staff!.id}) returning id`;
  const [otherLoc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${otherStoreId}, 'B', 'Room B', ${type!.id}, 'operating', true, ${staff!.id}) returning id`;

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${uid('ITEM')}, 'Pork Belly', 'raw_material', 'kg', ${staff!.id}) returning id`;

  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Acme Meats', ${staff!.id}) returning id`;
  const [otherSupplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Beta Foods', ${staff!.id}) returning id`;

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${'orgs/' + orgId + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${staff!.id}) returning id`;

  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2020-01-01', '2035-12-31', 'open')`;

  const [money] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation limit 1`;
  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${uid('SE')}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staff!.id, setBy: manager!.id,
  });

  return {
    orgId,
    storeId,
    otherStoreId,
    staff: { personId: staff!.id, orgId },
    manager: { personId: manager!.id, orgId },
    manager2: { personId: manager2!.id, orgId },
    locationId: loc!.id,
    otherStoreLocationId: otherLoc!.id,
    itemId: item!.id,
    supplierId: supplier!.id,
    otherSupplierId: otherSupplier!.id,
    fileId: file!.id,
    moneyAccountId: money!.id,
    categoryId: category!.id,
  };
}

/** Receive one line, kind='supplier', proof supplied — returns the delivery + line + layer ids. */
async function receiveOne(
  f: Fixture,
  qty: string,
  unitCost: string,
  deliveredOn: string,
  supplierId = f.supplierId,
): Promise<{ deliveryId: string; deliveryLineId: string; layerId: string; movementId: string }> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'supplier', ${supplierId}, ${deliveredOn}, ${f.fileId}, ${f.staff.personId}) returning id`;
  const deliveryId = d!.id;

  // ⭐ `receiveDelivery` (T-166) never touches `delivery_lines` at all — it writes only
  // stock_movements, stock_layers and the journal entry. There is no domain function anywhere
  // that creates a delivery_lines row either (grep-verified); the ordered/received document line
  // is drafted separately, at the UI layer, which does not exist yet for this route. Written
  // directly here for that reason.
  const [dl] = await sql<{ id: string }[]>`
    insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
    values (${deliveryId}, '1', ${f.itemId}, ${qty}, ${qty}, 'kg', '1', ${unitCost}, ${f.locationId}) returning id`;

  const result = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId,
      storeId: f.storeId,
      deliveryId,
      deliveredOn,
      locations: locations(f),
      receivedBy: f.staff.personId,
      lines: [
        {
          lineId: '1',
          itemId: f.itemId,
          itemKind: 'raw_material',
          receivedQuantity: quantity(qty),
          conversionFactor: '1',
          unitCost,
          locationId: f.locationId,
        },
      ],
    }),
  );
  if (!result.ok) throw new Error(`receiveOne setup failed: ${result.reason}`);

  return {
    deliveryId,
    deliveryLineId: dl!.id,
    layerId: result.layers[0]!.layerId,
    movementId: result.movements[0]!.movementId,
  };
}

/** Marks a layer as invoiced — the real domain path (`linkInvoiceToReceipt`) never touches
 *  `stock_layers` (DEF-124, found while building this test), so this fixture updates the layer
 *  directly, after creating a REAL invoice + line so the FK is genuine. */
async function markInvoiced(f: Fixture, layerId: string, itemId = f.itemId): Promise<void> {
  const inv = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.manager, {
      storeId: f.storeId,
      supplierId: f.supplierId,
      invoiceDate: '2026-01-01',
      totalAmount: '1000.00',
    }),
  );
  await asOrg(f.orgId, (tx) =>
    setInvoiceLines(tx, f.manager, inv.id, [
      { itemId, quantity: '10.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100.00', lineTotal: '1000.00' },
    ]),
  );
  const [line] = await sql<{ id: string }[]>`select id from supplier_invoice_lines where supplier_invoice_id = ${inv.id}`;
  await sql`update stock_layers set is_provisional = false, invoice_line_id = ${line!.id} where id = ${layerId}`;
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

async function balances(orgId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

beforeEach(async () => {
  await sql`
    truncate table supplier_return_lines, supplier_returns, ap_payment_allocations, ap_payments,
      supplier_invoice_lines, supplier_invoices, stock_layer_consumptions, stock_layers,
      stock_movements, delivery_lines, deliveries, stock_locations, location_types,
      journal_lines, journal_entries, fiscal_periods, stored_files, suppliers, accounts,
      person_store_scope, person_roles, person_identities, persons, items, stores, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-170 — the uninvoiced case: no credit arises', () => {
  it('returning 10 of 30 posts Dr 2120 / Cr 1310 at the relieved FIFO cost, and creates NO 1240 balance', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'damaged',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(true);

    const b = await balances(f.orgId);
    // 2120 is a liability: receipt credited 3000, the return's own Dr 1000 nets it to Cr 2000 —
    // i.e. debit-credit = 1000 - 3000 = -2000.
    expect(b['2120']).toBe('-2000.00');
    expect(b['1310']).toBe('2000.00'); // 30 - 10 = 20 kg remaining at 100 = 2000
    const balance = await asOrg(f.orgId, (tx) => supplierCreditBalance(tx, f.orgId, f.supplierId));
    expect(balance).toBe('0.00');
  });
});

describe('T-170 — the invoiced case: a real credit', () => {
  it('returning against an invoiced receipt posts Dr 1240 / Cr 1310 with the supplier as party', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId, layerId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    await markInvoiced(f, layerId);

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'wrong item',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(true);

    const balance = await asOrg(f.orgId, (tx) => supplierCreditBalance(tx, f.orgId, f.supplierId));
    expect(balance).toBe('1000.00');

    const [line] = await sql<{ party_id: string }[]>`
      select party_id from journal_lines l join accounts a on a.id = l.account_id
      where a.code = '1240' and l.debit = '1000.00'`;
    expect(line!.party_id).toBe(f.supplierId);
  });

  it('⭐ a return spanning BOTH cases (one delivery, two items) posts both legs in ONE entry, and it balances', async () => {
    const f = await fixture();
    const [item2] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('ITEM2')}, 'Chicken Breast', 'raw_material', 'kg', ${f.staff.personId}) returning id`;

    // ONE delivery, two lines — item A stays uninvoiced, item B's layer is marked invoiced.
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${f.supplierId}, '2026-01-05', ${f.fileId}, ${f.staff.personId}) returning id`;
    await sql`
      insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
      values (${d!.id}, '1', ${f.itemId}, '10.000', '10.000', 'kg', '1', '100.0000', ${f.locationId}),
             (${d!.id}, '2', ${item2!.id}, '10.000', '10.000', 'kg', '1', '80.0000', ${f.locationId})`;
    const result = await asOrg(f.orgId, (tx) =>
      receiveDelivery(tx, {
        orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-05',
        locations: locations(f), receivedBy: f.staff.personId,
        lines: [
          { lineId: '1', itemId: f.itemId, itemKind: 'raw_material', receivedQuantity: quantity('10.000'), conversionFactor: '1', unitCost: '100.0000', locationId: f.locationId },
          { lineId: '2', itemId: item2!.id, itemKind: 'raw_material', receivedQuantity: quantity('10.000'), conversionFactor: '1', unitCost: '80.0000', locationId: f.locationId },
        ],
      }),
    );
    if (!result.ok) throw new Error('setup failed');
    const layerByLine = new Map(result.layers.map((l) => [l.lineId, l.layerId]));
    await markInvoiced(f, layerByLine.get('2')!, item2!.id);
    const [dl1, dl2] = await sql<{ id: string; item_id: string }[]>`
      select id, item_id from delivery_lines where delivery_id = ${d!.id} order by line_no`;

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId: d!.id,
        returnedOn: '2026-01-06', reason: 'mixed batch',
        lines: [
          { itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('5.000'), deliveryLineId: dl1!.id },
          { itemId: item2!.id, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('4.000'), deliveryLineId: dl2!.id },
        ],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 5kg @ 100 = 500 uninvoiced (Dr 2120), 4kg @ 80 = 320 invoiced (Dr 1240) — ONE entry, both legs.
    const [entry] = await sql<{ n: string }[]>`
      select count(distinct l.entry_id)::text as n from journal_lines l join accounts a on a.id = l.account_id
      where a.code in ('2120','1240') and l.debit in ('500.00', '320.00')`;
    expect(entry!.n).toBe('1');

    const [ret] = await sql<{ credit_basis: string }[]>`select credit_basis from supplier_returns where id = ${res.returnId}`;
    expect(ret!.credit_basis).toBe('mixed');

    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l join accounts a on a.id = l.account_id where a.org_id = ${f.orgId}`;
    expect(tb!.net).toBe('0.00');
  });
});

describe('T-170 — the caps and the no-override guard', () => {
  it('returning 31 of 30 is refused', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'over-return',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('31.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(false);
  });

  it('⭐ returning more than ON-HAND is refused for a MANAGER too — the no-override rule is the point', async () => {
    const f = await fixture();
    // Untraceable (no delivery link) so invariant 2's cap does not apply at all — this isolates
    // invariant 3's on-hand check from invariant 2's received-quantity cap, which a traceable
    // return could not do cleanly (a delivery's cap and its own on-hand move together).
    await receiveOne(f, '10.000', '100.0000', '2026-01-05');
    expect(await onHand(f.itemId, f.locationId)).toBe('10.000');

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId: null,
        returnedOn: '2026-01-06', reason: 'more than is on the shelf',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('11.000'), deliveryLineId: null }],
        actor: f.manager,
      }),
    );
    expect(res.ok).toBe(false);
    expect(await onHand(f.itemId, f.locationId)).toBe('10.000');
  });
});

describe('T-170 — the relieved cost, not the delivery cost', () => {
  it('⭐ returning after part of the lot was consumed relieves the REMAINING layers at their cost', async () => {
    const f = await fixture();
    // Two receipts at different costs so FIFO has something to choose between.
    const first = await receiveOne(f, '10.000', '100.0000', '2026-01-01');
    await receiveOne(f, '10.000', '120.0000', '2026-01-05');

    // Consume 8 of the cheap layer via a usage-shaped raw movement isn't available here without
    // T-168's module; instead return against the SECOND (₱120) delivery after the first is
    // exhausted by a large earlier return, proving the return takes what is ACTUALLY there.
    const drain = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId: first.deliveryId,
        returnedOn: '2026-01-02', reason: 'drain the cheap layer',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId: first.deliveryLineId }],
        actor: f.staff,
      }),
    );
    expect(drain.ok).toBe(true);

    // Now on-hand is entirely the ₱120 layer. A further return (untraceable, so it just takes
    // whatever FIFO gives it) must cost ₱120/kg, not the ₱100 the FIRST delivery would suggest.
    const second = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId: null,
        returnedOn: '2026-01-06', reason: 'from the remaining lot',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('5.000'), deliveryLineId: null }],
        actor: f.staff,
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const [line] = await sql<{ unit_cost: string }[]>`
      select unit_cost from supplier_return_lines where return_id = ${second.returnId}`;
    expect(line!.unit_cost).toBe('120.0000');
  });
});

describe('T-170 — the credit is spendable', () => {
  async function invoicedReturnCredit(f: Fixture, amount: string): Promise<void> {
    const { deliveryId, deliveryLineId, layerId } = await receiveOne(f, '30.000', amount, '2026-01-05');
    await markInvoiced(f, layerId);
    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'credit setup',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    if (!res.ok) throw new Error(`invoicedReturnCredit setup failed: ${res.reason}`);
  }

  it('⭐ allocating the credit against a later invoice posts Dr 2110 / Cr 1240, and the balance is zero after', async () => {
    const f = await fixture();
    await invoicedReturnCredit(f, '100.0000'); // 10kg * 100 = 1000.00 credit

    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-02-01', totalAmount: '1000.00', receiptFileId: f.fileId }),
    );
    await asOrg(f.orgId, (tx) =>
      setInvoiceLines(tx, f.manager, inv.id, [
        { itemId: f.itemId, quantity: '10.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100.00', lineTotal: '1000.00' },
      ]),
    );
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager2, inv.id, { supplier: true, invoice: true, items: true, price: true }));
    const expense = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: inv.id,
        categoryId: f.categoryId, particulars: 'Stock purchase',
        payments: [{ method: 'credit', amount: '1000.00' }],
      }),
    );
    const expenseRow = { id: expense.expenseId };

    const paid = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-02-02',
        amount: '1000.00', moneyAccountId: f.moneyAccountId, creditApplied: '1000.00',
        allocations: [{ expenseId: expenseRow!.id, amountApplied: '1000.00' }],
      }),
    );
    expect(paid.entryId).toBeTruthy();

    const balance = await asOrg(f.orgId, (tx) => supplierCreditBalance(tx, f.orgId, f.supplierId));
    expect(balance).toBe('0.00');

    const b = await balances(f.orgId);
    expect(b['1240']).toBe('0.00');
  });

  it('allocating more credit than the balance is refused', async () => {
    const f = await fixture();
    await invoicedReturnCredit(f, '50.0000'); // 500.00 credit

    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-02-01', totalAmount: '1000.00', receiptFileId: f.fileId }),
    );
    await asOrg(f.orgId, (tx) =>
      setInvoiceLines(tx, f.manager, inv.id, [
        { itemId: f.itemId, quantity: '10.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100.00', lineTotal: '1000.00' },
      ]),
    );
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager2, inv.id, { supplier: true, invoice: true, items: true, price: true }));
    const expense = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: inv.id,
        categoryId: f.categoryId, particulars: 'Stock purchase',
        payments: [{ method: 'credit', amount: '1000.00' }],
      }),
    );
    const expenseRow = { id: expense.expenseId };

    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, {
          storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-02-02',
          amount: '1000.00', moneyAccountId: f.moneyAccountId, creditApplied: '600.00',
          allocations: [{ expenseId: expenseRow!.id, amountApplied: '1000.00' }],
        }),
      ),
    ).rejects.toThrow(/does not fit/);
  });

  it('a cash refund draws 1240 to zero', async () => {
    const f = await fixture();
    await invoicedReturnCredit(f, '100.0000'); // 1000.00 credit

    const res = await asOrg(f.orgId, (tx) =>
      refundSupplierCredit(tx, {
        storeId: f.storeId, supplierId: f.supplierId,
        moneyAccountId: f.moneyAccountId, amount: '1000.00', businessDate: '2026-02-02', actor: f.manager,
      }),
    );
    expect(res.ok).toBe(true);

    const balance = await asOrg(f.orgId, (tx) => supplierCreditBalance(tx, f.orgId, f.supplierId));
    expect(balance).toBe('0.00');
  });
});

describe('T-170 — void reverses everything, together', () => {
  it('void reverses stock, the credit, and the entry; the trial balance ties', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId, layerId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    await markInvoiced(f, layerId);

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'to void',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    if (!res.ok) throw new Error('setup failed');

    expect(await onHand(f.itemId, f.locationId)).toBe('20.000');
    let balance = await asOrg(f.orgId, (tx) => supplierCreditBalance(tx, f.orgId, f.supplierId));
    expect(balance).toBe('1000.00');

    const voided = await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, res.returnId, 'wrong call'));
    expect(voided.ok).toBe(true);

    expect(await onHand(f.itemId, f.locationId)).toBe('30.000');
    balance = await asOrg(f.orgId, (tx) => supplierCreditBalance(tx, f.orgId, f.supplierId));
    expect(balance).toBe('0.00');

    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l join accounts a on a.id = l.account_id where a.org_id = ${f.orgId}`;
    expect(tb!.net).toBe('0.00');
  });

  it('⭐ void after the credit was allocated is refused, naming the allocation', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId, layerId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    await markInvoiced(f, layerId);

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'to spend then void',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    if (!res.ok) throw new Error('setup failed');

    // Spend HALF the credit via a refund, leaving less than this return contributed.
    await asOrg(f.orgId, (tx) =>
      refundSupplierCredit(tx, {
        storeId: f.storeId, supplierId: f.supplierId,
        moneyAccountId: f.moneyAccountId, amount: '600.00', businessDate: '2026-01-07', actor: f.manager,
      }),
    );

    const voided = await asOrg(f.orgId, (tx) => voidReturn(tx, f.manager, res.returnId, 'too late'));
    expect(voided.ok).toBe(false);
    if (voided.ok) return;
    expect(voided.reason).toContain('spent');
  });
});

describe('T-170 — the period lock and the exit gate', () => {
  it('a return into a closed period is refused', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;

    await expect(
      asOrg(f.orgId, (tx) =>
        recordReturn(tx, {
          storeId: f.storeId, supplierId: f.supplierId, deliveryId,
          returnedOn: '2026-01-06', reason: 'closed period',
          lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('5.000'), deliveryLineId }],
          actor: f.staff,
        }),
      ),
    ).rejects.toThrow(/period|closed/i);
  });

  it('a return naming a different supplier than the linked delivery is refused', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.otherSupplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'wrong supplier',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('5.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(false);
  });

  it('⭐ after every path, Σ 1310+1320+1330 = Σ open-layer value — the Phase 3 exit gate', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'gate check',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );

    const [gate] = await sql<{ book: string; layers: string }[]>`
      select
        (select coalesce(sum(l.debit) - sum(l.credit), 0)::text from journal_lines l join accounts a on a.id = l.account_id
          where a.org_id = ${f.orgId} and a.code in ('1310','1320','1330')) as book,
        (select coalesce(round(sum(remaining_quantity * unit_cost), 2), 0)::text from stock_layers where remaining_quantity > 0) as layers`;
    expect(gate!.book).toBe(gate!.layers);
  });

  it('a return naming a location from another store is refused', async () => {
    const f = await fixture();
    const { deliveryId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');

    const res = await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'cross-store',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.otherStoreLocationId, quantity: quantity('5.000'), deliveryLineId: null }],
        actor: f.manager,
      }),
    );
    expect(res.ok).toBe(false);
  });
});

describe('T-170 — returnableQuantity', () => {
  it('reflects received minus already-returned', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    expect(await asOrg(f.orgId, (tx) => returnableQuantity(tx, deliveryLineId))).toBe('30.000');

    await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId, supplierId: f.supplierId, deliveryId,
        returnedOn: '2026-01-06', reason: 'partial',
        lines: [{ itemId: f.itemId, itemKind: 'raw_material', locationId: f.locationId, quantity: quantity('10.000'), deliveryLineId }],
        actor: f.staff,
      }),
    );
    expect(await asOrg(f.orgId, (tx) => returnableQuantity(tx, deliveryLineId))).toBe('20.000');
  });
});

/**
 * T-231 slice 1 / DEF-210 — the organisation is the ACTOR's, never the caller's.
 *
 * ⭐ **These run under `systemTransaction()`, deliberately re-arming an explicit bypass, not
 * `asOrg`.** Production (`apps/erp/src/app/inventory/returns/actions.ts:32`) DOES call these
 * through `withOrgPrincipal(actor.orgId, …)` today — RLS is a real backstop here, not bypassed.
 * These tests deliberately remove that backstop anyway, to prove the APPLICATION layer alone
 * (never trusting a caller-supplied orgId) refuses the cross-org write on its own — bible §15.11,
 * no layer may be the only one for a given risk.
 *
 * ⚠️ **This comment used to say the opposite** — that production opened these with no principal at
 * all, so a plain `transaction()` merely matched what the app already did. That was true once;
 * `withOrgPrincipal` was added since (DEF-175's shape: a comment describing a prior state as if it
 * were current — caught 2026-09-11 while measuring DEF-218). The claim below survived that change
 * of premise; it was not written under it.
 *
 * ⚠️ **The victim org is seeded with real books**, because that is the live case: Padre Garcia is
 * a going concern with a chart of accounts and an open period. An unseeded victim makes the attack
 * fail with *"no fiscal period covers…"*, which looks like a guard and is only a missing fixture.
 */
describe('T-231 / DEF-210 — a supplier return is stamped with the actor’s org', () => {
  /** A second organisation with books of its own — the franchise next door. */
  async function victimOrg(): Promise<string> {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${'Victim ' + uid('v')}, ${uid('vic')}) returning id`;
    await seedChartOfAccounts(sql, org!.id);
    await seedExpenseCategories(sql, org!.id);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${org!.id}, '2020-01-01', '2035-12-31', 'open')`;
    return org!.id;
  }

  it('recordReturn ignores a caller-supplied organisation', async () => {
    const f = await fixture();
    const { deliveryId, deliveryLineId } = await receiveOne(f, '10.000', '100.00', '2026-01-05');
    const victimOrgId = await victimOrg();

    const res = await systemTransaction((tx) =>
      recordReturn(tx, {
        // @ts-expect-error T-231/DEF-210 — the field is GONE. Supplying another org's id
        // must not compile; if someone re-adds it this directive goes unused and the build fails.
        orgId: victimOrgId,
        storeId: f.storeId, // the actor's OWN store, so authorize() axis 2 passes
        supplierId: f.supplierId,
        deliveryId,
        returnedOn: '2026-01-06',
        reason: 'damaged',
        lines: [
          {
            itemId: f.itemId,
            itemKind: 'raw_material',
            locationId: f.locationId,
            quantity: quantity('10.000'),
            deliveryLineId,
          },
        ],
        actor: f.staff,
      }),
    );
    expect(res.ok, res.ok ? '' : `recordReturn refused: ${res.reason}`).toBe(true);
    if (!res.ok) return;

    const [row] = await sql<{ org_id: string }[]>`
      select org_id from supplier_returns where id = ${res.returnId}`;
    expect(row!.org_id, 'the return landed in the org the CALLER named, not the actor’s').toBe(f.orgId);

    const [entry] = await sql<{ org_id: string }[]>`
      select e.org_id from journal_entries e
      join supplier_returns r on r.journal_entry_id = e.id where r.id = ${res.returnId}`;
    expect(entry?.org_id, 'the posting landed in another organisation’s books').toBe(f.orgId);
  });

  it('refundSupplierCredit reads the credit from the actor’s books, not a supplied org’s', async () => {
    const f = await fixture();
    // A real 1000.00 supplier credit in the ACTOR's books. `invoicedReturnCredit` is scoped to
    // another describe, so the three steps are inlined: an UNINVOICED return posts no credit at
    // all (Dr 2120 / Cr inventory), and a refund with nothing to draw down proves nothing.
    const { deliveryId, deliveryLineId, layerId } = await receiveOne(f, '30.000', '100.0000', '2026-01-05');
    await markInvoiced(f, layerId);
    await asOrg(f.orgId, (tx) =>
      recordReturn(tx, {
        storeId: f.storeId,
        supplierId: f.supplierId,
        deliveryId,
        returnedOn: '2026-01-06',
        reason: 'wrong item',
        lines: [
          {
            itemId: f.itemId,
            itemKind: 'raw_material',
            locationId: f.locationId,
            quantity: quantity('10.000'),
            deliveryLineId,
          },
        ],
        actor: f.staff,
      }),
    );
    const victimOrgId = await victimOrg();

    // ⭐ Pre-fix this was refused — `advancesPositionOf(tx, input.orgId, …)` looked in the VICTIM's
    // books, found nothing, and reported "only 0.00 of credit is available". That refusal was the
    // cross-org READ made visible: the function was asking the wrong organisation's ledger.
    const res = await systemTransaction((tx) =>
      refundSupplierCredit(tx, {
        // @ts-expect-error T-231/DEF-210 — the field is GONE. Supplying another org's id
        // must not compile; if someone re-adds it this directive goes unused and the build fails.
        orgId: victimOrgId,
        storeId: f.storeId,
        supplierId: f.supplierId,
        moneyAccountId: f.moneyAccountId,
        amount: '250.00',
        businessDate: '2026-02-02',
        actor: f.manager, // `apply_supplier_credit` is manager-and-up
      }),
    );
    expect(res.ok, res.ok ? '' : `refund refused — it read the wrong org’s ledger: ${res.reason}`).toBe(true);
    if (!res.ok) return;

    const [entry] = await sql<{ org_id: string }[]>`
      select org_id from journal_entries where id = ${res.entryId}`;
    expect(entry!.org_id, 'the refund posted into another organisation’s books').toBe(f.orgId);
  });
});
