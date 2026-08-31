/**
 * Server-only helpers for the AP screens — suppliers, supplier invoices, and payments. T-130.
 */
import {
  apRepo,
  itemsRepo,
  moneyAccountsRepo,
  type CatalogueEntry,
  type SupplierInvoiceRow,
  type SupplierRow,
} from '@shareat/db';
import { withOrgPrincipal, listStores } from '../expenses/lib';

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
  /** ⭐ T-196 — the picker now offers PENDING invoices too (draftable, no verification wait),
   *  alongside VERIFIED ones (still draftable — `createExpense` never requires verified, only
   *  not-voided). Surfaced so the option text can say which a cashier is picking. */
  status: 'pending' | 'verified';
}

/**
 * ⭐ T-196 — every OPEN invoice (not voided) with room left, not only verified ones. Before
 * T-196 a draft could not exist at all, so this only ever listed `verified` invoices; now
 * `/expenses/new` drafts against a `pending` one just as legitimately (Ian, 2026-08-31: "cashier
 * does not need verification to start recording"). The embedded "record expense" form on an
 * invoice's own page (`/ap/invoices/[id]`) does NOT use this — it already knows its one invoice
 * and only renders once that invoice is verified.
 */
export async function listOpenInvoicesForPicker(orgId: string): Promise<InvoicePickerOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [pending, verified, suppliers] = await Promise.all([
      apRepo.listSupplierInvoices(tx, orgId, { status: 'pending' }),
      apRepo.listSupplierInvoices(tx, orgId, { status: 'verified' }),
      apRepo.listSuppliers(tx, orgId, { includeInactive: true }),
    ]);
    const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
    const out: InvoicePickerOption[] = [];
    for (const inv of [...pending, ...verified]) {
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
        status: inv.status as 'pending' | 'verified',
      });
    }
    return out;
  });
}

export async function listOpenItems(orgId: string, supplierId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => apRepo.openItems(tx, orgId, supplierId, storeId));
}

/** Omit `storeId` for the supplier's whole-org total; pass one for that store's liability alone. */
export async function getPosition(orgId: string, supplierId: string, storeId?: string): Promise<string> {
  return withOrgPrincipal(orgId, async (tx) => (await apRepo.positionOf(tx, orgId, supplierId, storeId)).controlBalance);
}

/** Which stores this supplier actually has open payables at — the store picker's options. */
export async function storesWithOpenItems(
  orgId: string,
  supplierId: string,
): Promise<{ storeId: string; storeName: string; outstanding: string; count: number }[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const stores = await listStores(orgId);
    const out: { storeId: string; storeName: string; outstanding: string; count: number }[] = [];
    for (const s of stores) {
      const items = await apRepo.openItems(tx, orgId, supplierId, s.id);
      if (items.length === 0) continue;
      out.push({
        storeId: s.id,
        storeName: s.name,
        outstanding: items.reduce((t, i) => t + Number(i.outstanding), 0).toFixed(2),
        count: items.length,
      });
    }
    return out;
  });
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

/** How many line rows the invoice form offers. Blank rows are dropped server-side. */
export const INVOICE_LINE_ROWS = 5;

/**
 * ⭐ T-147: what to offer in a line's item picker.
 *
 * Ordered so what this supplier has actually billed before comes FIRST — that is the entry-quality
 * win the catalogue was built for. Everything else in the org follows, because a supplier's first
 * invoice for a new item has to be enterable too.
 */
export async function itemPickerFor(
  orgId: string,
  supplierId: string | null,
): Promise<{ known: CatalogueEntry[]; others: { id: string; name: string; code: string; baseUnit: string }[] }> {
  return withOrgPrincipal(orgId, async (tx) => {
    const all = await itemsRepo.listItems(tx, orgId, {});
    if (!supplierId) {
      return { known: [], others: all.map((i) => ({ id: i.id, name: i.name, code: i.code, baseUnit: i.baseUnit })) };
    }
    const known = await itemsRepo.itemsForSupplier(tx, orgId, supplierId);
    const knownIds = new Set(known.map((k) => k.itemId));
    return {
      known,
      others: all
        .filter((i) => !knownIds.has(i.id))
        .map((i) => ({ id: i.id, name: i.name, code: i.code, baseUnit: i.baseUnit })),
    };
  });
}

/** Who sells this item — the item page's sourcing view. */
export async function whoSells(orgId: string, itemId: string): Promise<CatalogueEntry[]> {
  return withOrgPrincipal(orgId, (tx) => itemsRepo.suppliersForItem(tx, orgId, itemId));
}

/** The lines already on an invoice — the form pre-fills from these, the table renders them. */
export async function invoiceLines(orgId: string, invoiceId: string) {
  return withOrgPrincipal(orgId, (tx) => itemsRepo.linesForInvoice(tx, orgId, invoiceId));
}

/**
 * ⚠️ **Masks a bank account number for a LIST.** T-188 §6.
 *
 * Business banking details are not a secret, but a register that puts every account number on one
 * screen is a register nobody should leave open on a counter. The detail page shows it whole.
 */
export function maskAccountNumber(n: string | null): string | null {
  if (!n) return null;
  const t = n.trim();
  if (t.length <= 4) return '•'.repeat(t.length);
  return '•'.repeat(Math.min(t.length - 4, 8)) + t.slice(-4);
}

/** ⭐ Search over the register, on the fields a person would actually type. Case-insensitive. */
export function matchesSupplier(s: SupplierRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [s.name, s.tin, s.representativeName, s.email, s.contactNo, s.bankName]
    .some((f) => (f ?? '').toLowerCase().includes(needle));
}

/** Human labels. ⚠️ The stored value stays a closed enum — these only render it. */
export const VAT_STATUS_LABEL: Record<string, string> = {
  vat_registered: 'VAT-registered',
  non_vat: 'Non-VAT',
};

export const CLASSIFICATION_LABEL: Record<string, string> = {
  corporate: 'Corporate',
  individual: 'Individual',
  other: 'Other',
};
