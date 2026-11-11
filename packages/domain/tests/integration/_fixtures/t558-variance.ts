/**
 * T-558 (TESTER) - the shared fixture for the POS sale variance tests. docs/tasks/558-pos-sale-variance-tolerance.md R2, R3.
 * Built on the T-531 world: sales go through the REAL domain (`sell`, so every device figure is `priceSession` over the rows the database holds).
 *
 * The case of audit item P-002 is a sale the server prices at 100.00 and that is paid 99.99. No menu item in the T-525 fixture costs 100.00, so `hundredItem` adds one
 * (an a-la-carte "Garlic rice set" at 100.00, on the same grill route, the same way the T-525 fixture adds its own).
 */
import { priceSession, type PriceSnapshot } from '../../../src/pos';
import { fixture, newStand, sql, uuid, RATES, type Fx, type Item } from './t525-pos';
import { insRule } from '../../../../db/tests/integration/_fixtures/t401-menu';
import { D1, manila, sell, world, type MadeSale, type PaySpec, type SaleSpec, type World } from './t531-day-close';

export { D1, manila, sell, uuid, RATES };
export type { World, Fx, Item, MadeSale, PaySpec, SaleSpec };

/** The tolerance in force, as the injected reader says (centavos). The default of the rule is 1n (PHP 0.01). */
export const ratesWith = (tolerance: bigint): Required<Pick<SaleSpec, 'deps'>>['deps'] => ({
  readRules: async () => ({ ...(await RATES.readRules()), saleVarianceToleranceCentavos: tolerance }),
});

/** One a-la-carte item at 100.00 on the store's menu (the P-002 price). */
export async function hundredItem(f: Fx, price = '100.00', name = 'Garlic rice set'): Promise<Item> {
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${f.orgId}, ${f.categoryId}, ${`${name} ${uuid().slice(0, 6)}`}, 'a_la_carte', true, false, true, 0, 'active', ${f.personId}) returning id`;
  const [variant] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${f.orgId}, ${item!.id}, null, true, 0, 'active', ${f.personId}) returning id`;
  await insRule(f, variant!.id);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
            values (${f.orgId}, ${f.storeId}, ${variant!.id}, 'store', ${null}, ${price}, ${null}, ${null}, false, ${f.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${item!.id}, ${f.grill}, ${f.personId})`;
  return { itemId: item!.id, variantId: variant!.id };
}

/** A world plus its 100.00 item. */
export type World58 = World & { hundred: Item };

/** A fresh live world (T-531's) with the 100.00 item. */
export async function world58(mode: 'test' | 'live' = 'live', liveFrom: string = D1): Promise<World58> {
  const w = await world(mode, liveFrom);
  return { ...w, hundred: await hundredItem(w) };
}

/** One 100.00 sale at `at`, paid as `pay`. The device figures are priceSession's (total 100.00); `o` can change the rules reader or edit the input. */
export const sellHundred = (f: World58, pay: PaySpec[], at: Date, o: Partial<SaleSpec> = {}): Promise<MadeSale> =>
  sell(f, { at, items: [{ item: f.hundred, qty: 1 }], expectTotal: '100.00', pay, ...o });

// ---- raw readers: the database is the oracle
export interface AuditRow { action: string; entity_id: string; sensitivity: string; severity: number; before: unknown; after: unknown }
export const auditRowsOf = (orgId: string, action: string) => sql<AuditRow[]>`
  select action, entity_id, sensitivity, severity, before, after from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at, id`;
export const receiptPayments = (receiptId: string) => sql<{ tender_id: string; amount: string; change_given: string }[]>`
  select tender_id, amount::text, change_given::text from pos_sales_receipt_payments where receipt_id = ${receiptId} order by amount desc`;
export const receiptRow = async (receiptId: string) =>
  (await sql<{ total: string; device_total: string; table_session_id: string }[]>`select total::text, device_total::text, table_session_id from pos_sales_receipts where id = ${receiptId}`)[0];
export const sessionStatus = async (sessionId: string) => (await sql<{ status: string }[]>`select status from table_sessions where id = ${sessionId}`)[0]?.status;
export const receiptCount = async (orgId: string) => Number((await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where org_id = ${orgId}`)[0]!.n);

/** Cents of a decimal text. */
export const cents = (s: string): number => Math.round(Number(s) * 100);

/** The text of a JSON value (an audit `after`), for "it holds this figure" checks that do not depend on the builder's key names. */
export const jsonText = (v: unknown): string => JSON.stringify(v);

/** A device-side priceSession figure for one line (the inbox events carry device figures too). */
export function priceOne(unitPrice: string, qty: number, lineId: string) {
  const snap: PriceSnapshot = {
    vatRegistered: true, vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n,
    lines: [{ lineId, qty, unitPrice, bundleHeads: null, discounts: [] }],
  };
  return priceSession(snap);
}

export { fixture, newStand };
