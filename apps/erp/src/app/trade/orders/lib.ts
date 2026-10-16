/**
 * Server-only reads for the trade-orders screens — DEF-138, 2026-09-03.
 *
 * ⭐ Until this file existed `createTradeOrder` / `dispatchTradeOrder` / `receiveTradeOrder`
 * (T-132/T-133/T-165, 40 green integration tests) had ZERO callers in `apps/` — every trade order
 * ever tested live was seeded by a one-off script. These helpers only read; every rule they
 * surface lives in `packages/domain` and is enforced there.
 */
import {
  arRepo,
  customersRepo,
  itemsRepo,
  moneyAccountsRepo,
  tradeRepo,
  treatmentOf,
  type CustomerRow,
  type TradeOrderLineRow,
  type TradeOrderListRow,
  type TradeOrderRow,
} from '@shareat/db';
import type { CustomerTreatment, TradeOrderStatus } from '@shareat/db/schema';
import { AuthorizationError, can, type Actor } from '@shareat/auth';
import { branchPriceFor, previewCreditExposure } from '@shareat/domain';
import { money, subtract } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';
import { scopedStores } from '../../reports/lib';

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
  // ⛔ T-435: `orderFormData` never fills a credit limit. This is serialised to the browser, where nothing read it; a buyer's limit is
  //    shown on the order page only to someone who can approve_buyer / override_credit_limit at the order's store. (Typed `null`
  //    only so older callers that build an option by hand still compile; it can never carry a figure.)
  creditLimit?: null;
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

/**
 * T-435 / bible row 353 - the stores the viewer may see trade orders for: their own scoped stores (the domain's dispatch/
 * receive gates are unchanged). A requested store outside this list is "not available", never a quiet fallback.
 */
export async function tradeStoresFor(actor: Actor): Promise<StoreOption[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => (await scopedStores(tx, actor)).stores);
}

/** Whether the viewer may see a buyer's credit limit on an order at `storeId`: approve_buyer or override_credit_limit there. */
export async function canSeeCreditLimit(actor: Actor, storeId: string): Promise<boolean> {
  return withOrgPrincipal(actor.orgId, async (tx) =>
    (await can(tx, actor, 'approve_buyer', { storeId })) || (await can(tx, actor, 'override_credit_limit', { storeId })),
  );
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

/**
 * T-435: an order is opened only by someone who holds approve_buyer, create_wholesale_order or record_ar_collection at the
 * ORDER's store; anyone else gets `null` - the same as a forged id.
 */
export async function orderDetail(actor: Actor, id: string): Promise<OrderDetail | null> {
  const orgId = actor.orgId;
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const order = await tradeRepo.getOrderById(tx, orgId, id);
    if (!order) return null;
    if (
      !(await can(tx, actor, 'approve_buyer', { storeId: order.storeId })) &&
      !(await can(tx, actor, 'create_wholesale_order', { storeId: order.storeId })) &&
      !(await can(tx, actor, 'record_ar_collection', { storeId: order.storeId }))
    ) {
      return null;
    }
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

/** T-433. The money accounts a payment at THIS order's store can go into (a payment into another store's account is refused). */
export async function storeMoneyAccounts(
  orgId: string,
  storeId: string,
): Promise<{ id: string; name: string; instrument: string; custodian: string }[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    return accounts.map((a) => ({ id: a.id, name: a.name, instrument: a.instrument, custodian: a.custodian }));
  });
}

/**
 * T-433 S3. The warning shown BEFORE dispatch is pressed: what the buyer owes and what this order would take them to. `null`
 * when the viewer may not dispatch here (they see no customer figures); the server still decides when the order posts.
 */
export async function creditPreview(
  actor: Actor,
  input: { customerId: string; storeId: string; total: string },
): Promise<{ owed: string; after: string; limit: string | null; over: boolean } | null> {
  try {
    return await withOrgPrincipal(actor.orgId, (tx) => previewCreditExposure(tx, actor, input));
  } catch (err) {
    if (err instanceof AuthorizationError) return null;
    throw err;
  }
}

export interface DeliveryReceiptData {
  detail: OrderDetail;
  /** Paid against THIS order's charge, and what is still due on it. */
  paid: string;
  balanceDue: string;
  /** The buyer's whole account, org-wide: receivable (1210) less store credit held (2140). */
  accountBalance: string;
  printedAt: Date;
}

/**
 * T-433 S2. Everything the printable delivery receipt shows - or `null`, which the page turns into a 404 for EVERY reason
 * alike (no such order, a draft or void one, a branch transfer, or a viewer without `approve_buyer`/`record_ar_collection`
 * at the order's store), so a person without the right learns nothing about whether the order exists.
 */
export async function deliveryReceiptData(actor: Actor, id: string): Promise<DeliveryReceiptData | null> {
  const detail = await orderDetail(actor, id);
  if (!detail) return null;
  const { order } = detail;
  if ((order.status !== 'dispatched' && order.status !== 'received') || !order.arChargeId) return null;
  const chargeId = order.arChargeId;
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const allowed =
      (await can(tx, actor, 'approve_buyer', { storeId: order.storeId })) ||
      (await can(tx, actor, 'record_ar_collection', { storeId: order.storeId }));
    if (!allowed) return null;
    const paid = await arRepo.paidForCharge(tx, actor.orgId, chargeId);
    const balanceDue = await arRepo.outstandingForCharge(tx, actor.orgId, chargeId);
    const position = await arRepo.positionOf(tx, actor.orgId, order.customerId);
    const credit = await arRepo.creditBalanceOf(tx, actor.orgId, order.customerId);
    const accountBalance = subtract(money(position.controlBalance), money(credit));
    return { detail, paid, balanceDue, accountBalance, printedAt: new Date() };
  });
}
