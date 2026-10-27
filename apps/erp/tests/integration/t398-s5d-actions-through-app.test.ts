import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-398 S5d / S5c (TESTER) - the SCREEN actions, called as the app calls them: the real server action, the session mocked to a real actor,
 * the database reached through the app's own `withOrgPrincipal` (which sets the org but NOT app.person_id unless the app arranges it).
 * The domain tests use an `asPerson` helper and so cannot see a missing person id; these legs can. No asPerson in the legs under test.
 *
 *   B2  PG's Receive action on /inventory/deliveries/inbound/<id>   -> shipment received, total, system bill   (RED: definer refuses 42501 "needs a signed-in person")
 *   B2b the S5c "Post credit note" action                           -> credited_total moves                    (pinned, GREEN)
 *   B2c the dispatch action for an inter-entity customer            -> one shipment, order dispatched          (pinned, GREEN)
 * Mutants: withOrgPrincipal never sets the person -> B2; credit action loses its principal -> B2b; dispatch skips the shipment -> B2c.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { createCustomer, createItem, createTradeOrder, receiveInterEntityShipment, runInterEntityReconcile } from '@shareat/domain';
import { fixture, stock, uid, wholesaleItem, asOrg, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t433-b2b';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Who = { personId: string; orgId: string };
async function act(who: Who, load: () => Promise<unknown>, name: string, ...args: unknown[]) {
  h.actor = who;
  const m = (await load()) as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
  const signal = await captureRedirect(() => m[name]!(...args));
  const o = outcomeOf(signal);
  return { error: o.flash.error, ok: o.flash.ok, path: o.path };
}
const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};

interface World { f: Fx; g: Fx; orderId: string; pork: string; supplierId: string }
/** f sells 10.000 kg pork at 310.00 (cost 250.0000) to g; g has a supplier row for f and the pork item mapped. */
async function world(hint: string): Promise<World> {
  const f = await fixture(sql, `${hint}f`);
  const g = await fixture(sql, `${hint}g`);
  const sellerPork = await wholesaleItem(f, 'Pork');
  await stock(sql, f, sellerPork, '20');
  const cust = await asOrg(f.orgId, (tx) =>
    createCustomer(tx, f.admin, { name: `Padre Garcia ${uid('pg')}`, customerGroup: 'franchise', counterpartyOrgId: g.orgId, priceListId: null }),
  );
  const o = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: cust.id, orderDate: '2026-10-10', lines: [{ itemId: sellerPork, quantity: '10', rate: '310.00' }] }),
  );
  const [sup] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, status, created_by, counterparty_org_id) values (${g.orgId}, ${uid('Commissary')}, 'active', ${g.manager.personId}, ${f.orgId}) returning id`;
  const pg = await asOrg(g.orgId, (tx) => createItem(tx, g.superAdmin, { code: testItemCode(), name: `Pork belly ${uid('pg')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: false }));
  await sql`insert into supplier_items (org_id, supplier_id, item_id, created_by) values (${g.orgId}, ${sup!.id}, ${pg.id}, ${g.manager.personId})`;
  return { f, g, orderId: o.orderId, pork: pg.id, supplierId: sup!.id };
}
const shipmentOf = (orderId: string) =>
  sql<{ id: string; status: string; received_total: string | null; credited_total: string }[]>`
    select id, status, received_total::text, credited_total::text from inter_entity_shipments where trade_order_id = ${orderId}`;

async function dispatched(hint: string) {
  const w = await world(hint);
  const r = await act(w.f.manager, () => import('../../src/app/trade/orders/actions'), 'dispatchOrderAction', form({ orderId: w.orderId }));
  expect(r.error, `dispatch said: ${r.error}`).toBeUndefined();
  const [s] = await shipmentOf(w.orderId);
  return { ...w, shipmentId: s!.id };
}

/** PG counts via the domain with the person set - setup for the credit-note leg only; the receive screen itself is B2. */
async function pgReceivesDomain(w: World & { shipmentId: string }, qty: string) {
  const lines = await sql<{ id: string }[]>`select id from inter_entity_shipment_lines where shipment_id = ${w.shipmentId} order by line_no`;
  await transaction(async (tx: Tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${w.g.orgId}, true)`);
    await tx.execute(dsql`select set_config('app.person_id', ${w.g.manager.personId}, true)`);
    await receiveInterEntityShipment(tx, w.g.manager, {
      shipmentId: w.shipmentId,
      storeId: w.g.storeId,
      lines: lines.map((l) => ({ shipmentLineId: l.id, itemId: w.pork, receivedQuantity: qty })),
    } as never);
  });
}

describe('B2 PG Receive action, through the app wrapper', () => {
  it('B2. receiving 8 of 10 from the screen: flash ok, shipment received at 2480.00, one verified system bill of 2480.00 (RED: needs a signed-in person)', async () => {
    const w = await dispatched('b2');
    const lines = await sql<{ id: string }[]>`select id from inter_entity_shipment_lines where shipment_id = ${w.shipmentId} order by line_no`;
    const { receiveInterEntityShipmentAction } = await import('../../src/app/inventory/deliveries/inbound/actions');
    h.actor = w.g.manager;
    const signal = await captureRedirect(() =>
      receiveInterEntityShipmentAction(
        w.shipmentId,
        form({ store: w.g.storeId, line: lines.map((l) => l.id), item: lines.map(() => w.pork), receivedQuantity: lines.map(() => '8') }),
      ),
    );
    const o = outcomeOf(signal);
    expect(o.flash.error, `the action said: ${o.flash.error}`).toBeUndefined();
    expect(o.flash.ok).toBeTruthy();
    const [s] = await shipmentOf(w.orderId);
    expect([s!.status, s!.received_total]).toEqual(['received', '2480.00']);
    const bills = await sql<{ status: string; total: string }[]>`select status, total_amount::text as total from supplier_invoices where org_id = ${w.g.orgId} and inter_entity_shipment_id = ${w.shipmentId}`;
    expect(bills).toEqual([{ status: 'verified', total: '2480.00' }]);
  });
});

describe('B2b / B2c the seller screens that already worked, pinned', () => {
  it('B2c. the dispatch action for an inter-entity customer writes ONE shipment note and dispatches the order', async () => {
    const w = await dispatched('b2c');
    const rows = await shipmentOf(w.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('in_transit');
    const [ord] = await sql<{ status: string }[]>`select status from trade_orders where id = ${w.orderId}`;
    expect(ord!.status).toBe('dispatched');
  });

  it('B2b. the Post credit note action after PG received 8 of 10: flash ok and the shipment note credited_total moves off 0.00', async () => {
    const w = await dispatched('b2b');
    await pgReceivesDomain(w, '8');
    await runInterEntityReconcile({ orgId: w.f.orgId, trigger: 'manual' }); // the 06:30 check raises the to-do the credit note ends
    const r = await act(w.f.manager, () => import('../../src/app/trade/orders/actions'), 'postFranchiseCreditAction', form({ orderId: w.orderId }));
    expect(r.error, `the action said: ${r.error}`).toBeUndefined();
    expect(r.ok).toMatch(/Credit note posted/);
    const [s] = await shipmentOf(w.orderId);
    expect(s!.credited_total).not.toBe('0.00');
  });
});
