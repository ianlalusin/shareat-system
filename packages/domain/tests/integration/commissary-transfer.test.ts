import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { receiveDelivery } from '../../src/deliveries/receive';
import { confirmReceipt, dispatchOrder } from '../../src/commissary/transfer';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-172/T-173 — the commissary pipeline's two postings.
 *
 * ⭐ **This is the largest single omission `CAPABILITY-GAPS.md` names**: for a branch store, this
 * IS how inventory gets replenished, and it straddled Phase 2 and Phase 3 owned by neither.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, commissary: string, branch: string, personA: string, fileA: string;
let comKitchen: string, brKitchen: string, itemA: string, brItemA: string;

const comLocations = (): LocationLike[] => [
  { id: comKitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
];

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

async function balances(storeId?: string): Promise<Record<string, string>> {
  const rows = storeId
    ? await sql<{ code: string; net: string }[]>`
        select a.code, (sum(l.debit) - sum(l.credit))::text as net
        from journal_lines l join accounts a on a.id = l.account_id
        where a.org_id = ${orgA} and l.store_id = ${storeId} group by a.code`
    : await sql<{ code: string; net: string }[]>`
        select a.code, (sum(l.debit) - sum(l.credit))::text as net
        from journal_lines l join accounts a on a.id = l.account_id
        where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

/** Every leg of one entry, account-ordered — what a posting actually WROTE. */
async function entryLegs(entryId: string): Promise<{ code: string; debit: string; credit: string }[]> {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, l.debit::text, l.credit::text from journal_lines l
    join accounts a on a.id = l.account_id
    where l.entry_id = ${entryId} order by a.code, l.debit`;
}

/** 100 kg into the commissary at ₱300 — Ian's worked case. */
async function stockCommissary(qty = '100', cost = '300.0000') {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${commissary},'purchase','2026-08-01',${fileA},${personA}) returning id`;
  await withOrgPrincipal(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: commissary, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: comLocations(), receivedBy: personA,
      lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId: comKitchen }],
    }),
  );
}

const receiptLine = (over: Record<string, unknown> = {}) => ({
  lineId: '1', itemId: itemA, branchItemId: brItemA, branchLocationId: brKitchen,
  dispatchedQuantity: quantity('100'), receivedQuantity: quantity('100'),
  branchBaseUnit: 'kg', commissaryBaseUnit: 'kg', rate: '310.0000',
  // ⛔ What the 100 kg COST the commissary — 100 × ₱300. `1340` is relieved from THIS, never
  // from `rate`; the ₱10/kg difference is the margin and goes to `5175`.
  dispatchCost: money('30000.00'),
  branchItemKind: 'raw_material', ...over,
});

beforeEach(async () => {
  await sql`
    truncate table commissary_item_map, commissary_item_offerings, commissary_links,
      trade_order_lines, trade_orders, customers, expense_categories, count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [c] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'COM','Commissary','multi_room') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'BR','Branch','multi_room') returning id`;
  commissary = c!.id; branch = b!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r1] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${commissary},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${branch},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  comKitchen = r1!.id; brKitchen = r2!.id;
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork','raw_material','kg',${personA}) returning id`;
  const [i2] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork (branch)','raw_material','kg',${personA}) returning id`;
  itemA = i!.id; brItemA = i2!.id;
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${personA}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await seedExpenseCategories(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgA},'2026-08-01','2026-08-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-172 — dispatch, and the gate that fails CLOSED', () => {
  it('moves stock off the shelf into 1340, and nothing crosses to the branch', async () => {
    await stockCommissary();
    const res = await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId: crypto.randomUUID(),
        dispatchedOn: '2026-08-20', dispatchedBy: personA,
        onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(money('30000.00'));

    const b = await balances();
    expect(b['1340']).toBe('30000.00');
    expect(b['1310']).toBe('0.00');
    // ⭐ Asserted by ABSENCE: T-173 is the only place the two stores' books touch.
    expect(b['1250']).toBeUndefined();
    expect(b['2150']).toBeUndefined();
    expect(await onHand(itemA, comKitchen)).toBe('0.000');
  });

  it('⛔ refuses more than the commissary holds', async () => {
    await stockCommissary('50');
    const res = await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId: crypto.randomUUID(),
        dispatchedOn: '2026-08-20', dispatchedBy: personA,
        onHandByItem: { [itemA]: quantity('50') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('80') }],
      }),
    );
    expect(res.ok).toBe(false);
    expect(await onHand(itemA, comKitchen)).toBe('50.000');
  });

  it('⭐ an UNTRACKED item is refused at dispatch — fail CLOSED, so the commissary fixes its data', async () => {
    await stockCommissary();
    const res = await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId: crypto.randomUUID(),
        dispatchedOn: '2026-08-20', dispatchedBy: personA,
        onHandByItem: {}, // no tracked balance at all
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('1') }],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('no tracked balance');
  });
});

describe('T-173 — ⭐ the one event where both stores move', () => {
  it('Ian’s case: bought at ₱300, transferred at ₱310 — four legs, two stores, one entry', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );

    const res = await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine()],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(money('31000.00'));

    const com = await balances(commissary);
    const br = await balances(branch);
    // ⭐ **1340 CLEARS TO ZERO.** It was debited ₱30,000 at cost and is credited ₱30,000 at cost —
    // never at the ₱310 transfer rate, which would leave it at −₱1,000 forever.
    expect(com['1340']).toBe('0.00');
    // ⭐ The ₱1,000 of processing work goes to 5175, which nets the commissary's payroll for this
    // job back to zero. An internal transfer earns nothing.
    expect(com['5175']).toBe('-1000.00');
    expect(com['1250']).toBe('31000.00');
    expect(br['2150']).toBe('-31000.00');
    expect(br['1310']).toBe('31000.00');

    // ⛔ NO revenue and NO payable anywhere — the v1 shape that must not be inherited.
    const all = await balances();
    expect(all['2110']).toBeUndefined();
    expect(all['1210']).toBeUndefined();
    for (const code of Object.keys(all)) expect(code.startsWith('4')).toBe(false);

    // ⭐ One entry: 1340, 1250, the branch's 1310, 2150 — and 5175 for the margin.
    const [n] = await sql<{ c: string }[]>`
      select count(*)::text as c from journal_lines where entry_id = ${res.entryId}`;
    expect(n!.c).toBe('5');

    // The branch's layer carries ₱310 — the mechanism by which the commissary's work travels.
    const [layer] = await sql<{ unit_cost: string }[]>`
      select unit_cost from stock_layers where store_id = ${branch}`;
    expect(layer!.unit_cost).toBe('310.0000');
  });

  it('⭐ posts at RECEIVED quantity, and the shortfall STAYS in 1340', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    const res = await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ receivedQuantity: quantity('90') })],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 90 × ₱310 = ₱27,900 — NOT 100 × ₱310.
    expect(res.value).toBe(money('27900.00'));
    expect(res.discrepancies).toHaveLength(1);
    // ⭐ AT COST: 10 kg that cost ₱300 each. ⚠️ NOT ₱3,100 — the margin is only earned on goods
    // that actually arrive, so valuing the gap at the transfer rate would relieve `1340` by more
    // than the dispatch ever put into it.
    expect(res.inTransitRemaining).toBe(money('3000.00'));

    const com = await balances(commissary);
    // ⭐ ₱30,000 in at dispatch, ₱27,000 of cost out at receipt — the rest is goods in a truck that
    // never arrived, and it is a real asset until T-174 says otherwise.
    expect(com['1340']).toBe('3000.00');
    expect(com['1250']).toBe('27900.00');
    // 90 kg × ₱10 of processing — the margin follows the goods, not the dispatch.
    expect(com['5175']).toBe('-900.00');
  });

  it('⚠️ a difference inside 0.005 is NOT a discrepancy — two scales, not a problem', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    const res = await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ receivedQuantity: quantity('99.996') })],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.discrepancies).toHaveLength(0);
  });

  it('⭐ a UNIT MISMATCH flags and skips the balance — the corrupt number never lands', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    const res = await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ branchBaseUnit: 'g' })],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unitMismatches).toHaveLength(1);
    expect(res.unitMismatches[0]).toContain('Stock was NOT added');
    // ⛔ No branch stock. Adding commissary-denominated quantity to a balance the branch reads in
    // grams is exactly the corruption the guard exists to prevent.
    expect(await onHand(brItemA, brKitchen)).toBe('0');

    // ⭐ **AND NO VALUE EITHER — this is where v2 parts company with v1.** v1 skips the balance and
    // books the value anyway, which debits the branch's 1310 for goods its stock ledger never
    // received. Under perpetual inventory that gap is permanent and no later count explains it.
    expect(res.entryId).toBeNull();
    expect(res.value).toBe(money('0.00'));
    // The whole shipment stays in transit, at what it cost.
    expect(res.inTransitRemaining).toBe(money('30000.00'));
    const br = await balances(branch);
    expect(br['1310']).toBeUndefined();
    expect((await balances(commissary))['1340']).toBe('30000.00');
    // ⛔ And no margin was recognised — nothing arrived, so nothing was earned.
    expect((await balances(commissary))['5175']).toBeUndefined();
  });

  it('⚠️ an UNKNOWN branch unit posts normally — the guard refuses to act on what it cannot check', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    const res = await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ branchBaseUnit: null })],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unitMismatches).toHaveLength(0);
    expect(await onHand(brItemA, brKitchen)).toBe('100.000');
  });
});

describe('⭐ a MIXED transfer — two item kinds, two asset accounts, one order', () => {
  /**
   * ⚠️ This is the test that fails if either half of the pipeline resolves ONE account for the
   * whole document. Both halves did, before this test existed: dispatch credited `1310` for
   * everything, and the receipt debited whatever `lines[0]` happened to name.
   *
   * ⭐ A commissary is precisely the store where that is guaranteed to bite — its job is holding
   * several kinds of stock at once and shipping them together in one crate.
   */
  it('credits and debits each line at its own kind’s account', async () => {
    const [sup] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgA},${testItemCode()},'Gloves','supply','pcs',${personA}) returning id`;
    const [brSup] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgA},${testItemCode()},'Gloves (branch)','supply','pcs',${personA}) returning id`;

    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${commissary},'purchase','2026-08-01',${fileA},${personA}) returning id`;
    await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: commissary, deliveryId: d!.id, deliveredOn: '2026-08-01',
        locations: comLocations(), receivedBy: personA,
        lines: [
          { lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '300.0000', locationId: comKitchen },
          { lineId: '2', itemId: sup!.id, itemKind: 'supply', receivedQuantity: quantity('50'), conversionFactor: '1', unitCost: '20.0000', locationId: comKitchen },
        ],
      }),
    );

    const orderId = crypto.randomUUID();
    const dispatched = await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA,
        onHandByItem: { [itemA]: quantity('100'), [sup!.id]: quantity('50') },
        lines: [
          { lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') },
          { lineId: '2', itemId: sup!.id, itemKind: 'supply', sourceLocationId: comKitchen, fulfilledQuantity: quantity('50') },
        ],
      }),
    );
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;

    // ⭐ ₱30,000 of raw material out of 1310, ₱1,000 of supplies out of 1320 — NOT ₱31,000 of 1310.
    // ⚠️ Read off the ENTRY, not the account balance: the purchase that stocked the commissary
    // debited the same accounts, so a cumulative balance would net to zero and prove nothing.
    expect(await entryLegs(dispatched.entryId)).toEqual([
      { code: '1310', debit: '0.00', credit: '30000.00' },
      { code: '1320', debit: '0.00', credit: '1000.00' },
      { code: '1340', debit: '31000.00', credit: '0.00' },
    ]);

    const res = await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [
          receiptLine(),
          {
            lineId: '2', itemId: sup!.id, branchItemId: brSup!.id, branchLocationId: brKitchen,
            dispatchedQuantity: quantity('50'), receivedQuantity: quantity('50'),
            branchBaseUnit: 'pcs', commissaryBaseUnit: 'pcs', rate: '22.0000',
            dispatchCost: money('1000.00'), branchItemKind: 'supply',
          },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // ⭐ The branch's side lands in TWO accounts: 100 × ₱310 and 50 × ₱22.
    const br = await balances(branch);
    expect(br['1310']).toBe('31000.00');
    expect(br['1320']).toBe('1100.00');
    expect(br['2150']).toBe('-32100.00');
    expect(res.value).toBe(money('32100.00'));

    // ⭐ And the commissary's 1340 clears in full across BOTH kinds: ₱31,000 of cost in, ₱31,000
    // out, with ₱1,100 of margin (₱1,000 on the pork, ₱100 on the gloves) to 5175.
    const comAfter = await balances(commissary);
    expect(comAfter['1340']).toBe('0.00');
    expect(comAfter['5175']).toBe('-1100.00');

    // ⛔ Still no revenue and no payable — a bigger, mixed order does not change the treatment.
    const all = await balances();
    for (const code of Object.keys(all)) expect(code.startsWith('4')).toBe(false);
    expect(all['2110']).toBeUndefined();
  });

  it('⛔ an unmapped item kind blocks BEFORE any stock moves', async () => {
    await stockCommissary();
    const res = await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId: crypto.randomUUID(),
        dispatchedOn: '2026-08-20', dispatchedBy: personA,
        onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'sorcery', sourceLocationId: comKitchen, fulfilledQuantity: quantity('10') }],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('no inventory account');
    // ⭐ The commissary's shelf is untouched — the refusal came before the first write.
    expect(await onHand(itemA, comKitchen)).toBe('100.000');
  });
});

describe('T-173 — the branch’s own delivery record', () => {
  async function dispatchAndReceive(receivedQty: string, unit: string | null = 'kg') {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    return withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ receivedQuantity: quantity(receivedQty), branchBaseUnit: unit })],
      }),
    );
  }

  it('⭐ lands on the BRANCH, exempt from the photo gate, posting nothing of its own', async () => {
    const res = await dispatchAndReceive('100');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [d] = await sql<{ store_id: string; kind: string; status: string; proof_file_id: string | null }[]>`
      select store_id, kind, status, proof_file_id from deliveries where id = ${res.deliveryId}`;
    expect(d!.store_id).toBe(branch);
    expect(d!.kind).toBe('commissary');
    expect(d!.status).toBe('received');
    // ⭐ No photo. `deliveries_proof_required_check` exempts a commissary row by kind — there is no
    // paper to photograph, and the commissary's dispatch is the corroboration.
    expect(d!.proof_file_id).toBeNull();

    // ⛔ Exactly ONE entry for the receipt. A second posting off this delivery would double the
    // branch's inventory — the reason the row is a record and not a document that posts.
    const [n] = await sql<{ c: string }[]>`
      select count(*)::text as c from journal_entries
      where source_id = ${res.deliveryId} or source_type = 'delivery'`;
    expect(n!.c).toBe('0');
  });

  it('⭐ records a REFUSED line too — a shipment whose units were wrong still arrived', async () => {
    const res = await dispatchAndReceive('100', 'g');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unitMismatches).toHaveLength(1);

    // ⚠️ No stock, no value, no entry — but the delivery row and its line exist, which is the only
    // way anyone finds out that a crate is standing at the branch unaccounted for.
    expect(res.entryId).toBeNull();
    const [l] = await sql<{ ordered_quantity: string; received_quantity: string; unit_cost: string }[]>`
      select ordered_quantity, received_quantity, unit_cost from delivery_lines
      where delivery_id = ${res.deliveryId}`;
    expect(l!.ordered_quantity).toBe('100.000');
    expect(l!.received_quantity).toBe('100.000');
    expect(l!.unit_cost).toBe('310.0000');
  });

  it('records the SHORT quantity, not the dispatched one', async () => {
    const res = await dispatchAndReceive('90');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [l] = await sql<{ ordered_quantity: string; received_quantity: string }[]>`
      select ordered_quantity, received_quantity from delivery_lines where delivery_id = ${res.deliveryId}`;
    expect(l!.ordered_quantity).toBe('100.000');
    expect(l!.received_quantity).toBe('90.000');
  });
});

describe('T-172/T-173 — the invariants that must survive', () => {
  it('⭐ 1250 equals 2150 across the org — invariant 6’s reciprocal check', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA, lines: [receiptLine()],
      }),
    );
    const [r] = await sql<{ due_from: string; due_to: string }[]>`
      select
        (select coalesce(sum(l.debit) - sum(l.credit),0)::text from journal_lines l join accounts a on a.id=l.account_id where a.code='1250' and a.org_id=${orgA}) as due_from,
        (select coalesce(sum(l.credit) - sum(l.debit),0)::text from journal_lines l join accounts a on a.id=l.account_id where a.code='2150' and a.org_id=${orgA}) as due_to`;
    expect(r!.due_from).toBe(r!.due_to);
  });

  it('the party on each store line is the OTHER store’s code', async () => {
    await stockCommissary('10', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('10') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('10') }],
      }),
    );
    await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ dispatchedQuantity: quantity('10'), receivedQuantity: quantity('10') })],
      }),
    );
    const rows = await sql<{ code: string; party_id: string }[]>`
      select a.code, l.party_id from journal_lines l join accounts a on a.id = l.account_id
      where a.code in ('1250','2150')`;
    expect(rows.find((r) => r.code === '1250')!.party_id).toBe('BR');
    expect(rows.find((r) => r.code === '2150')!.party_id).toBe('COM');
  });

  it('the trial balance ties across both stores', async () => {
    await stockCommissary('100', '300.0000');
    const orderId = crypto.randomUUID();
    await withOrgPrincipal(orgA, (tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId, dispatchedOn: '2026-08-20',
        dispatchedBy: personA, onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    await withOrgPrincipal(orgA, (tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR',
        orderId, receivedOn: '2026-08-21', receivedBy: personA,
        lines: [receiptLine({ receivedQuantity: quantity('90') })],
      }),
    );
    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l
      join accounts a on a.id = l.account_id where a.org_id = ${orgA}`;
    expect(tb!.net).toBe('0.00');
  });
});

describe('T-172 — the order document’s own rules', () => {
  /** ⚠️ ONE customer row, reused — `customers_org_name_key` would otherwise be the duplicate
   *  the second call trips, and the test would pass for the wrong reason. */
  async function branchAsCounterparty(): Promise<string> {
    const [existing] = await sql<{ id: string }[]>`
      select id from customers where org_id = ${orgA} and counterparty_store_id = ${branch}`;
    if (existing) return existing.id;
    const [cst] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
      values (${orgA},'Branch as counterparty','internal',${branch},${personA}) returning id`;
    return cst!.id;
  }

  async function makeOrder(status = 'draft'): Promise<string> {
    const customerId = await branchAsCounterparty();
    const [o] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, requested_by_store_id, created_by)
      values (${orgA},${commissary},${customerId},'2026-08-20',${status},1,${branch},${personA}) returning id`;
    return o!.id;
  }

  it('⭐ one open order at a time per (branch, commissary)', async () => {
    await makeOrder();
    await expect(makeOrder()).rejects.toThrow(/one_open_per_branch/);
  });

  it('⛔ a commissary-added line always needs the branch’s answer', async () => {
    const id = await makeOrder();
    await expect(
      sql`insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total, origin, approval)
          values (${orgA},${id},${itemA},1,'kg',1,1,'commissary_added','not_required')`,
    ).rejects.toThrow(/added_needs_approval/);
  });

  it('⭐ submit is refused while a line has no expense category', async () => {
    const id = await makeOrder();
    await sql`insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total, requested_quantity)
              values (${orgA},${id},${itemA},1,'kg',1,1,1)`;
    await expect(
      sql`update trade_orders set status='confirmed' where id=${id}`,
    ).rejects.toThrow(/no expense category/);
  });

  it('and refused while a commissary addition is still pending', async () => {
    const id = await makeOrder();
    const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id=${orgA} limit 1`;
    await sql`insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total, requested_quantity, expense_category_id, origin, approval)
              values (${orgA},${id},${itemA},1,'kg',1,1,1,${cat!.id},'commissary_added','pending')`;
    await expect(
      sql`update trade_orders set status='confirmed' where id=${id}`,
    ).rejects.toThrow(/awaiting the branch decision/);
  });
});
