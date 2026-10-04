/**
 * `npm run dev:seed:inventory` — a worked commissary shipment, in a LOCAL database.
 *
 * ⭐ **It runs the real domain functions, not INSERTs.** Every figure on the inventory screens
 * therefore comes from the same code path production would use — `receiveDelivery`,
 * `dispatchOrder`, `confirmReceipt` — so the pages demonstrate the pipeline rather than a
 * hand-built fixture that happens to look like one. A seed that writes rows directly can make a
 * screen look right while the code that produces them is wrong; this one cannot.
 *
 * It reproduces T-133's worked case and then breaks it on purpose:
 *
 * ```
 * 100 kg pork bought by the commissary at ₱300/kg        1310 30,000
 * 100 kg dispatched to the branch at ₱310/kg             1340 30,000 (at COST — DEF-098)
 *  90 kg signed for                                     branch 1310 27,900 · 5175 900
 *  10 kg unaccounted for                                1340  3,000, and one open discrepancy
 * ```
 *
 * ⚠️ **The shortfall is deliberate.** An unresolved one blocks the commissary opening a new sales
 * day (T-174 invariant 7), so leaving it open is what makes that block visible on a screen instead
 * of only in a test. Resolve it on `/commissary/discrepancies` and the block lifts.
 *
 * ## It refuses to run against anything but a *_dev database
 *
 * Same guard, same reason as `dev-seed.ts`: a seed is a write path, and a write path that can
 * reach production is a liability regardless of intent. The check is on the DATABASE NAME, before
 * a single statement runs.
 *
 * Idempotent: it looks for its own marker order and does nothing if one exists.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

import { transaction } from '../packages/db/src/client';
import { lowStockRepo } from '../packages/db/src/index';
import { receiveDelivery } from '../packages/domain/src/deliveries/receive';
import { confirmReceipt, dispatchOrder } from '../packages/domain/src/commissary/transfer';
import { quantity } from '../packages/domain/src/stock/quantity';
import { decimal, money } from '../packages/core/src/money';
import type { LocationLike } from '../packages/domain/src/stock-locations/rules';

const REFERENCE = 'DEV-SEED-COMMISSARY-1';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.');

  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_dev')) {
    throw new Error(`Refusing to seed "${dbName}" — this script only runs against a *_dev database.`);
  }

  const sql = postgres(url, { max: 1 });
  try {
    const [existing] = await sql<{ id: string }[]>`
      select id from trade_orders where reference_no = ${REFERENCE}
    `;
    if (existing) {
      console.log(`Already seeded (order ${existing.id}). Nothing to do.`);
      return;
    }

    const [org] = await sql<{ id: string }[]>`select id from organizations order by code limit 1`;
    if (!org) throw new Error('No organization. Run `npm run dev:seed` first.');

    const stores = await sql<{ id: string; code: string; name: string }[]>`
      select id, code, name from stores where org_id = ${org.id} order by code
    `;
    if (stores.length < 2) throw new Error('Need two stores. Run `npm run dev:seed` first.');
    // ⚠️ Alphabetical, so this is stable rather than "whichever came back first".
    const commissary = stores[0]!;
    const branch = stores[1]!;

    const [person] = await sql<{ id: string }[]>`
      select id from persons where org_id = ${org.id} and display_name = 'Dev Admin'
    `;
    if (!person) throw new Error('No Dev Admin. Run `npm run dev:seed` first.');

    // ── Rooms ───────────────────────────────────────────────────────────────────────────
    const [locType] = await sql<{ id: string }[]>`
      insert into location_types (org_id, code, name)
      values (${org.id}, 'STK', 'Stockroom')
      on conflict do nothing
      returning id
    `;
    const typeId =
      locType?.id ??
      (await sql<{ id: string }[]>`select id from location_types where org_id = ${org.id} limit 1`)[0]!.id;

    const rooms = new Map<string, string>();
    for (const store of [commissary, branch]) {
      const [room] = await sql<{ id: string }[]>`
        select id from stock_locations where store_id = ${store.id} and code = 'KIT'
      `;
      if (room) {
        rooms.set(store.id, room.id);
        continue;
      }
      const [created] = await sql<{ id: string }[]>`
        insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
        values (${org.id}, ${store.id}, 'KIT', 'Kitchen', ${typeId}, 'operating', true, ${person.id})
        returning id
      `;
      rooms.set(store.id, created!.id);
    }

    // ── Items ───────────────────────────────────────────────────────────────────────────
    const item = async (code: string, name: string, unit: string) => {
      const [found] = await sql<{ id: string }[]>`
        select id from items where org_id = ${org.id} and code = ${code}
      `;
      if (found) return found.id;
      const [created] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by)
        values (${org.id}, ${code}, ${name}, 'raw_material', ${unit}, ${person.id})
        returning id
      `;
      return created!.id;
    };
    const comPork = await item('DEV-PORK', 'Pork belly', 'kg');
    const brPork = await item('DEV-PORK-BR', 'Pork belly (branch)', 'kg');

    // ── A fiscal period the postings can land in ────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthEnd = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)
      .toISOString()
      .slice(0, 10);
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${org.id}, ${monthStart}, ${monthEnd}, 'open')
      on conflict do nothing
    `;

    // ── The commissary buys 100 kg at ₱300 ──────────────────────────────────────────────
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
      values (${org.id}, ${'orgs/' + org.id + '/dev-seed-proof.jpg'}, 'image/jpeg', 1024, 'devseed', 'receipt_photo', ${person.id})
      returning id
    `;
    const [delivery] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by, reference_no)
      values (${org.id}, ${commissary.id}, 'purchase', ${today}, ${file!.id}, ${person.id}, ${REFERENCE + '-DEL'})
      returning id
    `;
    const comLocations: LocationLike[] = [
      { id: rooms.get(commissary.id)!, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
    ];
    await transaction((tx) =>
      receiveDelivery(tx, {
        orgId: org.id,
        storeId: commissary.id,
        deliveryId: delivery!.id,
        deliveredOn: today,
        locations: comLocations,
        receivedBy: person.id,
        lines: [
          {
            lineId: '1',
            itemId: comPork,
            itemKind: 'raw_material',
            receivedQuantity: quantity('100'),
            conversionFactor: '1',
            unitCost: '300.0000',
            locationId: rooms.get(commissary.id)!,
          },
        ],
      }),
    );

    // ── The branch orders, the commissary dispatches, the branch signs for 90 ───────────
    const [customer] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
      values (${org.id}, ${branch.name + ' (internal)'}, 'internal', ${branch.id}, ${person.id})
      on conflict (org_id, name) do update set name = excluded.name
      returning id
    `;
    const [order] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount,
                                requested_by_store_id, reference_no, created_by)
      values (${org.id}, ${commissary.id}, ${customer!.id}, ${today}, 'draft', 31000,
              ${branch.id}, ${REFERENCE}, ${person.id})
      returning id
    `;
    const [line] = await sql<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total, requested_quantity)
      values (${org.id}, ${order!.id}, ${comPork}, 100, 'kg', 310, 31000, 100)
      returning id
    `;

    const dispatched = await transaction((tx) =>
      dispatchOrder(tx, {
        orgId: org.id,
        commissaryStoreId: commissary.id,
        orderId: order!.id,
        dispatchedOn: today,
        dispatchedBy: person.id,
        onHandByItem: { [comPork]: quantity('100') },
        lines: [
          {
            lineId: '1',
            itemId: comPork,
            itemKind: 'raw_material',
            sourceLocationId: rooms.get(commissary.id)!,
            fulfilledQuantity: quantity('100'),
          },
        ],
      }),
    );
    if (!dispatched.ok) throw new Error(`dispatch failed: ${dispatched.reason}`);

    const received = await transaction((tx) =>
      confirmReceipt(tx, {
        orgId: org.id,
        commissaryStoreId: commissary.id,
        branchStoreId: branch.id,
        commissaryStoreCode: commissary.code,
        branchStoreCode: branch.code,
        orderId: order!.id,
        receivedOn: today,
        receivedBy: person.id,
        orderLineIdByLineId: { '1': line!.id },
        lines: [
          {
            lineId: '1',
            itemId: comPork,
            branchItemId: brPork,
            branchLocationId: rooms.get(branch.id)!,
            dispatchedQuantity: quantity('100'),
            // ⚠️ TEN KILOS SHORT, on purpose — see the header.
            receivedQuantity: quantity('90'),
            branchBaseUnit: 'kg',
            commissaryBaseUnit: 'kg',
            rate: '310.0000',
            dispatchCost: money(dispatched.costByLineId['1']!),
            branchItemKind: 'raw_material',
            shortageReason: 'not_received',
          },
        ],
      }),
    );
    if (!received.ok) throw new Error(`receipt failed: ${received.reason}`);

    // ── A link and a price, so the branch can auto-order, plus two thresholds ───────────
    await sql`
      insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
      values (${org.id}, ${commissary.id}, ${branch.id}, ${person.id})
      on conflict do nothing
    `;
    await sql`
      insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by)
      values (${org.id}, ${commissary.id}, ${comPork}, 310, ${person.id})
      on conflict do nothing
    `;
    await transaction((tx) =>
      lowStockRepo.setThreshold(tx, {
        orgId: org.id,
        storeId: branch.id,
        itemId: brPork,
        // Above the 90 kg received, so the branch shows as LOW immediately.
        threshold: decimal('120', '14,3'),
        setBy: person.id,
      }),
    );

    console.log(`commissary  : ${commissary.name}`);
    console.log(`branch      : ${branch.name}`);
    console.log(`dispatched  : ₱${dispatched.value} at COST (100 kg × ₱300)`);
    console.log(`received    : ₱${received.value} at the ₱310 transfer rate (90 kg)`);
    console.log(`in transit  : ₱${received.inTransitRemaining} still in 1340, at cost`);
    console.log(`discrepancy : ${received.discrepancies.length} open — this BLOCKS a new sales day`);
    console.log('\nNow open http://localhost:9008/inventory');
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
