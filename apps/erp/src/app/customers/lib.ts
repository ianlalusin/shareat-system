/**
 * Server-only helpers for the customer and price-list screens. T-129.
 *
 * ⭐ The treatment is derived from the links on every read — there is no stored flag to render, and
 * that is deliberate (ADR-008 §2).
 */
import { toBusinessDate } from '@shareat/core/datetime';
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
import { add, compare, money } from '@shareat/core/money';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';
import type { StoreOption } from '../expenses/lib';
import { heldStoresFor } from '../../lib/held-stores';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface CustomerListRow extends CustomerRow {
  treatment: CustomerTreatment;
  balance: string;
}

// ⛔ T-435 / bible row 353 — every reader of customer data takes the FULL Actor and is limited to the stores the actor may
//    collect at (`record_ar_collection`, store-scoped). Customers are org master data with no store of their own, so a viewer
//    sees a customer if it has any AR row at a held store, a held counterparty store, or no AR rows at all (Ian Q1: no
//    cross-branch customers). A refusal is authorize()'s AuthorizationError.

/** The stores `actor` may collect at; throws authorize()'s refusal when there are none. */
async function heldArStores(tx: Tx, actor: Actor): Promise<StoreOption[]> {
  const held = await heldStoresFor(tx, actor, ['record_ar_collection'], { includeRetired: true });
  if (held.length === 0) {
    await authorize(tx, actor, 'record_ar_collection', {}); // store-scoped with no storeId: always refuses
    throw new AuthorizationError('authorize: no store is held for record_ar_collection', 'record_ar_collection');
  }
  return held;
}

/** The stores the viewer may see, for the page's pickers and counterparty names. */
export async function arStoresFor(actor: Actor): Promise<StoreOption[]> {
  // Never throws: the pages turn an empty list into the plain refusal sentence.
  return withOrgPrincipal(actor.orgId, (tx) => heldStoresFor(tx, actor, ['record_ar_collection'], { includeRetired: true }));
}

export async function listRegister(actor: Actor): Promise<CustomerListRow[]> {
  const orgId = actor.orgId;
  return withOrgPrincipal(orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    const [rows, balances] = await Promise.all([
      customersRepo.listCustomersInScope(tx, orgId, storeIds),
      customersRepo.balancesByCustomer(tx, orgId, storeIds),
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

export async function getCustomer(actor: Actor, id: string): Promise<CustomerDetail | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    const row = await customersRepo.getByIdInScope(tx, actor.orgId, id, storeIds);
    return row ? { ...row, treatment: treatmentOf(row) } : null;
  });
}

/**
 * What the customer owes AT THE STORES THE VIEWER HOLDS (or at one chosen held store).
 *
 * ⚠️ **Per store when asked, and the page must never conflate them.** A credit limit is extended to a BUYER
 * (`recordCharge` judges it org-wide) - see `isOverLimit`, the only org-wide judgement that leaves this file, and only as a
 * yes/no. Allocation happens per STORE, because a collection posts every leg at its own store.
 */
export async function getPosition(actor: Actor, customerId: string, storeId?: string): Promise<string> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    if (storeId) await authorize(tx, actor, 'record_ar_collection', { storeId });
    const { controlBalance } = await arRepo.positionOf(tx, actor.orgId, customerId, storeId, storeIds);
    return controlBalance;
  });
}

/**
 * ⭐ T-435 - "is this buyer over their credit limit?", judged ORG-WIDE (a limit is extended to the buyer, not to a branch),
 * returned as a yes/no ONLY. The org-wide figure and other stores' amounts never reach the page.
 */
export async function isOverLimit(actor: Actor, customerId: string): Promise<boolean> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    const row = await customersRepo.getByIdInScope(tx, actor.orgId, customerId, storeIds);
    if (!row || row.creditLimit === null) return false;
    const { controlBalance } = await arRepo.positionOf(tx, actor.orgId, customerId);
    return compare(money(controlBalance), money(row.creditLimit)) > 0;
  });
}

/** Store credit held on the customer's behalf at the viewer's stores - `2140`, a liability, not a discount. */
export async function creditBalance(actor: Actor, customerId: string): Promise<string> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    return arRepo.creditBalanceOf(tx, actor.orgId, customerId, storeIds);
  });
}

export async function listCharges(actor: Actor, customerId: string, storeId?: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    if (storeId) await authorize(tx, actor, 'record_ar_collection', { storeId });
    return arRepo.listChargesForCustomer(tx, actor.orgId, customerId, storeId ? { storeId } : { storeIds });
  });
}

export async function listCollections(actor: Actor, customerId: string, storeId?: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const storeIds = (await heldArStores(tx, actor)).map((s) => s.id);
    if (storeId) await authorize(tx, actor, 'record_ar_collection', { storeId });
    return arRepo.listCollectionsForCustomer(tx, actor.orgId, customerId, storeId ? { storeId } : { storeIds });
  });
}

export async function openItemsFor(actor: Actor, customerId: string, storeId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'record_ar_collection', { storeId });
    return arRepo.openItems(tx, actor.orgId, customerId, storeId);
  });
}

/**
 * Which of the VIEWER'S stores this customer owes money at, with the total and the count.
 *
 * ⭐ Mirrors `/ap/suppliers/[id]`'s helper deliberately, including the reason it exists: the store
 * is **CHOSEN**, never inferred from whichever open item sorted first. AP's older behaviour booked
 * every leg of a payment at one store when the supplier was owed at two, so one store's control
 * account went negative and the other's never cleared.
 */
export async function storesWithOpenItems(
  actor: Actor,
  customerId: string,
): Promise<{ storeId: string; storeName: string; outstanding: string; count: number }[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const stores = await heldArStores(tx, actor);
    const out: { storeId: string; storeName: string; outstanding: string; count: number }[] = [];
    for (const s of stores) {
      const items = await arRepo.openItems(tx, actor.orgId, customerId, s.id);
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

export async function moneyAccountsFor(actor: Actor, storeId: string) {
  const orgId = actor.orgId;
  return withOrgPrincipal(orgId, async (tx) => {
    await authorize(tx, actor, 'record_ar_collection', { storeId });
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
  return toBusinessDate();
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
