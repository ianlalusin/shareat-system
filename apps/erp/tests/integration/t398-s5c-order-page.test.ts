import { afterAll, describe, expect, it, vi } from 'vitest';

import { plain, render, sql, uid, world } from './t435-fixture';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

/**
 * T-398 S5c (TESTER) - the order page labels a Padre Garcia sale. Orchestrator ruling (26 Oct):
 *  - an inter-entity order shows "Inter-entity sale to <buyer org name>";
 *  - once the shipment is received it also shows "Received by <buyer org name> on <YYYY-MM-DD>" (Manila date of received_at);
 *  - an external order shows neither.
 * The order, link and shipment are seeded as OWNER (no dispatch needed), so a red here is the missing label, not a setup error.
 * Mutants: label keyed to customer_group instead of the link; "Received by" shown while in_transit; date in UTC instead of Manila.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const orderPage = () => import('../../src/app/trade/orders/[id]/page');

async function seed(received: boolean) {
  const w = await world();
  const buyerName = `Padre Garcia Foods ${uid('pg')}`;
  const [b] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${buyerName}, ${uid('pgo')}) returning id`;
  const [bp] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${b!.id}, 'PG receiver') returning id`;
  const [cu] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, counterparty_org_id, created_by) values (${w.orgId}, ${uid('Linked')}, ${b!.id}, ${w.A.personId}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${w.orgId}, ${testItemCode()}, ${uid('Pork')}, 'raw_material', 'kg', ${w.A.personId}) returning id`;
  const [o] = await sql<{ id: string }[]>`
    insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
    values (${w.orgId}, ${w.s1}, ${cu!.id}, '2026-01-20', 'draft', '3100.00', ${w.A.personId}) returning id`;
  const [ol] = await sql<{ id: string }[]>`
    insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total) values (${w.orgId}, ${o!.id}, ${item!.id}, '10.000', 'kg', '310.00', '3100.00') returning id`;
  await sql.begin(async (t) => {
    const q = t as unknown as typeof sql;
    const [sh] = await q<{ id: string }[]>`
      insert into inter_entity_shipments (org_id, buyer_org_id, trade_order_id, store_id, shipped_on, billed_total, status)
      values (${w.orgId}, ${b!.id}, ${o!.id}, ${w.s1}, '2026-01-20', '3100.00', 'in_transit') returning id`;
    await q`insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
      values (${w.orgId}, ${b!.id}, ${sh!.id}, ${ol!.id}, 1, 'Pork', 'kg', '10.000', '310.00', '3100.00')`;
    if (received) {
      await q`update inter_entity_shipment_lines set received_quantity = quantity where shipment_id = ${sh!.id}`;
      await q`update inter_entity_shipments set status = 'received', received_at = '2026-01-21 23:30:00+08', received_by = ${bp!.id}, received_total = '3100.00' where id = ${sh!.id}`;
    }
  });
  const [je] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${w.orgId} limit 1`;
  await sql`update trade_orders set status = 'dispatched', dispatched_at = now(), dispatched_by = ${w.A.personId}, journal_entry_id = ${je!.id} where id = ${o!.id}`;
  return { w, orderId: o!.id, buyerName };
}

describe('S5c order page: the inter-entity label', () => {
  it('in transit: "Inter-entity sale to <buyer>" shown, "Received by" not', async () => {
    const { w, orderId, buyerName } = await seed(false);
    const text = plain(await render(orderPage, w.A, { params: { id: orderId } }));
    expect(text).toContain(`Inter-entity sale to ${buyerName}`);
    expect(text).not.toContain('Received by');
  });

  it('received: also "Received by <buyer> on <Manila date>" (23:30 +08 on 21 Jan is 2026-01-21, not a UTC date)', async () => {
    const { w, orderId, buyerName } = await seed(true);
    const text = plain(await render(orderPage, w.A, { params: { id: orderId } }));
    expect(text).toContain(`Inter-entity sale to ${buyerName}`);
    expect(text).toContain(`Received by ${buyerName} on 2026-01-21`);
  });

  it('an external order shows neither', async () => {
    const w = await world();
    const text = plain(await render(orderPage, w.A, { params: { id: w.orderYS1 } }));
    expect(text).not.toContain('Inter-entity sale');
    expect(text).not.toContain('Received by');
  });
});
