/**
 * Suppliers, supplier invoices, and AP payments. T-130. Gate timing changed by T-196.
 *
 * ## ⭐ The gate — corrected twice, by Ian, directly (docs/tasks/130-accounts-payable.md §2),
 * then RETIMED by T-196 (docs/tasks/196-draft-expense-on-a-pending-invoice.md)
 *
 * No expense — cash or credit — may POST until its `supplier_invoices` row is `verified`. Since
 * T-196 this is a POSTING gate, not an EXISTENCE gate: a draft may sit against a `pending`
 * invoice (`createExpense` alone, no `approve_expense` needed), and `verifyInvoice` below posts
 * every draft standing against the invoice the moment it verifies — Ian, 2026-08-31: *"when
 * receipt is verified the expense are posted."* `recordExpenseForInvoice` below still calls
 * `createExpense` then `approveExpense` (`../expenses`) back to back, in ONE transaction, for the
 * already-verified case — the manager-holding-both shortcut T-130 built, unchanged. The combined
 * call authorizing on BOTH `create_expense` and `approve_expense` is what makes only a manager
 * (who holds both) able to complete it in one click, without this module minting a new, parallel
 * posting capability. Either way, `approveExpense` is the ONLY posting path there is.
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
  itemsRepo,
  expensesRepo,
  filesRepo,
  moneyAccountsRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import type {
  SupplierClassification,
  SupplierInvoiceVatType,
  SupplierStatus,
  SupplierVatStatus,
} from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { createExpense, type CreateExpensePaymentInput } from '../expenses/create';
import { approveExpense, type ApproveExpenseResult } from '../expenses/approve';
import { voidExpense } from '../expenses/void';
import { deleteExpenseDraft } from '../expenses/delete';
import { validateInvoiceLines, type InvoiceLineDraft } from '../items';

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

  // ---- T-188. Measured against live v1 data before being accepted here; the fields NOT ported
  // are recorded in docs/tasks/188-supplier-master-data.md with their fill rates.
  email?: string | null;
  representativeName?: string | null;
  /** v1's `vatRegistrationNo` — in the Philippines this IS the TIN. */
  tin?: string | null;
  /** ⚠️ A LABEL. ⛔ Nothing may branch on it — see `SUPPLIER_CLASSIFICATIONS`. */
  classification?: SupplierClassification | null;
  /** ⭐ Defaults the document type on invoices logged against this supplier. */
  issuesOfficialReceipt?: boolean;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
}

/**
 * Everything `editSupplier` will accept.
 *
 * ⚠️ **Every field is OPTIONAL, including `name`** — the service writes only the keys actually
 * present, so a caller that renders three fields must not be forced to send the other ten. Making
 * `name` required here would have pushed callers into sending a whole object, which is exactly
 * the shape that blanks the fields a form did not happen to show.
 *
 * ⛔ `reconciled*` is absent on purpose — an attestation is stamped by `reconcileSupplier`,
 * never typed into an edit form.
 */
export interface EditSupplierInput extends Partial<CreateSupplierInput> {
  supplierId: string;
  status?: SupplierStatus;
}

/** Trim to null so an emptied field clears rather than storing `''`. */
function orNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v?.trim() || null;
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
      email: orNull(input.email) ?? null,
      representativeName: orNull(input.representativeName) ?? null,
      tin: orNull(input.tin) ?? null,
      classification: input.classification ?? null,
      issuesOfficialReceipt: input.issuesOfficialReceipt ?? true,
      bankName: orNull(input.bankName) ?? null,
      bankAccountName: orNull(input.bankAccountName) ?? null,
      bankAccountNumber: orNull(input.bankAccountNumber) ?? null,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ **Corrects a supplier.** T-188.
 *
 * `apRepo.updateSupplier` was written long ago and had **no caller at all** — no service, no
 * screen — so a typo in a supplier's name was permanent. That is the gap this task exists to
 * close; the write path was already there and merely unwired.
 *
 * ⛔ **Gated on `approve_supplier`, the same capability as CREATE, and deliberately so.** A name
 * and a bank account number are the two fields that decide where money goes. A weaker gate on edit
 * would make the stronger gate on create pointless — anyone could admit nothing and then rewrite
 * everything.
 *
 * ⚠️ Only keys actually PRESENT on `input` are written. An absent key leaves the column alone;
 * a present-but-empty one clears it. Passing a whole object would blank every field the caller
 * did not happen to render.
 */
export async function editSupplier(
  tx: Tx | null,
  actor: Actor,
  input: EditSupplierInput,
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});

    const existing = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!existing) {
      throw new Error(`editSupplier: supplier ${input.supplierId} does not exist.`);
    }

    const values: Parameters<typeof apRepo.updateSupplier>[3] = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error('editSupplier: a supplier needs a name people will recognise.');
      values.name = name;
    }
    if (input.address !== undefined) values.address = orNull(input.address) ?? null;
    if (input.contactNo !== undefined) values.contactNo = orNull(input.contactNo) ?? null;
    if (input.vatStatus !== undefined) values.vatStatus = input.vatStatus;
    if (input.notes !== undefined) values.notes = orNull(input.notes) ?? null;
    if (input.status !== undefined) values.status = input.status;
    if (input.email !== undefined) values.email = orNull(input.email) ?? null;
    if (input.representativeName !== undefined) {
      values.representativeName = orNull(input.representativeName) ?? null;
    }
    if (input.tin !== undefined) values.tin = orNull(input.tin) ?? null;
    if (input.classification !== undefined) values.classification = input.classification;
    if (input.issuesOfficialReceipt !== undefined) {
      values.issuesOfficialReceipt = input.issuesOfficialReceipt;
    }
    if (input.bankName !== undefined) values.bankName = orNull(input.bankName) ?? null;
    if (input.bankAccountName !== undefined) {
      values.bankAccountName = orNull(input.bankAccountName) ?? null;
    }
    if (input.bankAccountNumber !== undefined) {
      values.bankAccountNumber = orNull(input.bankAccountNumber) ?? null;
    }

    await apRepo.updateSupplier(trx, actor.orgId, input.supplierId, values);
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
  /** ⚠️ Omit to inherit the supplier's default — see the copy at the insert below. */
  isOfficialReceipt?: boolean;
  storeId: string;
  supplierId: string;
  invoiceNo?: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  totalAmount: string;
  /**
   * T-151. Inbound freight, supplier to us. Ian, 2026-08-28: *"delivery fee from supplier to Lipa
   * is added to price."* Part of `totalAmount`, NOT a line, and allocated across the lines by
   * value when a landed cost is read.
   */
  deliveryFee?: string | null;
  otherFees?: string | null;
  notes?: string | null;
  /** ⭐ The brokered file id from T-141's upload — the ONLY accepted form of evidence.
   *  ⛔ There is deliberately no `receiptPhotoUrl`: it was plain text, so `x` satisfied it. */
  receiptFileId?: string | null;
  vatType?: SupplierInvoiceVatType | null;
  vatRate?: string | null;
  vatAmount?: string | null;
  vatExclusiveAmount?: string | null;
  /**
   * ⭐ T-145 — what the bill was actually FOR. Optional: a utility bill or a service invoice has
   * no lines, and requiring them would make those unenterable. When present they must sum to
   * `totalAmount` and each must be arithmetically sound (`validateInvoiceLines`).
   */
  lines?: InvoiceLineDraft[];
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
    // ⭐ Ian, 2026-08-28, requirement 1: the supplier must be EXISTING **and ACTIVE**. A v2
    // tightening — v1's `upsertReceiptAction` checks only that the supplier document exists
    // (`receipt.actions.ts`), so an inactive supplier can still be billed against there. An
    // inactive supplier is one the business has stopped buying from; a new bill from one is
    // either a mistake or something worth a second look, and neither should post quietly.
    if (supplier.status !== 'active') {
      throw new Error(
        `recordInvoice: ${supplier.name} is ${supplier.status}, not active — reactivate the ` +
          'supplier first if you really are still buying from them.',
      );
    }

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
      deliveryFee: input.deliveryFee ?? '0',
      otherFees: input.otherFees ?? '0',
      notes: input.notes?.trim() || null,
      receiptFileId: input.receiptFileId ?? null,
      vatType: input.vatType ?? null,
      vatRate: input.vatRate ?? null,
      vatAmount: input.vatAmount ?? null,
      vatExclusiveAmount: input.vatExclusiveAmount ?? null,
      /**
       * ⭐ T-188. COPIED from the supplier's habit, not read through to it.
       *
       * ⛔ The distinction is the whole point: what a supplier *usually* issues and what *this
       * document* was are different facts, and a BIR audit asks about the second. Reading through
       * would mean flipping a supplier's setting today silently rewrites what last month's
       * receipt was. The caller may still override.
       */
      isOfficialReceipt: input.isOfficialReceipt ?? supplier.issuesOfficialReceipt ?? true,
      createdBy: actor.personId,
    });

    // ⭐ Lines are validated against THIS invoice's own total, then written in the same
    // transaction — an invoice can never exist with lines that do not add up to it.
    // T-151: the fees are part of the invoice total but are NOT lines, so the lines are checked
    // against the goods portion. Ian, 2026-08-28: inbound freight is added to the item's price,
    // which happens in the landed-cost derivation, not by inventing a line for it here.
    const goodsTotal = (
      Number(input.totalAmount) - Number(input.deliveryFee ?? 0) - Number(input.otherFees ?? 0)
    ).toFixed(2);
    const lines = await validateInvoiceLines(trx, actor.orgId, input.lines ?? [], goodsTotal, input.storeId);
    if (lines.length > 0) await itemsRepo.insertInvoiceLines(trx, created.id, lines);

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
export interface VerifyInvoiceAttestation {
  /** The bill is from the supplier it names. */
  supplier: boolean;
  /** Invoice number, date and total match the paper. */
  invoice: boolean;
  /** The things listed are the things received. */
  items: boolean;
  /** The prices charged are the prices agreed. */
  price: boolean;
}

/**
 * ⭐ Replace a PENDING invoice's lines — the wiring T-145 was missing.
 *
 * ⛔ **Pending only.** A verified invoice's lines are what somebody attested to when they ticked
 * "right items, right price"; editing them afterwards would make that attestation a claim about
 * something that no longer exists. Void and re-record instead, like every other posted document
 * in this system.
 *
 * ⚠️ Replaces the whole set rather than patching rows. The lines must sum to the invoice total
 * (`validateInvoiceLines`), and a partial edit cannot be checked against that without knowing
 * which rows the caller meant to leave alone — the same "supply the full set" rule
 * `editExpense`'s payments already follow.
 */
export async function setInvoiceLines(
  tx: Tx | null,
  actor: Actor,
  invoiceId: string,
  lines: InvoiceLineDraft[],
): Promise<{ count: number }> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, invoiceId);
    if (!invoice) throw new Error(`setInvoiceLines: supplier invoice ${invoiceId} does not exist.`);
    await authorize(trx, actor, 'record_supplier_invoice', { storeId: invoice.storeId });
    if (invoice.status !== 'pending') {
      throw new Error(
        `setInvoiceLines: invoice ${invoiceId} is ${invoice.status}. Lines can only be changed ` +
          'while it is still pending — after verification they are what somebody attested to.',
      );
    }
    const goodsTotal = (
      Number(invoice.totalAmount) - Number(invoice.deliveryFee ?? 0) - Number(invoice.otherFees ?? 0)
    ).toFixed(2);
    const validated = await validateInvoiceLines(trx, actor.orgId, lines, goodsTotal, invoice.storeId);
    await itemsRepo.deleteInvoiceLines(trx, invoiceId);
    if (validated.length > 0) await itemsRepo.insertInvoiceLines(trx, invoiceId, validated);
    return { count: validated.length };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ The approval, and what it now MEANS. Ian, 2026-08-28: *"verified means right supplier, right
 * invoice data, right items, right price all verified plus an uploaded photo of the receipt."*
 *
 * Four separate confirmations, recorded separately, because one boolean cannot say which of the
 * four a person actually looked at. `attestedItems`/`attestedPrice` are a human's judgement
 * against the photo today; when the item master lands they become machine-checkable too.
 *
 * ⛔ **Evidence is a FILE row, full stop.** The old code fell through to a plain-text
 * `receiptPhotoUrl` whenever no file was named — and the AP form only ever offered that text box,
 * so every invoice in practice was verified on a typed string, `x` included. The column is gone
 * (migration 0046). `filesRepo.getById` is what proves the evidence is real: the row exists, in
 * this org, for this store. Exempt only for a system-managed commissary mirror, which is an
 * interbranch transfer with no outside paperwork — v1's own exemption (`isCommissaryMirrorSupplier`).
 *
 * ⛔ **Two people.** `verified_by <> created_by` is enforced by the database (migration 0046) and
 * checked here for a readable error. 44% of v1's verified receipts were self-verified.
 *
 * ## ⭐ T-196 — verification posts every draft standing against the invoice
 *
 * Immediately after `markInvoiceVerified`, **inside this same transaction**: every `draft`
 * expense on the invoice, oldest first (`apRepo.liveExpensesForInvoice`'s own ordering), is
 * posted through `approveExpense` — the same primitive every other posting path uses, never a
 * reimplementation.
 *
 * ⚠️ **All or nothing, deliberately not verify-and-skip.** If any one draft cannot post — an
 * unmapped category, a closed period, an office account that would go overdrawn —
 * `approveExpense` throws, and because this whole function runs inside one transaction (either
 * the caller's `tx` or the one `transaction(run)` opens), that throw unwinds `markInvoiceVerified`
 * too: the invoice is left `pending`, not verified-with-stuck-drafts. A verified invoice that
 * still carries a draft would be a NEW orphan class — worse than the pending pile this task
 * exists to relieve, because nothing about the invoice's own status would say anything is wrong.
 * The verifier — who already proved they hold `approve_expense` — is exactly the person who can
 * see the failure and fix the coding, so the error is left to name the offending expense (it
 * always does: every `approveExpense` failure message includes the expense id) rather than being
 * swallowed and retried.
 */
export async function verifyInvoice(
  tx: Tx | null,
  actor: Actor,
  invoiceId: string,
  attestation: VerifyInvoiceAttestation,
): Promise<void> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, invoiceId);
    if (!invoice) throw new Error(`verifyInvoice: supplier invoice ${invoiceId} does not exist.`);
    await authorize(trx, actor, 'verify_supplier_invoice', { storeId: invoice.storeId });

    if (invoice.status !== 'pending') {
      throw new Error(`verifyInvoice: supplier invoice ${invoiceId} is ${invoice.status}, not pending.`);
    }

    // ⛔ Segregation of duties. The DB enforces it too; this is the sentence a human can act on.
    if (invoice.createdBy === actor.personId) {
      throw new Error(
        'verifyInvoice: you logged this invoice, so you cannot also verify it. Verification is a ' +
          'second pair of eyes — ask a manager who did not enter it, or an admin.',
      );
    }

    const missing = (Object.keys(attestation) as (keyof VerifyInvoiceAttestation)[]).filter(
      (k) => !attestation[k],
    );
    if (missing.length > 0) {
      throw new Error(
        `verifyInvoice: confirm every part of the bill before verifying it — still unconfirmed: ` +
          `${missing.join(', ')}. Verifying means you checked the supplier, the invoice details, ` +
          'the items and the prices against the photo.',
      );
    }

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, invoice.supplierId);
    if (!supplier) throw new Error(`verifyInvoice: supplier ${invoice.supplierId} does not exist.`);
    if (supplier.status !== 'active') {
      throw new Error(`verifyInvoice: ${supplier.name} is ${supplier.status}, not active.`);
    }

    const isCommissaryMirror = !!supplier.counterpartyStoreId;
    if (!isCommissaryMirror) {
      if (!invoice.receiptFileId) {
        throw new Error(
          `verifyInvoice: supplier invoice ${invoiceId} has no receipt photo — upload one before ` +
            'verifying. A photo of the paper is the evidence the whole gate rests on (DEF-055).',
        );
      }
      // ⭐ T-141's real check, not a truthiness test: the file must exist, in this org, and belong
      // to this invoice's store. A receipt from somewhere else is not evidence for this bill.
      const file = await filesRepo.getById(trx, actor.orgId, invoice.receiptFileId);
      if (!file) {
        throw new Error(
          `verifyInvoice: supplier invoice ${invoiceId} names a receipt file that does not exist in this org.`,
        );
      }
      if (file.storeId && file.storeId !== invoice.storeId) {
        throw new Error(
          `verifyInvoice: supplier invoice ${invoiceId} names a receipt belonging to another store — ` +
            'a photo from somewhere else is not evidence for this invoice.',
        );
      }
    }

    await apRepo.markInvoiceVerified(trx, actor.orgId, invoiceId, { verifiedBy: actor.personId });

    // ⭐ T-196 — post every draft standing against this invoice, oldest first, in the SAME
    // transaction as the status flip above. See this function's own doc comment for why a
    // failure here must unwind the verification rather than leaving it verified-with-stuck-drafts.
    const live = await apRepo.liveExpensesForInvoice(trx, actor.orgId, invoiceId);
    const drafts = live.filter((e) => e.status === 'draft');
    for (const d of drafts) {
      try {
        await approveExpense(trx, actor, d.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `verifyInvoice: supplier invoice ${invoiceId} cannot be verified — draft expense ${d.id} ` +
            `failed to post: ${reason}`,
        );
      }
    }
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Cascades through the live-linked expenses — sequential, fail-fast, retry-safe: if one
 * linked expense's void/delete fails, the ones already handled stay handled and the invoice is
 * not flipped. Matches `voidReceiptAction`'s exact contract.
 *
 * ## ⭐ T-196 — branches on the child's status, a defect this task's own change creates
 *
 * Before T-196, every live-linked expense here was necessarily `posted` — nothing else could
 * exist against an invoice at all — so a flat `voidExpense` loop was correct. Now a `pending`
 * invoice can carry drafts, and `voidExpense` THROWS on a draft ("nothing has been posted yet to
 * void; edit or discard it instead"). Branch on the status `apRepo.liveExpensesForInvoice` now
 * returns:
 *   - `draft`  → `deleteExpenseDraft` (row 125 — a draft is not a financial record, no entry, no
 *     balance touched, nobody asserted it; nothing to reverse).
 *   - `posted` → `voidExpense`, unchanged — a reversal entry, both entries stand.
 * Both primitives are reused rather than the delete/reverse being hand-rolled inline — `ap/index.ts`'s
 * own module comment records what happened last time a cascade was reimplemented (budget release,
 * cash-request liquidation, the expense-summary projection and a CAPEX depreciation guard all
 * silently skipped). `edit_any_expense` (what `deleteExpenseDraft` authorizes against) and
 * `void_supplier_invoice` are both manager-and-above, so the actor voiding the invoice is already
 * authorized for the delete.
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
      if (e.status === 'draft') {
        await deleteExpenseDraft(trx, actor, e.id);
      } else {
        await voidExpense(trx, actor, e.id, `Invoice voided: ${reason}`);
      }
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

    // ⛔ Lock the named expenses BEFORE reading their balances. `openItems` then decide then
    // write is check-then-act: without this, two payments naming the same open item both read it
    // as open and both post, paying the supplier twice. The lock serialises exactly those two.
    await apRepo.lockExpensesForAllocation(
      trx,
      actor.orgId,
      input.allocations.map((a) => a.expenseId),
    );

    // ⛔ Every allocation must be an OPEN item for THIS supplier AT THIS STORE — validated
    // against apRepo.openItems, never trusted from the caller. No partial apply: the whole
    // payment is rejected if any one allocation is wrong.
    //
    // ⭐ Store-scoped (Ian, 2026-08-28). An org-wide read here is the bug: every leg of this
    // payment posts at `input.storeId`, so settling another store's open item would put the 2110
    // debit on books that never carried the matching credit — one store's payables go negative
    // while the other's never clear, and neither store's trial balance shows why.
    const open = await apRepo.openItems(trx, actor.orgId, input.supplierId, input.storeId);
    const byExpense = new Map(open.map((o) => [o.expenseId, o]));
    let allocatedTotal = 0;
    for (const a of input.allocations) {
      const item = byExpense.get(a.expenseId);
      if (!item) {
        throw new Error(
          `recordPayment: expense ${a.expenseId} is not an open item for this supplier at this ` +
            'store — it may belong to another supplier or another store, not be a credit expense, ' +
            'already be fully paid, or not be posted.',
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
