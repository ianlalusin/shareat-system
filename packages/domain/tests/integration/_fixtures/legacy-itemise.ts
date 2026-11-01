/**
 * T-502 section 12 - the web-layer tests below the actions cannot pass `requireItemised: false` (the screens never do), so a fixture that
 * records an expense through a server action needs an invoice that HAS lines. This gives a legacy lineless invoice ONE line for its whole
 * total on an item with NO category: the "Uncategorised" part, whose open room accepts any category up to the invoice total, so these
 * tests keep their category choices and amounts. The tests that exercise the itemised rule itself build real lines (t502-s12).
 */
import type postgres from 'postgres';
import { testItemCode } from './item-code';

export async function itemiseLegacy(sql: postgres.Sql, invoiceId: string): Promise<void> {
  const [inv] = await sql<{ org_id: string; created_by: string; total: string }[]>`
    select org_id, created_by, total_amount::text as total from supplier_invoices where id = ${invoiceId}`;
  if (!inv) throw new Error('itemiseLegacy: no such invoice');
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${inv.org_id}, ${testItemCode()}, ${`Legacy line ${invoiceId}`}, 'raw_material', 'kg', ${inv.created_by}) returning id`;
  await sql`
    insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
    values (${invoiceId}, 1, ${item!.id}, '1', 'pcs', '1', ${inv.total}, ${inv.total})`;
}
