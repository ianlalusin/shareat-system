/**
 * Suppliers, supplier invoices, and AP payments. T-130.
 *
 * ## ⭐ The gate — corrected twice, by Ian, directly (docs/tasks/130-accounts-payable.md §2)
 *
 * No expense — cash or credit — may be recorded until its `supplier_invoices` row is
 * `verified`. Verification IS the approval; recording an expense against a verified invoice
 * needs no separate draft step of its own. This module does not reimplement expense posting to
 * get that: `recordExpenseForInvoice` below calls `createExpense` then `approveExpense`
 * (`../expenses`) back to back, in ONE transaction — the same two primitives T-122 already
 * built, tested, and smoketested. The combined call authorizing on BOTH `create_expense` and
 * `approve_expense` is what makes only a manager (who holds both) able to complete it, without
 * this module minting a new, parallel posting capability.
 *
 * ## ⭐ `positionOf` / `openItems` — v1's `ap_open`, as a live query
 *
 * Every AP figure — per supplier, per invoice, the `2110` control total — is summed from
 * `journal_lines`, never stored (DEF-075's pattern, refused the sixth time). `packages/db/src/repo/ap.ts`
 * is where the SQL lives; this file owns the business rules and the transactions.
 *
 * ## ⛔ Voiding an invoice reuses the expense-void primitive — never reimplements it
 *
 * v1's `voidReceiptAction` cascading through `voidExpense()` — instead of reversing journal legs
 * inline — is the single most load-bearing lesson this task's grounding found: an earlier inline
 * version silently skipped budget release, cash-request liquidation, the expense-summary
 * projection, and a CAPEX asset's live-depreciation guard. `voidInvoice` below does the same.
 */
import {
  apRepo,
  expensesRepo,
  filesRepo,
  moneyAccountsRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import type { SupplierInvoiceVatType, SupplierVatStatus } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { createExpense, type CreateExpensePaymentInput } from '../expenses/create';
import { approveExpense, type ApproveExpenseResult } from '../expenses/approve';
import { voidExpense } from '../expenses/void';

export const AP_CONTROL_CODE = apRepo.AP_CONTROL_CODE;
export const ADVANCES_CODE = apRepo.ADVANCES_CODE;

// -------------------------------------------------------------------------------------
// Suppliers
// -------------------------------------------------------------------------------------

export interface CreateSupplierInput {
  name: string;
  address?: string | null;
  contactNo?: string | null;
  /** ⚠️ Coupled to invoice VAT fields — see `packages/db/schema/suppliers.ts`'s own comment. */
  vatStatus?: SupplierVatStatus | null;
  notes?: string | null;
}

export async function createSupplier(
  tx: Tx | null,
  actor: Actor,
  input: CreateSupplierInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});
    const name = input.name.trim();
    if (!name) throw new Error('createSupplier: a supplier needs a name people will recognise.');
    return apRepo.insertSupplier(trx, {
      orgId: actor.orgId,
      name,
      address: input.address?.trim() || null,
      contactNo: input.contactNo?.trim() || null,
      vatStatus: input.vatStatus ?? null,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Stamp the reconciliation anchor — same shape as `reconcileCustomer`
 * (`packages/domain/src/customers`). An attestation, not a balance; refused while the supplier
 * still shows a real `2110` outstanding.
 */
export async function reconcileSupplier(
  tx: Tx | null,
  actor: Actor,
  input: { supplierId: string; asOf: string },
): Promise<{ balanceAtStamp: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});
    const supplier = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!supplier) throw new Error(`reconcileSupplier: supplier ${input.supplierId} does not exist.`);

    const position = await apRepo.positionOf(trx, actor.orgId, supplier.id);
    if (Math.abs(Number(position.controlBalance)) > 0.005) {
      throw new Error(
        `reconcileSupplier: this supplier is owed ₱${position.controlBalance}. An anchor says ` +
          `they were verified at ZERO on a date, so stamping one now would tell every later aging ` +
          `report that a live obligation was settled.`,
      );
    }

    await apRepo.updateSupplier(trx, actor.orgId, supplier.id, {
      reconciledAsOf: input.asOf,
      reconciledAt: new Date(),
      reconciledBy: actor.personId,
    });
    return { balanceAtStamp: position.controlBalance };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Supplier invoices — the gate
// -------------------------------------------------------------------------------------

export interface RecordInvoiceInput {
  storeId: string;
  supplierId: string;
  invoiceNo?: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  totalAmount: string;
  notes?: string | null;
  receiptPhotoUrl?: string | null;
  receiptFileId?: string | null;
  vatType?: SupplierInvoiceVatType | null;
  vatRate?: string | null;
  vatAmount?: string | null;
  vatExclusiveAmount?: string | null;
}

export interface RecordInvoiceResult {
  id: string;
  /** Present when another invoice already exists for this supplier + invoice number — a
   *  warning, never a block (bible §16.10). */
  duplicateWarning?: string;
}

export async function recordInvoice(
  tx: Tx | null,
  actor: Actor,
  input: RecordInvoiceInput,
): Promise<RecordInvoiceResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_supplier_invoice', { storeId: input.storeId });

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!supplier) throw new Error(`recordInvoice: supplier ${input.supplierId} does not exist.`);

    const amount = Number(input.totalAmount);
    if (amount <= 0) throw new Error('recordInvoice: an invoice total has to be greater than zero.');

    let duplicateWarning: string | undefined;
    const invoiceNo = input.invoiceNo?.trim() || null;
    if (invoiceNo) {
      const duplicates = await apRepo.findDuplicateInvoices(trx, actor.orgId, {
        supplierId: input.supplierId,
        invoiceNo,
      });
      if (duplicates.length > 0) {
        duplicateWarning =
          `This looks like a duplicate — ${supplier.name} already has invoice "${invoiceNo}" ` +
          `recorded (${duplicates.map((d) => `${d.invoiceDate} ₱${d.totalAmount}`).join(', ')}). ` +
          'Saved anyway; check it is not the same bill twice.';
      }
    }

    const created = await apRepo.insertSupplierInvoice(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      supplierId: input.supplierId,
      invoiceNo,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate ?? null,
      totalAmount: input.totalAmount,
      notes: input.notes?.trim() || null,
      receiptPhotoUrl: input.receiptPhotoUrl ?? null,
      receiptFileId: input.receiptFileId ?? null,
      vatType: input.vatType ?? null,
      vatRate: input.vatRate ?? null,
      vatAmount: input.vatAmount ?? null,
      vatExclusiveAmount: input.vatExclusiveAmount ?? null,
      createdBy: actor.personId,
    });

    return { id: created.id, ...(duplicateWarning ? { duplicateWarning } : {}) };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ The approval. Requires the evidence — a CHECK constraint cannot safely join out to
 * `suppliers` to test the commissary exemption (`docs/tasks/130-accounts-payable.md` §2), so
 * this is where v1's actual rule (`receipt.actions.ts:267-281`) lives: exempt only when the
 * supplier is a system-managed commissary mirror (`counterpartyStoreId` set).
 */
export async function verifyInvoice(
  tx: Tx | null,
  actor: Actor,
  invoiceId: string,
): Promise<void> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, invoiceId);
    if (!invoice) throw new Error(`verifyInvoice: supplier invoice ${invoiceId} does not exist.`);
    await authorize(trx, actor, 'verify_supplier_invoice', { storeId: invoice.storeId });

    if (invoice.status !== 'pending') {
      throw new Error(`verifyInvoice: supplier invoice ${invoiceId} is ${invoice.status}, not pending.`);
    }

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, invoice.supplierId);
    const isCommissaryMirror = !!supplier?.counterpartyStoreId;
    if (!isCommissaryMirror) {
      // ⭐ T-141's rule, ported not re-derived (DEF-055 relocated here from expense approval): a
      // ROW is checked, never a string. `receipt_photo_url` is plain text — satisfied by typing
      // `x` — so a bare truthiness check on it (or on a hand-typed `receiptFileId`) is not
      // evidence, it is the pre-T-141 hole reopened. `filesRepo.getById` is the only thing that
      // proves the file is real, in this org, and belongs to this invoice's store.
      if (invoice.receiptFileId) {
        const file = await filesRepo.getById(trx, actor.orgId, invoice.receiptFileId);
        if (!file) {
          throw new Error(
            `verifyInvoice: supplier invoice ${invoiceId} names a receipt file that does not exist in this org`,
          );
        }
        if (file.storeId && file.storeId !== invoice.storeId) {
          throw new Error(
            `verifyInvoice: supplier invoice ${invoiceId} names a receipt belonging to another store — ` +
              'a photo from somewhere else is not evidence for this invoice',
          );
        }
      } else if (!invoice.receiptPhotoUrl || !invoice.receiptPhotoUrl.trim()) {
        throw new Error(
          `verifyInvoice: supplier invoice ${invoiceId} has no receipt photo — attach one before ` +
            'verifying (DEF-055, relocated here from expense approval).',
        );
      }
    }

    await apRepo.markInvoiceVerified(trx, actor.orgId, invoiceId, { verifiedBy: actor.personId });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Cascades through `voidExpense` for every live linked expense — sequential, fail-fast,
 * retry-safe: if one linked expense's void fails, the ones already voided stay voided and the
 * invoice is not flipped. Matches `voidReceiptAction`'s exact contract.
 */
export async function voidInvoice(
  tx: Tx | null,
  actor: Actor,
  input: { invoiceId: string; reason: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, input.invoiceId);
    if (!invoice) throw new Error(`voidInvoice: supplier invoice ${input.invoiceId} does not exist.`);
    await authorize(trx, actor, 'void_supplier_invoice', { storeId: invoice.storeId });

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidInvoice: say why this invoice is being voided.');

    const live = await apRepo.liveExpensesForInvoice(trx, actor.orgId, input.invoiceId);
    for (const e of live) {
      await voidExpense(trx, actor, e.id, `Invoice voided: ${reason}`);
    }

    await apRepo.markInvoiceVoided(trx, actor.orgId, input.invoiceId, {
      voidedBy: actor.personId,
      voidReason: reason,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Recording an expense against a verified invoice — create + approve, one call
// -------------------------------------------------------------------------------------

export interface RecordExpenseForInvoiceInput {
  storeId: string;
  supplierInvoiceId: string;
  supplierId: string;
  categoryId: string;
  ownerId?: string | null;
  particulars: string;
  payments: CreateExpensePaymentInput[];
}

export interface RecordExpenseForInvoiceResult extends ApproveExpenseResult {
  expenseId: string;
}

/**
 * ⭐ *"Expense may already be posted, no need for draft"* (Ian, 2026-08-27) — made true by
 * calling `createExpense` then `approveExpense` (`../expenses`) in ONE transaction, never by
 * building a second posting path. Requiring BOTH `create_expense` and `approve_expense` is what
 * keeps this manager-gated (a manager holds both; staff does not hold `approve_expense`) without
 * a new capability — posting has always been the gate that matters in this system.
 */
export async function recordExpenseForInvoice(
  tx: Tx | null,
  actor: Actor,
  input: RecordExpenseForInvoiceInput,
): Promise<RecordExpenseForInvoiceResult> {
  const run = async (trx: Tx) => {
    const { id: expenseId } = await createExpense(trx, actor, {
      storeId: input.storeId,
      businessDate: '', // ignored — createExpense forces this from the invoice's own date
      categoryId: input.categoryId,
      supplierId: input.supplierId,
      supplierInvoiceId: input.supplierInvoiceId,
      ownerId: input.ownerId ?? null,
      particulars: input.particulars,
      payments: input.payments,
    });
    const approved = await approveExpense(trx, actor, expenseId);
    return { expenseId, ...approved };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// AP payments — settling a supplier against named open items
// -------------------------------------------------------------------------------------

export interface ApPaymentAllocationInput {
  expenseId: string;
  amountApplied: string;
}

export interface RecordApPaymentInput {
  storeId: string;
  supplierId: string;
  businessDate: string;
  /** The TOTAL handed over — allocated + unallocated (overpayment). */
  amount: string;
  moneyAccountId: string;
  /** Set when this payment draws on a released cash request — attribution only, mirrors
   *  `expense_payments.cashRequestId`'s role exactly. */
  cashRequestId?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
  allocations: ApPaymentAllocationInput[];
}

export interface RecordApPaymentResult {
  paymentId: string;
  entryId: string;
  allocated: string;
  unallocated: string;
  warning?: string;
}

export async function recordPayment(
  tx: Tx | null,
  actor: Actor,
  input: RecordApPaymentInput,
): Promise<RecordApPaymentResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_ap_payment', { storeId: input.storeId });

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!supplier) throw new Error(`recordPayment: supplier ${input.supplierId} does not exist.`);

    const amount = Number(input.amount);
    if (amount <= 0) throw new Error('recordPayment: a payment has to be greater than zero.');
    if (input.allocations.length === 0) {
      throw new Error(
        'recordPayment: name at least one open item this payment settles (bible §16.10 — a ' +
          'payment must never float unallocated).',
      );
    }

    // ⛔ Every allocation must be an OPEN item for THIS supplier — validated against
    // apRepo.openItems, never trusted from the caller. No partial apply: the whole payment is
    // rejected if any one allocation is wrong.
    const open = await apRepo.openItems(trx, actor.orgId, input.supplierId);
    const byExpense = new Map(open.map((o) => [o.expenseId, o]));
    let allocatedTotal = 0;
    for (const a of input.allocations) {
      const item = byExpense.get(a.expenseId);
      if (!item) {
        throw new Error(
          `recordPayment: expense ${a.expenseId} is not an open item for this supplier — it may ` +
            'belong to another supplier, not be a credit expense, already be fully paid, or not be posted.',
        );
      }
      const applied = Number(a.amountApplied);
      if (applied <= 0) throw new Error(`recordPayment: allocation for expense ${a.expenseId} must be greater than zero.`);
      if (applied > Number(item.outstanding) + 0.005) {
        throw new Error(
          `recordPayment: expense ${a.expenseId} has only ₱${item.outstanding} still owed — ` +
            `₱${a.amountApplied} does not fit.`,
        );
      }
      allocatedTotal += applied;
    }
    if (allocatedTotal > amount + 0.005) {
      throw new Error(
        `recordPayment: allocations total ₱${allocatedTotal.toFixed(2)}, more than the ` +
          `₱${input.amount} handed over — a payment cannot allocate more than it pays.`,
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw new Error('recordPayment: that money account does not exist.');
    if (account.storeId !== input.storeId) {
      // ⭐ Cross-store money movement — same rule as `approveExpense` (bible row 153).
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }
    const warning = await checkDraw(trx, actor.orgId, account, amount, 'recordPayment');

    const unallocated = Math.max(0, amount - allocatedTotal);
    const allocated = allocatedTotal;

    const lines = [
      {
        accountCode: AP_CONTROL_CODE,
        storeId: input.storeId,
        debit: allocated.toFixed(2),
        partyType: 'supplier' as const,
        partyId: input.supplierId,
        lineMemo: `AP payment — ${supplier.name}`,
      },
      ...(unallocated > 0
        ? [
            {
              accountCode: ADVANCES_CODE,
              storeId: input.storeId,
              debit: unallocated.toFixed(2),
              partyType: 'supplier' as const,
              partyId: input.supplierId,
              lineMemo: `Overpayment — ${supplier.name}`,
            },
          ]
        : []),
      {
        accountCode: account.glAccountCode,
        storeId: input.storeId,
        credit: input.amount,
        ...(account.glAccountCode === '1140'
          ? { partyType: 'money_account' as const, partyId: account.id }
          : {}),
        lineMemo: `Payment to ${supplier.name}`,
      },
    ];

    const { id: paymentId } = await apRepo.insertApPayment(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      supplierId: input.supplierId,
      businessDate: input.businessDate,
      amount: input.amount,
      moneyAccountId: input.moneyAccountId,
      cashRequestId: input.cashRequestId ?? null,
      referenceNo: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.businessDate,
      sourceType: 'ap_payment',
      sourceId: paymentId,
      idempotencyKey: `ap_payment:${paymentId}:post`,
      memo: `Payment to ${supplier.name}`,
      postedBy: actor.personId,
      lines,
    });

    if (result.created) {
      await apRepo.markApPaymentPosted(trx, actor.orgId, paymentId, { journalEntryId: result.entryId });
      await apRepo.insertApPaymentAllocations(
        trx,
        paymentId,
        input.allocations.map((a) => ({ expenseId: a.expenseId, amountApplied: a.amountApplied })),
      );
    }

    return {
      paymentId,
      entryId: result.entryId,
      allocated: allocated.toFixed(2),
      unallocated: unallocated.toFixed(2),
      ...(warning ? { warning } : {}),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** ⚠️ Reversal, never a delete — the original and its mirror both stay on the ledger. Allocation
 *  rows are NOT deleted; a voided payment's allocations must stay visible so `openItems` correctly
 *  shows the expense open again (invariant 8). */
export async function voidPayment(
  tx: Tx | null,
  actor: Actor,
  input: { paymentId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const payment = await apRepo.getApPaymentById(trx, actor.orgId, input.paymentId);
    if (!payment) throw new Error(`voidPayment: ap_payment ${input.paymentId} does not exist.`);
    await authorize(trx, actor, 'record_ap_payment', { storeId: payment.storeId });

    if (payment.status !== 'posted') {
      throw new Error(`voidPayment: ap_payment ${input.paymentId} is ${payment.status}, not posted.`);
    }
    if (!payment.journalEntryId) {
      throw new Error(`voidPayment: ap_payment ${input.paymentId} is posted but carries no journalEntryId — data inconsistency.`);
    }

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidPayment: say why this payment is being voided.');

    const result = await reverseEntry(trx, {
      entryId: payment.journalEntryId,
      reason,
      reversedBy: actor.personId,
    });

    if (result.created) {
      await apRepo.markApPaymentVoided(trx, actor.orgId, input.paymentId, {
        voidedBy: actor.personId,
        voidReason: reason,
      });
    }

    return { entryId: result.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}
