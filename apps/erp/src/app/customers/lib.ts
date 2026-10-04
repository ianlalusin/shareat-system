/**
 * Server-only helpers for the customer and price-list screens. T-129.
 *
 * ⭐ The treatment is derived from the links on every read — there is no stored flag to render, and
 * that is deliberate (ADR-008 §2).
 */
import {
  arRepo,
  customersRepo,
  moneyAccountsRepo,
  treatmentOf,
  type CustomerRow,
  type PriceListItemRow,
  type PriceListRow,
} from '@shareat/db';
import type { CustomerTreatment } from '@shareat/db/schema';
import { add, money } from '@shareat/core/money';
import { listStores, withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface CustomerListRow extends CustomerRow {
  treatment: CustomerTreatment;
  balance: string;
}

export async function listRegister(orgId: string): Promise<CustomerListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [rows, balances] = await Promise.all([
      customersRepo.listCustomers(tx, orgId),
      customersRepo.balancesByCustomer(tx, orgId),
    ]);
    return rows.map((c) => ({
      ...c,
      treatment: treatmentOf(c),
      balance: balances.get(c.id) ?? '0.00',
    }));
  });
}

export async function listLists(orgId: string): Promise<PriceListRow[]> {
  return withOrgPrincipal(orgId, (tx) => customersRepo.listPriceLists(tx, orgId));
}

export interface PriceListDetail extends PriceListRow {
  items: PriceListItemRow[];
}

export async function getListDetail(orgId: string, id: string): Promise<PriceListDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const row = await customersRepo.getPriceList(tx, orgId, id);
    if (!row) return null;
    return { ...row, items: await customersRepo.listPriceListItems(tx, orgId, id) };
  });
}

// -------------------------------------------------------------------------------------
// The customer detail page — T-226 / DEF-190
//
// ⛔ Reads only. Every one runs under `withOrgPrincipal` and NONE of them calls a domain
// function: DEF-189's lesson is that calling a gated service to satisfy a page read returns
// HTTP 500 where a refusal is wanted. Only a form submission reaches the domain.
// -------------------------------------------------------------------------------------

export interface CustomerDetail extends CustomerRow {
  treatment: CustomerTreatment;
}

export async function getCustomer(orgId: string, id: string): Promise<CustomerDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const row = await customersRepo.getById(tx, orgId, id);
    return row ? { ...row, treatment: treatmentOf(row) } : null;
  });
}

/**
 * What the customer owes.
 *
 * ⚠️ **Org-wide by default, per store when asked, and the page must never conflate them.** A
 * credit limit is extended to a BUYER (`recordCharge` judges it org-wide); allocation happens per
 * STORE, because a collection posts every leg at its own store.
 */
export async function getPosition(orgId: string, customerId: string, storeId?: string): Promise<string> {
  return withOrgPrincipal(orgId, async (tx) => {
    const { controlBalance } = await arRepo.positionOf(tx, orgId, customerId, storeId);
    return controlBalance;
  });
}

/** Store credit held on the customer's behalf — `2140`, a liability, not a discount. */
export async function creditBalance(orgId: string, customerId: string): Promise<string> {
  return withOrgPrincipal(orgId, (tx) => arRepo.creditBalanceOf(tx, orgId, customerId));
}

export async function listCharges(orgId: string, customerId: string, storeId?: string) {
  return withOrgPrincipal(orgId, (tx) =>
    arRepo.listChargesForCustomer(tx, orgId, customerId, storeId ? { storeId } : {}),
  );
}

export async function listCollections(orgId: string, customerId: string, storeId?: string) {
  return withOrgPrincipal(orgId, (tx) =>
    arRepo.listCollectionsForCustomer(tx, orgId, customerId, storeId ? { storeId } : {}),
  );
}

export async function openItemsFor(orgId: string, customerId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => arRepo.openItems(tx, orgId, customerId, storeId));
}

/**
 * Which stores this customer owes money at, with the total and the count.
 *
 * ⭐ Mirrors `/ap/suppliers/[id]`'s helper deliberately, including the reason it exists: the store
 * is **CHOSEN**, never inferred from whichever open item sorted first. AP's older behaviour booked
 * every leg of a payment at one store when the supplier was owed at two, so one store's control
 * account went negative and the other's never cleared.
 */
export async function storesWithOpenItems(
  orgId: string,
  customerId: string,
): Promise<{ storeId: string; storeName: string; outstanding: string; count: number }[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const stores = await listStores(orgId);
    const out: { storeId: string; storeName: string; outstanding: string; count: number }[] = [];
    for (const s of stores) {
      const items = await arRepo.openItems(tx, orgId, customerId, s.id);
      if (items.length === 0) continue;
      out.push({
        storeId: s.id,
        storeName: s.name,
        outstanding: add(...items.map((i) => money(i.outstanding))),
        count: items.length,
      });
    }
    return out;
  });
}

export async function moneyAccountsFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    return Promise.all(
      accounts.map(async (a) => ({ ...a, balance: await moneyAccountsRepo.balanceOf(tx, orgId, a) })),
    );
  });
}

/** Other orgs in the system — the franchise link. ⚠️ Never this org: that is a sale to ourselves. */
export async function otherOrgs(orgId: string) {
  return withOrgPrincipal(orgId, (tx) => customersRepo.otherOrgs(tx, orgId));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ⭐ The label says what the treatment DOES to the books, not just what it is called. "Internal" and
 * "external" are one word apart and a world apart: one eliminates the movement, the other is
 * revenue.
 */
export const TREATMENT_LABEL: Record<string, string> = {
  internal: 'Internal — eliminates, not revenue',
  inter_entity: 'Another company — real revenue',
  external: 'External — real revenue',
};

export const TREATMENT_TONE: Record<string, string> = {
  internal: 'text-sky-700 dark:text-sky-400',
  inter_entity: 'text-violet-700 dark:text-violet-400',
  external: 'text-neutral-700 dark:text-neutral-300',
};

export const GROUP_LABEL: Record<string, string> = {
  wholesale: 'Wholesale',
  franchise: 'Franchise',
  internal: 'Internal',
  staff: 'Staff',
  other: 'Other',
};
