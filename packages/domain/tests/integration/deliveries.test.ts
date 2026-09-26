import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { createDeliveryDocument, receiveDeliveryDocument } from '../../src/deliveries/documents';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

/**
 * T-166 / DEF-135 — the DOCUMENT layer over `receive.ts`'s already-tested engine
 * (`receive-delivery.test.ts`, 16 cases, untouched). This file proves the seam: a person drafts a
 * delivery through `createDeliveryDocument`, then receives it through `receiveDeliveryDocument`,
 * and every role/shape/duplicate rule in the task spec's §6 fires from THAT path — not from a
 * hand-built `receiveDelivery` input, which is all the engine's own tests exercised.
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

const asActor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

async function balances(orgId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

async function linesOf(deliveryId: string): Promise<{ id: string; itemId: string }[]> {
  const rows = await sql<{ id: string; item_id: string }[]>`
    select id, item_id from delivery_lines where delivery_id = ${deliveryId} order by line_no`;
  return rows.map((r) => ({ id: r.id, itemId: r.item_id }));
}

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staff: Actor;
  manager: Actor;
  managerOtherStore: Actor;
  receivingRoom: string;
  kitchen: string;
  itemA: string; // raw_material, kg
  itemB: string; // retail, pcs
  supplierId: string;
  fileId: string;
}

async function fixture(): Promise<Fixture> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${'Org ' + uid('o')}, ${uid('org')}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store One', 'multi_room') returning id`;
  const storeId = store!.id;
  const [store2] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st2')}, 'Store Two', 'multi_room') returning id`;
  const otherStoreId = store2!.id;

  const [staffP] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  const [managerP] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [managerOtherP] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager Other') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffP!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerP!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerOtherP!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffP!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerP!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerOtherP!.id}, ${otherStoreId})`;

  const [type] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [rcv] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, purpose, created_by)
    values (${orgId}, ${storeId}, 'RCV', 'Receiving', ${type!.id}, 'receiving', ${staffP!.id}) returning id`;
  const [kit] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${staffP!.id}) returning id`;
  await sql`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${otherStoreId}, 'OTH', 'Other Room', ${type!.id}, 'operating', true, ${staffP!.id})`;

  const [itemA] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${uid('PORK')}, 'Pork Belly', 'raw_material', 'kg', ${staffP!.id}) returning id`;
  const [itemB] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${uid('MILKIS')}, 'Milkis', 'retail', 'pcs', ${staffP!.id}) returning id`;

  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${orgId}, 'Batangas Meat Supply', ${staffP!.id}) returning id`;

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${'orgs/' + orgId + '/stores/proof.jpg'}, 'image/jpeg', 1024, ${uid('chk')}, 'receipt_photo', ${staffP!.id})
    returning id`;

  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2020-01-01', '2035-12-31', 'open')`;

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffP!.id}, ${uid('SE')}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staffP!.id, setBy: managerP!.id,
  });

  return {
    orgId,
    storeId,
    otherStoreId,
    staff: asActor(orgId, staffP!.id),
    manager: asActor(orgId, managerP!.id),
    managerOtherStore: asActor(orgId, managerOtherP!.id),
    receivingRoom: rcv!.id,
    kitchen: kit!.id,
    itemA: itemA!.id,
    itemB: itemB!.id,
    supplierId: supplier!.id,
    fileId: file!.id,
  };
}

/** A single-line purchase draft: item A, 10 kg @ ₱300, parked in the kitchen. */
function baseLine(f: Fixture, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    itemId: f.itemA,
    orderedQuantity: '10',
    purchaseUnit: 'kg',
    conversionFactor: '1',
    unitCost: '300.0000',
    locationId: f.kitchen,
    ...overrides,
  } as {
    itemId: string;
    orderedQuantity: string;
    purchaseUnit: string;
    conversionFactor: string;
    unitCost: string;
    locationId: string | null;
  };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_lines, deliveries, stock_layer_consumptions, stock_layers,
      stock_movements, stock_locations, location_types,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, suppliers, person_store_scope, person_roles, person_identities, persons,
      items, stores, organizations restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-166 doc — the photo gate and basic shape refusals', () => {
  it('a non-existent proof file id is refused before anything is written', async () => {
    const f = await fixture();
    const fakeFileId = crypto.randomUUID();
    await expect(
      asOrg(f.orgId, (tx) =>
        createDeliveryDocument(tx, f.staff, {
          storeId: f.storeId,
          kind: 'purchase',
          supplierId: null,
          referenceNo: null,
          deliveredOn: '2026-09-01',
          proofFileId: fakeFileId,
          lines: [baseLine(f)],
        }),
      ),
    ).rejects.toThrow(/does not exist/);
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from deliveries`;
    expect(n!.c).toBe('0');
  });

  it('a supplier delivery with no supplier is refused', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) =>
        createDeliveryDocument(tx, f.staff, {
          storeId: f.storeId,
          kind: 'supplier',
          supplierId: null,
          referenceNo: 'DR-1',
          deliveredOn: '2026-09-01',
          proofFileId: f.fileId,
          lines: [baseLine(f)],
        }),
      ),
    ).rejects.toThrow(/name its supplier/);
  });

  it("kind 'commissary' is refused — only T-173's own receipt creates that kind", async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) =>
        createDeliveryDocument(tx, f.staff, {
          storeId: f.storeId,
          kind: 'commissary' as never,
          supplierId: null,
          referenceNo: null,
          deliveredOn: '2026-09-01',
          proofFileId: f.fileId,
          lines: [baseLine(f)],
        }),
      ),
    ).rejects.toThrow(/commissary/);
  });

  it('T-343 S5.3: a zero ordered quantity is named by LINE POSITION, never the item id, in userMessage', async () => {
    const f = await fixture();
    const caught = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f, { orderedQuantity: '0' })],
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the bad line was not refused at all').not.toBeNull();
    expect(caught!.message).toContain(f.itemA);
    const userMessage = (caught as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toMatch(/^Line 1:/);
    expect(userMessage).not.toContain(f.itemA);
  }, 30000);

  it('⛔ T-343 S5.3 message-regex: the raw diagnostic stays byte-identical (Invariant 1) — a non-existent proof file id', async () => {
    const f = await fixture();
    const fakeFileId = crypto.randomUUID();
    await expect(
      asOrg(f.orgId, (tx) =>
        createDeliveryDocument(tx, f.staff, {
          storeId: f.storeId,
          kind: 'purchase',
          supplierId: null,
          referenceNo: null,
          deliveredOn: '2026-09-01',
          proofFileId: fakeFileId,
          lines: [baseLine(f)],
        }),
      ),
      // ⛔ Green now and after — `refuse`/`gone` never rewrite `message`, only add `userMessage`
      // (Invariant 1). Same scenario as this describe's OWN unedited test above, asserted a second,
      // independent way so a conversion that accidentally changed the raw text fails HERE too.
    ).rejects.toThrow(/createDeliveryDocument: proof file .+ does not exist in this org/);
  }, 30000);

  it('a delivery with no lines is refused', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) =>
        createDeliveryDocument(tx, f.staff, {
          storeId: f.storeId,
          kind: 'purchase',
          supplierId: null,
          referenceNo: null,
          deliveredOn: '2026-09-01',
          proofFileId: f.fileId,
          lines: [],
        }),
      ),
    ).rejects.toThrow(/at least one line/);
  });

  it('staff CAN create and receive a plain in-full delivery — ✅ is a decision too', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);
    const result = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '10' }],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('T-166 doc — receiving 10 of 10 posts one entry, one layer, one movement', () => {
  it('2120 rises by the line total and 1310 rises by the same amount', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);
    const result = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '10' }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(await onHand(f.itemA, f.kitchen)).toBe('10.000');

    const b = await balances(f.orgId);
    expect(b['1310']).toBe('3000.00');
    expect(b['2120']).toBe('-3000.00');

    const [m] = await sql<{ c: string }[]>`select count(*)::text as c from stock_movements`;
    const [l] = await sql<{ c: string }[]>`select count(*)::text as c from stock_layers`;
    const [j] = await sql<{ c: string }[]>`select count(*)::text as c from journal_entries`;
    expect({ movements: m!.c, layers: l!.c, entries: j!.c }).toEqual({ movements: '1', layers: '1', entries: '1' });
  });
});

describe('T-166 doc — over-receipt needs an explicit flag AND a manager', () => {
  it('12 of 10: refused for staff even with the flag; refused for manager without it; accepted for manager with it', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);

    // ⛔ A cashier who ticks the box is refused before any write — asserted directly.
    await expect(
      asOrg(f.orgId, (tx) =>
        receiveDeliveryDocument(tx, f.staff, {
          deliveryId: created.deliveryId,
          lines: [{ lineId: line!.id, receivedQuantity: '12', overReceiptOk: true }],
        }),
      ),
    ).rejects.toThrow(/allow_over_receipt/);

    // A manager who forgets the flag is refused by the DATABASE trigger, not by JS.
    await expect(
      asOrg(f.orgId, (tx) =>
        receiveDeliveryDocument(tx, f.manager, {
          deliveryId: created.deliveryId,
          lines: [{ lineId: line!.id, receivedQuantity: '12' }],
        }),
      ),
    ).rejects.toThrow(/over-receipt approval/);

    // Nothing was written by either failed attempt — the delivery is still draft, receivable.
    const result = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.manager, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '12', overReceiptOk: true }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(await onHand(f.itemA, f.kitchen)).toBe('12.000');
  });
});

describe('T-166 doc — a short line must explain itself', () => {
  it('8 of 10 with no reason is refused; with supplier_short, accepted', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);

    await expect(
      asOrg(f.orgId, (tx) =>
        receiveDeliveryDocument(tx, f.staff, {
          deliveryId: created.deliveryId,
          lines: [{ lineId: line!.id, receivedQuantity: '8' }],
        }),
      ),
    ).rejects.toThrow(/shortage reason/);

    const result = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '8', shortageReason: 'supplier_short' }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(await onHand(f.itemA, f.kitchen)).toBe('8.000');
  });

  it('a line answered zero auto-sets not_received — no picker choice needed', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f), baseLine(f, { itemId: f.itemB, orderedQuantity: '24', purchaseUnit: 'pcs', unitCost: '25.0000' })],
      }),
    );
    const lines = await linesOf(created.deliveryId);
    const lineA = lines.find((l) => l.itemId === f.itemA)!;
    const lineB = lines.find((l) => l.itemId === f.itemB)!;

    const result = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [
          { lineId: lineA.id, receivedQuantity: '0' },
          { lineId: lineB.id, receivedQuantity: '24' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(await onHand(f.itemA, f.kitchen)).toBe('0');
    expect(await onHand(f.itemB, f.kitchen)).toBe('24.000');

    const [row] = await sql<{ shortage_reason: string }[]>`select shortage_reason from delivery_lines where id = ${lineA.id}`;
    expect(row!.shortage_reason).toBe('not_received');
  });
});

describe('T-166 doc — an undecided line parks in Receiving, never guessed', () => {
  it('no location on the line lands in Receiving', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f, { locationId: null })],
      }),
    );
    const [line] = await linesOf(created.deliveryId);
    await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '10' }],
      }),
    );
    expect(await onHand(f.itemA, f.receivingRoom)).toBe('10.000');
    expect(await onHand(f.itemA, f.kitchen)).toBe('0');
  });

  it('with no Receiving room, lands in the default room instead — neither case loses quantity', async () => {
    const f = await fixture();
    await sql`delete from stock_locations where id = ${f.receivingRoom}`;
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f, { locationId: null })],
      }),
    );
    const [line] = await linesOf(created.deliveryId);
    await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '10' }],
      }),
    );
    expect(await onHand(f.itemA, f.kitchen)).toBe('10.000');
  });
});

describe('T-166 doc — duplicate risk warns, never blocks', () => {
  it('same reference (voided prior), same item same day, and overstock all fire — and the receive still succeeds', async () => {
    const f = await fixture();
    // Give itemA some on-hand so the overstock heuristic (>= 2x) has something to double.
    await sql`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${f.orgId}, ${f.storeId}, ${f.kitchen}, ${f.itemA}, now(), '5', 'opening', 'test_seed', ${crypto.randomUUID()}, ${f.staff.personId})`;

    // A prior VOIDED delivery, same supplier + same reference, same item, TODAY. The only shape
    // that fires `same_reference` without tripping the hard unique index (excludes void rows) —
    // see this file's own repo comment on `recentDeliveriesForRisk`. Doubles as `same_item_same_day`.
    const [prior] = await sql<{ id: string; delivered_on: string }[]>`
      insert into deliveries (org_id, store_id, kind, supplier_id, reference_no, delivered_on, status, proof_file_id, voided_at, voided_by, void_reason, created_by)
      values (${f.orgId}, ${f.storeId}, 'supplier', ${f.supplierId}, 'DR-100', current_date, 'void', ${f.fileId}, now(), ${f.staff.personId}, 'test seed', ${f.staff.personId})
      returning id, delivered_on::text`;
    await sql`
      insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, purchase_unit, conversion_factor, unit_cost)
      values (${prior!.id}, '1', ${f.itemA}, 5, 'kg', 1, 300)`;

    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'supplier',
        supplierId: f.supplierId,
        referenceNo: 'DR-100',
        deliveredOn: prior!.delivered_on,
        proofFileId: f.fileId,
        // 20 kg >= 2x the 5 kg on hand — overstock.
        lines: [baseLine(f, { orderedQuantity: '20' })],
      }),
    );

    expect(created.warnings.map((w) => w.code).sort()).toEqual(['overstock', 'same_item_same_day', 'same_reference']);

    const [line] = await linesOf(created.deliveryId);
    const result = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '20' }],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('T-166 doc — a received delivery is immutable, and store scope is enforced', () => {
  it('receiving an already-received delivery is refused', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);
    await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '10' }],
      }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        receiveDeliveryDocument(tx, f.staff, {
          deliveryId: created.deliveryId,
          lines: [{ lineId: line!.id, receivedQuantity: '10' }],
        }),
      ),
    ).rejects.toThrow(/not draft/);
  });

  it('a manager scoped to store A cannot receive store B\'s delivery', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);

    await expect(
      asOrg(f.orgId, (tx) =>
        receiveDeliveryDocument(tx, f.managerOtherStore, {
          deliveryId: created.deliveryId,
          lines: [{ lineId: line!.id, receivedQuantity: '10' }],
        }),
      ),
    ).rejects.toThrow(/no store scope/);

    // Untouched by the refusal.
    const [d] = await sql<{ status: string }[]>`select status from deliveries where id = ${created.deliveryId}`;
    expect(d!.status).toBe('draft');
  });

  it('every line of the document must be answered before it can be received', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f), baseLine(f, { itemId: f.itemB, orderedQuantity: '24', purchaseUnit: 'pcs', unitCost: '25.0000' })],
      }),
    );
    const lines = await linesOf(created.deliveryId);
    const lineA = lines.find((l) => l.itemId === f.itemA)!;

    await expect(
      asOrg(f.orgId, (tx) =>
        receiveDeliveryDocument(tx, f.staff, {
          deliveryId: created.deliveryId,
          lines: [{ lineId: lineA.id, receivedQuantity: '10' }],
        }),
      ),
    ).rejects.toThrow(/not answered/);
  });
});

describe('T-343 S5.3b — R1: receiveDeliveryDocument surfaces receiveDelivery’s own userReason', () => {
  it('every line received as zero: userMessage is receive.ts’s own userReason, not "…Reload the page and try again." (was the generic fallback)', async () => {
    const f = await fixture();
    const created = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines: [baseLine(f)],
      }),
    );
    const [line] = await linesOf(created.deliveryId);

    const caught = await asOrg(f.orgId, (tx) =>
      receiveDeliveryDocument(tx, f.staff, {
        deliveryId: created.deliveryId,
        lines: [{ lineId: line!.id, receivedQuantity: '0' }],
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'receiving nothing was not refused at all').not.toBeNull();
    expect(caught!.message).toContain('every line was received as zero — nothing to post');
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).not.toBe("This delivery couldn't be received. Reload the page and try again.");
    expect(userMessage).toMatch(/^[A-Z]/);
    expect(userMessage).toMatch(/\.$/);
  }, 30000);
});

describe('T-343 S5.3b — R3: "Line n" names the operator’s VISIBLE form row, not the post-filter array index', () => {
  it('a bad row 3, after an empty row 2 was dropped: "Line 3:", not "Line 2:" (was the array-index number)', async () => {
    const f = await fixture();
    // Simulates what `inventory/deliveries/actions.ts` will send once it numbers rows BEFORE
    // dropping empties: row 2 (truly empty — no itemId at all) never reaches here; rows 1 and 3
    // carry their ORIGINAL form position as `lineNo`. Assigned via a variable, not an inline
    // literal, so TS's excess-property check does not fire on a field `CreateDeliveryLineInput`
    // does not declare yet (R3 adds it to the domain side).
    const lines = [
      baseLine(f),
      { ...baseLine(f, { orderedQuantity: '0' }), lineNo: 3 },
    ];

    const caught = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: f.fileId,
        lines,
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the bad line was not refused at all').not.toBeNull();
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toMatch(/^Line 3:/);
    expect(userMessage).not.toMatch(/^Line 2:/);
  }, 30000);
});

describe('T-343 S5.3b — R4: a gone proof photo carries its own sentence, not the generic gone( ) wording', () => {
  it('userMessage === "That photo could not be found — try attaching it again." (was goneSentence(\'proof photo\'))', async () => {
    const f = await fixture();
    const fakeFileId = crypto.randomUUID();

    const caught = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.staff, {
        storeId: f.storeId,
        kind: 'purchase',
        supplierId: null,
        referenceNo: null,
        deliveredOn: '2026-09-01',
        proofFileId: fakeFileId,
        lines: [baseLine(f)],
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the missing photo was not refused at all').not.toBeNull();
    // ⛔ Raw stays byte-identical — R1.5's own promise, re-asserted here (R4's ⛔ half).
    expect(caught!.message).toBe(`createDeliveryDocument: proof file ${fakeFileId} does not exist in this org`);
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toBe('That photo could not be found — try attaching it again.');
  }, 30000);
});
