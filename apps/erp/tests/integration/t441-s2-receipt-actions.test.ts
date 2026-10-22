import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@shareat/auth';
import { closeDb, filesRepo } from '@shareat/db';
import { claimUpload, inMemoryDriver, recordCharge, setStorageDriver, uploadFile, WHOLESALE_REVENUE_CODE } from '@shareat/domain';
import { asOrg, buyer, fixture, freezeClock, orderWorth, thawClock, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t433-b2b';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url || !/shareat_test|_test(\?|$)/.test(url)) throw new Error('A test PostgreSQL database is required.');
const sql = postgres(url, { max: 5 });
const current = vi.hoisted(() => ({ actor: null as Actor | null }));
class Outcome extends Error {
  constructor(public messageData: Record<string, string>) { super('action outcome'); }
}
vi.mock('../../src/lib/session', () => ({ requireActor: async () => current.actor! }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/flash', () => ({
  redirectWithFlash: async (_path: string, _params: unknown, message: Record<string, string>) => { throw new Outcome(message); },
}));
import { recordCollectionAction } from '../../src/app/customers/actions';
import { createDeliveryAction } from '../../src/app/inventory/deliveries/actions';
import { dispatchOrderAction } from '../../src/app/trade/orders/actions';

const JPEG = new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,255,217]);
beforeEach(() => { freezeClock(); setStorageDriver(inMemoryDriver()); });
afterEach(() => { thawClock(); setStorageDriver(null); });
afterAll(async () => { await closeDb(); await sql.end({ timeout: 5 }); });
const fdOf = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
};
async function outcome(run: () => Promise<void>) {
  try { await run(); } catch (error) { if (error instanceof Outcome) return error.messageData; throw error; }
  throw new Error('Expected redirect outcome');
}
async function attach(f: Fx, fd: FormData, field: string, mode: 'id' | 'file', uploader = f.manager) {
  if (mode === 'file') { fd.set(field, new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' })); return null; }
  const uploaded = await asOrg(f.orgId, tx => uploadFile(tx, uploader, {
    purpose: 'receipt_photo', storeId: f.storeId, contentType: 'image/jpeg', bytes: JPEG,
  }));
  fd.set(`${field}FileId`, uploaded.fileId);
  return uploaded.fileId;
}
async function checkOwner(f: Fx, fileId: string, ownerId: string) {
  const rows = await sql`select linked_to from stored_files where org_id = ${f.orgId} and id = ${fileId}`;
  expect(rows).toEqual([{ linked_to: ownerId }]);
  const unlinked = await asOrg(f.orgId, tx => filesRepo.listReferencedUnlinked(tx, f.orgId));
  expect(unlinked).toEqual([]);
  const problems = await asOrg(f.orgId, tx => filesRepo.listReferenceProblems(tx, f.orgId));
  expect(Object.values(problems).flat()).toEqual([]);
}

describe.each(['id', 'file'] as const)('S2 actual actions: %s upload path', mode => {
  it('customer collection claims the collection and leaves a clean census', async () => {
    const f = await fixture(sql, `441-c-${mode}`); current.actor = f.manager;
    const customerId = await buyer(sql, f);
    const charged = await asOrg(f.orgId, tx => recordCharge(tx, f.manager, {
      storeId: f.storeId, customerId, chargeDate: '2026-10-16', totalAmount: '100.00', revenueAccountCode: WHOLESALE_REVENUE_CODE,
    }));
    const fd = fdOf({ storeId: f.storeId, customerId, amount: '100.00', collectionDate: '2026-10-16', moneyAccountId: f.walletA,
      allocateChargeId: charged.chargeId, [`allocateAmount_${charged.chargeId}`]: '100.00' });
    await attach(f, fd, 'receiptPhoto', mode);
    expect(await outcome(() => recordCollectionAction(fd))).toHaveProperty('ok');
    const [saved] = await sql`select id, receipt_file_id from ar_collections where org_id = ${f.orgId}`;
    expect(saved).toBeDefined(); await checkOwner(f, saved!.receipt_file_id, saved!.id);
  });

  it('trade pay-now claims the collection, never the order', async () => {
    const f = await fixture(sql, `441-t-${mode}`); current.actor = f.manager;
    const customerId = await buyer(sql, f);
    const order = await orderWorth(sql, f, customerId, '100.00');
    const [stockProof] = await sql`select id from deliveries where org_id = ${f.orgId}`;
    await asOrg(f.orgId, tx => claimUpload(tx, f.superAdmin, { fileId: f.fileId, purpose: 'receipt_photo', storeId: f.storeId, linkTo: stockProof!.id }));
    const fd = fdOf({ orderId: order.orderId, payNowAmount: '100.00', moneyAccountId: f.walletA });
    await attach(f, fd, 'receiptPhoto', mode);
    expect(await outcome(() => dispatchOrderAction(fd))).toHaveProperty('ok');
    const [saved] = await sql`select id, receipt_file_id from ar_collections where org_id = ${f.orgId}`;
    expect(saved!.id).not.toBe(order.orderId); await checkOwner(f, saved!.receipt_file_id, saved!.id);
  });

  it('delivery proof claims the delivery document', async () => {
    const f = await fixture(sql, `441-d-${mode}`); current.actor = f.manager;
    const customerId = await buyer(sql, f);
    const order = await orderWorth(sql, f, customerId, '100.00');
    const [stockProof] = await sql`select id from deliveries where org_id = ${f.orgId}`;
    await asOrg(f.orgId, tx => claimUpload(tx, f.superAdmin, { fileId: f.fileId, purpose: 'receipt_photo', storeId: f.storeId, linkTo: stockProof!.id }));
    const fd = fdOf({ storeId: f.storeId, kind: 'purchase', deliveredOn: '2026-10-16', itemId: order.itemId,
      orderedQuantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '10.0000', locationId: f.locationId });
    await attach(f, fd, 'proofPhoto', mode);
    expect(await outcome(() => createDeliveryAction(fd))).toHaveProperty('ok');
    const [saved] = await sql`select id, proof_file_id from deliveries where org_id = ${f.orgId} and id <> ${stockProof!.id}`;
    expect(saved).toBeDefined(); await checkOwner(f, saved!.proof_file_id, saved!.id);
  });
});

it.each(['customer', 'trade', 'delivery'] as const)('%s refuses another uploader and rolls back all document, ledger and stock writes', async flow => {
  const f = await fixture(sql, `441-refuse-${flow}`); current.actor = f.manager;
  const customerId = await buyer(sql, f);
  const order = await orderWorth(sql, f, customerId, '100.00');
  const charged = flow === 'customer' ? await asOrg(f.orgId, tx => recordCharge(tx, f.manager, {
    storeId: f.storeId, customerId, chargeDate: '2026-10-16', totalAmount: '100.00', revenueAccountCode: WHOLESALE_REVENUE_CODE,
  })) : null;
  const fd = flow === 'customer'
    ? fdOf({ storeId: f.storeId, customerId, amount: '100.00', collectionDate: '2026-10-16', moneyAccountId: f.walletA,
        allocateChargeId: charged!.chargeId, [`allocateAmount_${charged!.chargeId}`]: '100.00' })
    : flow === 'trade'
      ? fdOf({ orderId: order.orderId, payNowAmount: '100.00', moneyAccountId: f.walletA })
      : fdOf({ storeId: f.storeId, kind: 'purchase', deliveredOn: '2026-10-16', itemId: order.itemId,
          orderedQuantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '10.0000', locationId: f.locationId });
  const fileId = await attach(f, fd, flow === 'delivery' ? 'proofPhoto' : 'receiptPhoto', 'id', f.superAdmin);
  const snapshot = async () => ({
    collections: await sql`select * from ar_collections where org_id = ${f.orgId} order by id`,
    charges: await sql`select * from ar_charges where org_id = ${f.orgId} order by id`,
    ledger: await sql`select * from journal_entries where org_id = ${f.orgId} order by id`,
    movements: await sql`select * from stock_movements where org_id = ${f.orgId} order by id`,
    layers: await sql`select * from stock_layers where org_id = ${f.orgId} order by id`,
    deliveries: await sql`select * from deliveries where org_id = ${f.orgId} order by id`,
    orders: await sql`select * from trade_orders where org_id = ${f.orgId} order by id`,
    files: await sql`select * from stored_files where org_id = ${f.orgId} order by id`,
  });
  const before = await snapshot();
  const run = flow === 'customer' ? recordCollectionAction : flow === 'trade' ? dispatchOrderAction : createDeliveryAction;
  expect(await outcome(() => run(fd))).toEqual({ error: 'That photo is no longer available - pick it again.' });
  expect(await snapshot()).toEqual(before);
  expect((await sql`select linked_to from stored_files where id = ${fileId!}`)[0]?.linked_to).toBeNull();
});
