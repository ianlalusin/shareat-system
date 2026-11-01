/**
 * T-502 S5 - the read queries behind the cost report by category -> sub-category -> item
 * (docs/tasks/502-expense-item-catalog.md section 4 S5, section 16). Read-only; nothing is stored.
 *
 * Two queries, both scoped by org, date (the expense business date) and an optional store list:
 *  - `postedParts`: POSTED expenses summed per (invoice, category). This is the "T" of the attribution rule.
 *  - `linesOfInvoices`: the invoice lines of those invoices, with the item's category and sub-category. The "L" side.
 * Every number leaves as exact decimal text (numeric cast to text), never a float.
 * `storeIds` omitted = every store; an empty list = nothing (fail closed).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client';

function storeTail(column: SQL, storeIds: readonly string[] | undefined): SQL {
  if (storeIds === undefined) return sql``;
  if (storeIds.length === 0) return sql`and false`;
  return sql`and ${column} in (${sql.join(storeIds.map((id) => sql`${id}`), sql`, `)})`;
}

export interface ExpenseScope {
  orgId: string;
  from: string;
  to: string;
  storeIds?: readonly string[];
}

export interface PostedPartRow {
  invoiceId: string;
  categoryId: string;
  categoryName: string;
  group: string;
  storeId: string;
  /** Latest expense business date of the part (all are the invoice date; createExpense forces it). */
  businessDate: string;
  /** Exact numeric(14,2) text. */
  total: string;
}

export async function postedParts(tx: Tx, s: ExpenseScope): Promise<PostedPartRow[]> {
  const rows = (await tx.execute(sql`
    select e.supplier_invoice_id::text as invoice_id, e.category_id::text as category_id, c.category as category_name,
           c."group"::text as grp, e.store_id::text as store_id, max(e.business_date)::text as business_date,
           sum(e.total_amount)::numeric(14,2)::text as total
    from expenses e
    join expense_categories c on c.id = e.category_id
    where e.org_id = ${s.orgId} and e.status = 'posted'
      and e.business_date between ${s.from} and ${s.to} ${storeTail(sql`e.store_id`, s.storeIds)}
    group by e.supplier_invoice_id, e.category_id, c.category, c."group", e.store_id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    invoiceId: String(r.invoice_id),
    categoryId: String(r.category_id),
    categoryName: String(r.category_name),
    group: String(r.grp),
    storeId: String(r.store_id),
    businessDate: String(r.business_date),
    total: String(r.total),
  }));
}

export interface InvoiceLineRow {
  invoiceId: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnit: string;
  purchaseUnit: string;
  /** null = the item has no expense category yet. */
  categoryId: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  /** numeric(14,3) text. */
  quantity: string;
  /** numeric(14,6) text. */
  conversionFactor: string;
  /** numeric(14,2) text. */
  lineTotal: string;
}

/** Lines of every invoice that carries at least one posted expense in scope. */
export async function linesOfScopedInvoices(tx: Tx, s: ExpenseScope): Promise<InvoiceLineRow[]> {
  const rows = (await tx.execute(sql`
    select l.supplier_invoice_id::text as invoice_id, l.line_no::int as line_no, l.item_id::text as item_id,
           i.name as item_name, i.base_unit::text as base_unit, l.purchase_unit::text as purchase_unit,
           i.expense_category_id::text as category_id, i.expense_subcategory_id::text as subcategory_id,
           sc.name as subcategory_name, l.quantity::numeric(14,3)::text as quantity,
           l.conversion_factor::numeric(14,6)::text as conversion_factor, l.line_total::numeric(14,2)::text as line_total
    from supplier_invoice_lines l
    join items i on i.id = l.item_id
    left join expense_subcategories sc on sc.id = i.expense_subcategory_id
    where l.supplier_invoice_id in (
      select e.supplier_invoice_id from expenses e
      where e.org_id = ${s.orgId} and e.status = 'posted'
        and e.business_date between ${s.from} and ${s.to} ${storeTail(sql`e.store_id`, s.storeIds)}
    )
    order by l.supplier_invoice_id, l.line_no
  `)) as unknown as Record<string, string | number | null>[];
  return rows.map((r) => ({
    invoiceId: String(r.invoice_id),
    lineNo: Number(r.line_no),
    itemId: String(r.item_id),
    itemName: String(r.item_name),
    baseUnit: String(r.base_unit),
    purchaseUnit: String(r.purchase_unit),
    categoryId: r.category_id === null ? null : String(r.category_id),
    subcategoryId: r.subcategory_id === null ? null : String(r.subcategory_id),
    subcategoryName: r.subcategory_name === null ? null : String(r.subcategory_name),
    quantity: String(r.quantity),
    conversionFactor: String(r.conversion_factor),
    lineTotal: String(r.line_total),
  }));
}

export interface ExpenseDrillRow {
  expenseId: string;
  invoiceId: string;
  storeId: string;
  businessDate: string;
  categoryId: string;
  amount: string;
  particulars: string;
}

/** The posted expenses of one category in scope, for the "(unitemised)" drill. */
export async function postedExpensesOfCategory(tx: Tx, s: ExpenseScope, categoryId: string): Promise<ExpenseDrillRow[]> {
  const rows = (await tx.execute(sql`
    select e.id::text as expense_id, e.supplier_invoice_id::text as invoice_id, e.store_id::text as store_id,
           e.business_date::text as business_date, e.category_id::text as category_id,
           e.total_amount::numeric(14,2)::text as amount, e.particulars
    from expenses e
    where e.org_id = ${s.orgId} and e.status = 'posted' and e.category_id = ${categoryId}
      and e.business_date between ${s.from} and ${s.to} ${storeTail(sql`e.store_id`, s.storeIds)}
    order by e.business_date, e.created_at
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    expenseId: String(r.expense_id),
    invoiceId: String(r.invoice_id),
    storeId: String(r.store_id),
    businessDate: String(r.business_date),
    categoryId: String(r.category_id),
    amount: String(r.amount),
    particulars: String(r.particulars),
  }));
}
