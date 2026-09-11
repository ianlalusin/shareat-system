import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, tradeDiscrepanciesRepo, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { confirmReceipt, dispatchOrder } from '../../src/commissary/transfer';
import { deferDiscrepancy, resolveDiscrepancy } from '../../src/commissary/discrepancy';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';

/**
 * T-174 — what happens to the goods that never arrived.
 *
 * ⭐ T-173 leaves a short receipt's difference sitting in `1340 Inventory in transit`, because
 * goods that visibly left one building and did not reach another are a REAL ASSET until somebody
 * says otherwise. These tests are about somebody saying otherwise.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, commissary: string, branch: string, personA: string, personB: string, fileA: string;
let comKitchen: string, brKitchen: string, itemA: string, brItemA: string;
let orderId: string, orderLineId: string;

const comLocations = (): LocationLike[] => [
  { id: comKitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
];

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

/** 100 kg in at ₱300, 100 dispatched at ₱310, `received` of them confirmed. */
async function shipAndReceive(received: string): Promise<string | null> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${commissary},'purchase','2026-08-01',${fileA},${personA}) returning id`;
  await withOrgPrincipal(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: commissary, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: comLocations(), receivedBy: personA,
      lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '300.0000', locationId: comKitchen }],
    }),
  );
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
      orderLineIdByLineId: { '1': orderLineId },
      lines: [{
        lineId: '1', itemId: itemA, branchItemId: brItemA, branchLocationId: brKitchen,
        dispatchedQuantity: quantity('100'), receivedQuantity: quantity(received),
        branchBaseUnit: 'kg', commissaryBaseUnit: 'kg', rate: '310.0000',
        dispatchCost: money('30000.00'), branchItemKind: 'raw_material',
      }],
    }),
  );
  if (!res.ok) throw new Error(res.reason);
  return res.discrepancies[0]?.id ?? null;
}

beforeEach(async () => {
  await sql`
    truncate table trade_discrepancies, commissary_item_map, commissary_item_offerings,
      commissary_links, trade_order_lines, trade_orders, customers, expense_categories,
      count_lines, count_session_locations, count_sessions,
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
  const [p2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Driver Ben') returning id`;
  personA = p!.id; personB = p2!.id;
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
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgA},'2026-08-01','2026-08-31','open')`;

  const [cst] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${orgA},'Branch as counterparty','internal',${branch},${personA}) returning id`;
  const [ord] = await sql<{ id: string }[]>`
    insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, requested_by_store_id, created_by)
    values (${orgA},${commissary},${cst!.id},'2026-08-20','draft',31000,${branch},${personA}) returning id`;
  orderId = ord!.id;
  const [line] = await sql<{ id: string }[]>`
    insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total, requested_quantity)
    values (${orgA},${orderId},${itemA},100,'kg',310,31000,100) returning id`;
  orderLineId = line!.id;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-174 — the row is raised BY the confirm, never by hand', () => {
  it('⭐ 90 against 100 raises exactly one open discrepancy, at the line rate', async () => {
    const id = await shipAndReceive('90');
    expect(id).not.toBeNull();

    const [d] = await sql<{ quantity: string; value: string; status: string; disposition: string | null; store_id: string }[]>`
      select quantity, value, status, disposition, store_id from trade_discrepancies`;
    expect(d!.quantity).toBe('10.000');
    // ⭐ 10 × ₱300 — AT COST, because cost is what `1340` is actually holding. ⚠️ Valuing the
    // dispute at the ₱310 transfer rate would make every disposal relieve `1340` by ₱100 more
    // than the dispatch put in, leaving the account negative once per dispute.
    expect(d!.value).toBe('3000.00');
    expect(d!.status).toBe('open');
    expect(d!.disposition).toBeNull();
    // ⚠️ The COMMISSARY's row: it is the commissary's asset and its manager's decision.
    expect(d!.store_id).toBe(commissary);

    expect((await balances(commissary))['1340']).toBe('3000.00');
  });

  it('a receipt in full raises nothing', async () => {
    const id = await shipAndReceive('100');
    expect(id).toBeNull();
    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_discrepancies`;
    expect(n!.c).toBe('0');
  });

  it('⚠️ a difference inside the 0.005 measurement tolerance raises nothing either', async () => {
    await shipAndReceive('99.996');
    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_discrepancies`;
    expect(n!.c).toBe('0');
  });

  it('⛔ one per order line — a second confirm cannot raise a second dispute', async () => {
    await shipAndReceive('90');
    await expect(
      sql`insert into trade_discrepancies (org_id, store_id, order_id, order_line_id, quantity, value)
          values (${orgA},${commissary},${orderId},${orderLineId},1,1)`,
    ).rejects.toThrow(/trade_discrepancies_line_key/);
  });
});

describe('T-174 — the three dispositions, and each is a different account', () => {
  it('⭐ LOSS posts Dr 5300 / Cr 1340 and relieves the transit account exactly', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'loss', note: 'spoiled on the road', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(money('3000.00'));

    const com = await balances(commissary);
    // ⭐ 1340 back to zero — the whole point. Nothing is left holding a ghost.
    expect(com['1340']).toBe('0.00');
    expect(com['5300']).toBe('3000.00');
    // ⚠️ 5400 is the COUNT variance account and must not be touched: this is a loss, not a
    // correction to the books.
    expect(com['5400']).toBeUndefined();

    const [d] = await sql<{ status: string; disposition: string; resolved_by: string }[]>`
      select status, disposition, resolved_by from trade_discrepancies where id = ${id}`;
    expect(d!.status).toBe('resolved');
    expect(d!.disposition).toBe('loss');
    expect(d!.resolved_by).toBe(personA);
  });

  it('⭐ CHARGE posts Dr 1230 / Cr 1340 with the person as party', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'charge', chargePersonId: personB,
        resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const com = await balances(commissary);
    expect(com['1340']).toBe('0.00');
    // ⚠️ An ASSET, not an expense. It is a receivable from the staffer, drawn down by payroll.
    expect(com['1230']).toBe('3000.00');
    expect(com['5300']).toBeUndefined();

    const [l] = await sql<{ party_type: string; party_id: string }[]>`
      select l.party_type, l.party_id from journal_lines l
      join accounts a on a.id = l.account_id where a.code = '1230'`;
    expect(l!.party_type).toBe('employee');
    expect(l!.party_id).toBe(personB);
  });

  it('⛔ a charge with nobody named is refused, and posts nothing', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'charge', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(false);
    expect((await balances(commissary))['1340']).toBe('3000.00');
  });

  it('⛔ a LOSS that names a person is refused — the two dispositions are not interchangeable', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'loss', chargePersonId: personB, resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(false);
  });

  it('⭐ AUDIT posts nothing, leaves the value in 1340 — and STAYS OPEN', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'audit', note: 'recount tomorrow', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entryId).toBeNull();
    expect((await balances(commissary))['1340']).toBe('3000.00');

    // ⭐ Still open, so the day-open block keeps refusing. An `audit` that stopped the blocking
    // would be a way to make a dispute disappear without deciding it.
    const [d] = await sql<{ status: string; disposition: string }[]>`
      select status, disposition from trade_discrepancies where id = ${id}`;
    expect(d!.status).toBe('open');
    expect(d!.disposition).toBe('audit');
  });

  it('LATE RECEIPT closes the row and posts nothing here', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'late_receipt', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ⚠️ T-173's own second confirm posts the balance. Posting here as well would relieve 1340
    // twice for one lot of goods.
    expect(res.entryId).toBeNull();
    expect((await balances(commissary))['1340']).toBe('3000.00');
    const [d] = await sql<{ status: string }[]>`select status from trade_discrepancies where id = ${id}`;
    expect(d!.status).toBe('resolved');
  });
});

describe('T-174 — the rules the database keeps, not the service', () => {
  it('⭐ defer once succeeds; a SECOND defer is refused', async () => {
    const id = (await shipAndReceive('90'))!;
    const first = await withOrgPrincipal(orgA, (tx) =>
      deferDiscrepancy(tx, { orgId: orgA, discrepancyId: id, commissaryStoreId: commissary, toDate: '2026-08-25' }),
    );
    expect(first.ok).toBe(true);

    // ⛔ v1's rule verbatim, and the whole reason defer is safe to offer: a dispute cannot be
    // pushed down the road indefinitely.
    await expect(
      withOrgPrincipal(orgA, (tx) =>
        deferDiscrepancy(tx, { orgId: orgA, discrepancyId: id, commissaryStoreId: commissary, toDate: '2026-09-30' }),
      ),
    ).rejects.toThrow(/already deferred/);
  });

  it('⛔ resolution is TERMINAL — a resolved row is not editable, even by raw SQL', async () => {
    const id = (await shipAndReceive('90'))!;
    await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'loss', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    await expect(
      sql`update trade_discrepancies set disposition = 'audit' where id = ${id}`,
    ).rejects.toThrow(/reverse it and resolve again/);

    const second = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'charge', chargePersonId: personB, resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain('already resolved');
    // ⭐ And 1340 was relieved exactly once.
    expect((await balances(commissary))['1340']).toBe('0.00');
  });

  it('⛔ the BRANCH cannot decide what the difference was', async () => {
    const id = (await shipAndReceive('90'))!;
    const res = await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: branch,
        disposition: 'loss', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('the branch reports, it does not decide');
  });
});

describe('T-174 — ⭐ the blocking list, derived every time', () => {
  it('an OPEN one blocks; a resolved one does not', async () => {
    const id = (await shipAndReceive('90'))!;
    let blocking = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-22'));
    expect(blocking).toHaveLength(1);

    await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'loss', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    blocking = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-22'));
    expect(blocking).toHaveLength(0);
  });

  it('⭐ an AUDITED one still blocks — the decision was to wait, not to finish', async () => {
    const id = (await shipAndReceive('90'))!;
    await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'audit', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    const blocking = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-22'));
    expect(blocking).toHaveLength(1);
  });

  it('⭐ a deferral is a promise, not an exemption: clear until the date, blocking ON it', async () => {
    const id = (await shipAndReceive('90'))!;
    await withOrgPrincipal(orgA, (tx) =>
      deferDiscrepancy(tx, { orgId: orgA, discrepancyId: id, commissaryStoreId: commissary, toDate: '2026-08-25' }),
    );
    const before = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-24'));
    expect(before).toHaveLength(0);
    const onTheDay = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-25'));
    expect(onTheDay).toHaveLength(1);
    const after = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-26'));
    expect(after).toHaveLength(1);
  });

  it('⚠️ the BRANCH is not blocked by the commissary’s dispute', async () => {
    await shipAndReceive('90');
    const atBranch = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, branch, '2026-08-22'));
    expect(atBranch).toHaveLength(0);
  });

  it('⭐ `blocking` and `unresolved` are ONE query’s worth of truth — they cannot disagree', async () => {
    const id = (await shipAndReceive('90'))!;
    await withOrgPrincipal(orgA, (tx) =>
      deferDiscrepancy(tx, { orgId: orgA, discrepancyId: id, commissaryStoreId: commissary, toDate: '2026-08-25' }),
    );
    // The screen always shows it; the block only refuses from the promised date. ⚠️ The failure
    // this guards against is the other way round — a block that refuses over something the screen
    // does not list, which leaves a manager with nothing to click.
    const listed = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.unresolved(tx, orgA, commissary));
    expect(listed.map((d) => d.id)).toContain(id);
    const blocked = await withOrgPrincipal(orgA, (tx) => tradeDiscrepanciesRepo.blocking(tx, orgA, commissary, '2026-08-25'));
    expect(blocked.map((d) => d.id)).toEqual(listed.map((d) => d.id));
  });
});

describe('T-174 — ⭐ the Phase 3 gate holds on the disposal path', () => {
  /**
   * ⭐ `1340` is the account most likely to be left holding a ghost, which is why the gate is
   * asserted on the DISPOSAL path and not only on the receiving one.
   *
   * ⚠️ Written as two separate cases rather than a loop: truncating `journal_entries` between
   * them would CASCADE to `trade_orders`, which references it — and the fixture would then be
   * rebuilding the very order the second case needs.
   */
  /**
   * ⭐ **TWO ties, not one, and separating them is the finding.** The first draft asserted
   * `1310+1320+1330+1340 = open layer value` and failed by exactly the in-transit amount —
   * correctly. Goods on a truck are deliberately in NO layer: they are not on anybody's shelf, and
   * a FIFO layer is a thing on a shelf.
   *
   * ⚠️ So `1340` is reconciled against a different subledger — the unresolved discrepancy rows.
   * A `1340` balance with nothing unresolved to explain it is the ghost this gate exists to catch.
   */
  async function assertTie(): Promise<void> {
    const [tie] = await sql<{ shelves: string; layers: string; transit: string; disputes: string }[]>`
      select
        (select coalesce(sum(l.debit) - sum(l.credit),0)::text from journal_lines l
           join accounts a on a.id = l.account_id
           where a.org_id = ${orgA} and a.code in ('1310','1320','1330')) as shelves,
        (select coalesce(sum(sl.remaining_quantity * sl.unit_cost),0)::text
           from stock_layers sl where sl.org_id = ${orgA}) as layers,
        (select coalesce(sum(l.debit) - sum(l.credit),0)::text from journal_lines l
           join accounts a on a.id = l.account_id
           where a.org_id = ${orgA} and a.code = '1340') as transit,
        (select coalesce(sum(d.value),0)::text from trade_discrepancies d
           where d.org_id = ${orgA} and d.status <> 'resolved') as disputes`;
    expect(Number(tie!.shelves).toFixed(2)).toBe(Number(tie!.layers).toFixed(2));
    expect(Number(tie!.transit).toFixed(2)).toBe(Number(tie!.disputes).toFixed(2));
  }

  it('holds after a LOSS — 1340 emptied into 5300, and nothing left over', async () => {
    const id = (await shipAndReceive('90'))!;
    await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'loss', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    await assertTie();
  });

  it('holds after an AUDIT — the value is still IN 1340, and that is the point', async () => {
    const id = (await shipAndReceive('90'))!;
    await withOrgPrincipal(orgA, (tx) =>
      resolveDiscrepancy(tx, {
        orgId: orgA, discrepancyId: id, commissaryStoreId: commissary,
        disposition: 'audit', resolvedOn: '2026-08-22', resolvedBy: personA,
      }),
    );
    await assertTie();
  });

  it('⭐ and after a FULL receipt — 1340 clears to zero, holding no ghost at all', async () => {
    await shipAndReceive('100');
    await assertTie();
    const [t] = await sql<{ n: string }[]>`
      select coalesce(sum(l.debit) - sum(l.credit),0)::text n from journal_lines l
      join accounts a on a.id = l.account_id where a.code = '1340'`;
    expect(t!.n).toBe('0.00');
  });
});
