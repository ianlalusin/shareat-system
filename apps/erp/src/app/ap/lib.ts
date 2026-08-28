/**
 * Server-only helpers for the AP screens — suppliers, supplier invoices, and payments. T-130.
 */
import { apRepo, moneyAccountsRepo, type SupplierInvoiceRow, type SupplierRow } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal, listCategoriesGrouped, listMoneyAccountsForPicker } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export async function listSuppliers(orgId: string): Promise<SupplierRow[]> {
  return withOrgPrincipal(orgId, (tx) => apRepo.listSuppliers(tx, orgId, { includeInactive: true }));
}

export async function getSupplier(orgId: string, id: string): Promise<SupplierRow | undefined> {
  return withOrgPrincipal(orgId, (tx) => apRepo.getSupplierById(tx, orgId, id));
}

export interface SupplierWithPosition extends SupplierRow {
  controlBalance: string;
}

export async function listSuppliersWithPosition(orgId: string): Promise<SupplierWithPosition[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const suppliers = await apRepo.listSuppliers(tx, orgId, { includeInactive: true });
    return Promise.all(
      suppliers.map(async (s) => ({
        ...s,
        controlBalance: (await apRepo.positionOf(tx, orgId, s.id)).controlBalance,
      })),
    );
  });
}

export async function listInvoices(
  orgId: string,
  filter: { supplierId?: string; status?: SupplierInvoiceRow['status'] } = {},
): Promise<SupplierInvoiceRow[]> {
  return withOrgPrincipal(orgId, (tx) => apRepo.listSupplierInvoices(tx, orgId, filter));
}

export async function getInvoice(orgId: string, id: string): Promise<SupplierInvoiceRow | undefined> {
  return withOrgPrincipal(orgId, (tx) => apRepo.getSupplierInvoiceById(tx, orgId, id));
}

export interface InvoicePickerOption {
  id: string;
  supplierId: string;
  supplierName: string;
  invoiceNo: string | null;
  invoiceDate: string;
  totalAmount: string;
  remaining: string;
}

/** Every VERIFIED invoice with room left — what `expenses/new` and the "record expense" form
 *  on an invoice's own page both offer. One list, both screens; the two cannot drift. */
export async function listVerifiedInvoicesForPicker(orgId: string): Promise<InvoicePickerOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [invoices, suppliers] = await Promise.all([
      apRepo.listSupplierInvoices(tx, orgId, { status: 'verified' }),
      apRepo.listSuppliers(tx, orgId, { includeInactive: true }),
    ]);
    const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
    const out: InvoicePickerOption[] = [];
    for (const inv of invoices) {
      const capacity = await apRepo.capacityOf(tx, orgId, inv.id);
      if (!capacity || Number(capacity.remaining) < 1) continue;
      out.push({
        id: inv.id,
        supplierId: inv.supplierId,
        supplierName: supplierName.get(inv.supplierId) ?? inv.supplierId,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        totalAmount: inv.totalAmount,
        remaining: capacity.remaining,
      });
    }
    return out;
  });
}

export async function listOpenItems(orgId: string, supplierId: string) {
  return withOrgPrincipal(orgId, (tx) => apRepo.openItems(tx, orgId, supplierId));
}

export async function getPosition(orgId: string, supplierId: string): Promise<string> {
  return withOrgPrincipal(orgId, async (tx) => (await apRepo.positionOf(tx, orgId, supplierId)).controlBalance);
}

export async function moneyAccountsFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    return Promise.all(
      accounts.map(async (a) => ({ ...a, balance: await moneyAccountsRepo.balanceOf(tx, orgId, a) })),
    );
  });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
