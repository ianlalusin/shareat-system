/**
 * The only place SQL is written for the item master and supplier invoice lines. T-145.
 *
 * ⭐ **Price history is a QUERY, never a table.** Same discipline as `apRepo.openItems`: every
 * figure recomputes from `supplier_invoice_lines`, so nothing can go stale. That is not a
 * preference — v1's stored `costPerUnit` is **zero on 595 of its 842 items (71%)**, which is what
 * an unmaintained snapshot looks like after a year.
 *
 * ⚠️ **The normalisation, once, here.** A supplier bills in whatever unit it likes — a case, a
 * sack, a kilo. Comparing those numbers directly is meaningless. Every query below derives:
 *
 *     baseQuantity = quantity × conversion_factor          (in the item's own base unit)
 *     basePrice    = line_total ÷ baseQuantity             (₱ per base unit)
 *
 * and the conversion factor comes from the LINE, never from the item — see `schema/items.ts`.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { recordGone } from './record-gone';
import {
  items,
  itemRequests,
  type ItemRequestStatus,
  type BaseUnit,
  type ItemKind,
  type ItemStatus,
} from '../../schema/items';
import { supplierItems, type CatalogueSource } from '../../schema/supplier-items';
import type { Decimal, Money, Quantity } from '@shareat/core/money';
import { storeItemSellability } from '../../schema/items';
import { stockMovements } from '../../schema/stock-ledger';

export interface ItemRow {
  id: string;
  orgId: string;
  code: string;
  name: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  status: ItemStatus;
  /** T-151. Price off another item (a slab) instead of this one's own history. */
  costBasisItemId: string | null;
  isPurchasable: boolean;
  sellableRetail: boolean;
  sellableWholesale: boolean;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertItem(
  tx: Tx,
  input: {
    orgId: string;
    code: string;
    name: string;
    kind: ItemKind;
    baseUnit: BaseUnit;
    notes: string | null;
    createdBy: string;
    isPurchasable?: boolean;
    sellableRetail?: boolean;
    sellableWholesale?: boolean;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(items).values(input).returning({ id: items.id });
  return row!;
}

export async function getItemById(tx: Tx, orgId: string, id: string): Promise<ItemRow | undefined> {
  const [row] = await tx
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.orgId, orgId)))
    .limit(1);
  return row as ItemRow | undefined;
}

export async function listItems(
  tx: Tx,
  orgId: string,
  filter: { includeInactive?: boolean } = {},
): Promise<ItemRow[]> {
  const conditions = [eq(items.orgId, orgId)];
  if (!filter.includeInactive) conditions.push(eq(items.status, 'active'));
  const rows = await tx.select().from(items).where(and(...conditions)).orderBy(asc(items.name));
  return rows as ItemRow[];
}

/**
 * T-383 S2b (B2.5). The items a CONSUME or MOVE picker offers at one store: every active item, plus a retired
 * (`inactive`) item only while its on-hand at THAT store is above zero ("usable until it is used up"). A merged item is
 * never offered. Same columns and order as `listItems`.
 */
export async function listUsableItems(tx: Tx, orgId: string, storeId: string): Promise<ItemRow[]> {
  const rows = await tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.orgId, orgId),
        sql`(${items.status} = 'active' or (${items.status} = 'inactive' and (
          select coalesce(sum(${stockMovements.quantity}), 0) from ${stockMovements}
          where ${stockMovements.itemId} = ${items.id} and ${stockMovements.storeId} = ${storeId}
            and ${stockMovements.orgId} = ${orgId}
        ) > 0))`,
      ),
    )
    .orderBy(asc(items.name));
  return rows as ItemRow[];
}

export async function updateItem(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{
    code: string;
    name: string;
    kind: ItemKind;
    baseUnit: BaseUnit;
    status: ItemStatus;
    notes: string | null;
    isPurchasable: boolean;
    sellableRetail: boolean;
    sellableWholesale: boolean;
    costBasisItemId: string | null;
  }>,
): Promise<void> {
  const updated = await tx
    .update(items)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(items.id, id), eq(items.orgId, orgId)))
    .returning({ id: items.id });
  if (updated.length === 0) throw recordGone(`updateItem: item ${id} does not exist in org ${orgId}`, 'item');
}

// -------------------------------------------------------------------------------------
// supplier_invoice_lines
// -------------------------------------------------------------------------------------

/**
 * T-371 C2 — what `insertInvoiceLines` binds. Raw SQL, so `SafeInsert` cannot type it: each numeric is branded with
 * its column's shape instead (quantity (14,3), conversion_factor (14,6), unit_price (14,4), line_total (14,2)).
 */
export interface InvoiceLineInput {
  lineNo: number;
  itemId: string;
  description: string | null;
  quantity: Quantity;
  purchaseUnit: string;
  conversionFactor: Decimal<'14,6'>;
  unitPrice: Decimal<'14,4'>;
  lineTotal: Money;
}

export async function insertInvoiceLines(
  tx: Tx,
  supplierInvoiceId: string,
  lines: InvoiceLineInput[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.execute(sql`
    insert into supplier_invoice_lines
      (supplier_invoice_id, line_no, item_id, description, quantity, purchase_unit, conversion_factor, unit_price, line_total)
    values ${sql.join(
      lines.map(
        (l) => sql`(${supplierInvoiceId}, ${l.lineNo}, ${l.itemId}, ${l.description}, ${l.quantity},
                    ${l.purchaseUnit}, ${l.conversionFactor}, ${l.unitPrice}, ${l.lineTotal})`,
      ),
      sql`, `,
    )}
  `);
}

/** Clears an invoice's lines so `setInvoiceLines` can replace the whole set. */
export async function deleteInvoiceLines(tx: Tx, supplierInvoiceId: string): Promise<void> {
  await tx.execute(sql`delete from supplier_invoice_lines where supplier_invoice_id = ${supplierInvoiceId}`);
}

/** A line as READ back. Plain strings: a read is not a write, and nothing here is bound to a column. */
export interface InvoiceLineRow {
  lineNo: number;
  itemId: string;
  description: string | null;
  quantity: string;
  purchaseUnit: string;
  conversionFactor: string;
  unitPrice: string;
  lineTotal: string;
  id: string;
  itemName: string;
  baseUnit: string;
  baseQuantity: string;
  basePrice: string;
}

export async function linesForInvoice(tx: Tx, orgId: string, invoiceId: string): Promise<InvoiceLineRow[]> {
  const rows = (await tx.execute(sql`
    select l.id, l.line_no, l.item_id, l.description, l.quantity::text as quantity,
           l.purchase_unit, l.conversion_factor::text as conversion_factor,
           l.unit_price::text as unit_price, l.line_total::text as line_total,
           i.name as item_name, i.base_unit,
           (l.quantity * l.conversion_factor)::text as base_quantity,
           (l.line_total / nullif(l.quantity * l.conversion_factor, 0))::text as base_price
    from supplier_invoice_lines l
    join supplier_invoices si on si.id = l.supplier_invoice_id
    join items i on i.id = l.item_id
    where l.supplier_invoice_id = ${invoiceId} and si.org_id = ${orgId}
    order by l.line_no asc
  `)) as unknown as Record<string, string>[];
  return rows.map(mapLine);
}

function mapLine(r: Record<string, string>): InvoiceLineRow {
  return {
    id: String(r.id),
    lineNo: Number(r.line_no ?? r.lineNo),
    itemId: String(r.item_id ?? r.itemId),
    description: r.description ?? null,
    quantity: Number(r.quantity).toFixed(3),
    purchaseUnit: String(r.purchase_unit ?? r.purchaseUnit),
    conversionFactor: Number(r.conversion_factor ?? r.conversionFactor).toFixed(6),
    unitPrice: Number(r.unit_price ?? r.unitPrice).toFixed(4),
    lineTotal: Number(r.line_total ?? r.lineTotal).toFixed(2),
    itemName: String(r.item_name ?? r.itemName),
    baseUnit: String(r.base_unit ?? r.baseUnit),
    baseQuantity: Number(r.base_quantity ?? r.baseQuantity).toFixed(3),
    basePrice: Number(r.base_price ?? r.basePrice).toFixed(4),
  };
}

// -------------------------------------------------------------------------------------
// ⭐ Price history — derived, never stored
// -------------------------------------------------------------------------------------

export interface PriceObservation {
  invoiceId: string;
  invoiceDate: string;
  supplierId: string;
  supplierName: string;
  storeId: string;
  quantity: string;
  purchaseUnit: string;
  unitPrice: string;
  baseQuantity: string;
  /** ⭐ ₱ per the item's own base unit — the only figure that is comparable across suppliers. */
  basePrice: string;
  /**
   * ⭐ T-151. `basePrice` plus this line's share of the invoice's inbound delivery and other fees,
   * allocated by value. What the goods actually cost to have — the basis a branch price is built
   * on. Equals `basePrice` when the invoice carried no fees.
   */
  landedBasePrice: string;
}

/**
 * Every price ever paid for one item, oldest first.
 *
 * ⛔ Voided invoices are excluded: a bill that was cancelled is not evidence of a price.
 */
export async function priceHistory(
  tx: Tx,
  orgId: string,
  itemId: string,
  filter: { from?: string; to?: string; storeId?: string; supplierId?: string } = {},
): Promise<PriceObservation[]> {
  const rows = (await tx.execute(sql`
    select si.id as invoice_id, si.invoice_date::text as invoice_date, si.supplier_id,
           s.name as supplier_name, si.store_id,
           l.quantity::text as quantity, l.purchase_unit, l.unit_price::text as unit_price,
           (l.quantity * l.conversion_factor)::text as base_quantity,
           (l.line_total / nullif(l.quantity * l.conversion_factor, 0))::text as base_price,
           -- ⭐ T-151 LANDED cost. Ian, 2026-08-28: "delivery fee from supplier to Lipa is added
           -- to price." The invoice's inbound fees are allocated across its lines BY VALUE and
           -- folded into the per-base-unit cost, so a price built on this is what the goods
           -- actually cost to have, not merely what the line said.
           -- ⚠️ Allocated on every read, never stored: a corrected fee re-allocates itself, which
           -- is exactly why v1's stored basis could be poisoned and this cannot.
           (
             (
               l.line_total
               + (coalesce(si.delivery_fee, 0) + coalesce(si.other_fees, 0))
                 * (l.line_total / nullif(g.goods, 0))
             ) / nullif(l.quantity * l.conversion_factor, 0)
           )::text as landed_base_price
    from supplier_invoice_lines l
    join supplier_invoices si on si.id = l.supplier_invoice_id
    -- DEF-602 (T-379 R7): the fee share's denominator is the WHOLE bill's lines, summed BEFORE
    -- the item filter narrows them. A window over the filtered rows gave each item the whole fee.
    join (
      select l2.supplier_invoice_id, sum(l2.line_total) as goods
      from supplier_invoice_lines l2
      join supplier_invoices s2 on s2.id = l2.supplier_invoice_id
      where s2.org_id = ${orgId}
        and l2.supplier_invoice_id in (
          select supplier_invoice_id from supplier_invoice_lines where item_id = ${itemId})
      group by l2.supplier_invoice_id
    ) g on g.supplier_invoice_id = l.supplier_invoice_id
    join suppliers s on s.id = si.supplier_id
    where si.org_id = ${orgId} and l.item_id = ${itemId} and si.status <> 'voided'
      ${filter.from ? sql`and si.invoice_date >= ${filter.from}` : sql``}
      ${filter.to ? sql`and si.invoice_date <= ${filter.to}` : sql``}
      ${filter.storeId ? sql`and si.store_id = ${filter.storeId}` : sql``}
      ${filter.supplierId ? sql`and si.supplier_id = ${filter.supplierId}` : sql``}
    order by si.invoice_date asc, si.id asc
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    invoiceId: String(r.invoice_id ?? r.invoiceId),
    invoiceDate: String(r.invoice_date ?? r.invoiceDate),
    supplierId: String(r.supplier_id ?? r.supplierId),
    supplierName: String(r.supplier_name ?? r.supplierName),
    storeId: String(r.store_id ?? r.storeId),
    quantity: Number(r.quantity).toFixed(3),
    purchaseUnit: String(r.purchase_unit ?? r.purchaseUnit),
    unitPrice: Number(r.unit_price ?? r.unitPrice).toFixed(4),
    baseQuantity: Number(r.base_quantity ?? r.baseQuantity).toFixed(3),
    basePrice: Number(r.base_price ?? r.basePrice).toFixed(4),
    landedBasePrice: Number(
      r.landed_base_price ?? r.landedBasePrice ?? r.base_price ?? r.basePrice,
    ).toFixed(4),
  }));
}

export interface PriceMonth {
  month: string;
  observations: number;
  minPrice: string;
  maxPrice: string;
  /** ⭐ WEIGHTED: total spent ÷ total base quantity. Never a mean of means — buying 100kg at ₱290
   *  and 1kg at ₱400 is not "₱345 average", and a chart that says so misleads about the money. */
  avgPrice: string;
  totalSpent: string;
}

export async function priceMovement(
  tx: Tx,
  orgId: string,
  itemId: string,
  filter: { from?: string; to?: string } = {},
): Promise<PriceMonth[]> {
  const rows = (await tx.execute(sql`
    with obs as (
      select to_char(si.invoice_date, 'YYYY-MM') as month,
             l.line_total as spent,
             (l.quantity * l.conversion_factor) as base_qty,
             (l.line_total / nullif(l.quantity * l.conversion_factor, 0)) as base_price
      from supplier_invoice_lines l
      join supplier_invoices si on si.id = l.supplier_invoice_id
      where si.org_id = ${orgId} and l.item_id = ${itemId} and si.status <> 'voided'
        ${filter.from ? sql`and si.invoice_date >= ${filter.from}` : sql``}
        ${filter.to ? sql`and si.invoice_date <= ${filter.to}` : sql``}
    )
    select month, count(*)::int as observations,
           min(base_price)::text as min_price, max(base_price)::text as max_price,
           (sum(spent) / nullif(sum(base_qty), 0))::text as avg_price,
           sum(spent)::text as total_spent
    from obs group by month order by month asc
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    month: String(r.month),
    observations: Number(r.observations),
    minPrice: Number(r.min_price ?? r.minPrice).toFixed(4),
    maxPrice: Number(r.max_price ?? r.maxPrice).toFixed(4),
    avgPrice: Number(r.avg_price ?? r.avgPrice).toFixed(4),
    totalSpent: Number(r.total_spent ?? r.totalSpent).toFixed(2),
  }));
}

/**
 * ⭐ What T-146's supplier comparison will read: every supplier who has billed this item, with
 * what they charged per base unit. Built now because it is three lines on top of `priceHistory`
 * and it is the question Ian asked ("compare multiple suppliers of same product").
 */
export interface SupplierPrice {
  supplierId: string;
  supplierName: string;
  observations: number;
  lastDate: string;
  lastPrice: string;
  avgPrice: string;
}

export async function priceBySupplier(tx: Tx, orgId: string, itemId: string): Promise<SupplierPrice[]> {
  const rows = (await tx.execute(sql`
    with obs as (
      select si.supplier_id, s.name as supplier_name, si.invoice_date,
             l.line_total as spent,
             (l.quantity * l.conversion_factor) as base_qty,
             (l.line_total / nullif(l.quantity * l.conversion_factor, 0)) as base_price
      from supplier_invoice_lines l
      join supplier_invoices si on si.id = l.supplier_invoice_id
      join suppliers s on s.id = si.supplier_id
      where si.org_id = ${orgId} and l.item_id = ${itemId} and si.status <> 'voided'
    )
    select supplier_id, supplier_name, count(*)::int as observations,
           max(invoice_date)::text as last_date,
           (array_agg(base_price order by invoice_date desc))[1]::text as last_price,
           (sum(spent) / nullif(sum(base_qty), 0))::text as avg_price
    from obs group by supplier_id, supplier_name order by avg_price asc
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    supplierId: String(r.supplier_id ?? r.supplierId),
    supplierName: String(r.supplier_name ?? r.supplierName),
    observations: Number(r.observations),
    lastDate: String(r.last_date ?? r.lastDate),
    lastPrice: Number(r.last_price ?? r.lastPrice).toFixed(4),
    avgPrice: Number(r.avg_price ?? r.avgPrice).toFixed(4),
  }));
}

// -------------------------------------------------------------------------------------
// ⭐ The supplier-item catalogue — T-147. Two sources, one query, nothing cached.
// -------------------------------------------------------------------------------------

export interface CatalogueEntry {
  supplierId: string;
  supplierName: string;
  itemId: string;
  itemName: string;
  itemCode: string;
  baseUnit: string;
  /** How we know. Computed here, never stored — see `schema/supplier-items.ts`. */
  source: CatalogueSource;
  /** The earliest invoice date that proves it. Null for a declaration nobody has billed yet. */
  firstSeenOn: string | null;
  /** How many invoice lines carry it. 0 for a declaration. */
  timesBilled: number;
}

/**
 * ⛔ **`observed` beats `declared` on collision, with no promotion step anywhere.**
 *
 * A declaration that later gets an invoice simply starts reporting as observed, with its real
 * date — the `supplier_items` row stops mattering rather than needing to be updated. That is the
 * whole payoff of deriving instead of storing: the two sources cannot disagree, because one of
 * them is not a copy.
 *
 * ⚠️ A VOIDED invoice still counts. The supplier did bill us that item; voiding corrects the
 * money, not the fact that the relationship exists. Filtering voided invoices out here would make
 * the catalogue flicker as bills are corrected.
 */
const catalogueQuery = (where: ReturnType<typeof sql>) => sql`
  with observed as (
    select si.supplier_id, l.item_id,
           min(si.invoice_date)::text as first_seen_on,
           count(*)::int as times_billed
    from supplier_invoice_lines l
    join supplier_invoices si on si.id = l.supplier_invoice_id
    group by si.supplier_id, l.item_id
  ),
  declared as (
    select supplier_id, item_id from supplier_items
  ),
  merged as (
    select supplier_id, item_id, 'observed' as source, first_seen_on, times_billed
    from observed
    union all
    select d.supplier_id, d.item_id, 'declared' as source, null::text, 0
    from declared d
    -- ⛔ Anti-join, so a declaration an invoice has since proven appears ONCE, as observed.
    where not exists (
      select 1 from observed o where o.supplier_id = d.supplier_id and o.item_id = d.item_id
    )
  )
  select m.*, s.name as supplier_name, i.name as item_name, i.code as item_code, i.base_unit
  from merged m
  join suppliers s on s.id = m.supplier_id
  join items i on i.id = m.item_id
  where s.org_id = i.org_id and ${where}
  order by i.name asc
`;

function mapCatalogue(r: Record<string, unknown>): CatalogueEntry {
  return {
    supplierId: String(r.supplier_id ?? r.supplierId),
    supplierName: String(r.supplier_name ?? r.supplierName),
    itemId: String(r.item_id ?? r.itemId),
    itemName: String(r.item_name ?? r.itemName),
    itemCode: String(r.item_code ?? r.itemCode),
    baseUnit: String(r.base_unit ?? r.baseUnit),
    source: String(r.source) as CatalogueSource,
    firstSeenOn: r.first_seen_on ? String(r.first_seen_on) : null,
    timesBilled: Number(r.times_billed ?? 0),
  };
}

/** What this supplier sells us — billed in the past, or declared for the future. */
export async function itemsForSupplier(tx: Tx, orgId: string, supplierId: string): Promise<CatalogueEntry[]> {
  const rows = (await tx.execute(
    catalogueQuery(sql`i.org_id = ${orgId} and m.supplier_id = ${supplierId}`),
  )) as unknown as Record<string, unknown>[];
  return rows.map(mapCatalogue);
}

/** Who sells us this item. The sourcing-risk view: one row here is a single point of supply. */
export async function suppliersForItem(tx: Tx, orgId: string, itemId: string): Promise<CatalogueEntry[]> {
  const rows = (await tx.execute(
    catalogueQuery(sql`i.org_id = ${orgId} and m.item_id = ${itemId}`),
  )) as unknown as Record<string, unknown>[];
  return rows.map(mapCatalogue);
}

export async function insertSupplierItem(
  tx: Tx,
  input: { orgId: string; supplierId: string; itemId: string; notes: string | null; createdBy: string },
): Promise<{ id: string }> {
  const [row] = await tx.insert(supplierItems).values(input).returning({ id: supplierItems.id });
  return row!;
}

/** ⛔ Removes a DECLARATION. An observed link is not a row, so this cannot reach one. */
export async function deleteSupplierItem(
  tx: Tx,
  orgId: string,
  supplierId: string,
  itemId: string,
): Promise<boolean> {
  const gone = await tx
    .delete(supplierItems)
    .where(
      and(
        eq(supplierItems.orgId, orgId),
        eq(supplierItems.supplierId, supplierId),
        eq(supplierItems.itemId, itemId),
      ),
    )
    .returning({ id: supplierItems.id });
  return gone.length > 0;
}

// -------------------------------------------------------------------------------------
// ⭐ T-148 — near-duplicate detection, requests, and merge
// -------------------------------------------------------------------------------------

/**
 * The similarity floor. Measured against this project's real names before being chosen:
 *
 *   3D W/LID    vs 3D W/LID.     1.00   ← my own import created both
 *   Bean sprout vs Beans Sprout  0.79   ← in v1's live data, kg vs pcs
 *   Coke 1.5    vs Coke 15       0.55   ← genuinely different, correctly still flagged
 *   Pork Belly  vs Beef Belly    0.43   ← unrelated, correctly silent
 *
 * ⚠️ 0.5 deliberately catches `Coke 1.5`/`Coke 15`. A machine cannot tell a typo from a real
 * variant, so it hands both to a person — the cost of a false warning is one glance, and the cost
 * of a missed duplicate is a price history that silently splits in two.
 */
export const SIMILARITY_FLOOR = 0.5;

export interface SimilarItem {
  id: string;
  name: string;
  code: string;
  baseUnit: string;
  status: string;
  similarity: number;
}

/**
 * Names close enough to `name` to be worth a human's attention.
 *
 * ⛔ Advisory only. Nothing in this module blocks on the result or merges on it — `pg_trgm`
 * cannot distinguish `Coke 1.5` from `Coke 15`, and a system that auto-merged on 0.55 would
 * destroy real items.
 */
export async function findSimilarItems(
  tx: Tx,
  orgId: string,
  name: string,
  floor = SIMILARITY_FLOOR,
): Promise<SimilarItem[]> {
  const rows = (await tx.execute(sql`
    select id, name, code, base_unit, status, similarity(lower(name), lower(${name})) as sim
    from items
    where org_id = ${orgId}
      and status <> 'merged'
      and similarity(lower(name), lower(${name})) >= ${floor}
    order by sim desc
    limit 10
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    code: String(r.code),
    baseUnit: String(r.base_unit ?? r.baseUnit),
    status: String(r.status),
    similarity: Number(r.sim),
  }));
}

export interface ItemRequestRow {
  id: string;
  orgId: string;
  name: string;
  code: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  isPurchasable: boolean;
  sellableRetail: boolean;
  sellableWholesale: boolean;
  reason: string | null;
  status: ItemRequestStatus;
  similarWarning: string | null;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdItemId: string | null;
}

export async function insertItemRequest(
  tx: Tx,
  input: {
    orgId: string;
    name: string;
    code: string;
    kind: ItemKind;
    baseUnit: BaseUnit;
    /** T-378 R7: omitted means the DB default (true / false / false). */
    isPurchasable?: boolean;
    sellableRetail?: boolean;
    sellableWholesale?: boolean;
    reason: string | null;
    similarWarning: string | null;
    requestedBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(itemRequests).values(input).returning({ id: itemRequests.id });
  return row!;
}

/** T-378 R2: the one definition of "has history" lives in the database; this is the page's courtesy read of it. */
export async function unitHistoryExists(tx: Tx, itemId: string): Promise<boolean> {
  const rows = await tx.execute(sql`select items_unit_history_exists(${itemId}::uuid) as h`);
  return (rows as unknown as { h: boolean }[])[0]?.h === true;
}

export async function getItemRequestById(tx: Tx, orgId: string, id: string): Promise<ItemRequestRow | undefined> {
  const [row] = await tx
    .select()
    .from(itemRequests)
    .where(and(eq(itemRequests.id, id), eq(itemRequests.orgId, orgId)))
    .limit(1);
  return row as ItemRequestRow | undefined;
}

export async function listItemRequests(
  tx: Tx,
  orgId: string,
  filter: { status?: ItemRequestStatus } = {},
): Promise<ItemRequestRow[]> {
  const conditions = [eq(itemRequests.orgId, orgId)];
  if (filter.status) conditions.push(eq(itemRequests.status, filter.status));
  const rows = await tx
    .select()
    .from(itemRequests)
    .where(and(...conditions))
    .orderBy(asc(itemRequests.requestedAt));
  return rows as ItemRequestRow[];
}

export async function decideItemRequest(
  tx: Tx,
  orgId: string,
  id: string,
  input: { status: 'approved' | 'rejected'; decidedBy: string; decisionNote: string | null; createdItemId: string | null },
): Promise<void> {
  const updated = await tx
    .update(itemRequests)
    .set({
      status: input.status,
      decidedBy: input.decidedBy,
      decidedAt: sql`now()`,
      decisionNote: input.decisionNote,
      createdItemId: input.createdItemId,
    })
    .where(and(eq(itemRequests.id, id), eq(itemRequests.orgId, orgId), eq(itemRequests.status, 'requested')))
    .returning({ id: itemRequests.id });
  if (updated.length === 0) {
    throw recordGone(`decideItemRequest: request ${id} does not exist or has already been decided`, 'item request');
  }
}

export interface MergeReport {
  invoiceLines: number;
  priceListRates: number;
  supplierLinks: number;
}

/**
 * ⭐ Repoint everything that references `loserId` at `winnerId`, then mark the loser merged.
 *
 * ⚠️ **Every referencing table must be listed here.** A table added later that references `items`
 * and is not repointed leaves rows pointing at a merged item — which still resolves, because the
 * row survives, but silently stops appearing in the winner's history. The FKs are the checklist:
 * `supplier_invoice_lines`, `price_list_items`, `supplier_items`.
 *
 * ⚠️ `supplier_items` needs ON CONFLICT: both items may be linked to the same supplier, and the
 * unique index would otherwise abort the whole merge. The loser's link is dropped rather than
 * duplicated.
 */
export async function mergeItemInto(
  tx: Tx,
  orgId: string,
  loserId: string,
  winnerId: string,
): Promise<MergeReport> {
  const lines = (await tx.execute(sql`
    update supplier_invoice_lines set item_id = ${winnerId} where item_id = ${loserId} returning id
  `)) as unknown as unknown[];

  const rates = (await tx.execute(sql`
    update price_list_items set item_id = ${winnerId}
    where org_id = ${orgId} and item_id = ${loserId}
      and not exists (
        select 1 from price_list_items w
        where w.price_list_id = price_list_items.price_list_id and w.item_id = ${winnerId}
      )
    returning id
  `)) as unknown as unknown[];
  // A rate that would have collided with one the winner already has is dropped, not overwritten:
  // the winner's own price is the surviving statement of what that item costs.
  await tx.execute(sql`delete from price_list_items where org_id = ${orgId} and item_id = ${loserId}`);

  const links = (await tx.execute(sql`
    update supplier_items set item_id = ${winnerId}
    where org_id = ${orgId} and item_id = ${loserId}
      and not exists (
        select 1 from supplier_items w
        where w.supplier_id = supplier_items.supplier_id and w.item_id = ${winnerId}
      )
    returning id
  `)) as unknown as unknown[];
  await tx.execute(sql`delete from supplier_items where org_id = ${orgId} and item_id = ${loserId}`);

  await tx.execute(sql`
    update items set status = 'merged', merged_into_id = ${winnerId}, updated_at = now()
    where id = ${loserId} and org_id = ${orgId}
  `);

  return { invoiceLines: lines.length, priceListRates: rates.length, supplierLinks: links.length };
}

export interface DuplicateCandidate {
  aId: string;
  aName: string;
  aUnit: string;
  bId: string;
  bName: string;
  bUnit: string;
  similarity: number;
  /** True when the two are measured differently — merging them is refused until that is fixed. */
  unitsDiffer: boolean;
}

/**
 * ⭐ The standing alert: pairs of LIVE items close enough to be the same thing.
 *
 * Ian, 2026-08-28: *"add a small wildcard checker that will check minimal spelling discrepancy and
 * alert superadmin."* This is that alert as a query — nothing is stored, so it cannot go stale,
 * and it re-answers itself every time the page loads.
 *
 * ⚠️ `a.id < b.id` keeps each pair once. Without it every pair appears twice, mirrored, which
 * makes a list of six look like twelve problems.
 */
export async function findDuplicateCandidates(
  tx: Tx,
  orgId: string,
  floor = SIMILARITY_FLOOR,
): Promise<DuplicateCandidate[]> {
  const rows = (await tx.execute(sql`
    select a.id a_id, a.name a_name, a.base_unit a_unit,
           b.id b_id, b.name b_name, b.base_unit b_unit,
           similarity(lower(a.name), lower(b.name)) sim
    from items a
    join items b
      on a.org_id = b.org_id
     and a.id < b.id
     and similarity(lower(a.name), lower(b.name)) >= ${floor}
    where a.org_id = ${orgId} and a.status <> 'merged' and b.status <> 'merged'
    order by sim desc, a.name asc
    limit 50
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    aId: String(r.a_id),
    aName: String(r.a_name),
    aUnit: String(r.a_unit),
    bId: String(r.b_id),
    bName: String(r.b_name),
    bUnit: String(r.b_unit),
    similarity: Number(r.sim),
    unitsDiffer: String(r.a_unit) !== String(r.b_unit),
  }));
}

export interface ResolvedSellability {
  isPurchasable: boolean;
  sellableRetail: boolean;
  sellableWholesale: boolean;
  /** True when this store has an override row — so a screen can show "set here" vs "org default". */
  overridden: boolean;
}

/**
 * ⭐ What this item may be bought and sold as **at this store**.
 *
 * `coalesce(store override, org default)`, per column. A store that only disagrees about one of
 * the three says so about one of the three.
 */
export async function sellabilityAt(
  tx: Tx,
  orgId: string,
  itemId: string,
  storeId: string,
): Promise<ResolvedSellability | undefined> {
  const [row] = (await tx.execute(sql`
    select
      coalesce(o.is_purchasable, i.is_purchasable)         as is_purchasable,
      coalesce(o.sellable_retail, i.sellable_retail)       as sellable_retail,
      coalesce(o.sellable_wholesale, i.sellable_wholesale) as sellable_wholesale,
      (o.id is not null)                                   as overridden
    from items i
    left join store_item_sellability o
      on o.item_id = i.id and o.store_id = ${storeId} and o.org_id = ${orgId}
    where i.id = ${itemId} and i.org_id = ${orgId}
  `)) as unknown as Record<string, boolean>[];
  if (!row) return undefined;
  return {
    isPurchasable: Boolean(row.is_purchasable ?? row.isPurchasable),
    sellableRetail: Boolean(row.sellable_retail ?? row.sellableRetail),
    sellableWholesale: Boolean(row.sellable_wholesale ?? row.sellableWholesale),
    overridden: Boolean(row.overridden),
  };
}

/** Is this item sold wholesale ANYWHERE in the org? What a price list — an org-wide rate card —
 *  needs to know, since a rate is not quoted per store. */
export async function sellableWholesaleAnywhere(tx: Tx, orgId: string, itemId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select (
      i.sellable_wholesale
      or exists (
        select 1 from store_item_sellability o
        where o.item_id = i.id and o.org_id = ${orgId} and o.sellable_wholesale is true
      )
    ) as ok
    from items i where i.id = ${itemId} and i.org_id = ${orgId}
  `)) as unknown as Record<string, boolean>[];
  return Boolean(row?.ok);
}

export async function upsertStoreSellability(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    itemId: string;
    isPurchasable: boolean | null;
    sellableRetail: boolean | null;
    sellableWholesale: boolean | null;
    note: string | null;
    setBy: string;
  },
): Promise<void> {
  await tx
    .insert(storeItemSellability)
    .values(input)
    .onConflictDoUpdate({
      target: [storeItemSellability.storeId, storeItemSellability.itemId],
      set: {
        isPurchasable: input.isPurchasable,
        sellableRetail: input.sellableRetail,
        sellableWholesale: input.sellableWholesale,
        note: input.note,
        updatedAt: sql`now()`,
      },
    });
}

export interface StoreSellabilityOverrideRow {
  storeId: string;
  /** ⚠️ `null` is "no opinion — follow the org", and the screen must render it as such, never as `false`. */
  isPurchasable: boolean | null;
  sellableRetail: boolean | null;
  sellableWholesale: boolean | null;
  note: string | null;
}

/**
 * ⭐ DEF-130. The RAW override rows for one item, one per store that has said anything — what the
 * item screen's per-store editor reads. `sellabilityAt` answers the RESOLVED question and cannot
 * tell "the store said false" from "the store said nothing and the org says false"; an editor
 * needs the distinction, because clearing and setting-to-false are different acts.
 */
export async function listStoreSellabilityOverrides(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<StoreSellabilityOverrideRow[]> {
  const rows = await tx
    .select({
      storeId: storeItemSellability.storeId,
      isPurchasable: storeItemSellability.isPurchasable,
      sellableRetail: storeItemSellability.sellableRetail,
      sellableWholesale: storeItemSellability.sellableWholesale,
      note: storeItemSellability.note,
    })
    .from(storeItemSellability)
    .where(and(eq(storeItemSellability.orgId, orgId), eq(storeItemSellability.itemId, itemId)));
  return rows;
}

/** Drop a store's override, returning it to the org default. */
export async function clearStoreSellability(
  tx: Tx,
  orgId: string,
  storeId: string,
  itemId: string,
): Promise<boolean> {
  const gone = await tx
    .delete(storeItemSellability)
    .where(
      and(
        eq(storeItemSellability.orgId, orgId),
        eq(storeItemSellability.storeId, storeId),
        eq(storeItemSellability.itemId, itemId),
      ),
    )
    .returning({ id: storeItemSellability.id });
  return gone.length > 0;
}

// -------------------------------------------------------------------------------------
// T-151 - the branch price
// -------------------------------------------------------------------------------------

export interface ItemPricingRow {
  itemId: string;
  pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
  fixedAmount: string | null;
  markupPercent: string | null;
  fixedMarkupAmount: string | null;
  marginAlertThresholdPct: string | null;
}

export async function getItemPricing(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<ItemPricingRow | undefined> {
  const [row] = (await tx.execute(sql`
    select item_id, pricing_mode, fixed_amount::text as fixed_amount,
           markup_percent::text as markup_percent,
           fixed_markup_amount::text as fixed_markup_amount,
           margin_alert_threshold_pct::text as margin_alert_threshold_pct
    from item_pricing where org_id = ${orgId} and item_id = ${itemId}
  `)) as unknown as Record<string, string | null>[];
  if (!row) return undefined;
  return {
    itemId: String(row.item_id),
    pricingMode: row.pricing_mode as ItemPricingRow['pricingMode'],
    fixedAmount: row.fixed_amount ?? null,
    markupPercent: row.markup_percent ?? null,
    fixedMarkupAmount: row.fixed_markup_amount ?? null,
    marginAlertThresholdPct: row.margin_alert_threshold_pct ?? null,
  };
}

/**
 * ⭐ DEF-138. Every rule in the org, in one query — so a screen can show "this will default to
 * ₱X" for the handful of items that carry a rule without asking `getItemPricing` once per item in
 * the catalogue (385 items in v1's import; one round trip each is a page that takes seconds).
 */
export async function listItemPricing(tx: Tx, orgId: string): Promise<ItemPricingRow[]> {
  const rows = (await tx.execute(sql`
    select item_id, pricing_mode, fixed_amount::text as fixed_amount,
           markup_percent::text as markup_percent,
           fixed_markup_amount::text as fixed_markup_amount,
           margin_alert_threshold_pct::text as margin_alert_threshold_pct
    from item_pricing where org_id = ${orgId}
  `)) as unknown as Record<string, string | null>[];
  return rows.map((row) => ({
    itemId: String(row.item_id),
    pricingMode: row.pricing_mode as ItemPricingRow['pricingMode'],
    fixedAmount: row.fixed_amount ?? null,
    markupPercent: row.markup_percent ?? null,
    fixedMarkupAmount: row.fixed_markup_amount ?? null,
    marginAlertThresholdPct: row.margin_alert_threshold_pct ?? null,
  }));
}

export async function upsertItemPricing(
  tx: Tx,
  input: {
    orgId: string;
    itemId: string;
    pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
    /** T-371 C2 — raw SQL, so each numeric carries its column's shape: (14,2), (8,4), (14,2), (8,4). */
    fixedAmount: Money | null;
    markupPercent: Decimal<'8,4'> | null;
    fixedMarkupAmount: Money | null;
    marginAlertThresholdPct: Decimal<'8,4'> | null;
    setBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into item_pricing
      (org_id, item_id, pricing_mode, fixed_amount, markup_percent, fixed_markup_amount,
       margin_alert_threshold_pct, set_by)
    values (${input.orgId}, ${input.itemId}, ${input.pricingMode}, ${input.fixedAmount},
            ${input.markupPercent}, ${input.fixedMarkupAmount}, ${input.marginAlertThresholdPct},
            ${input.setBy})
    on conflict (item_id) do update set
      pricing_mode = excluded.pricing_mode,
      fixed_amount = excluded.fixed_amount,
      markup_percent = excluded.markup_percent,
      fixed_markup_amount = excluded.fixed_markup_amount,
      margin_alert_threshold_pct = excluded.margin_alert_threshold_pct,
      updated_at = now()
  `);
}

async function lastTwoLandedMax(tx: Tx, orgId: string, itemId: string): Promise<string | null> {
  // T-379 S3a. R7 (DEF-602): fee share over the WHOLE bill's lines (`goods`), summed before the
  // item filter. R8 (DEF-601): 'voided' is the schema's value. R10: one bill = one receive, a
  // weighted price = sum(landed line totals) / sum(base qty), newest two bills, then max.
  const rows = (await tx.execute(sql`
    with goods as (
      select l2.supplier_invoice_id, sum(l2.line_total) as goods
      from supplier_invoice_lines l2
      join supplier_invoices s2 on s2.id = l2.supplier_invoice_id
      where s2.org_id = ${orgId}
        and l2.supplier_invoice_id in (
          select supplier_invoice_id from supplier_invoice_lines where item_id = ${itemId})
      group by l2.supplier_invoice_id
    ),
    receives as (
      select si.id, si.invoice_date, si.created_at,
             sum(
               l.line_total
               + (coalesce(si.delivery_fee, 0) + coalesce(si.other_fees, 0))
                 * (l.line_total / nullif(g.goods, 0))
             ) / nullif(sum(l.quantity * l.conversion_factor), 0) as landed_base_price
      from supplier_invoice_lines l
      join supplier_invoices si on si.id = l.supplier_invoice_id
      join goods g on g.supplier_invoice_id = l.supplier_invoice_id
      where si.org_id = ${orgId} and l.item_id = ${itemId} and si.status <> 'voided'
      group by si.id, si.invoice_date, si.created_at
    )
    select max(landed_base_price)::text as basis
    from (
      select landed_base_price from receives
      where landed_base_price is not null
      order by invoice_date desc, created_at desc, id desc
      limit 2
    ) t
  `)) as unknown as Record<string, string | null>[];
  const basis = rows[0]?.basis;
  return basis == null ? null : String(basis);
}

/**
 * The cost basis for a branch price: max of the LAST TWO landed receives - v1's rule, verbatim.
 *
 * v1: "so a single low-cost lot can't drop the branch price below what an earlier expensive lot
 * still in inventory cost" (ERP-rebuild/src/lib/financial/commissary/pricing.ts).
 *
 * DERIVED on every read, never stored. That is the one place this improves on v1, and it is not
 * cosmetic: v1's stored lastReceivedCost could be poisoned by one bad delivery line and, because
 * the rule is max(prior, new), the poison was sticky and survived correcting the delivery.
 */
export async function costBasisFor(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<{ basis: string; basisFrom: 'own' | 'linked' } | undefined> {
  const [item] = (await tx.execute(sql`
    select cost_basis_item_id from items where id = ${itemId} and org_id = ${orgId}
  `)) as unknown as Record<string, string | null>[];
  if (!item) return undefined;

  const linkedId = item.cost_basis_item_id;
  if (linkedId) {
    const linked = await lastTwoLandedMax(tx, orgId, String(linkedId));
    if (linked != null) return { basis: linked, basisFrom: 'linked' };
    // Falls through when the slab has no history of its own - v1 does the same rather than
    // pricing at zero.
  }
  const own = await lastTwoLandedMax(tx, orgId, itemId);
  return own == null ? undefined : { basis: own, basisFrom: 'own' };
}

/**
 * T-383 R5. The retire readout: what still leans on an item. Advisory display only; no domain code branches on it.
 * `onHand` is stock per store with a non-zero net, by store name; the two counts are live POS maps and live recipes
 * (as output or as an ingredient line, counted once per recipe). Every leg is filtered by org (tenancy layered).
 */
export interface RetireReadout {
  onHand: { storeName: string; quantity: string }[];
  activePosMaps: number;
  activeRecipes: number;
}

export async function retireReadout(tx: Tx, orgId: string, itemId: string): Promise<RetireReadout> {
  const stock = (await tx.execute(sql`
    select s.name as store_name, sum(m.quantity)::text as quantity
    from stock_movements m
    join stores s on s.id = m.store_id and s.org_id = ${orgId}
    where m.org_id = ${orgId} and m.item_id = ${itemId}
    group by s.id, s.name
    having sum(m.quantity) <> 0
    order by s.name asc, s.id asc
  `)) as unknown as { store_name: string; quantity: string }[];
  const maps = (await tx.execute(sql`
    select count(*)::int as n from pos_item_maps
    where org_id = ${orgId} and item_id = ${itemId} and status = 'active'
  `)) as unknown as { n: number }[];
  const recipes = (await tx.execute(sql`
    select count(distinct r.id)::int as n from production_recipes r
    where r.org_id = ${orgId} and r.status = 'active'
      and (r.output_item_id = ${itemId}
           or exists (select 1 from production_recipe_lines l where l.recipe_id = r.id and l.item_id = ${itemId}))
  `)) as unknown as { n: number }[];
  return {
    onHand: stock.map((r) => ({ storeName: r.store_name, quantity: r.quantity })),
    activePosMaps: Number(maps[0]?.n ?? 0),
    activeRecipes: Number(recipes[0]?.n ?? 0),
  };
}
