/**
 * Server-only helpers for the AP screens — suppliers, supplier invoices, and payments. T-130.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import {
  apRepo,
  itemsRepo,
  moneyAccountsRepo,
  type CatalogueEntry,
  type SupplierInvoiceRow,
  type SupplierRow,
} from '@shareat/db';
import { withOrgPrincipal, listStores } from '../expenses/lib';
import { heldStoreIdsOrAll } from '../../lib/held-stores';
import type { Actor, Capability } from '@shareat/auth';
import { compare, money } from '@shareat/core/money';

import { peso } from '../../lib/format';
export { peso };
export { listStores, withOrgPrincipal, listCategoriesGrouped } from '../expenses/lib';
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

/**
 * T-577 (DEF-834): the STORE-scoped capabilities the AP screens' reads need (`approve_supplier` is org-wide master data, so it is not here).
 * A viewer sees invoices, balances and open items only at stores where they hold one of these; an admin who holds them everywhere sees everything.
 */
export const AP_STORE_CAPABILITIES: readonly Capability[] = ['record_supplier_invoice', 'verify_supplier_invoice', 'record_ap_payment'];

/** The store ids the AP lists may show; `undefined` = every store (no filtering). See `heldStoreIdsOrAll`. */
export async function apStoreIds(actor: Actor): Promise<readonly string[] | undefined> {
  return withOrgPrincipal(actor.orgId, (tx) => heldStoreIdsOrAll(tx, actor, AP_STORE_CAPABILITIES));
}

/** What a supplier is owed across `storeIds` only (`undefined` = the whole org, one query). */
async function positionInScope(tx: Parameters<typeof apRepo.positionOf>[0], orgId: string, supplierId: string, storeIds: readonly string[] | undefined): Promise<string> {
  if (!storeIds) return (await apRepo.positionOf(tx, orgId, supplierId)).controlBalance;
  let total = 0;
  for (const storeId of storeIds) total += Number((await apRepo.positionOf(tx, orgId, supplierId, storeId)).controlBalance);
  return total.toFixed(2);
}

export async function getPositionInScope(orgId: string, supplierId: string, storeIds: readonly string[] | undefined): Promise<string> {
  return withOrgPrincipal(orgId, (tx) => positionInScope(tx, orgId, supplierId, storeIds));
}

/** Suppliers are org-level; their BALANCE is limited to `storeIds` (`undefined` = whole org). */
export async function listSuppliersWithPosition(orgId: string, storeIds?: readonly string[]): Promise<SupplierWithPosition[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const suppliers = await apRepo.listSuppliers(tx, orgId, { includeInactive: true });
    return Promise.all(suppliers.map(async (s) => ({ ...s, controlBalance: await positionInScope(tx, orgId, s.id, storeIds) })));
  });
}

export async function listInvoices(
  orgId: string,
  filter: { supplierId?: string; status?: SupplierInvoiceRow['status']; selfVerified?: true; storeIds?: readonly string[] } = {},
): Promise<SupplierInvoiceRow[]> {
  const { storeIds, ...repoFilter } = filter; // T-577: `storeIds` limits the rows to those stores; absent = every store
  return withOrgPrincipal(orgId, async (tx) => (await apRepo.listSupplierInvoices(tx, orgId, repoFilter)).filter((r) => !storeIds || storeIds.includes(r.storeId)));
}

/** T-520: one row of the /ap list. `recorded`/`remaining` = the invoice page's Recorded/Remaining; `owed` = what its open items still owe. */
export interface InvoiceListRow extends SupplierInvoiceRow {
  recorded: string;
  remaining: string;
  owed: string;
}

/**
 * T-520: every invoice (newest first, as the repo orders them) with its recorded / remaining / owed, in THREE queries
 * for any number of rows: the list, one grouped capacity query, one open-items query. No per-row query.
 */
export async function listInvoicesWithStanding(
  orgId: string,
  filter: { supplierId?: string; status?: SupplierInvoiceRow['status']; selfVerified?: true; storeIds?: readonly string[] } = {},
): Promise<InvoiceListRow[]> {
  const { storeIds, ...repoFilter } = filter; // T-577: `storeIds` limits the rows to those stores; absent = every store
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = (await apRepo.listSupplierInvoices(tx, orgId, repoFilter)).filter((r) => !storeIds || storeIds.includes(r.storeId));
    const [capacity, owed] = await Promise.all([
      apRepo.capacityOfMany(tx, orgId, rows.map((r) => r.id)),
      apRepo.owedByInvoice(tx, orgId),
    ]);
    return rows.map((r) => ({
      ...r,
      recorded: capacity.get(r.id)?.recorded ?? '0.00',
      remaining: capacity.get(r.id)?.remaining ?? r.totalAmount,
      owed: owed.get(r.id) ?? '0.00',
    }));
  });
}

export type StandingPill = { tone: 'warning' | 'success' | 'progress'; label: string } | null;

/** T-520: the Recorded and Paid pills of a row (null = a muted dash). Pure; the page only draws what this says. */
export function standingPills(inv: Pick<InvoiceListRow, 'status' | 'recorded' | 'remaining' | 'owed'>): { recorded: StandingPill; paid: StandingPill } {
  if (inv.status === 'voided') return { recorded: null, paid: null };
  const zero = money('0');
  const none = compare(money(inv.recorded), zero) <= 0;
  const full = compare(money(inv.remaining), zero) <= 0;
  const owes = compare(money(inv.owed), zero) > 0;
  const recorded: StandingPill = none
    ? { tone: 'warning', label: 'Not recorded' }
    : full
      ? { tone: 'success', label: 'Fully recorded' }
      : { tone: 'progress', label: `Open · ${peso(inv.remaining)} left` };
  // shortcut: part-recorded with nothing owed reads a dash (the recorded part is settled, more is still to record); revisit if Ian wants "Paid so far".
  const paid: StandingPill = none ? null : owes ? { tone: 'warning', label: `${peso(inv.owed)} owed` } : full ? { tone: 'success', label: 'Paid' } : null;
  return { recorded, paid };
}

export async function getInvoice(orgId: string, id: string): Promise<SupplierInvoiceRow | undefined> {
  return withOrgPrincipal(orgId, (tx) => apRepo.getSupplierInvoiceById(tx, orgId, id));
}

export interface InvoicePickerOption {
  id: string;
  supplierId: string;
  supplierName: string;
  /** T-475 C2 / F5: the supplier's terms (null = cash-on-delivery, so Credit is not offered) and status (an inactive one is marked and blocked). */
  creditTermsDays: number | null;
  supplierStatus: string;
  invoiceNo: string | null;
  invoiceDate: string;
  totalAmount: string;
  /** What is already recorded against it (the room left is `remaining`). */
  recorded: string;
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
export async function listOpenInvoicesForPicker(orgId: string, storeId?: string): Promise<InvoicePickerOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [pending, verified, suppliers] = await Promise.all([
      apRepo.listSupplierInvoices(tx, orgId, { status: 'pending', ...(storeId ? { storeId } : {}) }),
      apRepo.listSupplierInvoices(tx, orgId, { status: 'verified', ...(storeId ? { storeId } : {}) }),
      apRepo.listSuppliers(tx, orgId, { includeInactive: true }),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const out: InvoicePickerOption[] = [];
    for (const inv of [...pending, ...verified]) {
      const capacity = await apRepo.capacityOf(tx, orgId, inv.id);
      // T-371 (R4, C4): the room left is a database figure, re-minted and ordered exactly — a NaN no longer reads as room.
      if (!capacity || compare(money(capacity.remaining), money('1')) < 0) continue;
      out.push({
        id: inv.id,
        supplierId: inv.supplierId,
        supplierName: supplierById.get(inv.supplierId)?.name ?? inv.supplierId,
        creditTermsDays: supplierById.get(inv.supplierId)?.creditTermsDays ?? null,
        supplierStatus: supplierById.get(inv.supplierId)?.status ?? 'inactive',
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        totalAmount: inv.totalAmount,
        recorded: capacity.recorded,
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
  storeIds?: readonly string[],
): Promise<{ storeId: string; storeName: string; outstanding: string; count: number }[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const stores = (await listStores(orgId)).filter((s) => !storeIds || storeIds.includes(s.id)); // T-577: only the viewer's stores
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
  return toBusinessDate();
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
export interface PickerOther {
  id: string;
  name: string;
  code: string;
  baseUnit: string;
  /** T-502 section 12: the item's category / sub-category (null = none). */
  expenseCategoryId: string | null;
  expenseSubcategoryId: string | null;
}

export async function itemPickerFor(
  orgId: string,
  supplierId: string | null,
): Promise<{ known: CatalogueEntry[]; others: PickerOther[] }> {
  return withOrgPrincipal(orgId, async (tx) => {
    const all = await itemsRepo.listItems(tx, orgId, {});
    if (!supplierId) {
      return { known: [], others: all.map((i) => ({ id: i.id, name: i.name, code: i.code, baseUnit: i.baseUnit, expenseCategoryId: i.expenseCategoryId ?? null, expenseSubcategoryId: i.expenseSubcategoryId ?? null })) };
    }
    const known = await itemsRepo.itemsForSupplier(tx, orgId, supplierId);
    const knownIds = new Set(known.map((k) => k.itemId));
    return {
      known,
      others: all
        .filter((i) => !knownIds.has(i.id))
        .map((i) => ({ id: i.id, name: i.name, code: i.code, baseUnit: i.baseUnit, expenseCategoryId: i.expenseCategoryId ?? null, expenseSubcategoryId: i.expenseSubcategoryId ?? null })),
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
