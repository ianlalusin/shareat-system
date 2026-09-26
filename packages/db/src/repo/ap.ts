/**
 * The only place SQL is written for suppliers, supplier invoices, and AP payments. T-130.
 *
 * ⭐ `positionOf` mirrors `repo/liabilities.ts` and `repo/customers.ts`'s `balanceOf` exactly:
 * every AP figure is summed from `2110` by party, never a stored column (DEF-075's pattern,
 * refused for the sixth time here). `openItems` is v1's `ap_open` projection — as a live query,
 * not a stored, upsert-and-forget table, so it cannot go stale the way DEF-076 did.
 *
 * `assertOpenForRecording` mirrors the exact arithmetic of the hand-written
 * `expenses_check_invoice_open_for_recording` trigger (migration, DEF-073) — this is the clean,
 * named error; the trigger is the backstop that holds regardless of code path.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { businessDayRange, formatBusinessDateTime, parseBusinessDate } from '@shareat/core/datetime';
import type { Tx } from '../client';
import { refuse } from '../refusal';
import { recordGone } from './record-gone';
import {
  suppliers,
  supplierInvoices,
  type SupplierStatus,
  type SupplierClassification,
  type SupplierVatStatus,
  type SupplierInvoiceStatus,
  type SupplierInvoiceVatType,
} from '../../schema/suppliers';
import {
  apPayments,
  apPaymentAllocations,
  type ApPaymentStatus,
} from '../../schema/ap-payments';
import type { ExpenseStatus } from './expenses';

export const AP_CONTROL_CODE = '2110';
export const ADVANCES_CODE = '1240';
export const PARTY_TYPE = 'supplier';
/** Ported from v1's `RECEIPT_FULLY_RECORDED_TOLERANCE` (`recording.ts:13`) — answers "is what's
 *  LEFT small enough to stop offering this invoice for more recording", e.g. the picker in
 *  `apps/erp/src/app/expenses/new`. ⚠️ NOT the capacity check below — that answers a different
 *  question ("does THIS posting fit") and needs a much tighter tolerance, or a single expense
 *  could overshoot the invoice total by up to a peso. */
export const FULLY_RECORDED_TOLERANCE = 1;
/** The capacity check's own tolerance — decimal rounding only, never a business allowance. */
const CAPACITY_EPSILON = 0.005;

// -------------------------------------------------------------------------------------
// suppliers
// -------------------------------------------------------------------------------------

export interface SupplierRow {
  id: string;
  orgId: string;
  name: string;
  address: string | null;
  contactNo: string | null;
  counterpartyStoreId: string | null;
  vatStatus: SupplierVatStatus | null;
  status: SupplierStatus;
  notes: string | null;
  reconciledAsOf: string | null;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  // ---- T-188
  email: string | null;
  representativeName: string | null;
  tin: string | null;
  classification: SupplierClassification | null;
  issuesOfficialReceipt: boolean;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  /** ⭐ T-266 — NULL means cash-on-delivery, and the money form disables *Credit (AP)* with the
   *  reason. A number is both the permission and the default due date (`invoice_date + N`). */
  creditTermsDays: number | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertSupplier(
  tx: Tx,
  input: {
    orgId: string;
    name: string;
    address: string | null;
    contactNo: string | null;
    vatStatus: SupplierVatStatus | null;
    notes: string | null;
    createdBy: string;
    // ---- T-188. Optional so every existing caller keeps compiling unchanged.
    email?: string | null;
    representativeName?: string | null;
    tin?: string | null;
    classification?: SupplierClassification | null;
    issuesOfficialReceipt?: boolean;
    bankName?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(suppliers).values(input).returning({ id: suppliers.id });
  return row!;
}

export async function getSupplierById(tx: Tx, orgId: string, id: string): Promise<SupplierRow | undefined> {
  const [row] = await tx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.orgId, orgId)))
    .limit(1);
  return row as SupplierRow | undefined;
}

export async function listSuppliers(
  tx: Tx,
  orgId: string,
  filter: { includeInactive?: boolean } = {},
): Promise<SupplierRow[]> {
  const conditions = [eq(suppliers.orgId, orgId)];
  if (!filter.includeInactive) conditions.push(eq(suppliers.status, 'active'));
  const rows = await tx
    .select()
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(asc(suppliers.name));
  return rows as SupplierRow[];
}

export async function updateSupplier(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{
    name: string;
    address: string | null;
    contactNo: string | null;
    vatStatus: SupplierVatStatus | null;
    status: SupplierStatus;
    notes: string | null;
    reconciledAsOf: string | null;
    reconciledAt: Date | null;
    reconciledBy: string | null;
    // ---- T-188
    email: string | null;
    representativeName: string | null;
    tin: string | null;
    classification: SupplierClassification | null;
    issuesOfficialReceipt: boolean;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
  }>,
): Promise<void> {
  const updated = await tx
    .update(suppliers)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(suppliers.id, id), eq(suppliers.orgId, orgId)))
    .returning({ id: suppliers.id });
  if (updated.length === 0) {
    throw recordGone(`updateSupplier: supplier ${id} does not exist in org ${orgId}`, 'supplier');
  }
}

// -------------------------------------------------------------------------------------
// supplier_invoices
// -------------------------------------------------------------------------------------

export interface SupplierInvoiceRow {
  id: string;
  orgId: string;
  storeId: string;
  supplierId: string;
  invoiceNo: string | null;
  invoiceDate: string;
  dueDate: string | null;
  totalAmount: string;
  /** T-151. Inbound freight, part of totalAmount but not a line. */
  deliveryFee: string;
  otherFees: string;
  notes: string | null;
  status: SupplierInvoiceStatus;
  receiptFileId: string | null;
  attestedSupplier: boolean;
  attestedInvoice: boolean;
  attestedItems: boolean;
  attestedPrice: boolean;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  vatType: SupplierInvoiceVatType | null;
  vatRate: string | null;
  vatAmount: string | null;
  vatExclusiveAmount: string | null;
  createdBy: string;
  createdAt: Date;
  voidedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

export async function insertSupplierInvoice(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    supplierId: string;
    invoiceNo: string | null;
    invoiceDate: string;
    dueDate: string | null;
    totalAmount: string;
    /** T-151. Inbound freight, part of totalAmount but not a line. */
    deliveryFee: string;
    otherFees: string;
    notes: string | null;
    receiptFileId: string | null;
    vatType: SupplierInvoiceVatType | null;
    vatRate: string | null;
    vatAmount: string | null;
    vatExclusiveAmount: string | null;
    /** T-188 — copied from the supplier at creation, owned by the invoice thereafter. */
    isOfficialReceipt?: boolean;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(supplierInvoices).values(input).returning({ id: supplierInvoices.id });
  return row!;
}

export async function getSupplierInvoiceById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SupplierInvoiceRow | undefined> {
  const [row] = await tx
    .select()
    .from(supplierInvoices)
    .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.orgId, orgId)))
    .limit(1);
  return row as SupplierInvoiceRow | undefined;
}

export async function listSupplierInvoices(
  tx: Tx,
  orgId: string,
  filter: { supplierId?: string; status?: SupplierInvoiceStatus } = {},
): Promise<SupplierInvoiceRow[]> {
  const conditions = [eq(supplierInvoices.orgId, orgId)];
  if (filter.supplierId) conditions.push(eq(supplierInvoices.supplierId, filter.supplierId));
  if (filter.status) conditions.push(eq(supplierInvoices.status, filter.status));
  const rows = await tx
    .select()
    .from(supplierInvoices)
    .where(and(...conditions))
    .orderBy(desc(supplierInvoices.invoiceDate), desc(supplierInvoices.createdAt));
  return rows as SupplierInvoiceRow[];
}

/** Warn-only duplicate check (bible §16.10) — finishes `findDuplicateReceiptsAction`
 *  (`receipt.actions.ts:143-175`), which v1 built correctly and never wired up. */
export async function findDuplicateInvoices(
  tx: Tx,
  orgId: string,
  input: { supplierId: string; invoiceNo: string; excludeInvoiceId?: string },
): Promise<{ id: string; invoiceDate: string; totalAmount: string }[]> {
  const conditions = [
    eq(supplierInvoices.orgId, orgId),
    eq(supplierInvoices.supplierId, input.supplierId),
    eq(supplierInvoices.invoiceNo, input.invoiceNo),
  ];
  const rows = await tx
    .select({
      id: supplierInvoices.id,
      invoiceDate: supplierInvoices.invoiceDate,
      totalAmount: supplierInvoices.totalAmount,
    })
    .from(supplierInvoices)
    .where(and(...conditions));
  return rows.filter((r) => r.id !== input.excludeInvoiceId);
}

export async function markInvoiceVerified(
  tx: Tx,
  orgId: string,
  id: string,
  input: { verifiedBy: string },
): Promise<void> {
  const updated = await tx
    .update(supplierInvoices)
    .set({
      status: 'verified',
      verifiedBy: input.verifiedBy,
      verifiedAt: sql`now()`,
      // ⭐ Stamped together with the status, never separately: the DB CHECK requires all four to
      // be true for a verified row, so a status flip that forgot them would be refused outright.
      // The domain has already established the verifier confirmed each one.
      attestedSupplier: true,
      attestedInvoice: true,
      attestedItems: true,
      attestedPrice: true,
      updatedAt: sql`now()`,
    })
    .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.orgId, orgId), eq(supplierInvoices.status, 'pending')))
    .returning({ id: supplierInvoices.id });
  if (updated.length === 0) {
    throw recordGone(
      `markInvoiceVerified: supplier invoice ${id} does not exist, is not in org ${orgId}, or is not pending`,
      'supplier invoice',
      'pending',
    );
  }
}

export async function markInvoiceVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(supplierInvoices)
    .set({
      status: 'voided',
      voidedBy: input.voidedBy,
      voidedAt: sql`now()`,
      voidReason: input.voidReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.orgId, orgId), sql`${supplierInvoices.status} <> 'voided'`))
    .returning({ id: supplierInvoices.id });
  if (updated.length === 0) {
    throw recordGone(
      `markInvoiceVoided: supplier invoice ${id} does not exist, is not in org ${orgId}, or is already voided`,
      'supplier invoice',
    );
  }
}

export interface LiveExpenseForInvoice {
  id: string;
  /** ⭐ T-196 — `voidInvoice` now branches on this: a DRAFT is deleted, a POSTED expense is
   *  voided. Before T-196 every live-linked expense here was necessarily 'posted' (nothing else
   *  could exist against an invoice at all), so the caller never had to look. */
  status: ExpenseStatus;
}

/** Live-linked expenses (not voided) — what `voidInvoice` must cascade through. */
export async function liveExpensesForInvoice(
  tx: Tx,
  orgId: string,
  invoiceId: string,
): Promise<LiveExpenseForInvoice[]> {
  const rows = (await tx.execute(sql`
    select id, status from expenses
    where org_id = ${orgId} and supplier_invoice_id = ${invoiceId} and status <> 'voided'
    order by created_at asc
  `)) as unknown as LiveExpenseForInvoice[];
  return rows;
}

/**
 * How much of this invoice is still un-recorded, and whether it is even open to try.
 *
 * ⚠️ **Not stored anywhere** — computed fresh every call, the same discipline as
 * `liabilitiesRepo.positionOf`. Mirrors the hand-written `expenses_check_invoice_open_for_recording`
 * trigger's own arithmetic exactly, so a clean pre-check here and the DB backstop can never
 * disagree about what "open" means.
 */
export interface InvoiceCapacity {
  status: SupplierInvoiceStatus;
  totalAmount: string;
  recorded: string;
  remaining: string;
  /** T-343 S5.2 (R4.6) — `supplier_invoices.invoice_no` is nullable; `assertOpenForRecording`
   *  names the invoice by number when one exists, else by date (rule 2's no-number fallback). */
  invoiceNo: string | null;
  /** Raw `YYYY-MM-DD`, unparsed — kept on the success path so a malformed value never fails a
   *  read that isn't even about naming this invoice. `invoicePhrase` parses it lazily, only when
   *  it needs the human date, and falls back if parsing fails (S5.2 follow-up #4). */
  invoiceDate: string;
  supplierName: string;
}

export async function capacityOf(
  tx: Tx,
  orgId: string,
  invoiceId: string,
  /** ⭐ T-196 — pass the expense's OWN id when it already exists (approveExpense's call: the
   *  draft row is already in `expenses`, already `status <> 'voided'`, so without this it would
   *  be summed into `recorded` AND checked against `remaining` a second time, always reading as
   *  "0 remaining" for exactly the amount that is trying to post). Mirrors the trigger's own
   *  `AND id <> NEW.id`. Omit for `createExpense`'s call — the row does not exist yet. */
  excludeExpenseId?: string,
): Promise<InvoiceCapacity | undefined> {
  const [row] = (await tx.execute(sql`
    select
      si.status,
      si.total_amount::text as total_amount,
      coalesce(sum(e.total_amount), 0)::text as recorded,
      (si.total_amount - coalesce(sum(e.total_amount), 0))::text as remaining,
      si.invoice_no,
      si.invoice_date::text as invoice_date,
      s.name as supplier_name
    from supplier_invoices si
    join suppliers s on s.id = si.supplier_id and s.org_id = si.org_id
    left join expenses e on e.supplier_invoice_id = si.id and e.status <> 'voided'
      ${excludeExpenseId ? sql`and e.id <> ${excludeExpenseId}` : sql``}
    where si.id = ${invoiceId} and si.org_id = ${orgId}
    group by si.id, si.status, si.total_amount, s.name
  `)) as unknown as Record<string, string | null>[];
  if (!row) return undefined;
  return {
    status: row.status as SupplierInvoiceStatus,
    totalAmount: Number(row.total_amount).toFixed(2),
    recorded: Number(row.recorded).toFixed(2),
    remaining: Number(row.remaining).toFixed(2),
    invoiceNo: row.invoice_no ?? null,
    invoiceDate: row.invoice_date as string,
    supplierName: row.supplier_name as string,
  };
}

/** R4.6 — `${inv}`/`${Inv}`: the invoice named by number when one exists, else the no-number
 *  fallback, both from `rule 2`. `formatBusinessDateTime`/`businessDayRange` are the exact pair
 *  `@shareat/domain`'s `humanDate` calls (no second date formatter) — inlined here, not imported,
 *  because `packages/db` cannot depend on `@shareat/domain` (the dependency runs the other way).
 *  `invoiceDate` is parsed here, lazily, only for the no-number branch that actually needs it
 *  (S5.2 follow-up #4) — a malformed value falls back to the number-less, date-less phrase rather
 *  than failing the whole refusal it is meant to help explain. */
function invoicePhrase(capacity: InvoiceCapacity): string {
  if (capacity.invoiceNo) return `invoice ${capacity.invoiceNo} from ${capacity.supplierName}`;
  try {
    const date = parseBusinessDate(capacity.invoiceDate);
    return `the ${formatBusinessDateTime(businessDayRange(date).start, { dateStyle: 'medium' })} invoice from ${capacity.supplierName}`;
  } catch {
    return `the invoice from ${capacity.supplierName}`;
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The clean, named error — the hand-written trigger (DEF-073, replaced for T-196 by migration
 * 0113) is the actual backstop.
 *
 * ⭐ T-196 — `target` mirrors the trigger's own two-part rule exactly:
 *   - `'draft'`  — createExpense's call. Only "does it exist" and "is it voided" and "does it
 *     fit" matter; a PENDING invoice is fine, that is the whole point of this task.
 *   - `'posted'` — the approval path's call (`approveExpense`). The invoice must additionally be
 *     `verified` — the same test the trigger applies on the UPDATE that flips a row to 'posted'.
 * Message wording matches the trigger's, statement for statement, so a caller never sees two
 * different explanations for the same refusal depending on which layer caught it first.
 */
export async function assertOpenForRecording(
  tx: Tx,
  orgId: string,
  invoiceId: string,
  amount: string,
  target: 'draft' | 'posted',
  /** ⭐ T-196 — the approval path's own expense id, already `status = 'draft'` and already in
   *  the `recorded` sum by the time this runs. See `capacityOf`'s own comment. Omit for
   *  `createExpense`'s call, where the row does not exist yet. */
  excludeExpenseId?: string,
): Promise<void> {
  const capacity = await capacityOf(tx, orgId, invoiceId, excludeExpenseId);
  if (!capacity) {
    throw recordGone(`assertOpenForRecording: supplier invoice ${invoiceId} does not exist in org ${orgId}`, 'supplier invoice');
  }
  if (capacity.status === 'voided') {
    throw refuse(
      `assertOpenForRecording: supplier invoice ${invoiceId} is voided — nothing further may be ` +
        'recorded against it',
      `${capitalise(invoicePhrase(capacity))} has been voided, so nothing more can be recorded against it.`,
    );
  }
  if (target === 'posted' && capacity.status !== 'verified') {
    throw refuse(
      `assertOpenForRecording: supplier invoice ${invoiceId} is ${capacity.status} — a draft may ` +
        'stand against it, but it cannot post until it is verified',
      `${capitalise(invoicePhrase(capacity))} hasn't been verified yet, so this can't post against it.`,
    );
  }
  if (Number(amount) > Number(capacity.remaining) + CAPACITY_EPSILON) {
    throw refuse(
      `assertOpenForRecording: supplier invoice ${invoiceId} has only ₱${capacity.remaining} ` +
        `remaining (total ₱${capacity.totalAmount}, already recorded ₱${capacity.recorded}) — ` +
        `₱${amount} does not fit`,
      `${capitalise(invoicePhrase(capacity))} has only ₱${capacity.remaining} left of ₱${capacity.totalAmount}; ₱${amount} doesn't fit.`,
    );
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — every AP figure, from the ledger
// -------------------------------------------------------------------------------------

export interface ApPosition {
  controlBalance: string;
}

export async function positionOf(
  tx: Tx,
  orgId: string,
  supplierId: string,
  /** ⭐ Omit for the supplier's whole-org total; pass a store for THAT store's liability alone.
   *  Both are real questions: "what do we owe Alberto's" and "what does Lipa owe Alberto's". */
  storeId?: string,
): Promise<ApPosition> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${supplierId}
      and a.code = ${AP_CONTROL_CODE}
      and je.status <> 'draft'
      ${storeId ? sql`and jl.store_id = ${storeId}` : sql``}
  `)) as unknown as Record<string, string>[];
  return { controlBalance: Number(row?.balance ?? 0).toFixed(2) };
}

/**
 * ⭐ T-209b — the whole register's control balance, org-wide or for one store. The
 * reconciliation partner for `aging()`'s bucketed total: two independent aggregation paths
 * (this one straight off `journal_lines`, `aging()`'s own off `expenses`/`supplier_invoices`/
 * `expense_payments`/`ap_payment_allocations`) that must agree to the centavo.
 */
export async function orgAgingTotal(tx: Tx, orgId: string, storeId?: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${AP_CONTROL_CODE}
      and je.status <> 'draft'
      ${storeId ? sql`and jl.store_id = ${storeId}` : sql``}
  `)) as unknown as Record<string, string>[];
  return Number(row?.balance ?? 0).toFixed(2);
}

/** Every supplier's control balance in one query — the register's N+1 guard. */
export async function positionsBySupplier(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = (await tx.execute(sql`
    select jl.party_id as supplier_id, coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${AP_CONTROL_CODE}
      and je.status <> 'draft'
    group by jl.party_id
  `)) as unknown as Record<string, string>[];
  const map = new Map<string, string>();
  for (const r of rows) map.set(String(r.supplier_id ?? r.supplierId), Number(r.balance ?? 0).toFixed(2));
  return map;
}

/**
 * ⭐ T-170's `supplierCreditBalance` — the `1240` twin of `positionOf`'s `2110` query, but on the
 * OTHER side: `1240` is an asset, so its normal balance is `debit - credit`, not `credit - debit`.
 * A return DEBITS `1240` (T-170 §3b: `Dr 1240 / Cr inventory` — the credit we now hold). Spending
 * it in `recordPayment` CREDITS `1240` back down (`Dr 2110 / Cr 1240`). A balance of zero means
 * nothing is currently held or owed either way.
 */
export async function advancesPositionOf(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${supplierId}
      and a.code = ${ADVANCES_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return Number(row?.balance ?? 0).toFixed(2);
}

export interface OpenItem {
  expenseId: string;
  supplierId: string;
  supplierInvoiceId: string;
  storeId: string;
  businessDate: string;
  particulars: string;
  creditAmount: string;
  allocatedAmount: string;
  outstanding: string;
}

/**
 * v1's `ap_open` projection — as a live query, not a stored table. Cannot go stale the way
 * DEF-076 did: there is nothing to upsert and forget.
 */
export async function openItems(
  tx: Tx,
  orgId: string,
  supplierId: string,
  /** ⭐ REQUIRED, not optional (Ian, 2026-08-28: "make it store scoped not org but store"). An
   *  optional store filter would default to org-wide, which is exactly the bug: a payment made
   *  at one store could settle a liability another store incurred, putting the 2110 debit on
   *  books that never carried the credit. Making it required forces every caller to say which
   *  store's ledger it is talking about. */
  storeId: string,
): Promise<OpenItem[]> {
  const rows = (await tx.execute(sql`
    with credit as (
      select ep.expense_id, sum(ep.amount) as credit_amount
      from expense_payments ep
      where ep.method = 'credit'
      group by ep.expense_id
    ),
    allocated as (
      select apa.expense_id, sum(apa.amount_applied) as allocated_amount
      from ap_payment_allocations apa
      join ap_payments ap on ap.id = apa.ap_payment_id
      where ap.status = 'posted'
      group by apa.expense_id
    )
    select
      e.id as expense_id,
      e.supplier_id,
      e.supplier_invoice_id,
      e.store_id,
      e.business_date::text as business_date,
      e.particulars,
      c.credit_amount::text as credit_amount,
      coalesce(a.allocated_amount, 0)::text as allocated_amount,
      (c.credit_amount - coalesce(a.allocated_amount, 0))::text as outstanding
    from expenses e
    join credit c on c.expense_id = e.id
    left join allocated a on a.expense_id = e.id
    where e.org_id = ${orgId} and e.supplier_id = ${supplierId} and e.store_id = ${storeId}
      and e.status = 'posted'
      and (c.credit_amount - coalesce(a.allocated_amount, 0)) > 0.005
    order by e.business_date asc
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    expenseId: String(r.expense_id ?? r.expenseId),
    supplierId: String(r.supplier_id ?? r.supplierId),
    supplierInvoiceId: String(r.supplier_invoice_id ?? r.supplierInvoiceId),
    storeId: String(r.store_id ?? r.storeId),
    businessDate: String(r.business_date ?? r.businessDate),
    particulars: String(r.particulars),
    creditAmount: Number(r.credit_amount ?? r.creditAmount).toFixed(2),
    allocatedAmount: Number(r.allocated_amount ?? r.allocatedAmount).toFixed(2),
    outstanding: Number(r.outstanding).toFixed(2),
  }));
}

/** T-330's ordering-key shape, at the expense grain (AMENDMENT 4, F3+F7 — the sort's third key is
 *  `expenses.id`, not anything on `supplier_invoices`, because two expenses can share one invoice). */
export interface ApOrderingKeys {
  expenseId: string;
  /** `supplier_invoices.due_date` — NULLABLE, handed back RAW. */
  dueDate: string | null;
  /** `supplier_invoices.invoice_date` — NOT NULL, the fallback `allocateOldestFirst` resolves. */
  invoiceDate: string;
  invoiceNo: string | null;
}

/**
 * T-330 §1 / AMENDMENT 1 — the narrow ordering-key lookup, keyed by the ids `openItems` already
 * returned, used ONLY to sort. ⛔ Never a second definition of "open": the caller passes
 * `openItems`'s own expense ids in, never re-derives them (a divergent "open" would propose an
 * item Save then rejects, on a figure the operator never typed).
 *
 * ⭐ Q4, ruled: filtered by `org_id` here, in the real repo function — even though the ids already
 * came from an org-scoped `openItems` call — because bible §15.11 says no layer may be the only
 * one holding a risk down.
 */
export async function orderingKeysForExpenses(
  tx: Tx,
  orgId: string,
  expenseIds: readonly string[],
): Promise<ApOrderingKeys[]> {
  if (expenseIds.length === 0) return [];
  // ⛔ Each id its OWN bound parameter (`sql.join`), same discipline as `lockExpensesForAllocation`
  // above: a single bound array parameter sends `malformed array literal` against this driver.
  const ids = sql.join(
    expenseIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    select e.id as expense_id, si.due_date::text as due_date,
           si.invoice_date::text as invoice_date, si.invoice_no
    from expenses e
    join supplier_invoices si on si.id = e.supplier_invoice_id
    where e.org_id = ${orgId} and e.id in (${ids})
  `)) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    expenseId: String(r.expense_id ?? (r as Record<string, string>).expenseId),
    dueDate: r.due_date ? String(r.due_date) : null,
    invoiceDate: String(r.invoice_date ?? (r as Record<string, string>).invoiceDate),
    invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
  }));
}

export interface AgingBucket {
  supplierId: string;
  storeId: string;
  current: string;
  d1to30: string;
  d31to60: string;
  d61to90: string;
  d90plus: string;
}

/**
 * Buckets every open item by DUE DATE (bible §13, aging-basis decision, 2026-08-27 — not yet a
 * bible row, see `docs/tasks/130-accounts-payable.md` Invariant 11), falling back to invoice
 * date when an invoice carries none (informal supplier terms — real, not hypothetical).
 */
export async function aging(
  tx: Tx,
  orgId: string,
  asOfDate: string,
  /** Omit for every store; pass one to age a single store's payables. */
  storeId?: string,
): Promise<AgingBucket[]> {
  const rows = (await tx.execute(sql`
    with credit as (
      select ep.expense_id, sum(ep.amount) as credit_amount
      from expense_payments ep
      where ep.method = 'credit'
      group by ep.expense_id
    ),
    allocated as (
      select apa.expense_id, sum(apa.amount_applied) as allocated_amount
      from ap_payment_allocations apa
      join ap_payments ap on ap.id = apa.ap_payment_id
      where ap.status = 'posted'
      group by apa.expense_id
    ),
    open as (
      select
        e.supplier_id,
        e.store_id,
        coalesce(si.due_date, si.invoice_date) as aging_date,
        (c.credit_amount - coalesce(a.allocated_amount, 0)) as outstanding
      from expenses e
      join credit c on c.expense_id = e.id
      left join allocated a on a.expense_id = e.id
      join supplier_invoices si on si.id = e.supplier_invoice_id
      where e.org_id = ${orgId} and e.status = 'posted'
        and (c.credit_amount - coalesce(a.allocated_amount, 0)) > 0.005
        ${storeId ? sql`and e.store_id = ${storeId}` : sql``}
    )
    select
      supplier_id,
      store_id,
      coalesce(sum(outstanding) filter (where aging_date >= ${asOfDate}), 0)::text as current,
      coalesce(sum(outstanding) filter (where aging_date < ${asOfDate} and aging_date >= (${asOfDate}::date - 30)), 0)::text as d1to30,
      coalesce(sum(outstanding) filter (where aging_date < (${asOfDate}::date - 30) and aging_date >= (${asOfDate}::date - 60)), 0)::text as d31to60,
      coalesce(sum(outstanding) filter (where aging_date < (${asOfDate}::date - 60) and aging_date >= (${asOfDate}::date - 90)), 0)::text as d61to90,
      coalesce(sum(outstanding) filter (where aging_date < (${asOfDate}::date - 90)), 0)::text as d90plus
    from open
    group by supplier_id, store_id
    order by supplier_id, store_id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    supplierId: String(r.supplier_id ?? r.supplierId),
    storeId: String(r.store_id ?? r.storeId),
    current: Number(r.current).toFixed(2),
    d1to30: Number(r.d1to30).toFixed(2),
    d31to60: Number(r.d31to60).toFixed(2),
    d61to90: Number(r.d61to90).toFixed(2),
    d90plus: Number(r.d90plus).toFixed(2),
  }));
}

/**
 * ⛔ Take a row lock on the expenses a payment is about to allocate against, BEFORE reading
 * their outstanding balances.
 *
 * ⚠️ **Why this exists, precisely.** `recordPayment` reads `openItems`, decides an allocation
 * fits, and then writes — a check-then-act across two statements. Under READ COMMITTED (the
 * default here), two payments naming the same open item can both read it as open, both decide
 * they fit, and both post: the supplier is paid twice and `2110` goes negative for that party.
 * Locking the expense rows first serialises exactly those payments and nothing else — the second
 * transaction blocks until the first commits, then re-reads and correctly finds the item closed.
 *
 * ⚠️ Ordered by id so two payments naming the same pair of expenses in different orders cannot
 * deadlock against each other.
 */
export async function lockExpensesForAllocation(tx: Tx, orgId: string, expenseIds: string[]): Promise<void> {
  if (expenseIds.length === 0) return;
  // ⛔ Each id is its OWN bound parameter (`sql.join`), never interpolated and never a single
  // array parameter. These ids arrive from a form, so `sql.raw` here would be an injection hole
  // in the one function that also takes write locks; and binding the JS array as one value gives
  // `malformed array literal`, because the driver sends it as a scalar.
  const ids = sql.join(
    expenseIds.map((id) => sql`${id}`),
    sql`, `,
  );
  await tx.execute(sql`
    select id from expenses
    where org_id = ${orgId} and id in (${ids})
    order by id
    for update
  `);
}

// -------------------------------------------------------------------------------------
// ap_payments / ap_payment_allocations
// -------------------------------------------------------------------------------------

export interface ApPaymentRow {
  id: string;
  orgId: string;
  storeId: string;
  supplierId: string;
  businessDate: string;
  amount: string;
  moneyAccountId: string;
  cashRequestId: string | null;
  referenceNo: string | null;
  notes: string | null;
  status: ApPaymentStatus;
  journalEntryId: string | null;
  createdBy: string;
  postedAt: Date | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
}

export async function insertApPayment(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    supplierId: string;
    businessDate: string;
    amount: string;
    moneyAccountId: string;
    cashRequestId: string | null;
    referenceNo: string | null;
    notes: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(apPayments).values(input).returning({ id: apPayments.id });
  return row!;
}

export async function getApPaymentById(tx: Tx, orgId: string, id: string): Promise<ApPaymentRow | undefined> {
  const [row] = await tx
    .select()
    .from(apPayments)
    .where(and(eq(apPayments.id, id), eq(apPayments.orgId, orgId)))
    .limit(1);
  return row as ApPaymentRow | undefined;
}

export async function markApPaymentPosted(
  tx: Tx,
  orgId: string,
  id: string,
  input: { journalEntryId: string },
): Promise<void> {
  const updated = await tx
    .update(apPayments)
    .set({ status: 'posted', journalEntryId: input.journalEntryId, postedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(apPayments.id, id), eq(apPayments.orgId, orgId), eq(apPayments.status, 'draft')))
    .returning({ id: apPayments.id });
  if (updated.length === 0) {
    throw recordGone(
      `markApPaymentPosted: ap_payment ${id} does not exist, is not in org ${orgId}, or is not a draft`,
      'payment',
      'a draft',
    );
  }
}

export async function markApPaymentVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(apPayments)
    .set({ status: 'voided', voidedBy: input.voidedBy, voidedAt: sql`now()`, voidReason: input.voidReason, updatedAt: sql`now()` })
    .where(and(eq(apPayments.id, id), eq(apPayments.orgId, orgId), eq(apPayments.status, 'posted')))
    .returning({ id: apPayments.id });
  if (updated.length === 0) {
    throw recordGone(
      `markApPaymentVoided: ap_payment ${id} does not exist, is not in org ${orgId}, or is not posted`,
      'payment',
      'posted',
    );
  }
}

export async function insertApPaymentAllocations(
  tx: Tx,
  apPaymentId: string,
  allocations: { expenseId: string; amountApplied: string }[],
): Promise<void> {
  if (allocations.length === 0) return;
  await tx.insert(apPaymentAllocations).values(
    allocations.map((a) => ({ apPaymentId, expenseId: a.expenseId, amountApplied: a.amountApplied })),
  );
}

export interface ApPaymentAllocationRow {
  id: string;
  apPaymentId: string;
  expenseId: string;
  amountApplied: string;
}

export async function getAllocationsForPayment(tx: Tx, apPaymentId: string): Promise<ApPaymentAllocationRow[]> {
  const rows = await tx
    .select()
    .from(apPaymentAllocations)
    .where(eq(apPaymentAllocations.apPaymentId, apPaymentId));
  return rows as ApPaymentAllocationRow[];
}
