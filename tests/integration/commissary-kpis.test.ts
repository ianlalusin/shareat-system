/**
 * T-212 — the commissary KPI reads. `docs/tasks/212-commissary-and-inventory-kpis.md`.
 *
 * ⭐ **The load-bearing test here is a REGRESSION test, not a coverage test.** v1's
 * `monthReceivedTotal` sums the order header's dispatched amount, so a month with a short receipt
 * overstates (discovery 26 §B.4). `receivedInRange` reads LINES, and the test below asserts the two
 * differ — so the fix fails loudly the moment somebody "simplifies" it back to `total_amount`.
 *
 * Cross-layer by nature: it exercises a `packages/db` read over rows that `packages/domain`'s real
 * posting path wrote, which is why it lives here rather than under either package.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, commissaryKpisRepo, transaction } from '@shareat/db';
import { getDb } from '@shareat/db/client';
import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../packages/db/seed/expense-categories';
import { receiveDelivery } from '../../packages/domain/src/deliveries/receive';
import { confirmReceipt, dispatchOrder } from '../../packages/domain/src/commissary/transfer';
import { quantity } from '../../packages/domain/src/stock/quantity';
import type { LocationLike } from '../../packages/domain/src/stock-locations/rules';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, commissary: string, branch: string, personA: string, fileA: string;
let comKitchen: string, brKitchen: string, itemA: string, brItemA: string;
let internalCustomer: string, externalCustomer: string, periodA: string;
let acct1340: string, acct1310: string;
let extraBranchSeq = 0;

/** The repo functions take an `Executor` — a drizzle handle, not the raw postgres.js client. */
const db = () => getDb();

/**
 * ⚠️ `trade_orders_one_open_per_branch_key` (migration `0070`) allows exactly ONE open order per
 * (requesting branch, commissary) across draft/confirmed/dispatched. Any test needing two
 * branch-INITIATED orders in flight at once therefore needs two branches — that constraint is the
 * feature, not an obstacle to route around.
 */
async function anotherBranch(): Promise<string> {
  extraBranchSeq += 1;
  const [s] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model)
    values (${orgA}, ${'BR' + extraBranchSeq}, ${'Branch ' + extraBranchSeq}, 'multi_room') returning id`;
  return s!.id;
}

const comLocations = (): LocationLike[] => [
  { id: comKitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
];

/**
 * ⚠️ Ages are pinned to **Manila noon**, N days back, not to `now() - interval 'N days'`.
 * `reference_server_side_time_formatting_utc`: a date built off the server clock passes in Manila
 * and fails on a UTC CI box within eight hours of midnight. Noon is far from either boundary, so
 * the Manila-date difference is exactly N wherever this runs.
 */
function manilaNoonDaysAgo(days: number) {
  return sql`((((now() at time zone 'Asia/Manila')::date - ${days}::int)::timestamp + interval '12 hours') at time zone 'Asia/Manila')`;
}

/** 100 kg into the commissary at ₱300 — the same worked case commissary-transfer.test.ts uses. */
async function stockCommissary(qty = '100', cost = '300.0000') {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${commissary},'purchase','2026-08-01',${fileA},${personA}) returning id`;
  await transaction((tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: commissary, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: comLocations(), receivedBy: personA,
      lines: [{
        lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity(qty),
        conversionFactor: '1', unitCost: cost, locationId: comKitchen,
      }],
    }),
  );
}

interface OrderOpts {
  customerId?: string;
  status?: string;
  /** `quantity × rate`, and what `line_total` carries — dispatched value. */
  qty?: string;
  rate?: string;
  receivedQty?: string | null;
  deliveryFee?: string;
  otherFees?: string;
  acceptedAt?: boolean;
  readyAt?: boolean;
  isLedgerOnly?: boolean;
  receivedAt?: string | null;
  /** Which branch initiated it. Defaults to a FRESH branch so the one-open-per-branch unique
   *  index never collides between two fixtures in the same test. */
  requestedByStoreId?: string;
}

/**
 * `trade_orders_dispatch_shape_check` demands a journal entry on any dispatched/received order, and
 * `journal_entries_balance_check` (migration `0003`) is a **DEFERRABLE INITIALLY DEFERRED**
 * constraint trigger — it fires at COMMIT, not at insert, so a bare entry cannot be created and
 * back-filled across two statements. Entry and its two balanced legs go in one transaction.
 *
 * ⚠️ `journal_entries` has no `created_by`; `period_id` and `source_id` are both NOT NULL
 * (invariant 4 — every posting traces to a source document).
 */
async function makeBalancedEntry(): Promise<string> {
  // ⚠️ And the order is forced: `journal_lines` may only be inserted while the entry is DRAFT
  // (immutability, invariant 16), so it is draft → lines → post, never posted-then-filled.
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, memo)
      values (${orgA},'2026-08-20',${periodA},'trade_order_dispatch',${crypto.randomUUID()},'draft','fixture')
      returning id`;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${acct1340}, ${commissary}, '1.00', '0'),
             (${e!.id}, 2, ${acct1310}, ${commissary}, '0', '1.00')`;
    await tx`
      update journal_entries set status='posted', posted_at=now(), posted_by=${personA}
      where id = ${e!.id}`;
    return e!.id;
  }) as unknown as string;
}

/**
 * One order + one line, inserted directly. ⚠️ Legitimate as a fixture because every function under
 * test is a pure READ — no posting path is being bypassed. The discrepancy tests below are the
 * exception and go through the real `confirmReceipt`.
 */
async function makeOrder(o: OrderOpts = {}): Promise<{ orderId: string; lineId: string }> {
  const qty = o.qty ?? '10';
  const rate = o.rate ?? '350.00';
  const lineTotal = (Number(qty) * Number(rate)).toFixed(2);
  const fees = Number(o.deliveryFee ?? '0') + Number(o.otherFees ?? '0');
  const total = (Number(lineTotal) + fees).toFixed(2);
  const status = o.status ?? 'received';
  const needsDispatch = status === 'dispatched' || status === 'received';

  const entryId = needsDispatch ? await makeBalancedEntry() : null;

  // `trade_orders_branch_stage_check`: accepted_at implies a branch-initiated order.
  const isBranchInitiated = Boolean(o.acceptedAt || o.readyAt || o.requestedByStoreId);
  const requestedBy = isBranchInitiated ? (o.requestedByStoreId ?? (await anotherBranch())) : null;

  const [ord] = await sql<{ id: string }[]>`
    insert into trade_orders (
      org_id, store_id, customer_id, order_date, status, total_amount,
      delivery_fee, other_fees, requested_by_store_id,
      accepted_at, accepted_by, ready_at, ready_by,
      dispatched_at, dispatched_by, journal_entry_id, received_at, received_by, created_by)
    values (
      ${orgA}, ${commissary}, ${o.customerId ?? internalCustomer}, '2026-08-20', ${status}, ${total},
      ${o.deliveryFee ?? '0'}, ${o.otherFees ?? '0'}, ${requestedBy},
      ${o.acceptedAt || o.readyAt ? sql`now()` : null}, ${o.acceptedAt || o.readyAt ? personA : null},
      ${o.readyAt ? sql`now()` : null}, ${o.readyAt ? personA : null},
      ${needsDispatch ? sql`now()` : null}, ${needsDispatch ? personA : null}, ${entryId},
      ${status === 'received' ? (o.receivedAt ? sql`${o.receivedAt}::timestamptz` : sql`now()`) : null},
      ${status === 'received' ? personA : null},
      ${personA})
    returning id`;

  const [line] = await sql<{ id: string }[]>`
    insert into trade_order_lines (
      org_id, order_id, item_id, quantity, unit, rate, line_total,
      fulfilled_quantity, received_quantity, is_ledger_only)
    values (${orgA}, ${ord!.id}, ${itemA}, ${qty}, 'kg', ${rate}, ${lineTotal},
      ${qty}, ${o.receivedQty === undefined ? qty : o.receivedQty}, ${o.isLedgerOnly ?? false})
    returning id`;

  return { orderId: ord!.id, lineId: line!.id };
}

beforeEach(async () => {
  await sql`
    truncate table trade_discrepancies, commissary_item_map, commissary_item_offerings, commissary_links,
      trade_order_lines, trade_orders, customers, expense_categories, count_lines,
      count_session_locations, count_sessions, stock_usage_lines, stock_usage_records,
      delivery_lines, deliveries, stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments, journal_lines, journal_entries,
      fiscal_periods, audit_log, stored_files, accounts, items, person_identities, persons,
      stores, organizations restart identity cascade`;
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
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'PORK','Pork','raw_material','kg',${personA}) returning id`;
  const [i2] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'PORK-BR','Pork (branch)','raw_material','kg',${personA}) returning id`;
  itemA = i!.id; brItemA = i2!.id;
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${personA}) returning id`;
  fileA = f!.id;

  // ⭐ The two customer treatments this whole file turns on — `treatmentOf` is exactly
  // "counterparty_store_id is not null" (repo/customers.ts:53-59).
  const [ic] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, counterparty_store_id, created_by)
    values (${orgA},'Branch (internal)',${branch},${personA}) returning id`;
  const [ec] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, created_by)
    values (${orgA},'Franchisee (external)',${personA}) returning id`;
  internalCustomer = ic!.id; externalCustomer = ec!.id;

  await seedChartOfAccounts(sql, orgA);
  await seedExpenseCategories(sql, orgA);
  const [fp] = await sql<{ id: string }[]>`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgA},'2026-08-01','2026-08-31','open') returning id`;
  periodA = fp!.id;
  extraBranchSeq = 0;
  const [a1] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgA} and code = '1340'`;
  const [a2] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgA} and code = '1310'`;
  acct1340 = a1!.id; acct1310 = a2!.id;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ALL_TIME = { fromDate: '2000-01-01', toDate: '2100-01-01' };

describe('T-212 — receivedInRange, the figure v1 gets wrong', () => {
  it('⭐ REGRESSION: reports what ARRIVED, not what was dispatched — and differs from the header total', async () => {
    // 100 dispatched at ₱310, 90 signed for.
    await makeOrder({ qty: '100', rate: '310.00', receivedQty: '90' });

    const r = await commissaryKpisRepo.receivedInRange(db(), { orgId: orgA, ...ALL_TIME });

    expect(r.goodsReceivedValue).toBe('27900.00'); // 90 × 310
    expect(r.goodsDispatchedValue).toBe('31000.00'); // 100 × 310
    expect(r.shortReceivedValue).toBe('3100.00');
    expect(r.unrecordedValue).toBe('0.00');

    // ⛔ THE assertion. v1 would report the header total; if this ever passes, the query has been
    // "simplified" back to `total_amount` and the overstatement is back with it.
    const [o] = await sql<{ total: string }[]>`select total_amount::text as total from trade_orders`;
    expect(o!.total).toBe('31000.00');
    expect(r.goodsReceivedValue).not.toBe(o!.total);
  });

  it('the four figures satisfy dispatched = received + short + unrecorded', async () => {
    await makeOrder({ qty: '100', rate: '310.00', receivedQty: '90' });
    await makeOrder({ qty: '10', rate: '200.00', receivedQty: '10' });
    await makeOrder({ qty: '5', rate: '100.00', receivedQty: null }); // no receipt recorded

    const r = await commissaryKpisRepo.receivedInRange(db(), { orgId: orgA, ...ALL_TIME });
    expect(Number(r.goodsDispatchedValue)).toBeCloseTo(
      Number(r.goodsReceivedValue) + Number(r.shortReceivedValue) + Number(r.unrecordedValue), 2,
    );
    expect(r.unrecordedValue).toBe('500.00');
  });

  it('⛔ a line with NO recorded receipt is unrecorded, NEVER short', async () => {
    // The ledger-only case: `receiveTradeOrder` skips these deliberately, so received_quantity
    // stays null. Counting it as a zero receipt invents a shortfall that never happened.
    await makeOrder({ qty: '4', rate: '250.00', receivedQty: null, isLedgerOnly: true });

    const r = await commissaryKpisRepo.receivedInRange(db(), { orgId: orgA, ...ALL_TIME });
    expect(r.shortReceivedValue).toBe('0.00');
    expect(r.unrecordedValue).toBe('1000.00');
    expect(r.goodsReceivedValue).toBe('0.00');
  });

  it('⛔ an EXTERNAL wholesale sale is excluded entirely — it records no line receipt and would read 100% short', async () => {
    await makeOrder({ customerId: externalCustomer, qty: '2', rate: '180.00', receivedQty: null });
    await makeOrder({ customerId: internalCustomer, qty: '10', rate: '350.00', receivedQty: '10' });

    const r = await commissaryKpisRepo.receivedInRange(db(), { orgId: orgA, ...ALL_TIME });
    expect(r.orderCount).toBe(1);
    expect(r.goodsReceivedValue).toBe('3500.00');
    expect(r.shortReceivedValue).toBe('0.00');
    expect(r.unrecordedValue).toBe('0.00'); // ⛔ the external sale's ₱360 must not appear anywhere
  });

  it('fees ride separately and never enter the goods figure', async () => {
    await makeOrder({ qty: '10', rate: '350.00', receivedQty: '10', deliveryFee: '500.00', otherFees: '50.00' });

    const r = await commissaryKpisRepo.receivedInRange(db(), { orgId: orgA, ...ALL_TIME });
    expect(r.goodsReceivedValue).toBe('3500.00');
    expect(r.feesValue).toBe('550.00');
  });

  it('the date range filters on the Manila date of received_at', async () => {
    await makeOrder({ qty: '10', rate: '350.00', receivedQty: '10', receivedAt: '2026-08-20T04:00:00Z' });

    const inRange = await commissaryKpisRepo.receivedInRange(db(), {
      orgId: orgA, fromDate: '2026-08-20', toDate: '2026-08-20',
    });
    const outOfRange = await commissaryKpisRepo.receivedInRange(db(), {
      orgId: orgA, fromDate: '2026-08-21', toDate: '2026-08-31',
    });
    expect(inRange.orderCount).toBe(1);
    expect(outOfRange.orderCount).toBe(0);
    expect(outOfRange.goodsReceivedValue).toBe('0.00');
  });
});

describe('T-212 — inFlightOrders', () => {
  it('derives the four stages from timestamps, and a stage with no orders is ABSENT not zero', async () => {
    await makeOrder({ status: 'confirmed' }); // submitted
    await makeOrder({ status: 'confirmed', acceptedAt: true }); // accepted
    await makeOrder({ status: 'confirmed', acceptedAt: true, readyAt: true }); // ready
    await makeOrder({ status: 'dispatched' });

    const rows = await commissaryKpisRepo.inFlightOrders(db(), { orgId: orgA });
    expect(rows.map((r) => r.stage)).toEqual(['submitted', 'accepted', 'ready', 'dispatched']);
    expect(rows.every((r) => r.orderCount === 1)).toBe(true);
  });

  it('⛔ excludes draft, received and void — and a stage with nothing in it emits no row', async () => {
    await makeOrder({ status: 'draft' });
    await makeOrder({ status: 'received' });
    await makeOrder({ status: 'confirmed' }); // the only in-flight one

    const rows = await commissaryKpisRepo.inFlightOrders(db(), { orgId: orgA });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe('submitted');
    // ⛔ v1 pre-seeds all eight statuses with zeros; bible §16.9 — a permanently-zero line is noise.
    expect(rows.some((r) => r.orderCount === 0)).toBe(false);
  });

  it('excludes external wholesale orders', async () => {
    await makeOrder({ status: 'confirmed', customerId: externalCustomer });
    const rows = await commissaryKpisRepo.inFlightOrders(db(), { orgId: orgA });
    expect(rows).toHaveLength(0);
  });
});

describe('T-212 — openDisputes, and the AGE that was never on a screen', () => {
  /** Ages a discrepancy deterministically, pinned to Manila noon. */
  async function ageDispute(id: string, days: number) {
    await sql`update trade_discrepancies set created_at = ${manilaNoonDaysAgo(days)} where id = ${id}`;
  }

  /**
   * ⭐ The dispute row is written by the REAL `confirmReceipt`, in its own transaction — never hand
   * -inserted. T-174's whole guarantee is that a shortfall cannot sit in `1340` without a row
   * naming it, and a fixture that writes the row itself would prove nothing about that.
   */
  async function realDispute(receivedQty: string): Promise<string> {
    await stockCommissary();
    const { orderId, lineId } = await makeOrder({ qty: '100', rate: '310.00', receivedQty });
    await transaction((tx) =>
      dispatchOrder(tx, {
        orgId: orgA, commissaryStoreId: commissary, orderId,
        dispatchedOn: '2026-08-20', dispatchedBy: personA,
        onHandByItem: { [itemA]: quantity('100') },
        lines: [{ lineId, itemId: itemA, itemKind: 'raw_material', sourceLocationId: comKitchen, fulfilledQuantity: quantity('100') }],
      }),
    );
    const res = await transaction((tx) =>
      confirmReceipt(tx, {
        orgId: orgA, commissaryStoreId: commissary, branchStoreId: branch,
        commissaryStoreCode: 'COM', branchStoreCode: 'BR', orderId,
        receivedOn: '2026-08-21', receivedBy: personA,
        orderLineIdByLineId: { [lineId]: lineId },
        lines: [{
          lineId, itemId: itemA, branchItemId: brItemA, branchLocationId: brKitchen,
          dispatchedQuantity: quantity('100'), receivedQuantity: quantity(receivedQty),
          branchBaseUnit: 'kg', commissaryBaseUnit: 'kg', rate: '310.0000',
          dispatchCost: money('30000.00'), branchItemKind: 'raw_material', shortageReason: null,
        }],
      }),
    );
    expect(res.ok).toBe(true);
    const [d] = await sql<{ id: string }[]>`select id from trade_discrepancies where order_id = ${orderId}`;
    expect(d).toBeDefined();
    return d!.id;
  }

  it('⭐ confirmReceipt raises the row, and the KPI reports its AGE — the phase-6 exit criterion', async () => {
    const id = await realDispute('90');
    await ageDispute(id, 20);

    const d = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA });
    expect(d.count).toBe(1);
    expect(d.oldestAgeDays).toBe(20);
    expect(d.buckets).toEqual({ fresh: 0, ageing: 0, overdue: 1 });
    expect(d.rows[0]!.ageDays).toBe(20);
    // ⚠️ At COST (100−90 = 10 kg × ₱300), never at the ₱310 transfer rate — the schema's doc
    // comment says "transfer rate" and is wrong; transfer.ts:423-429 is right. See DEF section E.
    expect(d.rows[0]!.value).toBe('3000.00');
  });

  it('buckets by age at the 7- and 15-day boundaries', async () => {
    for (const [qty, days] of [['90', 3], ['80', 10], ['70', 20]] as const) {
      await ageDispute(await realDispute(String(qty)), days);
    }
    const d = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA });
    expect(d.count).toBe(3);
    expect(d.buckets).toEqual({ fresh: 1, ageing: 1, overdue: 1 });
    expect(d.oldestAgeDays).toBe(20);
    expect(d.rows.map((r) => r.ageDays)).toEqual([20, 10, 3]); // oldest first
  });

  it('⚠️ a DEFERRED dispute is still counted and still ages — a deferral is not an exemption', async () => {
    const id = await realDispute('90');
    await ageDispute(id, 18);
    await sql`update trade_discrepancies set status = 'deferred', deferred_to = '2026-12-31' where id = ${id}`;

    const d = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA });
    expect(d.count).toBe(1);
    expect(d.deferredCount).toBe(1);
    expect(d.buckets.overdue).toBe(1);
    expect(d.oldestAgeDays).toBe(18);
  });

  it('a resolved dispute leaves the list entirely', async () => {
    const id = await realDispute('90');
    await sql`
      update trade_discrepancies
      set status='resolved', disposition='loss', resolved_at=now(), resolved_by=${personA}
      where id = ${id}`;

    const d = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA });
    expect(d.count).toBe(0);
    expect(d.totalValue).toBe('0.00');
    expect(d.rows).toHaveLength(0);
  });

  it('⛔ the display cap never truncates a count or a total', async () => {
    // 25 hand-written rows — this test is about the cap, not about who writes the row.
    const { orderId, lineId } = await makeOrder({ qty: '100', rate: '310.00', receivedQty: '90' });
    for (let i = 0; i < 25; i++) {
      const [l] = await sql<{ id: string }[]>`
        insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
        values (${orgA},${orderId},${itemA},'1','kg','310.00','310.00') returning id`;
      await sql`
        insert into trade_discrepancies (org_id, store_id, order_id, order_line_id, quantity, value)
        values (${orgA},${commissary},${orderId},${l!.id},'1','100.00')`;
    }
    void lineId;

    const d = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA });
    expect(d.count).toBe(25);
    expect(d.rows).toHaveLength(commissaryKpisRepo.DISPUTE_ROW_CAP);
    expect(d.totalValue).toBe('2500.00'); // ⛔ all 25, not the capped 20
  });

  it('scopes to the COMMISSARY store, which is where the stranded value sits', async () => {
    const id = await realDispute('90');
    void id;
    const mine = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA, storeId: commissary });
    const theirs = await commissaryKpisRepo.openDisputes(db(), { orgId: orgA, storeId: branch });
    expect(mine.count).toBe(1);
    expect(theirs.count).toBe(0); // ⚠️ T-174 invariant 11 — not the branch's dispute to hold
  });
});
