import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Actor, Capability } from '@shareat/auth';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { createDeliveryDocument } from '../../../../packages/domain/src/deliveries/documents';
import { M, asOrg, expectAbsent, expectNotAvailable, expectPresent, expectRefusalCard, pageError, plain, render, sql, uid, world, type World } from './t435-fixture';

/**
 * T-603 S2 - store gates on the store-picker screens (inventory, till, remittance, trade returns, wastage) and on the single
 * inventory records that belong to one store. Spec: docs/tasks/603-store-scope-read-gates.md.
 *
 * Personas (shared T-435 world): W = staff holding ONLY the screen's word at S1 (position grant); C = cashier with no grant (refused);
 * M1 = manager at S1; G = admin with no scope rows (sees every store).
 * Per screen: W is let in; C gets the access card; M1 with ?store=<S2> gets the one sentence (never a quiet fallback); G sees S2.
 * Per [id] page: the other store's record is the same not-found as a forged id.
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

const NOT_FOUND = 'NEXT_NOT_FOUND';
const FORGED = '019a0000-0000-7000-8000-000000000001';

async function staffHolding(w: World, capabilities: readonly Capability[]): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, ${`Only ${capabilities.join('+')}`}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.s1})`;
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
    values (${w.orgId}, ${w.s1}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2025-01-01', ${w.A.personId}) returning id`;
  await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId: w.s1, employmentId: e!.id, personId: p!.id, setBy: w.A.personId, capabilities });
  return { personId: p!.id, orgId: w.orgId };
}

const LOC = { s1: 'Kitchen Zebrafish', s2: 'Kitchen Walrus' } as const;
const REF = { s1: 'DR-OTTER-S1', s2: 'DR-BADGER-S2' } as const;
const CUST = { s1: 'Onestorebuyer Marigold', s2: 'Twostorebuyer Hyacinth' } as const;

interface Records {
  workers: Map<string, Actor>;
  delivery: { s1: string; s2: string };
  count: { s1: string; s2: string };
  usage: { s1: string; s2: string };
  production: { s1: string; s2: string };
  trackedS1: string;
}

let cached: Promise<Records> | null = null;
const records = (): Promise<Records> => (cached ??= build());

async function build(): Promise<Records> {
  const w = await world();
  const { orgId, s1, s2 } = w;
  const adminId = w.A.personId;

  const workers = new Map<string, Actor>();
  for (const cap of ['record_stock_movement', 'record_till_count', 'accept_remittance', 'record_customer_return', 'record_order_wastage'] as const) {
    workers.set(cap, await staffHolding(w, [cap]));
  }

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const location = async (storeId: string, code: string, name: string) => {
    const [l] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${code}, ${name}, ${type!.id}, 'operating', true, ${adminId}) returning id`;
    return l!.id;
  };
  const loc1 = await location(s1, 'K1', LOC.s1);
  const loc2 = await location(s2, 'K2', LOC.s2);
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${adminId}) returning id`;

  const delivery = async (storeId: string, locationId: string, referenceNo: string) =>
    (await asOrg(orgId, (tx) =>
      createDeliveryDocument(tx, w.A, {
        storeId, kind: 'purchase', supplierId: null, referenceNo, deliveredOn: '2026-01-10', proofFileId: w.receiptFileId,
        lines: [{ itemId: item!.id, orderedQuantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '300.0000', locationId }],
      }),
    )).deliveryId;

  const count = async (storeId: string, locationId: string) => {
    const [c] = await sql<{ id: string }[]>`
      insert into count_sessions (org_id, store_id, status, counted_on, opened_by) values (${orgId}, ${storeId}, 'open', '2026-01-10', ${adminId}) returning id`;
    await sql`insert into count_session_locations (session_id, location_id) values (${c!.id}, ${locationId})`;
    return c!.id;
  };
  const usage = async (storeId: string, locationId: string) => {
    const [u] = await sql<{ id: string }[]>`
      insert into stock_usage_records (org_id, store_id, location_id, kind, status, used_on, created_by) values (${orgId}, ${storeId}, ${locationId}, 'usage', 'draft', '2026-01-10', ${adminId}) returning id`;
    return u!.id;
  };
  const production = async (storeId: string, locationId: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into production_records (org_id, store_id, location_id, kind, status, produced_on, created_by) values (${orgId}, ${storeId}, ${locationId}, 'cook', 'draft', '2026-01-10', ${adminId}) returning id`;
    return p!.id;
  };

  // A tracked, unresolved wastage at S1: the page then reads this store's posted settlements (a recorder of wastage alone may not).
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1}, '2026-01-11', '1000', '600', '400', ${adminId}) returning id`;
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${s1}, ${uid('Chan')}, true) returning id`;
  const [tracked] = await sql<{ id: string }[]>`
    insert into order_wastages (org_id, store_id, sales_day_id, channel_id, channel, type_mode, amount, reason, created_by)
    values (${orgId}, ${s1}, ${day!.id}, ${ch!.id}, 'Foodpanda', 'tracked', '50.00', 'Tamarind tracked reason', ${adminId}) returning id`;

  // Customers with store credit and one posted return at their own store (what the returns page keys "this store's customers" on).
  for (const [storeId, name] of [[s1, CUST.s1], [s2, CUST.s2]] as const) {
    const [c] = await sql<{ id: string }[]>`insert into customers (org_id, name, created_by) values (${orgId}, ${name}, ${adminId}) returning id`;
    const [o] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by) values (${orgId}, ${storeId}, ${c!.id}, '2026-01-20', 'draft', '10.00', ${adminId}) returning id`;
    const posted = await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-21', sourceType: 'manual_journal', sourceId: uid('cr'), idempotencyKey: uid('cr'), memo: 'T-603 fixture store credit', postedBy: adminId,
        lines: [{ accountCode: '4150', storeId, debit: '321.00' }, { accountCode: '2140', storeId, credit: '321.00', partyType: 'customer', partyId: c!.id }],
      }),
    );
    await sql`
      insert into customer_returns (org_id, store_id, trade_order_id, customer_id, treatment, returned_on, reason, settlement, status, journal_entry_id, created_by)
      values (${orgId}, ${storeId}, ${o!.id}, ${c!.id}, 'external', '2026-01-21', 'fixture return', 'store_credit', 'posted', ${posted.entryId}, ${adminId})`;
  }

  return {
    workers,
    delivery: { s1: await delivery(s1, loc1, REF.s1), s2: await delivery(s2, loc2, REF.s2) },
    count: { s1: await count(s1, loc1), s2: await count(s2, loc2) },
    usage: { s1: await usage(s1, loc1), s2: await usage(s2, loc2) },
    production: { s1: await production(s1, loc1), s2: await production(s2, loc2) },
    trackedS1: tracked!.id,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// S2 - the store-picker screens
// ---------------------------------------------------------------------------------------------------------------------

const screens = [
  { route: '/inventory', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/page') },
  { route: '/inventory/counts', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/counts/page') },
  { route: '/inventory/deliveries', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/deliveries/page') },
  { route: '/inventory/locations', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/locations/page') },
  { route: '/inventory/low-stock', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/low-stock/page') },
  { route: '/inventory/production', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/production/page') },
  { route: '/inventory/returns', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/returns/page') },
  { route: '/inventory/transfers', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/transfers/page') },
  { route: '/inventory/usage', cap: 'record_stock_movement', load: () => import('../../src/app/inventory/usage/page') },
  { route: '/till', cap: 'record_till_count', load: () => import('../../src/app/till/page') },
  { route: '/remittance', cap: 'accept_remittance', load: () => import('../../src/app/remittance/page') },
  { route: '/trade/returns', cap: 'record_customer_return', load: () => import('../../src/app/trade/returns/page') },
  { route: '/wastage', cap: 'record_order_wastage', load: () => import('../../src/app/wastage/page') },
] as const;

describe('T-603 S2 - every store-picker screen: the holder works, a cashier is refused, another store is one sentence', () => {
  for (const s of screens) {
    it(`${s.route}: W (only ${s.cap} at S1) sees S1 and nothing of S2; C gets the access card naming the screen's words`, async () => {
      const w = await world();
      const r = await records();
      const html = await render(s.load, r.workers.get(s.cap)!);
      expect(plain(html), `W ${s.route}: a real page, not the card`).not.toContain(M.refusedCard);
      expect(plain(html), `W ${s.route}: not the store sentence`).not.toContain(M.notAvailable);
      expect(html.length, `W ${s.route}`).toBeGreaterThan(500);
      expectAbsent(html, `W ${s.route}`, M.s2Name, w.s2);

      const refused = await render(s.load, w.C);
      expectRefusalCard(refused, `C ${s.route}`);
      expect(refused, `C ${s.route}: the key rides on data-capability`).toContain(`data-capability="`);
      expectAbsent(refused, `C ${s.route}`, '<form', M.s1Name);
    });

    it(`${s.route}: M1 with ?store=<S2> gets the one sentence (no fallback to S1); admin A sees S2`, async () => {
      const w = await world();
      const forged = await render(s.load, w.M1, { search: { store: w.s2 } });
      expectNotAvailable(forged, `M1 ${s.route}?store=S2`);
      expectAbsent(forged, `M1 ${s.route}?store=S2`, M.s1Name, M.s2Name, w.s2);
      const own = await render(s.load, w.M1, { search: { store: w.s1 } });
      expect(plain(own), `M1 ${s.route}?store=S1`).not.toContain(M.notAvailable);
      expectAbsent(own, `M1 ${s.route}?store=S1`, w.s2);
      const admin = await render(s.load, w.A, { search: { store: w.s2 } });
      expect(plain(admin), `A ${s.route}?store=S2`).not.toContain(M.notAvailable);
      expectPresent(admin, `A ${s.route}?store=S2`, w.s2);
    });
  }
});

describe('T-603 S2 - the inventory [id] pages: the other store\'s record is the same not-found as a forged id', () => {
  const kinds = [
    { name: 'deliveries/[id]', load: () => import('../../src/app/inventory/deliveries/[id]/page'), rec: (r: Records) => r.delivery, mark: REF },
    { name: 'counts/[id]', load: () => import('../../src/app/inventory/counts/[id]/page'), rec: (r: Records) => r.count, mark: LOC },
    { name: 'usage/[id]', load: () => import('../../src/app/inventory/usage/[id]/page'), rec: (r: Records) => r.usage, mark: LOC },
    { name: 'production/[id]', load: () => import('../../src/app/inventory/production/[id]/page'), rec: (r: Records) => r.production, mark: LOC },
  ];
  for (const k of kinds) {
    it(`${k.name}: M1 sees the S1 record, gets not-found for the S2 one; W likewise; C gets the card; G sees both`, async () => {
      const w = await world();
      const r = await records();
      const ids = k.rec(r);
      expectPresent(await render(k.load, w.M1, { params: { id: ids.s1 } }), `M1 ${k.name} S1`, k.mark.s1);
      const forged = await pageError(() => render(k.load, w.M1, { params: { id: FORGED } }));
      expect(forged, 'positive control: a forged id is a not-found').toBe(NOT_FOUND);
      expect(await pageError(() => render(k.load, w.M1, { params: { id: ids.s2 } })), `M1 ${k.name} S2`).toBe(forged);
      const worker = r.workers.get('record_stock_movement')!;
      expectPresent(await render(k.load, worker, { params: { id: ids.s1 } }), `W ${k.name} S1`, k.mark.s1);
      expect(await pageError(() => render(k.load, worker, { params: { id: ids.s2 } })), `W ${k.name} S2`).toBe(NOT_FOUND);
      expectRefusalCard(await render(k.load, w.C, { params: { id: ids.s1 } }), `C ${k.name}`);
      expectPresent(await render(k.load, w.G, { params: { id: ids.s2 } }), `G ${k.name} S2`, k.mark.s2);
    });
  }
});

describe('T-603 S2 - /inventory shows peso values only to managers and up (view_financial_reports at the store)', () => {
  const inventory = () => import('../../src/app/inventory/page');
  it('M1 sees the stock value and books total; W (record_stock_movement only) sees quantities and no peso text', async () => {
    const w = await world();
    const r = await records();
    expectPresent(await render(inventory, w.M1), 'M1 /inventory', 'On the books', 'Stock value');
    const worker = await render(inventory, r.workers.get('record_stock_movement')!);
    expectAbsent(worker, 'W /inventory', 'On the books', 'Stock value', '₱');
  });
});

describe('T-603 S2 - /wastage: a recorder of wastage who cannot record settlements still gets the page', () => {
  it('W (record_order_wastage at S1) with a tracked open row at S1 renders; M1 (a settlement recorder) sees it too', async () => {
    const w = await world();
    const r = await records();
    const wastage = () => import('../../src/app/wastage/page');
    const html = await render(wastage, r.workers.get('record_order_wastage')!);
    expectPresent(html, 'W /wastage', 'Order wastage', r.trackedS1);
    expectPresent(await render(wastage, w.M1), 'M1 /wastage', r.trackedS1);
    // the detail page has the same guard
    const detail = () => import('../../src/app/wastage/[id]/page');
    expectPresent(await render(detail, r.workers.get('record_order_wastage')!, { params: { id: r.trackedS1 } }), 'W /wastage/[id]', 'Tamarind tracked reason');
  });
});

describe('T-603 S2 - /trade/returns shows only this store\'s customers', () => {
  it('M1 (S1) sees the S1 customer\'s credit and never the S2 customer; admin on S2 sees the S2 customer and not the S1 one', async () => {
    const w = await world();
    const returns = () => import('../../src/app/trade/returns/page');
    const m1 = await render(returns, w.M1);
    expectPresent(m1, 'M1 /trade/returns', CUST.s1);
    expectAbsent(m1, 'M1 /trade/returns', CUST.s2);
    const g = await render(returns, w.A, { search: { store: w.s2 } });
    expectPresent(g, 'A /trade/returns?store=S2', CUST.s2);
    expectAbsent(g, 'A /trade/returns?store=S2', CUST.s1);
  });
});

describe('T-603 S2 - an org-wide admin with no scope rows is never store-filtered on a read', () => {
  it('G (admin, zero scope rows) picks S2 on /inventory', async () => {
    const w = await world();
    const html = await render(() => import('../../src/app/inventory/page'), w.G, { search: { store: w.s2 } });
    expect(plain(html)).not.toContain(M.notAvailable);
    expectPresent(html, 'G /inventory?store=S2', w.s2);
  });
});
