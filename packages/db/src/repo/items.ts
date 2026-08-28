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
import {
  items,
  type BaseUnit,
  type ItemKind,
  type ItemStatus,
} from '../../schema/items';

export interface ItemRow {
  id: string;
  orgId: string;
  code: string;
  name: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  status: ItemStatus;
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

export async function updateItem(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{ code: string; name: string; kind: ItemKind; baseUnit: BaseUnit; status: ItemStatus; notes: string | null }>,
): Promise<void> {
  const updated = await tx
    .update(items)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(items.id, id), eq(items.orgId, orgId)))
    .returning({ id: items.id });
  if (updated.length === 0) throw new Error(`updateItem: item ${id} does not exist in org ${orgId}`);
}

// -------------------------------------------------------------------------------------
// supplier_invoice_lines
// -------------------------------------------------------------------------------------

export interface InvoiceLineInput {
  lineNo: number;
  itemId: string;
  description: string | null;
  quantity: string;
  purchaseUnit: string;
  conversionFactor: string;
  unitPrice: string;
  lineTotal: string;
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

export interface InvoiceLineRow extends InvoiceLineInput {
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
           (l.line_total / nullif(l.quantity * l.conversion_factor, 0))::text as base_price
    from supplier_invoice_lines l
    join supplier_invoices si on si.id = l.supplier_invoice_id
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
