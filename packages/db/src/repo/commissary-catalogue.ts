/**
 * The commissary catalogue's SQL — links, offerings, and the cross-store item map. T-171 / DEF-129.
 *
 * ⭐ DEF-129: `commissary_item_map` had NO writer anywhere in application code — grepped, exactly
 * two INSERTs existed in the whole tree, both in test fixtures — so a real internal branch↔commissary
 * receipt was guaranteed to throw (`receiveTradeOrder`'s own error names exactly this table). The
 * same was true of `commissary_links` and `commissary_item_offerings`: nothing could create either.
 * This file is every WRITER for all three, plus the reads the new admin screen needs.
 *
 * `commissary.ts` beside this file owns the ORDER SIDE's reads (`mapItem`, `orderableCatalogue`,
 * `listCommissariesFor`, `activeLinkExists`, `internalCustomerFor`) — called from here, never
 * duplicated.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { commissaryItemMap, commissaryItemOfferings, commissaryLinks, LINK_STATUSES } from '../../schema/commissary';
import { stores } from '../../schema/stores';

export type LinkStatus = (typeof LINK_STATUSES)[number];

// -----------------------------------------------------------------------------------------
// A small shared lookup — both a validation ("does this store belong to this org") and the
// store's own name, which `upsertCommissaryLink` (packages/domain) needs to name the internal
// customer it creates alongside the link.
// -----------------------------------------------------------------------------------------

export interface StoreIdentity {
  id: string;
  code: string;
  name: string;
}

export async function storesInOrg(
  tx: Tx,
  orgId: string,
  storeIds: readonly string[],
): Promise<Map<string, StoreIdentity>> {
  if (storeIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: stores.id, code: stores.code, name: stores.name })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), inArray(stores.id, [...storeIds])));
  return new Map(rows.map((r) => [r.id, r]));
}

// -----------------------------------------------------------------------------------------
// commissary_links — which branch may order from which commissary
// -----------------------------------------------------------------------------------------

export interface LinkRow {
  id: string;
  commissaryStoreId: string;
  commissaryCode: string;
  commissaryName: string;
  branchStoreId: string;
  branchCode: string;
  branchName: string;
  status: LinkStatus;
  createdAt: Date;
}

/** Every link in the org, both stores named. The catalogue screen filters to one commissary
 *  itself — this makes no assumption about which. */
export async function listLinks(tx: Tx, orgId: string): Promise<LinkRow[]> {
  const rows = (await tx.execute(sql`
    select l.id,
           l.commissary_store_id as "commissaryStoreId", cs.code as "commissaryCode", cs.name as "commissaryName",
           l.branch_store_id as "branchStoreId", bs.code as "branchCode", bs.name as "branchName",
           l.status, l.created_at as "createdAt"
    from commissary_links l
    join stores cs on cs.id = l.commissary_store_id
    join stores bs on bs.id = l.branch_store_id
    where l.org_id = ${orgId}
    order by cs.name asc, bs.name asc
  `)) as unknown as LinkRow[];
  return rows;
}

/** Insert, or — on the `(commissary_store_id, branch_store_id)` pair — flip the status of the
 *  link that already exists. A link is never duplicated; re-linking a retired pair reactivates it. */
export async function upsertLink(
  tx: Tx,
  input: {
    orgId: string;
    commissaryStoreId: string;
    branchStoreId: string;
    status: LinkStatus;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(commissaryLinks)
    .values(input)
    .onConflictDoUpdate({
      target: [commissaryLinks.commissaryStoreId, commissaryLinks.branchStoreId],
      set: { status: input.status },
    })
    .returning({ id: commissaryLinks.id });
  return row!;
}

// -----------------------------------------------------------------------------------------
// commissary_item_offerings — what this commissary will dispatch
// -----------------------------------------------------------------------------------------

export interface OfferingRow {
  id: string;
  commissaryStoreId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string;
  kind: string;
  isPurchasable: boolean;
  itemStatus: string;
  manualCost: string | null;
  status: LinkStatus;
  createdAt: Date;
  updatedAt: Date | null;
}

/** Every offering this commissary has ever made — active or not, so a manager can find and
 *  reactivate one they turned off rather than only ever seeing the live list. */
export async function listOfferings(tx: Tx, orgId: string, commissaryStoreId: string): Promise<OfferingRow[]> {
  const rows = (await tx.execute(sql`
    select o.id, o.commissary_store_id as "commissaryStoreId", o.item_id as "itemId",
           i.code as "itemCode", i.name as "itemName", i.base_unit as "baseUnit", i.kind,
           i.is_purchasable as "isPurchasable", i.status as "itemStatus",
           o.manual_cost::text as "manualCost", o.status,
           o.created_at as "createdAt", o.updated_at as "updatedAt"
    from commissary_item_offerings o
    join items i on i.id = o.item_id
    where o.org_id = ${orgId} and o.commissary_store_id = ${commissaryStoreId}
    order by i.name asc
  `)) as unknown as OfferingRow[];
  return rows;
}

/** Insert, or — on the `(commissary_store_id, item_id)` pair — replace the manual cost and status. */
export async function upsertOffering(
  tx: Tx,
  input: {
    orgId: string;
    commissaryStoreId: string;
    itemId: string;
    manualCost: string | null;
    status: LinkStatus;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(commissaryItemOfferings)
    .values(input)
    .onConflictDoUpdate({
      target: [commissaryItemOfferings.commissaryStoreId, commissaryItemOfferings.itemId],
      set: { manualCost: input.manualCost, status: input.status, updatedAt: sql`now()` },
    })
    .returning({ id: commissaryItemOfferings.id });
  return row!;
}

// -----------------------------------------------------------------------------------------
// commissary_item_map — the cross-store correspondence. DEF-129's whole point.
// -----------------------------------------------------------------------------------------

export interface MapRow {
  id: string;
  commissaryStoreId: string;
  branchStoreId: string;
  commissaryItemId: string;
  commissaryItemName: string;
  commissaryItemUnit: string;
  branchItemId: string;
  branchItemName: string;
  branchItemUnit: string;
  isLedgerOnly: boolean;
  expenseCategoryId: string | null;
  expenseGroup: string | null;
  expenseCategory: string | null;
  expenseSubCategory: string | null;
  createdAt: Date;
}

export async function listMap(
  tx: Tx,
  orgId: string,
  commissaryStoreId: string,
  branchStoreId: string,
): Promise<MapRow[]> {
  const rows = (await tx.execute(sql`
    select m.id, m.commissary_store_id as "commissaryStoreId", m.branch_store_id as "branchStoreId",
           m.commissary_item_id as "commissaryItemId", ci.name as "commissaryItemName", ci.base_unit as "commissaryItemUnit",
           m.branch_item_id as "branchItemId", bi.name as "branchItemName", bi.base_unit as "branchItemUnit",
           m.is_ledger_only as "isLedgerOnly",
           m.expense_category_id as "expenseCategoryId", ec."group" as "expenseGroup",
           ec.category as "expenseCategory", ec.sub_category as "expenseSubCategory",
           m.created_at as "createdAt"
    from commissary_item_map m
    join items ci on ci.id = m.commissary_item_id
    join items bi on bi.id = m.branch_item_id
    left join expense_categories ec on ec.id = m.expense_category_id
    where m.org_id = ${orgId} and m.commissary_store_id = ${commissaryStoreId} and m.branch_store_id = ${branchStoreId}
    order by ci.name asc
  `)) as unknown as MapRow[];
  return rows;
}

/** Insert, or — on the `(commissary_store_id, branch_store_id, commissary_item_id)` triple —
 *  replace the branch item, the ledger-only decision and the expense category. */
export async function upsertMap(
  tx: Tx,
  input: {
    orgId: string;
    commissaryStoreId: string;
    branchStoreId: string;
    commissaryItemId: string;
    branchItemId: string;
    isLedgerOnly: boolean;
    expenseCategoryId: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(commissaryItemMap)
    .values(input)
    .onConflictDoUpdate({
      target: [commissaryItemMap.commissaryStoreId, commissaryItemMap.branchStoreId, commissaryItemMap.commissaryItemId],
      set: {
        branchItemId: input.branchItemId,
        isLedgerOnly: input.isLedgerOnly,
        expenseCategoryId: input.expenseCategoryId,
      },
    })
    .returning({ id: commissaryItemMap.id });
  return row!;
}

export interface MapIdentity {
  id: string;
  commissaryStoreId: string;
  branchStoreId: string;
}

/** What `removeMap`'s `authorize()` call needs before it knows which store to check — the map
 *  is the branch's to own (T-171 invariant 9), and the row itself is the only place that says which. */
export async function getMapById(tx: Tx, orgId: string, id: string): Promise<MapIdentity | undefined> {
  const [row] = await tx
    .select({
      id: commissaryItemMap.id,
      commissaryStoreId: commissaryItemMap.commissaryStoreId,
      branchStoreId: commissaryItemMap.branchStoreId,
    })
    .from(commissaryItemMap)
    .where(and(eq(commissaryItemMap.id, id), eq(commissaryItemMap.orgId, orgId)))
    .limit(1);
  return row;
}

export async function removeMap(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const deleted = await tx
    .delete(commissaryItemMap)
    .where(and(eq(commissaryItemMap.id, id), eq(commissaryItemMap.orgId, orgId)))
    .returning({ id: commissaryItemMap.id });
  return deleted.length > 0;
}
