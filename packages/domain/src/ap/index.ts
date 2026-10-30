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
import { advisoryLocksRepo, apRepo, auditLogRepo, cashRequestsRepo, itemsRepo, journalRepo, expensesRepo, filesRepo, moneyAccountsRepo, personsRepo, storesRepo, type Tx } from '@shareat/db';
import type {
  SupplierClassification,
  SupplierInvoiceVatType,
  SupplierStatus,
  SupplierVatStatus,
} from '@shareat/db/schema';
import type { PeriodOverrideReason } from '@shareat/db/schema';
import { authorize, can, type Actor } from '@shareat/auth';
import { add, compare, formatMoney, isZero, money, subtract, ZERO, type Money } from '@shareat/core/money';
import { addDays, parseBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { postEntry } from '../ledger/post-entry';
import { postEntryOnce, requireRequestId } from '../ledger/replay';
import { withInterStoreLegs } from '../ledger/inter-store';
import { reverseEntry } from '../ledger/reverse-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';
import { gone, humanDate, internalFault, refuse } from '../shared/refusal';
import { checkField } from '../field-rules/check';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SUPPLIER_ADD_RULES } from '../field-rules/ap';
import { allocateOldestFirst, type AllocationItem, type TypedAmount } from '../shared/allocate-oldest-first';
import {
  attestationCheck,
  attestationValues,
  buildReceiptFacts,
  buildSupplierFacts,
  buildVerifySupplierFacts,
  draftsWouldPostCheck,
  dueNotBeforeInvoiceCheck,
  duplicateNumberCheck,
  duplicateSavedAnywayFlash,
  feesNotOverTotalCheck,
  receiptPhotoCheck,
  selfVerifyCheck,
  supplierActiveCheck,
  vatCheck,
  verifySupplierActiveCheck,
} from '../business-rules';
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

  /**
   * T-362 / DEF-495 — R1: `null` means cash-on-delivery; `0` to `365` means credit (0 is legal:
   * on credit, due on the invoice date). The value is RAW here and parsed by `judgeCreditTerms`
   * after `authorize` (R2, the DEF-478 / T-352 / T-360 shape) — never judged at the call site.
   *
   * `UnrecognisedTermsMode` (audit finding F1, 2026-09-29): a caller mapping a `termsMode` selector
   * outside `{cod, credit}` (R4) passes this instead of a bare string. A bare string could not
   * distinguish "an unrecognised MODE" from "a real day-count box that happens to read the same
   * digits" — `termsMode='30'` with no `creditTermsDays` field was silently accepted as 30 days,
   * because the string `'30'` is indistinguishable from a genuine 30-day entry once it reaches this
   * function. The wrapper is a structural marker, not a value the caller validates: the action still
   * judges nothing about whether a NUMBER is in range (R4's "judges nothing" holds), it only flags
   * that the mode itself was unrecognised — the same distinction the action already makes to route
   * `cod`/`credit`/other in the first place.
   */
  creditTermsDays?: number | string | null | UnrecognisedTermsMode;
}

/** See `CreateSupplierInput.creditTermsDays`'s own comment (audit finding F1, 2026-09-29). */
export interface UnrecognisedTermsMode {
  readonly unrecognisedTermsMode: string;
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
  /** T-391 S4: the audit source of the status row. A screen leaves it out (web); the master-data load passes 'etl'. */
  source?: 'web' | 'etl';
}

/** Trim to null so an emptied field clears rather than storing `''`. */
function orNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v?.trim() || null;
}

/** T-440: the blank-name sentence is the supplier rule set's own, the very line the add form shows (one sentence, two places). */
function nameRequirement(): string {
  const c = checkField(SUPPLIER_ADD_RULES.name, '');
  return c.ok ? 'A supplier needs a name people will recognise.' : c.requirement;
}

/** The days-to-pay rule as a one-rule set: the SAME definition the add form's live check reads (T-440, one sentence in two places). */
const TERMS_RULE_SET = { form: SUPPLIER_ADD_RULES.form, creditTermsDays: SUPPLIER_ADD_RULES.creditTermsDays };
/** Something that is never a number of days, for the F1 marker (an unrecognised terms MODE is refused whatever digits it spells). */
const NOT_A_NUMBER_OF_DAYS = 'unrecognised';

/**
 * T-362 / DEF-495 — R2: judges a supplier's raw `creditTermsDays` box. `null`/`undefined` (the key absent, or explicitly cleared)
 * means cash-on-delivery. `0` is legal and means "on credit, due on the invoice date" (R1) — never coerced into "no credit".
 * T-440: the value rule (a whole number, 0 to 365) is `SUPPLIER_ADD_RULES.creditTermsDays` — the one the screen shows live — not
 * a second parser. A blank credit box uses the rule's required sentence (S9 B); null still means COD and the F1 marker
 * still refuses an unrecognised mode.
 * The database CHECK (`0141:47-48`) stays the backstop (RULES §6.3).
 */
function judgeCreditTerms(
  raw: number | string | null | undefined | UnrecognisedTermsMode,
  fn: string,
): number | null {
  if (raw === null || raw === undefined) return null;
  let text: string;
  if (typeof raw === 'object') text = NOT_A_NUMBER_OF_DAYS;
  else if (typeof raw === 'number') text = String(raw);
  else {
    text = raw.trim();
  }
  const days = assertFieldRules(TERMS_RULE_SET, { creditTermsDays: text }).creditTermsDays;
  return days === null || days === undefined ? null : Number(days);
}

export async function createSupplier(
  tx: Tx,
  actor: Actor,
  input: CreateSupplierInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});
    const name = input.name.trim();
    if (!name) throw refuse('createSupplier: a supplier needs a name people will recognise.', nameRequirement());
    const creditTermsDays = judgeCreditTerms(input.creditTermsDays, 'createSupplier');
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
      creditTermsDays: creditTermsDays ?? null,
    });
  };
  return run(tx);
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
 *
 * T-362 / DEF-495 — a real change to `creditTermsDays` is audited in `audit_log` (R3), since it
 * decides whether AP credit may be booked against this supplier. T-365 / DEF-498 — a real change
 * to any of the three bank fields is audited too, same transaction, full before/after triple.
 */
export async function editSupplier(
  tx: Tx,
  actor: Actor,
  input: EditSupplierInput,
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});

    const existing = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!existing) {
      throw gone(`editSupplier: supplier ${input.supplierId} does not exist.`, 'supplier');
    }

    const values: Parameters<typeof apRepo.updateSupplier>[3] = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw refuse('editSupplier: a supplier needs a name people will recognise.', nameRequirement());
      values.name = name;
    }
    // T-362 / DEF-495 — R2's order: authorize -> gone -> name -> TERMS -> the other fields.
    let creditTermsDays: number | null | undefined;
    if (input.creditTermsDays !== undefined) {
      creditTermsDays = judgeCreditTerms(input.creditTermsDays, 'editSupplier');
      values.creditTermsDays = creditTermsDays;
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

    // T-362 / DEF-495 — R3: audited in the table that already exists, same transaction, only on a
    // real change (the `setChannelPayoutDestination` precedent, `channel-settlements/index.ts:738`).
    // It decides whether AP credit may be booked against this supplier, so it is a control.
    if (creditTermsDays !== undefined && creditTermsDays !== existing.creditTermsDays) {
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'set_supplier_credit_terms',
        storeId: null,
        entityId: input.supplierId,
        before: { creditTermsDays: existing.creditTermsDays },
        after: { creditTermsDays },
        // The ERP screen is this function's only caller today; a second front-end must thread its
        // own source through, not inherit this one (same comment as the precedent).
        source: 'web',
      });
    }

    // T-391 S4 (P7, P12): a REAL status change is audited (before/after), same transaction.
    if (input.status !== undefined && input.status !== existing.status) {
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'set_supplier_status',
        storeId: null,
        entityId: input.supplierId,
        before: { status: existing.status },
        after: { status: input.status },
        source: input.source ?? 'web',
      });
    }

    // T-365 / DEF-498 — R1/R2: one `set_supplier_bank_account` row per edit that REALLY changes
    // where money goes, judged on the WRITTEN value (reusing `values`' already-normalised bank
    // keys, not renormalising), never on the raw input. Full before/after triple even when only
    // one field changed, so a row reads on its own. After the terms append (R1's ordering).
    const bankBefore = {
      bankName: existing.bankName,
      bankAccountName: existing.bankAccountName,
      bankAccountNumber: existing.bankAccountNumber,
    };
    const bankAfter = {
      bankName: input.bankName !== undefined ? values.bankName ?? null : bankBefore.bankName,
      bankAccountName:
        input.bankAccountName !== undefined ? values.bankAccountName ?? null : bankBefore.bankAccountName,
      bankAccountNumber:
        input.bankAccountNumber !== undefined ? values.bankAccountNumber ?? null : bankBefore.bankAccountNumber,
    };
    if (
      bankBefore.bankName !== bankAfter.bankName ||
      bankBefore.bankAccountName !== bankAfter.bankAccountName ||
      bankBefore.bankAccountNumber !== bankAfter.bankAccountNumber
    ) {
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'set_supplier_bank_account',
        storeId: null,
        entityId: input.supplierId,
        before: bankBefore,
        after: bankAfter,
        source: 'web',
      });
    }
  };
  return run(tx);
}

/**
 * T-391 S4 (P5). The commissary mirror: a supplier that IS one of our own stores. `counterparty_store_id` is
 * system-managed (createSupplier does not take it), so this is its one named, audited writer. Gated on
 * `approve_supplier`; a store of another organisation is refused.
 */
export async function setSupplierCounterpartyStore(
  tx: Tx,
  actor: Actor,
  input: { supplierId: string; storeId: string; source?: 'web' | 'etl' },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});
    const existing = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!existing) throw gone(`setSupplierCounterpartyStore: supplier ${input.supplierId} does not exist.`, 'supplier');
    const store = await storesRepo.getById(trx, actor.orgId, input.storeId);
    if (!store) {
      throw refuse(
        `setSupplierCounterpartyStore: store ${input.storeId} is not a store of this organisation.`,
        'That store does not belong to this organisation, so a supplier cannot be linked to it.',
      );
    }
    if (existing.counterpartyStoreId === input.storeId) return;
    await apRepo.updateSupplier(trx, actor.orgId, input.supplierId, { counterpartyStoreId: input.storeId });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'set_supplier_counterparty_store',
      storeId: null,
      entityId: input.supplierId,
      before: { counterpartyStoreId: existing.counterpartyStoreId },
      after: { counterpartyStoreId: input.storeId },
      source: input.source ?? 'web',
    });
  };
  return run(tx);
}

/**
 * ⭐ Stamp the reconciliation anchor — same shape as `reconcileCustomer`
 * (`packages/domain/src/customers`). An attestation, not a balance; refused while the supplier
 * still shows a real `2110` outstanding.
 */
export async function reconcileSupplier(
  tx: Tx,
  actor: Actor,
  input: { supplierId: string; asOf: string },
): Promise<{ balanceAtStamp: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});
    const supplier = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!supplier) throw gone(`reconcileSupplier: supplier ${input.supplierId} does not exist.`, 'supplier');

    const position = await apRepo.positionOf(trx, actor.orgId, supplier.id);
    // T-371 (R4, C4): the live balance re-minted and judged exactly — `Number(…)` let a NaN read as "zero owed".
    if (!isZero(money(position.controlBalance))) {
      throw refuse(
        `reconcileSupplier: this supplier is owed ₱${position.controlBalance}. An anchor says ` +
          `they were verified at ZERO on a date, so stamping one now would tell every later aging ` +
          `report that a live obligation was settled.`,
        `This supplier is owed ₱${position.controlBalance}. An anchor says they were verified at ` +
          'ZERO on a date, so stamping one now would tell every later aging report that a live ' +
          'obligation was settled.',
      );
    }

    await apRepo.updateSupplier(trx, actor.orgId, supplier.id, {
      reconciledAsOf: input.asOf,
      reconciledAt: new Date(),
      reconciledBy: actor.personId,
    });
    return { balanceAtStamp: position.controlBalance };
  };
  return run(tx);
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
  /** T-408 R1: `'supplier_default'` resolves on the server from the supplier's `vat_status`; omitted/null stays null. */
  vatType?: SupplierInvoiceVatType | 'supplier_default' | null;
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
  tx: Tx,
  actor: Actor,
  input: RecordInvoiceInput,
): Promise<RecordInvoiceResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_supplier_invoice', { storeId: input.storeId });

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!supplier) throw gone(`recordInvoice: supplier ${input.supplierId} does not exist.`, 'supplier');
    // ⭐ Ian, 2026-08-28, requirement 1: the supplier must be EXISTING **and ACTIVE**. A v2
    // tightening — v1's `upsertReceiptAction` checks only that the supplier document exists
    // (`receipt.actions.ts`), so an inactive supplier can still be billed against there. An
    // inactive supplier is one the business has stopped buying from; a new bill from one is
    // either a mistake or something worth a second look, and neither should post quietly.
    // T-475: the sentence lives in the shared rule leaf, so the form's live line and this refusal read the same.
    const supplierFacts = buildSupplierFacts([supplier]);
    const inactive = supplierActiveCheck.run(supplierFacts, { supplierId: supplier.id });
    if (inactive) throw refuse(`recordInvoice: ${inactive.sentence}`, inactive.sentence);

    // T-367 S3 (DEF-420, R8): every money input is parsed ONCE, here, and the row is written from the PARSED
    // values - a typed `abc` or `NaN` used to reach the database (22P02 / 23514) and a non-numeric fee became NaN.
    const total = parseMoneyInput(input.totalAmount, 'recordInvoice: the invoice total', 'The invoice total');
    if (compare(total, ZERO) <= 0) throw refuse('recordInvoice: an invoice total has to be greater than zero.', 'An invoice total has to be greater than zero.');
    // A fee is blank or a non-negative amount: `abc` is the parser's sentence, `-50` is refused here.
    // T-371 R6: both fee columns are NOT NULL DEFAULT '0', so a blank fee is `undefined` (the column's default decides),
    // never an invented zero; the arithmetic below reads a blank fee as nothing added.
    const feeOf = (raw: string | null | undefined, rawLabel: string, humanLabel: string): Money | undefined => {
      const fee = parseDecimalInput(raw, '14,2', rawLabel, humanLabel, { blank: 'omit' });
      if (fee !== undefined && compare(fee, ZERO) < 0) throw refuse(`${rawLabel} is negative.`, `${humanLabel} can't be less than zero.`);
      return fee;
    };
    const deliveryFee = feeOf(input.deliveryFee, 'recordInvoice: the delivery fee', 'The delivery fee');
    const otherFees = feeOf(input.otherFees, 'recordInvoice: the other fees', 'The other fees');
    // T-151: the fees are part of the invoice total but are NOT lines, so the lines are checked against the goods.
    // Two fees can together leave the `numeric(14,2)` range, which `subtract` reports as a RangeError - a refusal here.
    const feesVerdict = feesNotOverTotalCheck.run(undefined, {
      totalAmount: input.totalAmount,
      deliveryFee: input.deliveryFee ?? '',
      otherFees: input.otherFees ?? '',
    });
    if (feesVerdict) throw refuse('recordInvoice: the delivery and other fees exceed the invoice total.', feesVerdict.sentence);
    const goodsTotal = subtract(subtract(total, deliveryFee ?? ZERO), otherFees ?? ZERO);
    // T-371 (R6): the three VAT columns are nullable, so a blank is null; a typed figure is parsed to its column's shape
    // (`vat_rate` is numeric(8,4)) instead of reaching the database raw.
    const vatRate = parseDecimalInput(input.vatRate, '8,4', 'recordInvoice: the VAT rate', 'The VAT rate', { blank: 'null' });
    const vatAmount = parseDecimalInput(input.vatAmount, '14,2', 'recordInvoice: the VAT amount', 'The VAT amount', { blank: 'null' });
    const vatExclusiveAmount = parseDecimalInput(
      input.vatExclusiveAmount,
      '14,2',
      'recordInvoice: the VAT-exclusive amount',
      'The VAT-exclusive amount',
      { blank: 'null' },
    );

    // T-408 R1-R3: VAT is a LABEL typed from the paper (bible row 75), never computed at 12%. Every refusal is
    // thrown here, before the first write. `vat_rate` is never written and the exclusive figure is derived.
    const vatType: SupplierInvoiceVatType | null =
      input.vatType === 'supplier_default'
        ? supplier.vatStatus === 'vat_registered'
          ? 'vatable'
          : supplier.vatStatus === 'non_vat'
            ? 'non_vat'
            : null
        : (input.vatType ?? null);
    if (vatType !== null && !['vatable', 'zero_rated', 'exempt', 'non_vat'].includes(vatType)) {
      throw refuse(`recordInvoice: unknown VAT type "${String(vatType)}".`, "That VAT type isn't one we know.");
    }
    // T-475: the whole VAT family (non-VAT supplier, vatable needs an amount, zero-rated has none, an amount only with
    // vatable) is ONE check in the rule leaf; its sentence is the form's live line and this refusal.
    const vatVerdict = vatCheck.run(supplierFacts, {
      supplierId: supplier.id,
      vatType: input.vatType ?? '',
      vatAmount: input.vatAmount ?? '',
      totalAmount: input.totalAmount,
    });
    if (vatVerdict) throw refuse(`recordInvoice: ${vatVerdict.sentence}`, vatVerdict.sentence);
    let storedVatAmount: Money | null = null;
    let storedVatExclusive: Money | null = null;
    if (vatType === 'vatable') {
      storedVatAmount = vatAmount!;
      storedVatExclusive = subtract(total, vatAmount!);
    } else if (vatType === 'zero_rated') {
      storedVatAmount = ZERO;
      storedVatExclusive = total;
    }
    // The caller may not contradict what the server derived (refused, not overwritten): `vat_rate` is always null,
    // and the exclusive figure is whatever the derivation says.
    if (vatRate !== null) {
      throw refuse('recordInvoice: a VAT rate is not recorded; it was sent anyway.', "A VAT rate isn't recorded on a bill. Remove it.");
    }
    if (vatExclusiveAmount !== null && (storedVatExclusive === null || compare(vatExclusiveAmount, storedVatExclusive) !== 0)) {
      throw refuse(
        'recordInvoice: the VAT-exclusive amount sent disagrees with total minus VAT.',
        "The VAT-exclusive amount doesn't match the total minus the VAT. It is worked out for you, so leave it blank.",
      );
    }

    // T-367 S3 (DEF-499, R9): the due date. A malformed date is a sentence, not a raw throw (DEF-566: a raw throw
    // is a digest page in production). A blank due date takes the supplier's terms, COPIED at recording time (never
    // read through - changing the terms later must not rewrite an existing bill); cash on delivery (null terms)
    // stays null and T-330's ordering falls back to the invoice date.
    let invoiceDate: BusinessDate;
    try {
      invoiceDate = parseBusinessDate(input.invoiceDate.trim());
    } catch {
      throw refuse('recordInvoice: the invoice date is not a real date.', "The invoice date isn't a real date.");
    }
    const dueRaw = input.dueDate?.trim() || null;
    let dueDate: BusinessDate | null = null;
    if (dueRaw) {
      try {
        dueDate = parseBusinessDate(dueRaw);
      } catch {
        throw refuse('recordInvoice: the due date is not a real date.', "The due date isn't a real date.");
      }
      const dueVerdict = dueNotBeforeInvoiceCheck.run(undefined, { invoiceDate, dueDate: dueRaw });
      if (dueVerdict) throw refuse('recordInvoice: the due date is before the invoice date.', dueVerdict.sentence);
    } else if (supplier.creditTermsDays != null) {
      dueDate = addDays(invoiceDate, supplier.creditTermsDays);
    }

    let duplicateWarning: string | undefined;
    const invoiceNo = input.invoiceNo?.trim() || null;
    if (invoiceNo) {
      const duplicates = await apRepo.findDuplicateInvoices(trx, actor.orgId, {
        supplierId: input.supplierId,
        invoiceNo,
      });
      // T-475 Q1: still a WARNING, never a block. The live line and this flash share the leaf's words.
      const repeated = duplicateNumberCheck.run(
        {
          supplierName: supplier.name,
          invoiceNo,
          supplierId: input.supplierId,
          matches: duplicates.map((d) => ({ invoiceDate: d.invoiceDate, totalAmount: d.totalAmount })),
        },
        { invoiceNo, supplierId: input.supplierId },
      );
      if (repeated) duplicateWarning = duplicateSavedAnywayFlash(repeated.sentence);
    }

    const created = await apRepo.insertSupplierInvoice(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      supplierId: input.supplierId,
      invoiceNo,
      invoiceDate,
      dueDate,
      totalAmount: total,
      // T-371 R13: a blank fee is OMITTED, so the column's own default applies (the writer's fields are optional).
      deliveryFee,
      otherFees,
      notes: input.notes?.trim() || null,
      receiptFileId: input.receiptFileId ?? null,
      vatType,
      vatRate: null,
      vatAmount: storedVatAmount,
      vatExclusiveAmount: storedVatExclusive,
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
    // against the goods portion (`goodsTotal`, above). Ian, 2026-08-28: inbound freight is added to the item's price,
    // which happens in the landed-cost derivation, not by inventing a line for it here.
    const lines = await validateInvoiceLines(trx, actor.orgId, input.lines ?? [], String(goodsTotal), input.storeId);
    if (lines.length > 0) await itemsRepo.insertInvoiceLines(trx, created.id, lines);

    return { id: created.id, ...(duplicateWarning ? { duplicateWarning } : {}) };
  };
  return run(tx);
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

/** Human labels for `VerifyInvoiceAttestation`'s own keys — never the literal key in a sentence. */

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
  tx: Tx,
  actor: Actor,
  invoiceId: string,
  lines: InvoiceLineDraft[],
): Promise<{ count: number }> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, invoiceId);
    if (!invoice) throw gone(`setInvoiceLines: supplier invoice ${invoiceId} does not exist.`, 'supplier invoice');
    await authorize(trx, actor, 'record_supplier_invoice', { storeId: invoice.storeId });
    if (invoice.status !== 'pending') {
      throw refuse(
        `setInvoiceLines: invoice ${invoiceId} is ${invoice.status}. Lines can only be changed ` +
          'while it is still pending — after verification they are what somebody attested to.',
        `This invoice is ${invoice.status}. Lines can only be changed while it is still pending — after verification they are what somebody attested to.`,
      );
    }
    // T-367 S3 (R8): the goods total in `Money`, never `Number` - the same figure `recordInvoice` checked its lines against.
    const goodsTotal = subtract(
      subtract(money(invoice.totalAmount), money(invoice.deliveryFee ?? '0')),
      money(invoice.otherFees ?? '0'),
    );
    const validated = await validateInvoiceLines(trx, actor.orgId, lines, String(goodsTotal), invoice.storeId);
    await itemsRepo.deleteInvoiceLines(trx, invoiceId);
    if (validated.length > 0) await itemsRepo.insertInvoiceLines(trx, invoiceId, validated);
    return { count: validated.length };
  };
  return run(tx);
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
 *
 * ## T-376 S1 — a closed month is posted through the override
 *
 * `options.periodOverride` is passed to `approveExpense` for EVERY draft (one `period_overrides` row per entry).
 * `approveExpense` forwards it only when that draft's month is `closed`; `postEntry` authorises
 * `override_period_lock` against `actor`. Without the override a closed month refuses in `approveExpense`'s words.
 */
export async function verifyInvoice(
  tx: Tx,
  actor: Actor,
  invoiceId: string,
  attestation: VerifyInvoiceAttestation,
  options?: { periodOverride?: { reason: PeriodOverrideReason; note?: string | null } },
): Promise<void> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, invoiceId);
    if (!invoice) throw gone(`verifyInvoice: supplier invoice ${invoiceId} does not exist.`, 'supplier invoice');
    await authorize(trx, actor, 'verify_supplier_invoice', { storeId: invoice.storeId });

    if (invoice.status !== 'pending') {
      throw refuse(
        `verifyInvoice: supplier invoice ${invoiceId} is ${invoice.status}, not pending.`,
        `This invoice is ${invoice.status}, not pending.`,
      );
    }

    // ⛔ Segregation of duties. The DB enforces it too; this is the sentence a human can act on.
    // T-475 S3 (R4): the self-verify flag comes ONLY from this `can()` - never from a caller argument, form field or option.
    // `can()`, not `authorize()`: a manager asking is an ordinary answer, not an attempted act (no denial row).
    const createdByViewer = invoice.createdBy === actor.personId;
    const selfVerified = createdByViewer && (await can(trx, actor, 'verify_own_supplier_invoice'));
    const selfVerify = selfVerified ? null : selfVerifyCheck.run({ createdByViewer }, {});
    if (selfVerify) {
      throw refuse(
        'verifyInvoice: you logged this invoice, so you cannot also verify it (Verification is a second pair of eyes).',
        selfVerify.sentence,
      );
    }

    // T-475: the four ticks are one check in the rule leaf (fixed label order), shared with the verify form's live line.
    const unticked = attestationCheck.run(undefined, attestationValues(attestation));
    if (unticked) {
      const missing = (Object.keys(attestation) as (keyof VerifyInvoiceAttestation)[]).filter((k) => !attestation[k]);
      throw refuse(`verifyInvoice: confirm every part of the bill before verifying it - still unconfirmed: ${missing.join(', ')}.`, unticked.sentence);
    }

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, invoice.supplierId);
    if (!supplier) throw gone(`verifyInvoice: supplier ${invoice.supplierId} does not exist.`, 'supplier');
    const inactive = verifySupplierActiveCheck.run(buildVerifySupplierFacts(supplier), {});
    if (inactive) throw refuse(`verifyInvoice: ${inactive.sentence}`, inactive.sentence);

    // ⭐ T-141's real check, not a truthiness test: the file must exist, in this org, and belong to this invoice's store.
    // A receipt from somewhere else is not evidence for this bill. A commissary mirror has no paper to photograph.
    const receiptFile =
      invoice.receiptFileId && !supplier.counterpartyStoreId ? await filesRepo.getById(trx, actor.orgId, invoice.receiptFileId) : null;
    const noReceipt = receiptPhotoCheck.run(
      buildReceiptFacts({
        counterpartyStoreId: supplier.counterpartyStoreId ?? null,
        receiptFileId: invoice.receiptFileId ?? null,
        invoiceStoreId: invoice.storeId,
        file: receiptFile,
      }),
      {},
    );
    if (noReceipt) throw refuse(`verifyInvoice: supplier invoice ${invoiceId}: ${noReceipt.sentence} (DEF-055)`, noReceipt.sentence);

    await apRepo.markInvoiceVerified(trx, actor.orgId, invoiceId, { verifiedBy: actor.personId, selfVerified });

    // ⭐ T-196 — post every draft standing against this invoice, oldest first, in the SAME
    // transaction as the status flip above. See this function's own doc comment for why a
    // failure here must unwind the verification rather than leaving it verified-with-stuck-drafts.
    const live = await apRepo.liveExpensesForInvoice(trx, actor.orgId, invoiceId);
    const drafts = live.filter((e) => e.status === 'draft');
    for (const d of drafts) {
      try {
        await approveExpense(trx, actor, d.id, { periodOverride: options?.periodOverride });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const innerUserMessage = err instanceof Error ? (err as { userMessage?: unknown }).userMessage : undefined;
        // Rewrap: keeps the inner userMessage (rule 5) rather than re-deriving one from `.message`.
        // ⚠️ Presentable, not `instanceof RefusalError` — `AuthorizationError` (e.g. S2's
        // `transfer_funds` refusal on a cross-store draw inside `approveExpense`) carries a
        // `userMessage` too and is not a `RefusalError`; the same `isPresentable`-shaped check
        // `apps/erp/src/lib/error-shape.ts` uses (including its `instanceof Error` guard, so a
        // thrown non-Error can't TypeError here), duplicated since domain cannot import it.
        // T-475: the sentence is the shared V5 frame - the draft is NAMED, and the verify form's live line says the same words.
        // (If the failed posting left the transaction unusable the name cannot be read: the frame then says "a draft expense".)
        let particulars = 'a draft expense';
        try {
          particulars = (await expensesRepo.getExpenseById(trx, actor.orgId, d.id))?.particulars ?? particulars;
        } catch {
          // keep the generic name
        }
        const framed =
          typeof innerUserMessage === 'string' && innerUserMessage.trim() !== ''
            ? draftsWouldPostCheck.run({ drafts: [{ particulars, sentence: innerUserMessage }] }, {})
            : null;
        throw refuse(
          `verifyInvoice: supplier invoice ${invoiceId} cannot be verified — draft expense ${d.id} ` +
            `failed to post: ${reason}`,
          framed?.sentence ?? 'This invoice could not be verified — posting one of its draft expenses failed. Check the draft and try again.',
        );
      }
    }
    // T-402 S3 (C4): the verification step's event, same transaction, after the flip and the drafts it posted.
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'ap_invoice.approved',
      storeId: invoice.storeId,
      entityId: invoiceId,
      before: { status: 'pending' },
      after: { status: 'verified', draftsPosted: drafts.length },
      source: 'web',
    });
    // T-475 S3: the second event, only for a self-verify - same transaction, after the first.
    if (selfVerified) {
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'ap_invoice.self_verified',
        storeId: invoice.storeId,
        entityId: invoiceId,
        before: { selfVerified: false },
        after: { selfVerified: true },
        source: 'web',
      });
    }
  };
  return run(tx);
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
  tx: Tx,
  actor: Actor,
  input: { invoiceId: string; reason: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const invoice = await apRepo.getSupplierInvoiceById(trx, actor.orgId, input.invoiceId);
    if (!invoice) throw gone(`voidInvoice: supplier invoice ${input.invoiceId} does not exist.`, 'supplier invoice');
    await authorize(trx, actor, 'void_supplier_invoice', { storeId: invoice.storeId });

    // ⛔ T-367 S2 / R4 (DEF-396) — lock BEFORE reading live expenses or flipping status: a
    // concurrent `createExpense`/`approveExpense` on this SAME invoice (lockInvoiceForRecording)
    // or another voidInvoice now serialises here instead of both racing past a stale read.
    const locked = await apRepo.lockInvoiceForUpdate(trx, actor.orgId, input.invoiceId);
    if (!locked) throw gone(`voidInvoice: supplier invoice ${input.invoiceId} does not exist.`, 'supplier invoice');
    // ⭐ Re-read AFTER the lock: a concurrent void that committed while we queued makes this stale
    // otherwise, and the cascade below must never run twice for the same invoice.
    if (locked.status === 'voided') {
      throw refuse(
        `voidInvoice: supplier invoice ${input.invoiceId} is already voided.`,
        'This invoice is already voided.',
      );
    }

    const reason = input.reason.trim();
    if (!reason) throw refuse('voidInvoice: say why this invoice is being voided.', 'Say why this invoice is being voided.');

    const live = await apRepo.liveExpensesForInvoice(trx, actor.orgId, input.invoiceId);
    // ⛔ R4 — lock every live expense BEFORE the cascade, in id order (lockExpensesForAllocation's
    // own ordering rule), so a concurrent recordPayment/voidExpense on one of these rows serialises
    // instead of racing the cascade below.
    await apRepo.lockExpensesForAllocation(trx, actor.orgId, live.map((e) => e.id));
    for (const e of live) {
      if (e.status === 'draft') {
        await deleteExpenseDraft(trx, actor, e.id);
      } else {
        // ⛔ R6 (DEF-519) may refuse HERE, inside voidExpense, if this live expense has already
        // been paid — the cascade stops, and nothing voided so far is undone because nothing
        // commits until this whole transaction does.
        await voidExpense(trx, actor, e.id, `Invoice voided: ${reason}`);
      }
    }

    await apRepo.markInvoiceVoided(trx, actor.orgId, input.invoiceId, {
      voidedBy: actor.personId,
      voidReason: reason,
    });
  };
  return run(tx);
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
  /** T-376 S1: post into a CLOSED month. Authorised inside `postEntry` against `actor`; ignored for an open month. */
  periodOverride?: { reason: PeriodOverrideReason; note?: string | null };
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
 *
 * T-361 / DEF-492 — the cash-on-delivery rule reaches this function through `createExpense`,
 * which it calls below; there is no separate copy of it here.
 */
export async function recordExpenseForInvoice(
  tx: Tx,
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
    const approved = await approveExpense(trx, actor, expenseId, { periodOverride: input.periodOverride });
    return { expenseId, ...approved };
  };
  return run(tx);
}

// -------------------------------------------------------------------------------------
// AP payments — settling a supplier against named open items
// -------------------------------------------------------------------------------------

/** R4.7 — org-scoped: an expenseId from another org (or none at all) yields no row, and the
 *  sentence falls back to the deictic "this expense" rather than a name from another org
 *  (rule 7 / Invariant 6). One refusal-path read, only when a naming is actually needed.
 *  ⚠️ rule 6 — never lets a naming lookup's own failure break the refusal it decorates: any
 *  error here (a bad businessDate, a dropped connection) falls back to the same deictic phrase. */
async function expenseKey(trx: Tx, orgId: string, expenseId: string): Promise<string> {
  try {
    const expense = await expensesRepo.getExpenseById(trx, orgId, expenseId);
    return expense ? `"${expense.particulars}" (${humanDate(parseBusinessDate(expense.businessDate))})` : 'this expense';
  } catch {
    return 'this expense';
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface ApPaymentAllocationInput {
  expenseId: string;
  amountApplied: string;
}

export interface RecordApPaymentInput {
  /**
   * DEF-778: generated when the form renders and submitted back. It IS the `ap_payments` row's id and the journal key is
   * `ap_payment:${requestId}:post`, so a double click is a replay (the first result comes back, nothing is posted twice).
   * A missing or non-uuid value is refused; a replay with other figures is refused.
   */
  requestId: string;
  storeId: string;
  supplierId: string;
  businessDate: string;
  /** The TOTAL handed over — allocated + unallocated (overpayment). */
  amount: string;
  moneyAccountId: string;
  /**
   * ⭐ T-170 §5: `1240`'s twin as a FUNDING source, not only an overpayment destination. Drawn
   * down from the supplier's existing return credit (`apRepo.advancesPositionOf`) BEFORE the
   * money account covers the rest — `0` (the default) leaves this payment exactly as it was
   * before T-170. When `creditApplied` covers the whole `amount`, the money-account leg is a
   * zero-amount line and is omitted (same omission rule the overpayment leg already follows);
   * `moneyAccountId` stays required regardless (ADR-010 — always a real account, never a label),
   * even though no draw happens against it that day.
   */
  creditApplied?: string;
  /** T-415: the released cash request this payment draws on. Required when `moneyAccountId` is a staff cash (1120)
   *  account and cash leaves it; refused for any other account. The request is locked and its live balance checked. */
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
  tx: Tx,
  actor: Actor,
  input: RecordApPaymentInput,
): Promise<RecordApPaymentResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_ap_payment', { storeId: input.storeId });
    const requestId = requireRequestId('recordPayment', input.requestId);

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, input.supplierId);
    if (!supplier) throw gone(`recordPayment: supplier ${input.supplierId} does not exist.`, 'supplier');

    // T-371 (C4): every figure below stays `Money` and is ordered with `compare` — `Number(…)` let a NaN pass each check.
    const amount = parseMoneyInput(input.amount, 'recordPayment: the amount', 'The payment amount');

    // DEF-778: a replay is looked up BEFORE the open-item and balance checks. After the first call committed, the item may be
    // fully paid and the account lower, so judging the same request afresh would refuse a harmless double click.
    const replayed = await apRepo.getApPaymentById(trx, actor.orgId, requestId);
    if (replayed) return replayOfPayment(trx, replayed, input, amount);
    if (compare(amount, ZERO) <= 0) throw refuse('recordPayment: a payment has to be greater than zero.', 'A payment has to be greater than zero.');
    if (input.allocations.length === 0) {
      throw refuse(
        'recordPayment: name at least one open item this payment settles (bible §16.10 — a ' +
          'payment must never float unallocated).',
        'Name at least one open item this payment settles — a payment must never float unallocated.',
      );
    }

    // DEF-272: parsed here, once, so every downstream use — the balance check and the row this
    // payment writes — sees the same validated value, never the raw form.
    const allocations = input.allocations.map((a) => {
      // T-343 S5.5n / DEF-459 — logged before rethrowing: a malformed allocation amount is a
      // real-world typo worth seeing in the logs, not only on the screen the throw already reaches.
      let amountApplied: ReturnType<typeof parseMoneyInput>;
      try {
        amountApplied = parseMoneyInput(
          a.amountApplied,
          `recordPayment: the allocation for expense ${a.expenseId}`,
          'An amount applied to an invoice',
        );
      } catch (err) {
        logger.info({ err }, 'recordPayment: malformed allocation amount');
        throw err;
      }
      return { expenseId: a.expenseId, amountApplied };
    });

    // ⛔ Lock the named expenses BEFORE reading their balances. `openItems` then decide then
    // write is check-then-act: without this, two payments naming the same open item both read it
    // as open and both post, paying the supplier twice. The lock serialises exactly those two.
    await apRepo.lockExpensesForAllocation(
      trx,
      actor.orgId,
      allocations.map((a) => a.expenseId),
    );

    // ⛔ Every allocation must be an OPEN item for THIS supplier AT THIS STORE — validated
    // against apRepo.openItems, never trusted from the caller. No partial apply: the whole
    // payment is rejected if any one allocation is wrong.
    //
    // ⭐ Store-scoped (Ian, 2026-08-28). An org-wide read here is the bug: every leg of this
    // payment posts at `input.storeId`, so settling another store's open item would put the 2110
    // debit on books that never carried the matching credit — one store's payables go negative
    // while the other's never clear, and neither store's trial balance shows why.
    // DEF-778: a simultaneous double submit queued on the lock above; the first has committed by now, so look again before
    // judging the open items it just used up.
    const replayedAfterLock = await apRepo.getApPaymentById(trx, actor.orgId, requestId);
    if (replayedAfterLock) return replayOfPayment(trx, replayedAfterLock, input, amount);
    const open = await apRepo.openItems(trx, actor.orgId, input.supplierId, input.storeId);
    const byExpense = new Map(open.map((o) => [o.expenseId, o]));
    let allocatedTotal: Money = ZERO;
    for (const a of allocations) {
      const item = byExpense.get(a.expenseId);
      if (!item) {
        // ⚠️ Never named — this branch means the id is not in THIS STORE's open items, and
        // `expenseKey`'s lookup is org-scoped only (R4.7), so a real expense here could belong to
        // another store in the same org. Naming it would leak that store's expense across the
        // boundary this refusal exists to hold (auditor CHANGES, S5.2 follow-up #1).
        throw refuse(
          `recordPayment: expense ${a.expenseId} is not an open item for this supplier at this ` +
            'store — it may belong to another supplier or another store, not be a credit expense, ' +
            'already be fully paid, or not be posted.',
          'This expense is not an open item for this supplier at this store — it may belong to ' +
            'another supplier or another store, not be a credit expense, already be fully paid, or not be posted.',
        );
      }
      const applied = a.amountApplied;
      if (compare(applied, ZERO) <= 0) {
        throw refuse(
          `recordPayment: allocation for expense ${a.expenseId} must be greater than zero.`,
          `The allocation for ${await expenseKey(trx, actor.orgId, a.expenseId)} must be greater than zero.`,
        );
      }
      // R4: the outstanding figure is a database value, re-minted; both sides are exact to the centavo, so no epsilon.
      if (compare(applied, money(item.outstanding)) > 0) {
        throw refuse(
          `recordPayment: expense ${a.expenseId} has only ₱${item.outstanding} still owed — ` +
            `₱${a.amountApplied} does not fit.`,
          `${capitalise(await expenseKey(trx, actor.orgId, a.expenseId))} has only ₱${item.outstanding} still owed — ₱${a.amountApplied} doesn't fit.`,
        );
      }
      allocatedTotal = add(allocatedTotal, applied);
    }
    if (compare(allocatedTotal, amount) > 0) {
      throw refuse(
        `recordPayment: allocations total ₱${allocatedTotal}, more than the ` +
          `₱${input.amount} handed over — a payment cannot allocate more than it pays.`,
        `Allocations total ₱${allocatedTotal}, more than the ₱${input.amount} handed over — a payment cannot allocate more than it pays.`,
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw gone('recordPayment: that money account does not exist.', 'money account');
    if (account.storeId !== input.storeId) {
      // ⭐ Cross-store money movement — same rule as `approveExpense` (bible row 153).
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }

    // ⭐ T-170 §5. Validated against the LIVE balance, never trusted from the caller — same
    // check-then-write discipline as `openItems` above. `advancesPositionOf` is a query over
    // `journal_lines`, never a stored column (DEF-075's pattern, refused again).
    // T-371: parsed after `authorize`, like every other figure here. A blank (or absent) box applies no credit — this is
    // a journal amount, not a column, so "none" is the meaning; a malformed one (`abc`, which `Number` turned into a NaN
    // that slipped past every check below) is now the parser's sentence.
    const creditApplied =
      parseDecimalInput(input.creditApplied, '14,2', 'recordPayment: creditApplied', 'The credit applied', { blank: 'omit' }) ??
      ZERO;
    if (compare(creditApplied, ZERO) > 0) {
      // ⭐ A distinct decision from recording the payment itself, checked separately even though
      // only manager+ ever holds `record_ap_payment` anyway (this file's own top authorize call).
      await authorize(trx, actor, 'apply_supplier_credit', { storeId: input.storeId });
    }
    if (compare(creditApplied, ZERO) < 0) throw refuse('recordPayment: creditApplied cannot be negative.', 'The credit applied cannot be negative.');
    if (compare(creditApplied, amount) > 0) {
      throw refuse(
        `recordPayment: creditApplied (₱${creditApplied}) cannot exceed the ` +
          `₱${input.amount} payment it is funding.`,
        `The credit applied (₱${creditApplied}) cannot exceed the ₱${input.amount} payment it is funding.`,
      );
    }
    if (compare(creditApplied, ZERO) > 0) {
      // T-369 S0·N3: serialise with every other reader/mover of this supplier's credit (another draw,
      // or `voidPayment` handing an overpayment back) BEFORE reading the balance it is about to spend.
      await advisoryLocksRepo.lockSupplierCredit(trx, input.supplierId);
      const balance = money(await apRepo.advancesPositionOf(trx, actor.orgId, input.supplierId));
      if (compare(creditApplied, balance) > 0) {
        throw refuse(
          `recordPayment: ${supplier.name} holds only ₱${balance} of return credit — ` +
            `₱${creditApplied} does not fit.`,
          `${supplier.name} holds only ₱${balance} of return credit — ₱${creditApplied} doesn't fit.`,
        );
      }
    }

    // ⭐ Only the CASH portion draws the money account — a payment fully funded by credit draws
    // nothing from it at all, so `checkDraw` (an overdraft check on a real account) is skipped
    // rather than asked about a draw of zero.
    // Both differences are ≥ 0 by the refusals above (credit ≤ amount, allocations ≤ amount); `max` stays as the floor.
    const atLeastZero = (m: Money): Money => (compare(m, ZERO) < 0 ? ZERO : m);
    const cashPortion = atLeastZero(subtract(amount, creditApplied));
    // `checkDraw` (money-accounts) takes `Money`; `cashPortion` is a finite, validated `Money` here.
    // ⭐ T-415 (DEF-657): cash leaving a staff cash account (1120) is a draw on ONE cash request. Only when cash leaves.
    // Lock order (ruling 2): expenses -> supplier credit (above) -> request lock -> live balance read.
    const floatRequestId = input.cashRequestId ?? null;
    let warning: string | undefined;
    if (compare(cashPortion, ZERO) > 0) {
      if (account.glAccountCode === '1120') {
        if (!floatRequestId) {
          throw refuse(
            `recordPayment: money account ${account.id} is a staff cash account but no cash request was named.`,
            'This is a staff cash account. Pick the cash request the money comes from.',
          );
        }
        if (account.storeId !== input.storeId) {
          throw refuse(
            `recordPayment: staff cash account ${account.id} is at store ${account.storeId}, the payment at ${input.storeId}.`,
            "A cash request can only be paid from its store's staff cash account.",
          );
        }
        const [req] = await cashRequestsRepo.lockForSpend(trx, actor.orgId, [floatRequestId]);
        if (!req) {
          throw gone(`recordPayment: cash request ${floatRequestId} does not exist in org ${actor.orgId}.`, 'cash request');
        }
        const holder = (await personsRepo.getPersonById(trx, actor.orgId, req.requestedFor))?.displayName ?? 'The holder';
        if (req.status !== 'released') {
          throw refuse(
            `recordPayment: cash request ${floatRequestId} is ${req.status}, not released.`,
            `${holder}'s cash request is no longer open (${req.status}). Pick another source.`,
          );
        }
        if (req.storeId !== input.storeId) {
          throw refuse(
            `recordPayment: payment at store ${input.storeId} draws on cash request ${floatRequestId}, released at store ${req.storeId}.`,
            `${holder}'s cash request belongs to another store, so this payment cannot draw from it. Pick another source.`,
          );
        }
        const outstanding = money((await cashRequestsRepo.floatPositionOf(trx, actor.orgId, floatRequestId)).outstanding);
        if (compare(cashPortion, outstanding) > 0) {
          throw refuse(
            `recordPayment: payment draws ${cashPortion} from cash request ${floatRequestId}, which has ${outstanding} left.`,
            `${holder}'s cash request has ${formatMoney(outstanding)} left — this payment draws ${formatMoney(cashPortion)} from it. Lower the amount or pay the rest another way.`,
          );
        }
        // The per-request check above replaces `checkDraw` for a float leg (T-414 ruling 6).
      } else {
        if (floatRequestId) {
          throw refuse(
            `recordPayment: cash request ${floatRequestId} named but money account ${account.id} is not a staff cash account.`,
            "A cash request can only be paid from its store's staff cash account.",
          );
        }
        warning = (await checkDraw(trx, actor.orgId, account, cashPortion, 'recordPayment')) ?? undefined;
      }
    }

    const unallocated = atLeastZero(subtract(amount, allocatedTotal));
    const allocated = allocatedTotal;

    const paymentLines = [
      {
        accountCode: AP_CONTROL_CODE,
        storeId: input.storeId,
        debit: allocated,
        partyType: 'supplier' as const,
        partyId: input.supplierId,
        lineMemo: `AP payment — ${supplier.name}`,
      },
      ...(compare(unallocated, ZERO) > 0
        ? [
            {
              accountCode: ADVANCES_CODE,
              storeId: input.storeId,
              debit: unallocated,
              partyType: 'supplier' as const,
              partyId: input.supplierId,
              lineMemo: `Overpayment — ${supplier.name}`,
            },
          ]
        : []),
      ...(compare(creditApplied, ZERO) > 0
        ? [
            {
              accountCode: ADVANCES_CODE,
              storeId: input.storeId,
              credit: creditApplied,
              partyType: 'supplier' as const,
              partyId: input.supplierId,
              lineMemo: `Return credit applied — ${supplier.name}`,
            },
          ]
        : []),
      ...(compare(cashPortion, ZERO) > 0
        ? [
            {
              accountCode: account.glAccountCode,
              // T-369 S8 (DEF-551): the cash credit sits at the ACCOUNT's store - `balanceOf` reads a safe there.
              storeId: account.storeId,
              credit: cashPortion,
              ...(account.glAccountCode === '1140'
                ? { partyType: 'money_account' as const, partyId: account.id }
                : account.glAccountCode === '1120' && floatRequestId
                  ? { partyType: 'cash_request' as const, partyId: floatRequestId }
                  : {}),
              lineMemo: `Payment to ${supplier.name}`,
            },
          ]
        : []),
    ];
    // A cross-store draw gains the 1250/2150 pair for the cash that left that store's account (not the credit
    // applied, which never touched it). `ap_payments.store_id` stays `input.storeId`: the payment belongs to the
    // owing store's AP.
    const lines = await withInterStoreLegs(trx, actor.orgId, {
      owingStoreId: input.storeId,
      memo: `Payment to ${supplier.name}`,
      lines: paymentLines,
    });

    const inserted = await apRepo.insertApPayment(trx, {
      id: requestId,
      orgId: actor.orgId,
      storeId: input.storeId,
      supplierId: input.supplierId,
      businessDate: input.businessDate,
      amount,
      moneyAccountId: input.moneyAccountId,
      // T-415: only a payment that actually drew a float keeps the request id (a credit-only payment draws nothing).
      cashRequestId: compare(cashPortion, ZERO) > 0 ? (input.cashRequestId ?? null) : null,
      referenceNo: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
    if (!inserted) {
      // DEF-778: a simultaneous double submit committed this id first - answer from it (or refuse if the figures differ).
      const winner = await apRepo.getApPaymentById(trx, actor.orgId, requestId);
      if (!winner) {
        // The id belongs to another org's payment (org-scoped reads cannot see it).
        throw refuse(
          `recordPayment: requestId ${requestId} already belongs to a row outside this org.`,
          'This form is out of date. Reload the page and try again.',
        );
      }
      return replayOfPayment(trx, winner, input, amount);
    }
    const paymentId = inserted.id;

    const result = await postEntryOnce(trx, {
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
      await apRepo.insertApPaymentAllocations(trx, paymentId, allocations);
      // T-402 S3 (C4): the payment step's event, same transaction, after the posting and its own writes.
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'ap_payment.recorded',
        storeId: input.storeId,
        entityId: paymentId,
        before: null,
        after: { status: 'posted', amount: String(amount), supplierId: input.supplierId, allocated: String(allocated) },
        source: 'web',
      });
    }

    return {
      paymentId,
      entryId: result.entryId,
      allocated,
      unallocated,
      ...(warning ? { warning } : {}),
    };
  };
  return run(tx);
}

/**
 * DEF-778: the first result of a request id that has already posted - but only if this call asks for the same payment
 * (supplier, store, account, date, total, return credit applied and each allocation). Anything else is a reused id and
 * is refused rather than handed the old payment as if it were this one.
 */
async function replayOfPayment(
  trx: Tx,
  row: NonNullable<Awaited<ReturnType<typeof apRepo.getApPaymentById>>>,
  input: RecordApPaymentInput,
  amount: Money,
): Promise<RecordApPaymentResult> {
  const different = () =>
    refuse(
      `recordPayment: requestId ${row.id} was already posted with different figures.`,
      'This was already recorded with different figures. Reload the page and try again.',
    );
  if (row.status === 'voided') {
    throw refuse(`recordPayment: requestId ${row.id} was voided.`, 'This was voided. Reload the page and start a new one.');
  }
  if (!row.journalEntryId) throw different();
  const stored = await apRepo.getAllocationsForPayment(trx, row.id);
  const asked = new Map<string, Money>();
  for (const a of input.allocations) {
    const applied = parseMoneyInput(a.amountApplied, `recordPayment: the allocation for expense ${a.expenseId}`, 'An amount applied to an invoice');
    asked.set(a.expenseId, add(asked.get(a.expenseId) ?? ZERO, applied));
  }
  const creditAsked =
    parseDecimalInput(input.creditApplied, '14,2', 'recordPayment: creditApplied', 'The credit applied', { blank: 'omit' }) ?? ZERO;
  const lines = await journalRepo.findLinesForEntryWithAccountCodes(trx, row.journalEntryId);
  const creditPosted = lines
    .filter((l) => l.accountCode === ADVANCES_CODE)
    .reduce((sum, l) => add(sum, money(String(l.credit))), ZERO);
  const same =
    row.supplierId === input.supplierId &&
    row.storeId === input.storeId &&
    row.moneyAccountId === input.moneyAccountId &&
    String(row.businessDate).slice(0, 10) === String(input.businessDate).slice(0, 10) &&
    compare(money(row.amount), amount) === 0 &&
    compare(creditPosted, creditAsked) === 0 &&
    (row.cashRequestId ?? null) === (input.cashRequestId ?? null) &&
    stored.length === asked.size &&
    stored.every((s) => {
      const want = asked.get(s.expenseId);
      return want !== undefined && compare(money(s.amountApplied), want) === 0;
    });
  if (!same) throw different();
  const allocated = stored.reduce((sum, s) => add(sum, money(s.amountApplied)), ZERO);
  const unallocated = compare(subtract(amount, allocated), ZERO) < 0 ? ZERO : subtract(amount, allocated);
  return { paymentId: row.id, entryId: row.journalEntryId, allocated, unallocated };
}

/** ⚠️ Reversal, never a delete — the original and its mirror both stay on the ledger. Allocation
 *  rows are NOT deleted; a voided payment's allocations must stay visible so `openItems` correctly
 *  shows the expense open again (invariant 8). */
export async function voidPayment(
  tx: Tx,
  actor: Actor,
  input: {
    paymentId: string;
    reason: string;
    /** T-369 S0·N1: the date the REVERSAL is posted on. Read only when the payment's own month is
     *  no longer open — then it must name an open month. Ignored for a payment in an open month. */
    voidOn?: string;
  },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const first = await apRepo.getApPaymentById(trx, actor.orgId, input.paymentId);
    if (!first) throw gone(`voidPayment: ap_payment ${input.paymentId} does not exist.`, 'payment');
    await authorize(trx, actor, 'record_ap_payment', { storeId: first.storeId });

    // S0·N4: voiding puts money back into the account the payment drew on, so another store's
    // account needs the same right `recordPayment` required to draw on it.
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, first.moneyAccountId);
    if (!account) throw gone(`voidPayment: money account ${first.moneyAccountId} does not exist.`, 'money account');
    if (account.storeId !== first.storeId) {
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }

    // S0·N3: serialise on the supplier's credit, THEN read the payment's status again. A double
    // submit queues here behind the first void; reading the status before the lock would hand it a
    // stale `posted` and the overpayment check below would report the first void's own effect
    // ("already used") instead of the truth ("already voided").
    await advisoryLocksRepo.lockSupplierCredit(trx, first.supplierId);
    const payment = await apRepo.getApPaymentById(trx, actor.orgId, input.paymentId);
    if (!payment) throw gone(`voidPayment: ap_payment ${input.paymentId} does not exist.`, 'payment');

    if (payment.status === 'voided') {
      throw refuse(`voidPayment: ap_payment ${input.paymentId} is already voided.`, 'This payment has already been voided.');
    }
    if (payment.status !== 'posted') {
      throw refuse(
        `voidPayment: ap_payment ${input.paymentId} is ${payment.status}, not posted.`,
        `This payment is ${payment.status}, not posted.`,
      );
    }
    if (!payment.journalEntryId) {
      throw internalFault(`voidPayment: ap_payment ${input.paymentId} is posted but carries no journalEntryId — data inconsistency.`);
    }

    const reason = input.reason.trim();
    if (!reason) throw refuse('voidPayment: say why this payment is being voided.', 'Say why this payment is being voided.');

    // ⭐ T-415 (ruling 4): a void puts float money back on the request, so the request must still be open. Locked after the
    // supplier credit (above) and before the reversal, so a settle that is closing the request is waited for.
    if (payment.cashRequestId) {
      const [req] = await cashRequestsRepo.lockForSpend(trx, actor.orgId, [payment.cashRequestId]);
      if (req && req.status !== 'released') {
        const holder = (await personsRepo.getPersonById(trx, actor.orgId, req.requestedFor))?.displayName ?? 'The holder';
        throw refuse(
          `voidPayment: ap_payment ${input.paymentId} drew on cash request ${payment.cashRequestId}, which is ${req.status}.`,
          `${holder}'s cash request is ${req.status}, so this cannot be voided. The request must still be released.`,
        );
      }
    }

    // S0·N2: what this payment left on 1240 is its overpayment (`unallocated`, debited) less any
    // return credit it SPENT (`creditApplied`, credited back). Reversing it takes that NET out of the
    // supplier's balance; if the pool no longer holds it, later bills have already used it and the
    // void would leave the credit below zero. A payment whose net is zero never trips this.
    const unallocated = money(await apRepo.unallocatedOf(trx, actor.orgId, input.paymentId));
    const entryLines = await journalRepo.findLinesForEntryWithAccountCodes(trx, payment.journalEntryId);
    const spentCredit = entryLines
      .filter((l) => l.accountCode === apRepo.ADVANCES_CODE)
      .reduce((sum, l) => add(sum, money(l.credit)), money('0'));
    const net = subtract(unallocated, spentCredit);
    if (compare(net, money('0')) > 0) {
      const held = money(await apRepo.advancesPositionOf(trx, actor.orgId, payment.supplierId));
      if (compare(held, net) < 0) {
        const short = subtract(net, held);
        throw refuse(
          `voidPayment: ap_payment ${input.paymentId}'s overpayment has already been used to pay later bills (${held} of ${net} still held).`,
          `${formatMoney(short)} of this payment's overpayment has already been used to pay later bills. Void those payments first.`,
        );
      }
    }

    // S0·N1: a payment in a month that has since closed can only be reversed on a date in an open one.
    let reversalDate: string | undefined;
    const original = await journalRepo.findEntryById(trx, payment.journalEntryId);
    const originalPeriod = original ? await journalRepo.findPeriodById(trx, original.periodId) : undefined;
    if (originalPeriod && originalPeriod.status !== 'open') {
      if (!input.voidOn) {
        throw refuse(
          `voidPayment: ap_payment ${input.paymentId}'s period is ${originalPeriod.status} and no voidOn was given.`,
          'This payment is in a closed month. Pick a date in an open month for the reversal.',
        );
      }
      let voidOn: string;
      try {
        voidOn = parseBusinessDate(input.voidOn);
      } catch {
        throw refuse(`voidPayment: voidOn ${JSON.stringify(input.voidOn)} is not a valid date.`, 'Pick a valid date for the reversal.');
      }
      const target = await journalRepo.findPeriodForDate(trx, actor.orgId, voidOn);
      if (!target || target.status !== 'open') {
        throw refuse(
          `voidPayment: voidOn ${voidOn} is not in an open fiscal period.`,
          'That date is not in an open month. Pick a date in an open month for the reversal.',
        );
      }
      reversalDate = voidOn;
    }

    const result = await reverseEntry(trx, {
      entryId: payment.journalEntryId,
      reason,
      reversedBy: actor.personId,
      ...(reversalDate ? { reversalDate } : {}),
    });

    if (result.created) {
      await apRepo.markApPaymentVoided(trx, actor.orgId, input.paymentId, {
        voidedBy: actor.personId,
        voidReason: reason,
      });
    }

    return { entryId: result.reversalEntryId };
  };
  return run(tx);
}

// -------------------------------------------------------------------------------------
// T-330 — auto-allocation SUGGESTION.
// -------------------------------------------------------------------------------------

/**
 * The ordering keys for one open item, read separately from `openItems` and keyed by its id.
 * ⛔ AMENDMENT 4 (F3+F7): the allocation grain is the EXPENSE, not the supplier invoice, and two
 * expense rows can share one invoice (`expenses.supplier_invoice_id` is NOT NULL but NOT unique,
 * `packages/db/schema/expenses.ts:149-151`) — so all three invoice-side keys (`due_date`,
 * `invoice_no`, and a since-dropped `created_at`) can tie across them. ⛔ `createdAt` is NOT a
 * field here and must not be re-added: it is `defaultNow()`, identical for every row one
 * transaction writes, so it can never break a tie `id` doesn't already break. The final,
 * always-deciding key is `expenseId` itself (`uuidv7()` — unique and creation-ordered), which
 * `allocateOldestFirst` uses as the item's `id`.
 */
export interface ApOrderingKeys {
  readonly expenseId: string;
  /** `supplier_invoices.due_date` — NULLABLE, handed in RAW. */
  readonly dueDate: string | null;
  /** `supplier_invoices.invoice_date` — NOT NULL. The pure module resolves the fallback. */
  readonly invoiceDate: string;
  readonly invoiceNo: string | null;
}

export interface SuggestApAllocationResult {
  readonly allocations: ApPaymentAllocationInput[];
  readonly unallocated: string;
}

/**
 * Suggests an oldest-first allocation of `amount` across `open`, via the pure
 * `allocateOldestFirst`. Never posts anything.
 *
 * ⭐ `tx` first and `Promise`-returning, per the TESTER's correction: ruling 3 requires an
 * `authorize` call, which needs a `Tx` and therefore makes this async. The spec's original snippet
 * showed neither and was wrong; every other export in this file is `(tx, actor, …)`.
 *
 * ⛔ WRITES NOTHING, EVER (invariant 5). It proposes; `recordPayment` commits, re-reading
 * `openItems` inside its own transaction and refusing anything not open (`:739-759`).
 * ⛔ `open` is PASSED IN — this function must not call `openItems` itself. A second definition of
 * "open" fails by proposing an item Save then rejects, on a figure the operator never typed.
 * `authorize(trx, actor, 'record_ap_payment', { storeId })` gates it — Ian's ruling 2026-09-20:
 * the capability is the payment's own. ⚠️ It is a BACKSTOP, not the gate: after AMENDMENT 2 this
 * function reads nothing, so the ledger has already left the database in the CALLER before this
 * runs (AMENDMENT 4, finding F2).
 * ⛔⛔ IT REFUSES ANY HANDED-IN ITEM WHOSE `storeId` DIFFERS FROM `storeId`. `openItems`
 * is store-scoped by Ian's ruling (`repo/ap.ts:558-564`, 2026-08-28), and nothing else binds the
 * caller to the store the payment posts at — an org-wide fetch would propose another store's open
 * item and Save would throw on a figure the operator never typed.
 */
export async function suggestPaymentAllocation(
  tx: Tx,
  actor: Actor,
  storeId: string,
  amount: string,
  open: Awaited<ReturnType<typeof apRepo.openItems>>,
  keys: readonly ApOrderingKeys[],
  /** ⭐ Amounts the operator ALREADY TYPED. Ian's ruling 2: fill only the EMPTY boxes — these
   *  are skipped, the payment available is reduced by their sum, and a sum exceeding the payment
   *  is refused. Defaults to empty, so existing call sites are unaffected. AMENDMENT 7. */
  typed: readonly TypedAmount[] = [],
): Promise<SuggestApAllocationResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_ap_payment', { storeId });

    for (const o of open) {
      // Holds only while every caller fetches `open` for the SAME store it passes here
      // (apps/erp/src/app/ap/actions.ts:260) — a caller mismatch is a bug in the caller, not
      // something the person acting can fix, hence internalFault rather than a user sentence.
      if (o.storeId !== storeId) {
        throw internalFault(
          `suggestPaymentAllocation: expense ${o.expenseId} belongs to store ${o.storeId}, not ` +
            `${storeId} — refusing to propose an allocation outside the payment's own store.`,
        );
      }
    }

    const keyByExpenseId = new Map(keys.map((k) => [k.expenseId, k]));
    const items: AllocationItem[] = open.map((o) => {
      const key = keyByExpenseId.get(o.expenseId);
      if (!key) {
        throw internalFault(
          `suggestPaymentAllocation: expense ${o.expenseId} is open but has no ordering key — ` +
            'cannot sort it safely.',
        );
      }
      return {
        id: o.expenseId,
        dueDate: key.dueDate,
        documentDate: key.invoiceDate,
        tieBreak: key.invoiceNo,
        outstanding: money(o.outstanding),
      };
    });

    const plan = allocateOldestFirst(items, parseMoneyInput(amount, 'suggestPaymentAllocation: the amount', 'The payment amount'), typed);
    return {
      allocations: plan.allocations.map((a) => ({ expenseId: a.id, amountApplied: a.amount })),
      unallocated: plan.remainder,
    };
  };
  return run(tx);
}
