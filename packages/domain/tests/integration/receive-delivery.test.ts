import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';

/**
 * T-166 — receiving, and the seam five tasks were waiting for.
 *
 * ⭐ **The case that matters most is the rollback one.** T-161's movements, T-162's layers and
 * T-163's postings each had tests but no caller; receiving is what makes them ONE act, and the
 * only way to prove that is to break one and check the other two did not happen.
 *
 * ⚠️ v1's equivalent cascade is explicitly non-atomic and documents its own accepted risk (OC-14).
 * The constraint that forced that is gone, so the risk should be too — and this file is where that
 * claim is either true or not.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string, fileA: string;
let receivingRoom: string, kitchen: string, itemA: string, itemB: string;

/** The rooms as the domain sees them — Receiving plus one operating room. */
function locations(): LocationLike[] {
  return [
    { id: receivingRoom, role: 'storage', purpose: 'receiving', isDefault: false, status: 'active' },
    { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
  ];
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

beforeEach(async () => {
  await sql`
    truncate table delivery_lines, deliveries, stock_layer_consumptions, stock_layers,
      stock_movements, stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r1] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, purpose, created_by)
    values (${orgA},${storeA},'RCV','Receiving',${t!.id},'receiving',${personA}) returning id`;
  const [r2] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  receivingRoom = r1!.id; kitchen = r2!.id;
  const [i1] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgA},'PORK','Pork Belly','raw_material','kg',${personA}) returning id`;
  const [i2] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgA},'GLOVE','Gloves','supply','pcs',${personA}) returning id`;
  itemA = i1!.id; itemB = i2!.id;
  // ⚠️ `receipt_photo`, not a new purpose: a delivery's proof IS the photo of the supplier's
  // paper, which is exactly what that purpose already means. The storage path must match
  // `^orgs/{uuid}/` — the schema checks the shape rather than trusting the caller.
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/stores/proof.jpg'}, 'image/jpeg', 1024, 'abc123', 'receipt_photo', ${personA})
    returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgA},'2026-08-01','2026-08-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function makeDelivery(kind = 'supplier', proof: string | null = fileA): Promise<string> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, proof_file_id, created_by)
    values (${orgA}, ${storeA}, ${kind}, null, '2026-08-20', ${proof}, ${personA})
    returning id`;
  return d!.id;
}

describe('T-166 — the photo gate, refused by the database', () => {
  it('⭐ a PURCHASE with no proof cannot be stored at all', async () => {
    await expect(
      sql`insert into deliveries (org_id, store_id, kind, delivered_on, created_by)
          values (${orgA},${storeA},'purchase','2026-08-20',${personA})`,
    ).rejects.toThrow(/proof_required/);
  });

  it('⚠️ a COMMISSARY delivery is exempt — it is system-generated and has no paper', async () => {
    await expect(
      sql`insert into deliveries (org_id, store_id, kind, delivered_on, created_by)
          values (${orgA},${storeA},'commissary','2026-08-20',${personA})`,
    ).resolves.toBeTruthy();
  });

  it('a SUPPLIER delivery must name its supplier', async () => {
    await expect(
      sql`insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
          values (${orgA},${storeA},'supplier','2026-08-20',${fileA},${personA})`,
    ).rejects.toThrow(/supplier_required/);
  });
});

describe('T-166 — receiving is ONE act', () => {
  it('⭐ moves stock, layers the cost, and posts the value — all three, one transaction', async () => {
    const deliveryId = await makeDelivery('purchase');
    const res = await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: locations(), receivedBy: personA,
        lines: [{
          lineId: '1', itemId: itemA, itemKind: 'raw_material',
          receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '300.0000',
          locationId: kitchen,
        }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 1. quantity
    expect(await onHand(itemA, kitchen)).toBe('100.000');
    // 2. cost
    const [layer] = await sql<{ quantity: string; unit_cost: string; is_provisional: boolean }[]>`
      select quantity, unit_cost, is_provisional from stock_layers`;
    expect(layer!.quantity).toBe('100.000');
    expect(layer!.unit_cost).toBe('300.0000');
    // ⭐ Provisional: no invoice has arrived, and that is a fact about the COST, not the quantity.
    expect(layer!.is_provisional).toBe(true);
    // 3. value
    const b = await balances();
    expect(b['1310']).toBe('30000.00');
    expect(b['2120']).toBe('-30000.00');
  });

  it('routes by item kind across lines — raw material to 1310, supplies to 1320', async () => {
    const deliveryId = await makeDelivery('purchase');
    await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: locations(), receivedBy: personA,
        lines: [
          { lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('10'), conversionFactor: '1', unitCost: '100.0000', locationId: kitchen },
          { lineId: '2', itemId: itemB, itemKind: 'supply', receivedQuantity: quantity('50'), conversionFactor: '1', unitCost: '2.0000', locationId: kitchen },
        ],
      }),
    );
    const b = await balances();
    expect(b['1310']).toBe('1000.00');
    expect(b['1320']).toBe('100.00');
    expect(b['2120']).toBe('-1100.00');
  });

  it('⭐ a line with NO location parks in Receiving — it is never guessed into the default room', async () => {
    const deliveryId = await makeDelivery('purchase');
    await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: locations(), receivedBy: personA,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('5'), conversionFactor: '1', unitCost: '100.0000', locationId: null }],
      }),
    );
    expect(await onHand(itemA, receivingRoom)).toBe('5.000');
    // ⛔ The default room stayed empty. Parking is honest; guessing looks decided and is not.
    expect(await onHand(itemA, kitchen)).toBe('0');
  });

  it('⭐ converts purchase units to base units — a 12-piece case is 12 pieces of stock', async () => {
    const deliveryId = await makeDelivery('purchase');
    const res = await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: locations(), receivedBy: personA,
        lines: [{
          lineId: '1', itemId: itemB, itemKind: 'supply',
          receivedQuantity: quantity('5'), conversionFactor: '12', unitCost: '24.0000',
          locationId: kitchen,
        }],
      }),
    );
    expect(res.ok).toBe(true);
    // 5 cases × 12 = 60 pieces on hand…
    expect(await onHand(itemB, kitchen)).toBe('60.000');
    // …and the cost is per BASE unit: ₱24 a case over 12 = ₱2.0000 a piece.
    const [layer] = await sql<{ unit_cost: string; quantity: string }[]>`select unit_cost, quantity from stock_layers`;
    expect(layer!.quantity).toBe('60.000');
    expect(layer!.unit_cost).toBe('2.0000');
    // The ledger still sees what was actually paid: 5 × ₱24.
    expect((await balances())['1320']).toBe('120.00');
  });

  it('a line received as ZERO moves no stock and posts nothing for itself', async () => {
    const deliveryId = await makeDelivery('purchase');
    await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: locations(), receivedBy: personA,
        lines: [
          { lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('0'), conversionFactor: '1', unitCost: '100.0000', locationId: kitchen },
          { lineId: '2', itemId: itemB, itemKind: 'supply', receivedQuantity: quantity('4'), conversionFactor: '1', unitCost: '5.0000', locationId: kitchen },
        ],
      }),
    );
    expect(await onHand(itemA, kitchen)).toBe('0');
    expect(await onHand(itemB, kitchen)).toBe('4.000');
    expect((await balances())['2120']).toBe('-20.00');
  });

  it('⛔ refuses when a line has no location and the store has nowhere to park it', async () => {
    const deliveryId = await makeDelivery('purchase');
    const res = await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: [], receivedBy: personA,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('5'), conversionFactor: '1', unitCost: '1.0000', locationId: null }],
      }),
    );
    expect(res.ok).toBe(false);
    // ⛔ Nothing was written. Inventing a room is how v1 lost stock.
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from stock_movements`;
    expect(n!.c).toBe('0');
  });
});

describe('T-166 — ⭐ all three or none', () => {
  it('a failure in the POSTING rolls back the movement and the layer', async () => {
    // An unmapped item kind fails at step 3, after steps 1 and 2 have already written rows.
    // v1's cascade would have left them; this must not.
    const deliveryId = await makeDelivery('purchase');
    const res = await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
        locations: locations(), receivedBy: personA,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'spaceship', receivedQuantity: quantity('10'), conversionFactor: '1', unitCost: '100.0000', locationId: kitchen }],
      }),
    );
    expect(res.ok).toBe(false);

    // ⭐ THIS CASE FOUND A REAL BUG. The first cut validated the item kind inside the write loop,
    // so the movement and layer were already written when the posting refused — and because
    // `postReceiptValue` RETURNS rather than throws, the transaction committed them. v1's
    // non-atomic cascade, reproduced by accident. Fixed by checking every precondition before the
    // first write; a refusal after one is now a throw, so the transaction unwinds.
    const [m] = await sql<{ c: string }[]>`select count(*)::text as c from stock_movements`;
    const [l] = await sql<{ c: string }[]>`select count(*)::text as c from stock_layers`;
    const [j] = await sql<{ c: string }[]>`select count(*)::text as c from journal_entries`;
    expect(j!.c).toBe('0');
    expect({ movements: m!.c, layers: l!.c }).toEqual({ movements: '0', layers: '0' });
  });

  it('⭐ a closed period rolls back everything — the throw unwinds all three', async () => {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgA}`;
    const deliveryId = await makeDelivery('purchase');
    await expect(
      withOrgPrincipal(orgA, (tx) =>
        receiveDelivery(tx, {
          orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
          locations: locations(), receivedBy: personA,
          lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('10'), conversionFactor: '1', unitCost: '100.0000', locationId: kitchen }],
        }),
      ),
    ).rejects.toThrow(/period/i);

    const [m] = await sql<{ c: string }[]>`select count(*)::text as c from stock_movements`;
    const [l] = await sql<{ c: string }[]>`select count(*)::text as c from stock_layers`;
    expect({ movements: m!.c, layers: l!.c }).toEqual({ movements: '0', layers: '0' });
  });

  it('receiving twice is idempotent — the movement index refuses the second', async () => {
    const deliveryId = await makeDelivery('purchase');
    const line = {
      lineId: '1', itemId: itemA, itemKind: 'raw_material',
      receivedQuantity: quantity('10'), conversionFactor: '1', unitCost: '100.0000',
      locationId: kitchen,
    };
    const input = {
      orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
      locations: locations(), receivedBy: personA, lines: [line],
    };
    await withOrgPrincipal(orgA, (tx) => receiveDelivery(tx, input));
    await expect(withOrgPrincipal(orgA, (tx) => receiveDelivery(tx, input))).rejects.toThrow(/source_pair_key/);
    expect(await onHand(itemA, kitchen)).toBe('10.000');
  });
});

describe('T-166 — the line-level controls', () => {
  it('⭐ a SHORT line must explain itself', async () => {
    const deliveryId = await makeDelivery('purchase');
    await sql`update deliveries set status='received', received_at=now(), received_by=${personA} where id=${deliveryId}`;
    await expect(
      sql`insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost)
          values (${deliveryId},'1',${itemA},10,8,'kg',1,100)`,
    ).rejects.toThrow(/shortage reason/);
  });

  it('⭐ an OVER-receipt needs explicit approval — a cashier cannot bypass the cap', async () => {
    const deliveryId = await makeDelivery('purchase');
    await sql`update deliveries set status='received', received_at=now(), received_by=${personA} where id=${deliveryId}`;
    await expect(
      sql`insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost)
          values (${deliveryId},'1',${itemA},10,12,'kg',1,100)`,
    ).rejects.toThrow(/over-receipt approval/);

    // ⚠️ Allowed WITH the flag: suppliers legitimately send extra, and v1 made this a deliberate,
    // gated exception rather than a silent tolerance.
    await expect(
      sql`insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, over_receipt_allowed)
          values (${deliveryId},'2',${itemA},10,12,'kg',1,100,true)`,
    ).resolves.toBeTruthy();
  });

  it('a DRAFT line needs neither — the controls apply at receipt', async () => {
    const deliveryId = await makeDelivery('purchase');
    await expect(
      sql`insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, purchase_unit, conversion_factor, unit_cost)
          values (${deliveryId},'1',${itemA},10,'kg',1,100)`,
    ).resolves.toBeTruthy();
  });

  it('the same supplier and paper reference twice is refused outright', async () => {
    const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgA},'Acme',${personA}) returning id`;
    await sql`insert into deliveries (org_id, store_id, kind, supplier_id, reference_no, delivered_on, proof_file_id, created_by)
              values (${orgA},${storeA},'supplier',${sup!.id},'DR-001','2026-08-20',${fileA},${personA})`;
    await expect(
      sql`insert into deliveries (org_id, store_id, kind, supplier_id, reference_no, delivered_on, proof_file_id, created_by)
          values (${orgA},${storeA},'supplier',${sup!.id},'DR-001','2026-08-21',${fileA},${personA})`,
    ).rejects.toThrow(/supplier_reference_key/);
  });
});
