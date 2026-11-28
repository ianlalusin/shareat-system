import { afterAll, describe, expect, it, vi } from 'vitest';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-649 - the new-order form's quote map (`orderFormData().quotes`) comes from the SAME row pricing the order line uses.
 * docs/tasks/649-price-list-cost-plus.md "Tests" 3.
 *
 * Pinned: an outside customer on a list gets the list's rule worked out today (cost + 7% on a delivery cost of 120 = 128.40); a customer with no list gets the
 * default list's; no default list = no entry; an item with a markup rule and no delivery cost yet has no entry; an INTERNAL customer never gets a list quote
 * (it is charged the branch price). A source guard: the loader no longer reads `rate` straight off the list rows.
 *
 * MUTANTS: loader reading `r.rate` directly (cost-plus rows are null -> the 128.40 case red); default fallback dropped (the no-list case red); the internal skip dropped
 * (the internal case red).
 */
config({ path: '.env.local' });
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());

const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function world() {
  const { seedChartOfAccounts } = await import('../../../../packages/db/seed/chart-of-accounts');
  const { testItemCode } = await import('../../../../packages/domain/tests/integration/_fixtures/item-code');
  const { transaction, APP_ROLE } = await import('@shareat/db');
  const { createCustomer, createPriceList, setPrice, setDefaultPriceList } = await import('@shareat/domain');
  const code = uid('t649form');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  const admin = { personId: p!.id, orgId };
  const asOrg = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
    transaction(async (tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
      return fn(tx as never);
    });
  const mkItem = async (name: string, stocked = true) => {
    const [i] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, sellable_wholesale)
      values (${orgId}, ${testItemCode()}, ${`${name} ${uid('n')}`}, 'raw_material', 'kg', ${p!.id}, true) returning id`;
    return i!.id;
  };
  const landCost = async (itemId: string, price: string) => {
    const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${p!.id}) returning id`;
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, created_by)
      values (${orgId}, ${store!.id}, ${sup!.id}, '2026-01-20', ${price}, ${p!.id}) returning id`;
    await sql`
      insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
      values (${inv!.id}, 1, ${itemId}, '1', 'kg', '1', ${price}, ${price})`;
  };
  const list = await asOrg((tx) => createPriceList(tx, admin, { name: uid('Wholesale') }));
  const fixedItem = await mkItem('Fixed');
  const percentItem = await mkItem('Percent');
  const noCostItem = await mkItem('NoCost');
  await landCost(percentItem, '120.00');
  await asOrg((tx) => setPrice(tx, admin, { priceListId: list.id, itemId: fixedItem, mode: 'fixed', rate: '100' }));
  await asOrg((tx) => setPrice(tx, admin, { priceListId: list.id, itemId: percentItem, mode: 'percent_markup', markupPercent: '7' }));
  await asOrg((tx) => setPrice(tx, admin, { priceListId: list.id, itemId: noCostItem, mode: 'fixed_markup', markupAmount: '50' }));
  const onList = await asOrg((tx) => createCustomer(tx, admin, { name: uid('OnList'), priceListId: list.id }));
  const noList = await asOrg((tx) => createCustomer(tx, admin, { name: uid('NoList') }));
  const internal = await asOrg((tx) => createCustomer(tx, admin, { name: uid('Branch'), counterpartyStoreId: store!.id, priceListId: list.id }));
  return { orgId, admin, asOrg, list, fixedItem, percentItem, noCostItem, onList, noList, internal, setDefaultPriceList };
}

describe('T-649 the order form quotes come from the one row pricing', () => {
  it('⭐ a customer on a list is quoted each rule worked out today; an item with no delivery cost yet has no quote', async () => {
    const w = await world();
    const { orderFormData } = await import('../../src/app/trade/orders/lib');
    const q = (await orderFormData(w.orgId)).quotes[w.onList.id]!;
    expect(q[w.fixedItem]).toBe('100.00');
    expect(q[w.percentItem]).toBe('128.40'); // 120 x 1.07
    expect(q[w.noCostItem], 'a markup with no delivery cost yet is left for the person to type').toBeUndefined();
  });

  it('⭐ a customer with no list is quoted from the default list, and from nothing when there is none', async () => {
    const w = await world();
    const { orderFormData } = await import('../../src/app/trade/orders/lib');
    expect((await orderFormData(w.orgId)).quotes[w.noList.id]).toBeUndefined();
    await w.asOrg((tx) => w.setDefaultPriceList(tx, w.admin, { priceListId: w.list.id }));
    const q = (await orderFormData(w.orgId)).quotes[w.noList.id]!;
    expect(q[w.percentItem]).toBe('128.40');
  });

  it('an internal customer never gets a list quote (it is charged the branch price)', async () => {
    const w = await world();
    await w.asOrg((tx) => w.setDefaultPriceList(tx, w.admin, { priceListId: w.list.id }));
    const { orderFormData } = await import('../../src/app/trade/orders/lib');
    expect((await orderFormData(w.orgId)).quotes[w.internal.id]).toBeUndefined();
  });

  it('source: the loader prices rows through priceOfRow, not r.rate', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/app/trade/orders/lib.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/priceOfRow\(/);
    expect(src).not.toMatch(/r\.rate\b/);
  });
});
