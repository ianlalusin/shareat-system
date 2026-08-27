/**
 * Server-only helpers for the customer and price-list screens. T-129.
 *
 * ⭐ The treatment is derived from the links on every read — there is no stored flag to render, and
 * that is deliberate (ADR-008 §2).
 */
import {
  customersRepo,
  treatmentOf,
  type CustomerRow,
  type PriceListItemRow,
  type PriceListRow,
} from '@shareat/db';
import type { CustomerTreatment } from '@shareat/db/schema';
import { withOrgPrincipal } from '../expenses/lib';

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
