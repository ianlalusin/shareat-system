/**
 * T-502 section 12 - server-side loader: an invoice's parts (category groups + the open room) as plain JSON for the pickers.
 * The rule itself is the domain's `buildInvoiceParts`; this only reads the facts and labels the parts.
 */
import { expensesRepo } from '@shareat/db';
import { buildInvoiceParts } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import type { CategoryChoice, InvoicePartsView } from '@/components/expenses/parts-types';

export async function invoicePartsView(
  orgId: string,
  invoiceId: string,
  categories: readonly CategoryChoice[],
  excludeExpenseId?: string,
): Promise<InvoicePartsView> {
  const facts = await withOrgPrincipal(orgId, (tx) => expensesRepo.invoicePartsFacts(tx, orgId, invoiceId, excludeExpenseId));
  if (!facts) return { invoiceId, itemised: false, linesExceedTotal: false, parts: [] };
  const built = buildInvoiceParts(facts);
  const nameOf = (id: string | null) => categories.find((c) => c.id === id)?.category ?? 'Category';
  return {
    invoiceId,
    itemised: built.itemised,
    linesExceedTotal: built.linesExceedTotal,
    parts: built.parts.map((p) => ({
      key: p.key,
      kind: p.kind,
      categoryId: p.categoryId,
      label: p.kind === 'category' ? nameOf(p.categoryId) : p.kind === 'uncategorised' ? 'Uncategorised' : 'Fees and other charges on this bill',
      itemNames: p.itemNames,
      total: String(p.total),
      left: String(p.left),
    })),
  };
}
