/**
 * Server-only reads for the trade-orders screens — DEF-138, 2026-09-03.
 *
 * ⭐ Until this file existed `createTradeOrder` / `dispatchTradeOrder` / `receiveTradeOrder`
 * (T-132/T-133/T-165, 40 green integration tests) had ZERO callers in `apps/` — every trade order
 * ever tested live was seeded by a one-off script. These helpers only read; every rule they
 * surface lives in `packages/domain` and is enforced there.
 */
import {
  customersRepo,
  itemsRepo,
  tradeRepo,
  treatmentOf,
  type CustomerRow,
  type TradeOrderLineRow,
  type TradeOrderListRow,
  type TradeOrderRow,
} from '@shareat/db';
import type { CustomerTreatment, TradeOrderStatus } from '@shareat/db/schema';
import { branchPriceFor } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { peso } from '../../../lib/format';
export { listStores, withOrgPrincipal };
export type { StoreOption };

export const STATUS_LABEL: Record<TradeOrderStatus, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  dispatched: 'Dispatched',
  received: 'Received',
  void: 'Void',
};

/** Today in Asia/Manila — never the server's UTC date (bible §6, landmine: server-side toLocale = UTC). */
export function today(): string {
  return toBusinessDate();
}

export interface CustomerOption {
  id: string;
  name: string;
  customerGroup: CustomerRow['customerGroup'];
  treatment: CustomerTreatment;
  counterpartyStoreId: string | null;
  priceListId: string | null;
  creditLimit: string | null;
}

export interface ItemOption {
  id: string;
  code: string;
  name: string;
  baseUnit: string;
}

export interface OrderFormData {
  customers: CustomerOption[];
  items: ItemOption[];
  /**
   * ⭐ What the rate will DEFAULT to when left blank — shown as the input's placeholder so the
   * person sees the agreed price before the line is captured. Keyed customerId → itemId → rate,
   * from the customer's price list. The domain reads the same source when the rate is omitted.
   */
  quotes: Record<string, Record<string, string>>;
  /** The branch price per item, for the items that carry a pricing rule — an INTERNAL order's default. */
  branchPrices: Record<string, string>;
}

/** Everything the "New order" form needs, in one org-scoped transaction. */
export async function orderFormData(orgId: string): Promise<OrderFormData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [customerRows, itemRows, lists, rules] = await Promise.all([
      customersRepo.listCustomers(tx, orgId),
      itemsRepo.listItems(tx, orgId, { includeInactive: false }),
      customersRepo.listPriceLists(tx, orgId),
      itemsRepo.listItemPricing(tx, orgId),
    ]);

    const ratesByList = new Map<string, Record<string, string>>();
    for (const list of lists) {
      const rates = await customersRepo.listPriceListItems(tx, orgId, list.id);
      ratesByList.set(list.id, Object.fromEntries(rates.map((r) => [r.itemId, r.rate])));
    }

    const customers: CustomerOption[] = customerRows
      .filter((c) => c.status === 'active')
      .map((c) => ({
        id: c.id,
        name: c.name,
        customerGroup: c.customerGroup,
        treatment: treatmentOf(c),
        counterpartyStoreId: c.counterpartyStoreId,
        priceListId: c.priceListId,
        creditLimit: c.creditLimit,
      }));

    const quotes: Record<string, Record<string, string>> = {};
    for (const c of customers) {
      if (c.priceListId) quotes[c.id] = ratesByList.get(c.priceListId) ?? {};
    }

    // ⚠️ Only the RULED items are priced — `branchPriceFor` is three queries per item, and the
    // catalogue is hundreds of items of which a handful carry a rule.
    const branchPrices: Record<string, string> = {};
    for (const rule of rules) {
      const bp = await branchPriceFor(tx, orgId, rule.itemId);
      if (bp) branchPrices[rule.itemId] = bp.price;
    }

    return {
      customers,
      items: itemRows.map((i) => ({ id: i.id, code: i.code, name: i.name, baseUnit: i.baseUnit })),
      quotes,
      branchPrices,
    };
  });
}

export async function orderRegister(orgId: string, storeId: string): Promise<TradeOrderListRow[]> {
  return withOrgPrincipal(orgId, (tx) => tradeRepo.listOrders(tx, orgId, storeId));
}

export interface OrderLineView extends TradeOrderLineRow {
  itemName: string;
  itemCode: string;
}

export interface OrderDetail {
  order: TradeOrderRow;
  lines: OrderLineView[];
  customer: CustomerRow;
  /** ⭐ Derived from the customer's links on every read, never stored (ADR-008 §2). */
  treatment: CustomerTreatment;
  sellingStore: StoreOption | undefined;
  /** The branch an INTERNAL transfer is going to; undefined for a sale. */
  receivingStore: StoreOption | undefined;
}

export async function orderDetail(orgId: string, id: string): Promise<OrderDetail | null> {
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const order = await tradeRepo.getOrderById(tx, orgId, id);
    if (!order) return null;
    const customer = await customersRepo.getById(tx, orgId, order.customerId);
    if (!customer) return null;
    const rawLines = await tradeRepo.linesFor(tx, orgId, order.id);
    const lines: OrderLineView[] = [];
    for (const l of rawLines) {
      const item = await itemsRepo.getItemById(tx, orgId, l.itemId);
      lines.push({ ...l, itemName: item?.name ?? l.itemId, itemCode: item?.code ?? '' });
    }
    lines.sort((a, b) => a.itemName.localeCompare(b.itemName));
    return {
      order,
      lines,
      customer,
      treatment: treatmentOf(customer),
      sellingStore: stores.find((s) => s.id === order.storeId),
      receivingStore: customer.counterpartyStoreId
        ? stores.find((s) => s.id === customer.counterpartyStoreId)
        : undefined,
    };
  });
}
