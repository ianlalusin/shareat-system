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
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
vi.mock('../../src/components/scheduler-status', () => ({ SchedulerStatus: () => null }));

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

const M3_CACHE: { actor?: Promise<Actor> } = {};
async function m3(w: World): Promise<Actor> {
  M3_CACHE.actor ??= (async () => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Manager Closedbranch') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.s3})`;
    return { personId: p!.id, orgId: w.orgId };
  })();
  return M3_CACHE.actor;
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
  for (const cap of ['record_stock_movement', 'record_till_count', 'accept_remittance', 'record_customer_return', 'record_order_wastage', 'create_expense'] as const) {
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
  // the new-expense form: another store's open invoices, budget caps and money lines follow ?store=
  { route: '/expenses/new', cap: 'create_expense', load: () => import('../../src/app/expenses/new/page') },
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

// ---------------------------------------------------------------------------------------------------------------------
// S3 - "all my stores" lists and finance detail pages (loans, owners, liabilities, prepaid, money accounts, transfers, service charge,
// expenses, recurring expenses, findings, scorecard)
// ---------------------------------------------------------------------------------------------------------------------

const N = {
  loan: { s1: 'Loan Zinnia One', s2: 'Loan Yarrow Two' },
  liability: { s1: 'Liability Zinnia One', s2: 'Liability Yarrow Two' },
  prepaid: { s1: 'Prepaid Zinnia One', s2: 'Prepaid Yarrow Two' },
  owner: { s1: 'Ownerperson Zinnia', s2: 'Ownerperson Yarrow' },
  account: { s1: 'Bank Zinnia One', s2: 'Bank Yarrow Two' },
  transfer: { s1: 'XFER-S1-ONLY', s2: 'XFER-S2-ONLY', s2to1: 'XFER-S2-TO-S1', s1to2: 'XFER-S1-TO-S2' },
  expense: { s1: 'Spend Zinnia One', s2: 'Spend Yarrow Two' },
  orgFinding: 'The opening conversion does not add up',
} as const;

interface Finance {
  loan: { s1: string; s2: string };
  owner: { s1: string; s2: string };
  liability: { s1: string; s2: string };
  prepaid: { s1: string; s2: string };
  recurringWorker: Actor;
}

let cached3: Promise<Finance> | null = null;
const finance = (): Promise<Finance> => (cached3 ??= build3());

async function build3(): Promise<Finance> {
  const w = await world();
  const { orgId, s1, s2 } = w;
  const adminId = w.A.personId;
  const pair = async <T>(make: (storeId: string, tag: 's1' | 's2') => Promise<T>) => ({ s1: await make(s1, 's1'), s2: await make(s2, 's2') });

  const loan = await pair(async (storeId, tag) => {
    const [r] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${orgId}, ${storeId}, 'Lender', ${N.loan[tag]}, '1000.00', '1.0000', 'month', 'straight', 'monthly', 12, '2026-01-01', ${adminId}) returning id`;
    return r!.id;
  });
  const owner = await pair(async (storeId, tag) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${N.owner[tag]}) returning id`;
    const [r] = await sql<{ id: string }[]>`insert into owners (org_id, store_id, person_id, created_by) values (${orgId}, ${storeId}, ${p!.id}, ${adminId}) returning id`;
    return r!.id;
  });
  const liability = await pair(async (storeId, tag) => {
    const [r] = await sql<{ id: string }[]>`
      insert into liabilities (org_id, store_id, name, category, created_by) values (${orgId}, ${storeId}, ${N.liability[tag]}, 'other', ${adminId}) returning id`;
    return r!.id;
  });
  const prepaid = await pair(async (storeId, tag) => {
    const [r] = await sql<{ id: string }[]>`
      insert into prepaid_items (org_id, store_id, name, category, coverage_start_date, coverage_months, total_cost, created_by)
      values (${orgId}, ${storeId}, ${N.prepaid[tag]}, 'insurance', '2026-01-01', 12, '1200.00', ${adminId}) returning id`;
    return r!.id;
  });

  // Money accounts: a second (bank, office) account per store with a name no other store shares, then transfers between accounts.
  const acct = await pair(async (storeId, tag) => {
    const [r] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${storeId}, ${N.account[tag]}, 'bank', '1140', 'office') returning id`;
    return r!.id;
  });
  const [f1] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${s1} and id <> ${acct.s1} order by is_foundation desc, id limit 1`;
  const [f2] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${s2} and id <> ${acct.s2} order by is_foundation desc, id limit 1`;
  const transfer = (storeId: string, from: string, to: string, reference: string) =>
    sql`insert into money_transfers (org_id, store_id, from_money_account_id, to_money_account_id, amount_out, amount_in, transfer_date, reference, created_by)
        values (${orgId}, ${storeId}, ${from}, ${to}, '10.00', '10.00', '2026-01-15', ${reference}, ${adminId})`;
  await transfer(s1, f1!.id, acct.s1, N.transfer.s1);
  await transfer(s2, f2!.id, acct.s2, N.transfer.s2);
  await transfer(s2, f2!.id, f1!.id, N.transfer.s2to1);
  await transfer(s1, f1!.id, f2!.id, N.transfer.s1to2);

  const [cat] = await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('cat')}, null) returning id`;
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${adminId}) returning id`;
  await pair(async (storeId, tag) => {
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, verified_by, verified_at,
        attested_supplier, attested_invoice, attested_items, attested_price, created_by)
      values (${orgId}, ${storeId}, ${supplier!.id}, ${uid('INV')}, '2026-01-10', '500.00', 'verified', ${w.M1.personId}, now(), true, true, true, true, ${adminId}) returning id`;
    await sql`
      insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
      values (${orgId}, ${storeId}, '2026-01-10', '500.00', ${cat!.id}, ${supplier!.id}, ${inv!.id}, ${N.expense[tag]}, 'draft', ${adminId})`;
  });

  // Findings: one stale POS sales day per store (a store finding, plus its occurrence for the scorecard) and an unbalanced 3900 (organisation-level).
  await pair(async (storeId) => {
    await sql`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, pos_sourced, pos_sourced_at, status, created_by)
      values (${orgId}, ${storeId}, '2025-12-01', '100', '60', '40', true, now(), 'open', ${adminId})`;
    await sql`
      insert into finding_occurrences (org_id, store_id, finding_key, kind, opened_on, last_seen_on)
      values (${orgId}, ${storeId}, ${`salesDayUnposted:${storeId}`}, 'salesDayUnposted', current_date, current_date)`;
  });
  await sql`insert into finding_occurrences (org_id, store_id, finding_key, kind, opened_on, last_seen_on) values (${orgId}, null, 'openingBalanceEquityNonZero', 'openingBalanceEquityNonZero', current_date, current_date)`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-10', sourceType: 'manual_journal', sourceId: uid('ob'), idempotencyKey: uid('ob'), memo: 'T-603 fixture opening residue', postedBy: adminId,
      lines: [{ accountCode: '6200', storeId: s1, debit: '99.00' }, { accountCode: '3900', storeId: s1, credit: '99.00' }],
    }),
  );

  return { loan, owner, liability, prepaid, recurringWorker: await staffHolding(w, ['manage_recurring_expenses']) };
}

describe('T-603 S3 - the "all my stores" lists show only the viewer\'s stores', () => {
  const lists = [
    { name: '/loans', load: () => import('../../src/app/loans/page'), mark: N.loan },
    { name: '/owners', load: () => import('../../src/app/owners/page'), mark: 'ids' as const },
    { name: '/liabilities', load: () => import('../../src/app/liabilities/page'), mark: N.liability },
    { name: '/prepaid', load: () => import('../../src/app/prepaid/page'), mark: N.prepaid },
    { name: '/money-accounts', load: () => import('../../src/app/money-accounts/page'), mark: N.account },
    { name: '/expenses', load: () => import('../../src/app/expenses/page'), mark: N.expense },
  ];
  for (const l of lists) {
    it(`${l.name}: M1 sees the S1 row and never the S2 row; admin G (no scope rows) and A see both`, async () => {
      const w = await world();
      await finance();
      // owners: the person picker lists every person by name, so the row is told apart by its link (the record id)
      const f = await finance();
      const mark = l.mark === 'ids' ? f.owner : l.mark;
      const m1 = await render(l.load, w.M1);
      expectPresent(m1, `M1 ${l.name}`, mark.s1);
      expectAbsent(m1, `M1 ${l.name}`, mark.s2);
      for (const [who, actor] of [['G', w.G], ['A', w.A]] as const) expectPresent(await render(l.load, actor), `${who} ${l.name}`, mark.s1, mark.s2);
    });
  }

  it('/expenses: C (no expense capability) gets the access card', async () => {
    const w = await world();
    expectRefusalCard(await render(() => import('../../src/app/expenses/page'), w.C), 'C /expenses');
  });

  it('/money-transfers: M1 sees a transfer when either side is S1 and not the S2-only one; A sees all four', async () => {
    const w = await world();
    await finance();
    const transfers = () => import('../../src/app/money-transfers/page');
    const m1 = await render(transfers, w.M1);
    expectPresent(m1, 'M1 /money-transfers', N.transfer.s1, N.transfer.s2to1, N.transfer.s1to2);
    expectAbsent(m1, 'M1 /money-transfers', N.transfer.s2, N.account.s2);
    expectPresent(await render(transfers, w.A), 'A /money-transfers', ...Object.values(N.transfer));
  });

  it('/service-charge and /expenses/recurring: a forged ?store=<S2> is the one sentence; the holder works; admin sees S2; C gets the card', async () => {
    const w = await world();
    const f = await finance();
    for (const [route, load, who] of [
      ['/service-charge', () => import('../../src/app/service-charge/page'), w.M1],
      ['/expenses/recurring', () => import('../../src/app/expenses/recurring/page'), f.recurringWorker],
    ] as const) {
      expectNotAvailable(await render(load, who, { search: { store: w.s2 } }), `${route}?store=S2`);
      expect(plain(await render(load, who, { search: { store: w.s1 } })), `${route} own store`).not.toContain(M.notAvailable);
      expect(plain(await render(load, w.A, { search: { store: w.s2 } })), `A ${route}?store=S2`).not.toContain(M.notAvailable);
      expectRefusalCard(await render(load, w.C), `C ${route}`);
    }
  });
});

describe('T-603 S3 - the finance detail pages: the other store\'s record is the same not-found as a forged id', () => {
  const kinds = [
    { name: 'loans/[id]', load: () => import('../../src/app/loans/[id]/page'), pick: (f: Finance) => f.loan, mark: N.loan },
    { name: 'owners/[id]', load: () => import('../../src/app/owners/[id]/page'), pick: (f: Finance) => f.owner, mark: N.owner },
    { name: 'liabilities/[id]', load: () => import('../../src/app/liabilities/[id]/page'), pick: (f: Finance) => f.liability, mark: N.liability },
    { name: 'prepaid/[id]', load: () => import('../../src/app/prepaid/[id]/page'), pick: (f: Finance) => f.prepaid, mark: N.prepaid },
  ];
  for (const k of kinds) {
    it(`${k.name}: M1 sees S1, not-found for S2; A sees both`, async () => {
      const w = await world();
      const ids = k.pick(await finance());
      expectPresent(await render(k.load, w.M1, { params: { id: ids.s1 } }), `M1 ${k.name} S1`, k.mark.s1);
      const forged = await pageError(() => render(k.load, w.M1, { params: { id: FORGED } }));
      expect(forged, 'a forged id is a not-found').toBe(NOT_FOUND);
      expect(await pageError(() => render(k.load, w.M1, { params: { id: ids.s2 } })), `M1 ${k.name} S2`).toBe(forged);
      expectPresent(await render(k.load, w.A, { params: { id: ids.s2 } }), `A ${k.name} S2`, k.mark.s2);
    });
  }
});

describe('T-603 S3 - /findings and the scorecard', () => {
  const findings = () => import('../../src/app/findings/page');
  const scorecard = () => import('../../src/app/findings/scorecard/page');

  it('/findings: M1 sees S1\'s finding and no other store\'s, and not the organisation-level one; A sees all; C gets the card', async () => {
    const w = await world();
    await finance();
    const m1 = await render(findings, w.M1);
    expectPresent(m1, 'M1 /findings', `${M.s1Name} has`);
    expectAbsent(m1, 'M1 /findings', `${M.s2Name} has`, N.orgFinding);
    expectPresent(await render(findings, w.A), 'A /findings', `${M.s1Name} has`, `${M.s2Name} has`, N.orgFinding);
    expectRefusalCard(await render(findings, w.C), 'C /findings');
  });

  it('/findings/scorecard: M1 sees only the S1 row (no other store, no organisation row); A sees every row; C gets the card', async () => {
    const w = await world();
    await finance();
    const m1 = await render(scorecard, w.M1);
    expectPresent(m1, 'M1 scorecard', M.s1Name);
    expectAbsent(m1, 'M1 scorecard', M.s2Name, 'Organisation-wide');
    expectPresent(await render(scorecard, w.A), 'A scorecard', M.s1Name, M.s2Name, 'Organisation-wide');
    expectRefusalCard(await render(scorecard, w.C), 'C scorecard');
  });
});

describe('T-603 - a closed (retired) store stays workable for the people who hold it', () => {
  const closedScreens = [
    ['/till', () => import('../../src/app/till/page')],
    ['/remittance', () => import('../../src/app/remittance/page')],
    ['/wastage', () => import('../../src/app/wastage/page')],
    ['/inventory', () => import('../../src/app/inventory/page')],
    ['/service-charge', () => import('../../src/app/service-charge/page')],
    ['/expenses/recurring', () => import('../../src/app/expenses/recurring/page')],
  ] as const;
  const selected = (html: string, id: string) => new RegExp(`value="${id}"[^>]*selected`).test(html);

  for (const [route, load] of closedScreens) {
    it(`${route}: admin A can pick the closed S3 (pickable, not the default); M1 without a scope row there gets the sentence; the manager of S3 alone lands on it`, async () => {
      const w = await world();
      const closed = await render(load, w.A, { search: { store: w.s3 } });
      expect(plain(closed), `A ${route}?store=S3`).not.toContain(M.notAvailable);
      expectPresent(closed, `A ${route}?store=S3`, w.s3);
      expect(selected(closed, w.s3), `A ${route}?store=S3 selects it`).toBe(true);
      const dflt = await render(load, w.A);
      expect(selected(dflt, w.s3), `A ${route} default must not be the closed store`).toBe(false);
      expectNotAvailable(await render(load, w.M1, { search: { store: w.s3 } }), `M1 ${route}?store=S3`);
      expect(plain(await render(load, await m3(w))), `M3 ${route}`).not.toContain(M.notAvailable);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// S4 - the staff picker follows store scope (DEF-915)
// ---------------------------------------------------------------------------------------------------------------------

describe('T-603 S4 - staff pickers list the people employed at the store', () => {
  async function employed(w: World, storeId: string, name: string): Promise<string> {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
      values (${w.orgId}, ${storeId}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2025-01-01', ${w.A.personId})`;
    return p!.id;
  }

  it('listActingPersons(orgId, S1) has the S1 person, not the S2-only one; alsoIds keeps a cited name; no store = everyone', async () => {
    const w = await world();
    const { listActingPersons } = await import('../../src/app/expenses/lib');
    const here = await employed(w, w.s1, 'Heron Hereperson');
    const there = await employed(w, w.s2, 'Sandpiper Elsewhere');
    const names = async (...args: [string, string?, string[]?]) => (await listActingPersons(...args)).map((p) => p.displayName);
    const atS1 = await names(w.orgId, w.s1);
    expect(atS1).toContain('Heron Hereperson');
    expect(atS1).not.toContain('Sandpiper Elsewhere');
    expect(await names(w.orgId, w.s1, [there])).toContain('Sandpiper Elsewhere');
    expect(await names(w.orgId)).toEqual(expect.arrayContaining(['Heron Hereperson', 'Sandpiper Elsewhere']));
    expect(here).not.toBe(there);
  });

  it('every page that offers the picker passes its store (the picker is only drawn for a chargeable variance or a handover, so the call site is what is checked)', async () => {
    const { readFileSync } = await import('node:fs');
    const pages = ['till/page.tsx', 'remittance/page.tsx', 'expenses/[id]/page.tsx', 'sales-days/[id]/page.tsx'];
    for (const f of pages) {
      const src = readFileSync(new URL(`../../src/app/${f}`, import.meta.url), 'utf8');
      expect(/listActingPersons\([^)]*(storeId|\.storeId)/.test(src), `${f} passes a store to listActingPersons`).toBe(true);
    }
  });
});

describe('T-603 S4 - by-id repo reads take the organisation (DEF-918)', () => {
  it('a delivery, a delivery document and a count session are not found under another org id, found under the right one', async () => {
    const w = await world();
    const r = await records();
    const { deliveriesRepo, countSessionsRepo } = await import('@shareat/db');
    const other = FORGED;
    await asOrg(w.orgId, async (tx) => {
      expect(await deliveriesRepo.getDelivery(tx, w.orgId, r.delivery.s1)).toBeDefined();
      expect(await deliveriesRepo.getDelivery(tx, other, r.delivery.s1)).toBeUndefined();
      expect(await deliveriesRepo.getDeliveryDocument(tx, w.orgId, r.delivery.s1)).toBeDefined();
      expect(await deliveriesRepo.getDeliveryDocument(tx, other, r.delivery.s1)).toBeUndefined();
      expect(await countSessionsRepo.getCountSession(tx, w.orgId, r.count.s1)).toBeDefined();
      expect(await countSessionsRepo.getCountSession(tx, other, r.count.s1)).toBeUndefined();
    });
  });
});
