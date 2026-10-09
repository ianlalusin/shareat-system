import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-372 S3 (DEF-127) — outbound freight on an INTERNAL trade order posts at RECEIPT
 * (`confirmReceipt`), never at dispatch: Dr 6630 / Cr 2150 on the branch, Dr 1250 / Cr 6630 on the
 * commissary (R9) — a SECOND entry beside the goods transfer, keyed
 * `trade_order:<id>:receipt-freight`. `docs/tasks/372-def-511-prepared-order-stays-prepared.md`
 * §S3, legs F1-F9. Fixture shape copied from `trade.test.ts` (`fixture`, `wholesaleItem`, `stock`,
 * `mapSelf`) — same convention every other T-372/T-366/T-367 slice test uses.
 *
 * ⛔ TESTER, not BUILDER. `postInternalFreight` does not exist yet, so every leg reaches it through
 * the existing public surface (`receiveTradeOrder`) — the freight entry is looked up by its OWN
 * idempotency key directly (`trade_order:<id>:receipt-freight`), never through a
 * `received.freightEntryId` field that is not in `ReceiveTradeOrderResult` yet (F4 is the one leg
 * that specifically needs that field; it reaches it through a narrow, documented cast so typecheck
 * stays 0 without pretending the field exists everywhere else).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, setStoreSellability } from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Fixture — copied shape, trade.test.ts. `storeId` is the commissary (seller); `otherStoreId` is
// the branch (the internal customer's counterparty store, the one that RECEIVES).
// -----------------------------------------------------------------------------------------------

async function fixture(hint: string) {
  const code = uid(`t372f-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('com');
  const otherStoreId = await mkStore('br');

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');

  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  await mkLocation(otherStoreId); // the branch's own default room — receiveTradeOrder needs one to receive into.
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${superAdminId}) returning id`;

  return {
    orgId, storeId, otherStoreId, locationId, fileId: file!.id,
    superAdmin: actor(orgId, superAdminId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stock(f: Fixture, storeId: string, locationId: string, itemId: string, qty: string, unitCost = '300.0000'): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost, locationId }],
    }),
  );
}
async function mapSelf(f: Fixture, itemId: string): Promise<void> {
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.otherStoreId}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
}
async function wholesaleItem(f: Fixture, name: string): Promise<string> {
  const item = await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }));
  return item.id;
}
async function internalCustomer(f: Fixture): Promise<string> {
  const c = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('br')}`, customerGroup: 'internal', counterpartyStoreId: f.otherStoreId }));
  return c.id;
}

/** One internal order, dispatched and received on 2026-01-15 — the S3 fixture exactly. */
async function receivedOrder(f: Fixture, opts: { deliveryFee?: string; otherFees?: string; receiveLines?: { lineId: string; receivedQuantity: string; shortageReason?: string }[] } = {}) {
  const customerId = await internalCustomer(f);
  const itemId = await wholesaleItem(f, 'Prepped');
  await stock(f, f.storeId, f.locationId, itemId, '5', '300.0000');
  await mapSelf(f, itemId);
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId, customerId, orderDate: '2026-01-10',
      lines: [{ itemId, quantity: '1', rate: '18000' }],
      deliveryFee: opts.deliveryFee ?? '1000', otherFees: opts.otherFees ?? '200',
    }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const lines = opts.receiveLines
    ? (await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId))).map((l) => ({ lineId: l.id, receivedQuantity: '0', shortageReason: 'not_received' as const }))
    : undefined;
  const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-15', lines }));
  return { order, received, customerId, itemId };
}

async function freightEntryIdFor(orgId: string, orderId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${orgId} and idempotency_key = ${`trade_order:${orderId}:receipt-freight`}`;
  return row?.id ?? null;
}
async function entryHeader(entryId: string) {
  const [row] = await sql<{ source_type: string; source_id: string; entry_date: string }[]>`select source_type, source_id, entry_date::text from journal_entries where id = ${entryId}`;
  return row!;
}
async function legsOf(entryId: string) {
  return sql<{ code: string; store_id: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
    select a.code, l.store_id, l.debit::text, l.credit::text, l.party_type, l.party_id
    from journal_lines l join accounts a on a.id = l.account_id
    where l.entry_id = ${entryId} order by l.line_no`;
}
async function storeBalance(entryId: string, code: string, storeId: string): Promise<number> {
  const legs = await legsOf(entryId);
  return legs.filter((l) => l.code === code && l.store_id === storeId).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
}

// -----------------------------------------------------------------------------------------------

describe('F1 — the freight entry itself', () => {
  it('exactly one entry, correct key/source/date, exactly the four R9 legs at 1200.00 — Mutant: freight to 6900, or delivery_fee only (1000), or party omitted, red (no such entry today)', async () => {
    const f = await fixture('f1');
    const { order } = await receivedOrder(f);
    const entryId = await freightEntryIdFor(f.orgId, order.orderId);
    expect(entryId, 'today: postInternalFreight does not exist, so no such entry posts').not.toBeNull();

    const header = await entryHeader(entryId!);
    expect(header.source_type).toBe('trade_order_receipt');
    expect(header.source_id).toBe(order.orderId);
    expect(header.entry_date).toBe('2026-01-15');

    const legs = await legsOf(entryId!);
    expect(legs).toHaveLength(4);
    // DEF-040: a store party on 2150/1250 carries the store's CODE, not its uuid.
    const codes = await sql<{ id: string; code: string }[]>`select id, code from stores where id in (${f.storeId}, ${f.otherStoreId})`;
    const codeOf = new Map(codes.map((r) => [r.id, r.code]));
    const branch6630 = legs.find((l) => l.code === '6630' && l.store_id === f.otherStoreId)!;
    const branch2150 = legs.find((l) => l.code === '2150' && l.store_id === f.otherStoreId)!;
    const com1250 = legs.find((l) => l.code === '1250' && l.store_id === f.storeId)!;
    const com6630 = legs.find((l) => l.code === '6630' && l.store_id === f.storeId)!;
    expect(branch6630).toBeDefined();
    expect(branch2150).toBeDefined();
    expect(com1250).toBeDefined();
    expect(com6630).toBeDefined();
    expect(Number(branch6630.debit)).toBe(1200);
    expect(branch6630.party_type).toBeNull();
    expect(Number(branch2150.credit)).toBe(1200);
    expect(branch2150.party_type).toBe('store');
    expect(branch2150.party_id).toBe(codeOf.get(f.storeId));
    expect(Number(com1250.debit)).toBe(1200);
    expect(com1250.party_type).toBe('store');
    expect(com1250.party_id).toBe(codeOf.get(f.otherStoreId));
    expect(Number(com6630.credit)).toBe(1200);
    expect(com6630.party_type).toBeNull();
  });
});

describe('F2 — per-store balance', () => {
  it('B and C each balance on their own for this entry: 1200 = 1200', async () => {
    const f = await fixture('f2');
    const { order } = await receivedOrder(f);
    const entryId = await freightEntryIdFor(f.orgId, order.orderId);
    expect(entryId, 'no entry today').not.toBeNull();
    const legs = await legsOf(entryId!);
    const byStore = (storeId: string) => legs.filter((l) => l.store_id === storeId).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(byStore(f.otherStoreId)).toBe(0);
    expect(byStore(f.storeId)).toBe(0);
  });
});

describe('F3 — the goods entry is unchanged', () => {
  it("1250 Dr 18000, 2150 Cr 18000, no leg of 1000/200/1200 — this must hold whether or not F1's leg exists (guard)", async () => {
    const f = await fixture('f3');
    const { order, received } = await receivedOrder(f);
    expect(received.entryId, 'the goods entry must exist').not.toBeNull();
    const legs = await legsOf(received.entryId!);
    expect(Number(legs.find((l) => l.code === '1250')!.debit)).toBe(18000);
    expect(Number(legs.find((l) => l.code === '2150')!.credit)).toBe(18000);
    expect(legs.some((l) => [1000, 200, 1200].includes(Number(l.debit)) || [1000, 200, 1200].includes(Number(l.credit)))).toBe(false);
  });
});

describe('F4 — the result carries the freight entry id, distinct from the goods entry', () => {
  it('received.freightEntryId equals F1\'s id; received.entryId differs — Mutant: not returned, red (field absent today)', async () => {
    const f = await fixture('f4');
    const { order, received } = await receivedOrder(f);
    const entryId = await freightEntryIdFor(f.orgId, order.orderId);
    // `freightEntryId` is not on `ReceiveTradeOrderResult` yet (R8) — read it through a narrow cast
    // rather than pretending the type already has it.
    const receivedAny = received as unknown as { entryId: string | null; freightEntryId?: string | null };
    expect(receivedAny.freightEntryId, 'today: ReceiveTradeOrderResult has no freightEntryId field').toBe(entryId);
    expect(receivedAny.freightEntryId).not.toBe(receivedAny.entryId);
  });
});

describe('F5 — positive/negative control: no fees, no freight entry', () => {
  it('no …:receipt-freight entry; journal count on the RECEIPT DATE is +1 (goods only) — stock/dispatch post on their own earlier dates, so this isolates receipt-time postings without depending on the helper\'s internals', async () => {
    const f = await fixture('f5');
    const { order } = await receivedOrder(f, { deliveryFee: '0', otherFees: '0' });
    expect(await freightEntryIdFor(f.orgId, order.orderId)).toBeNull();
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and entry_date = '2026-01-15'`;
    expect(Number(row!.n)).toBe(1);
  });
});

describe('F6 — negative control: an EXTERNAL order carries no freight entry', () => {
  it('an external order with deliveryFee 1000, dispatched and received: no freight entry', async () => {
    const f = await fixture('f6');
    const itemId = await wholesaleItem(f, 'Prepped');
    await stock(f, f.storeId, f.locationId, itemId, '5', '300.0000');
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `External ${uid('ext')}` }));
    const order = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '1', rate: '18000' }], deliveryFee: '1000' }),
    );
    await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
    await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-15' }));
    expect(await freightEntryIdFor(f.orgId, order.orderId)).toBeNull();
  });
});

describe('F7 — everything received short to zero (Ian, Q2)', () => {
  it('the goods entryId is null, but F1\'s freight entry STILL posts — Mutant: the call placed inside `if (receiptLines.length > 0)` or gated on entryId, red', async () => {
    const f = await fixture('f7');
    const { order, received } = await receivedOrder(f, { receiveLines: [] });
    expect(received.entryId, 'nothing was accepted, so the goods entry must be null').toBeNull();
    const entryId = await freightEntryIdFor(f.orgId, order.orderId);
    expect(entryId, 'today: no such entry exists at all, so this is vacuously null either way — the target is that it posts regardless').not.toBeNull();
  });
});

describe('F8 — the branch bears the freight in its own P&L; consolidated it nets to zero', () => {
  it("branch's 6630 for the period = +1200; both stores' 6630 from this entry sums to 0", async () => {
    const f = await fixture('f8');
    const { order } = await receivedOrder(f);
    const entryId = await freightEntryIdFor(f.orgId, order.orderId);
    expect(entryId).not.toBeNull();
    expect(await storeBalance(entryId!, '6630', f.otherStoreId)).toBe(1200);
    expect(await storeBalance(entryId!, '6630', f.storeId)).toBe(-1200);
    const legs = await legsOf(entryId!);
    const total6630 = legs.filter((l) => l.code === '6630').reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(total6630).toBe(0);
  });
});

describe('F9 — a negative freight is refused, and nothing posts', () => {
  it('reached through the public surface: a negative-total order is refused at createTradeOrder (createTradeOrder:307), so there is no live path to a negative freight at receipt — Mutant: the guard removed, red', async () => {
    const f = await fixture('f9');
    const customerId = await internalCustomer(f);
    const itemId = await wholesaleItem(f, 'Prepped');
    await stock(f, f.storeId, f.locationId, itemId, '5', '300.0000');
    await mapSelf(f, itemId);
    const err = await asOrg(f.orgId, (tx) =>
      createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId, orderDate: '2026-01-10', lines: [{ itemId, quantity: '1', rate: '18000' }], deliveryFee: '-1.00' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from trade_orders where org_id = ${f.orgId}`;
    expect(n!.n).toBe('0');
  });
});
