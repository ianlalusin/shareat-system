import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { commissaryItemMap, commissaryLinks } from '../../schema/commissary';
import { customers } from '../../schema/customers';
import { stores } from '../../schema/stores';
import type { Tx } from '../client';

/**
 * The ORDER side's reads of the commissary catalogue — T-165 / T-172. The catalogue's own writers
 * (links, offerings, the map) live in `commissary-catalogue.ts` (T-171 / DEF-129).
 */

export interface MappedItem {
  branchItemId: string;
  isLedgerOnly: boolean;
  /** T-171 invariant 12 — the category the order captures at submit and the receipt reads back. */
  expenseCategoryId: string | null;
}

/**
 * ⭐ T-165. `confirmReceipt` needs the BRANCH's item for a line the commissary shipped — they
 * routinely differ (a commissary ships `prepped` marinated pork; the branch receives it as the
 * `raw_material` it will cook). `branch_item_id` is NOT NULL on this table by design (the
 * schema's own comment: an overloaded null cannot tell "not mapped yet" from "deliberately
 * ledger-only"), so a missing row is refused here rather than guessed.
 */
export async function mapItem(
  tx: Tx,
  commissaryStoreId: string,
  branchStoreId: string,
  commissaryItemId: string,
): Promise<MappedItem | undefined> {
  const [row] = await tx
    .select({
      branchItemId: commissaryItemMap.branchItemId,
      isLedgerOnly: commissaryItemMap.isLedgerOnly,
      expenseCategoryId: commissaryItemMap.expenseCategoryId,
    })
    .from(commissaryItemMap)
    .where(
      and(
        eq(commissaryItemMap.commissaryStoreId, commissaryStoreId),
        eq(commissaryItemMap.branchStoreId, branchStoreId),
        eq(commissaryItemMap.commissaryItemId, commissaryItemId),
      ),
    );
  return row;
}

/** ⭐ T-172. The map for EVERY item on an order in one query — submit resolves all lines at once. */
export async function mapItems(
  tx: Tx,
  commissaryStoreId: string,
  branchStoreId: string,
  commissaryItemIds: readonly string[],
): Promise<Map<string, MappedItem>> {
  if (commissaryItemIds.length === 0) return new Map();
  const rows = await tx
    .select({
      commissaryItemId: commissaryItemMap.commissaryItemId,
      branchItemId: commissaryItemMap.branchItemId,
      isLedgerOnly: commissaryItemMap.isLedgerOnly,
      expenseCategoryId: commissaryItemMap.expenseCategoryId,
    })
    .from(commissaryItemMap)
    .where(
      and(
        eq(commissaryItemMap.commissaryStoreId, commissaryStoreId),
        eq(commissaryItemMap.branchStoreId, branchStoreId),
        inArray(commissaryItemMap.commissaryItemId, [...commissaryItemIds]),
      ),
    );
  return new Map(rows.map((r) => [r.commissaryItemId, r]));
}

export interface CommissaryOption {
  id: string;
  code: string;
  name: string;
}

/** T-171 §4 `listAvailableCommissaries` — the commissaries this branch may order from, one query. */
export async function listCommissariesFor(tx: Tx, orgId: string, branchStoreId: string): Promise<CommissaryOption[]> {
  return tx
    .select({ id: stores.id, code: stores.code, name: stores.name })
    .from(commissaryLinks)
    .innerJoin(stores, eq(stores.id, commissaryLinks.commissaryStoreId))
    .where(
      and(
        eq(commissaryLinks.orgId, orgId),
        eq(commissaryLinks.branchStoreId, branchStoreId),
        eq(commissaryLinks.status, 'active'),
      ),
    )
    .orderBy(asc(stores.name));
}

export async function activeLinkExists(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  branchStoreId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: commissaryLinks.id })
    .from(commissaryLinks)
    .where(
      and(
        eq(commissaryLinks.orgId, orgId),
        eq(commissaryLinks.commissaryStoreId, commissaryStoreId),
        eq(commissaryLinks.branchStoreId, branchStoreId),
        eq(commissaryLinks.status, 'active'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * ⭐ How an internal order NAMES the branch: `trade_orders.customer_id` is NOT NULL, and T-133
 * derives the `internal` treatment from `customers.counterparty_store_id`. A branch with no such
 * row cannot be ordered for at all — the link screen (T-171 / DEF-129) creates it alongside the
 * link, so a branch that may order always has one.
 */
export async function internalCustomerFor(
  tx: Tx,
  orgId: string,
  branchStoreId: string,
): Promise<{ id: string; name: string; status: string } | undefined> {
  const [row] = await tx
    .select({ id: customers.id, name: customers.name, status: customers.status })
    .from(customers)
    .where(and(eq(customers.orgId, orgId), eq(customers.counterpartyStoreId, branchStoreId)))
    .orderBy(asc(customers.createdAt))
    .limit(1);
  return row;
}

export interface CatalogueRow {
  commissaryItemId: string;
  code: string;
  name: string;
  baseUnit: string;
  kind: string;
  /** Tier 3 of the price fallback, from the offering. */
  manualCost: string | null;
  branchItemId: string | null;
  branchItemName: string | null;
  branchItemBaseUnit: string | null;
  isLedgerOnly: boolean;
  expenseCategoryId: string | null;
  expenseCategoryLabel: string | null;
}

/**
 * ⭐ T-171 §4 `orderableCatalogue`, the SQL half: every ACTIVE offering of this commissary, joined
 * to its item and to this branch's map row (if any). Pricing is the domain's job — `branchPriceFor`
 * is T-151's and is called, not reimplemented (T-171 invariant 5).
 */
export async function orderableCatalogue(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  branchStoreId: string,
): Promise<CatalogueRow[]> {
  const rows = (await tx.execute(sql`
    select o.item_id                          as "commissaryItemId",
           i.code, i.name, i.base_unit        as "baseUnit", i.kind,
           o.manual_cost::text                as "manualCost",
           m.branch_item_id                   as "branchItemId",
           bi.name                            as "branchItemName",
           bi.base_unit                       as "branchItemBaseUnit",
           coalesce(m.is_ledger_only, false)  as "isLedgerOnly",
           m.expense_category_id              as "expenseCategoryId",
           case when ec.id is null then null
                else ec."group" || ' — ' || ec.category || coalesce(' / ' || ec.sub_category, '') end
                                              as "expenseCategoryLabel"
    from commissary_item_offerings o
    join items i on i.id = o.item_id
    left join commissary_item_map m
      on m.commissary_store_id = o.commissary_store_id
     and m.branch_store_id = ${branchStoreId}
     and m.commissary_item_id = o.item_id
    left join items bi on bi.id = m.branch_item_id
    left join expense_categories ec on ec.id = m.expense_category_id
    where o.org_id = ${orgId}
      and o.commissary_store_id = ${commissaryStoreId}
      and o.status = 'active'
      and i.status = 'active'
    order by i.name asc
  `)) as unknown as CatalogueRow[];
  return rows;
}
