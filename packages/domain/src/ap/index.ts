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
  advisoryLocksRepo,
  apRepo,
  auditLogRepo,
  itemsRepo,
  journalRepo,
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
import { add, compare, formatMoney, money, subtract } from '@shareat/core/money';
import { addDays, parseBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { parseMoneyInput } from '../shared/money-input';
import { gone, humanDate, internalFault, refuse } from '../shared/refusal';
import { allocateOldestFirst, type AllocationItem, type TypedAmount } from '../shared/allocate-oldest-first';
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
   * on credit, due on the invoice date). The value is RAW here and parsed by `parseCreditTermsDays`
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
}

/** Trim to null so an emptied field clears rather than storing `''`. */
function orNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v?.trim() || null;
}

const TERMS_BLANK = 'Enter how many days of credit this supplier gives (0 to 365), or choose Cash on delivery.';
const termsMalformed = (v: string) => `Payment terms — "${v}" is not a whole number of days from 0 to 365.`;

/**
 * T-362 / DEF-495 — R2: parses a supplier's raw `creditTermsDays` box. `null`/`undefined` (the key
 * absent, or explicitly cleared) means cash-on-delivery. `0` is legal and means "on credit, due on
 * the invoice date" (R1) — never coerced into "no credit". The upper bound (365) is the CHECK
 * constraint's own typo guard (`0141:47-48`); refusing it here first keeps the sentence readable,
 * with the database CHECK as the backstop (RULES §6.3).
 */
function parseCreditTermsDays(
  raw: number | string | null | undefined | UnrecognisedTermsMode,
  fn: string,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    const v = raw.unrecognisedTermsMode;
    throw refuse(`${fn}: credit terms mode ${JSON.stringify(v)} is not recognised`, termsMalformed(v));
  }
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 0 && raw <= 365) return raw;
    const v = String(raw);
    throw refuse(`${fn}: credit terms ${JSON.stringify(v)} is not a whole number of days from 0 to 365`, termsMalformed(v));
  }
  const t = raw.trim();
  if (t === '') {
    throw refuse(`${fn}: credit terms is blank`, TERMS_BLANK);
  }
  if (!/^\d+$/.test(t) || Number(t) > 365) {
    throw refuse(`${fn}: credit terms ${JSON.stringify(t)} is not a whole number of days from 0 to 365`, termsMalformed(t));
  }
  return Number(t);
}

export async function createSupplier(
  tx: Tx | null,
  actor: Actor,
  input: CreateSupplierInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_supplier', {});
    const name = input.name.trim();
    if (!name) throw refuse('createSupplier: a supplier needs a name people will recognise.', 'A supplier needs a name people will recognise.');
    const creditTermsDays = parseCreditTermsDays(input.creditTermsDays, 'createSupplier');
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
 *
 * T-362 / DEF-495 — a real change to `creditTermsDays` is audited in `audit_log` (R3), since it
 * decides whether AP credit may be booked against this supplier. T-365 / DEF-498 — a real change
 * to any of the three bank fields is audited too, same transaction, full before/after triple.
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
      throw gone(`editSupplier: supplier ${input.supplierId} does not exist.`, 'supplier');
    }

    const values: Parameters<typeof apRepo.updateSupplier>[3] = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw refuse('editSupplier: a supplier needs a name people will recognise.', 'A supplier needs a name people will recognise.');
      values.name = name;
    }
    // T-362 / DEF-495 — R2's order: authorize -> gone -> name -> TERMS -> the other fields.
    let creditTermsDays: number | null | undefined;
    if (input.creditTermsDays !== undefined) {
      creditTermsDays = parseCreditTermsDays(input.creditTermsDays, 'editSupplier');
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
        entity: 'suppliers',
        entityId: input.supplierId,
        before: { creditTermsDays: existing.creditTermsDays },
        after: { creditTermsDays },
        // The ERP screen is this function's only caller today; a second front-end must thread its
        // own source through, not inherit this one (same comment as the precedent).
        source: 'web',
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
        entity: 'suppliers',
        entityId: input.supplierId,
        before: bankBefore,
        after: bankAfter,
        source: 'web',
      });
    }
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
    if (!supplier) throw gone(`reconcileSupplier: supplier ${input.supplierId} does not exist.`, 'supplier');

    const position = await apRepo.positionOf(trx, actor.orgId, supplier.id);
    if (Math.abs(Number(position.controlBalance)) > 0.005) {
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
    if (!supplier) throw gone(`recordInvoice: supplier ${input.supplierId} does not exist.`, 'supplier');
    // ⭐ Ian, 2026-08-28, requirement 1: the supplier must be EXISTING **and ACTIVE**. A v2
    // tightening — v1's `upsertReceiptAction` checks only that the supplier document exists
    // (`receipt.actions.ts`), so an inactive supplier can still be billed against there. An
    // inactive supplier is one the business has stopped buying from; a new bill from one is
    // either a mistake or something worth a second look, and neither should post quietly.
    if (supplier.status !== 'active') {
      throw refuse(
        `recordInvoice: ${supplier.name} is ${supplier.status}, not active — reactivate the ` +
          'supplier first if you really are still buying from them.',
        `${supplier.name} is ${supplier.status}, not active — reactivate the supplier first if you really are still buying from them.`,
      );
    }

    // T-367 S3 (DEF-420, R8): every money input is parsed ONCE, here, and the row is written from the PARSED
    // values - a typed `abc` or `NaN` used to reach the database (22P02 / 23514) and a non-numeric fee became NaN.
    const total = parseMoneyInput(input.totalAmount, 'recordInvoice: the invoice total', 'The invoice total');
    if (compare(total, money('0')) <= 0) throw refuse('recordInvoice: an invoice total has to be greater than zero.', 'An invoice total has to be greater than zero.');
    // A fee is blank (= 0) or a non-negative amount: `abc` is the parser's sentence, `-50` is refused here.
    const feeOf = (raw: string | null | undefined, rawLabel: string, humanLabel: string) => {
      if (raw == null || raw.trim() === '') return money('0');
      const fee = parseMoneyInput(raw, rawLabel, humanLabel);
      if (compare(fee, money('0')) < 0) throw refuse(`${rawLabel} is negative.`, `${humanLabel} can't be less than zero.`);
      return fee;
    };
    const deliveryFee = feeOf(input.deliveryFee, 'recordInvoice: the delivery fee', 'The delivery fee');
    const otherFees = feeOf(input.otherFees, 'recordInvoice: the other fees', 'The other fees');
    // T-151: the fees are part of the invoice total but are NOT lines, so the lines are checked against the goods.
    // Two fees can together leave the `numeric(14,2)` range, which `subtract` reports as a RangeError - a refusal here.
    const feesTooBig = () =>
      refuse('recordInvoice: the delivery and other fees exceed the invoice total.', "The delivery and other fees can't be more than the invoice total.");
    let goodsTotal: ReturnType<typeof money>;
    try {
      goodsTotal = subtract(subtract(total, deliveryFee), otherFees);
    } catch {
      throw feesTooBig();
    }
    if (compare(goodsTotal, money('0')) < 0) throw feesTooBig();

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
      if (dueDate < invoiceDate) throw refuse('recordInvoice: the due date is before the invoice date.', "A due date can't be before the invoice date.");
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
      invoiceDate,
      dueDate,
      totalAmount: String(total),
      deliveryFee: String(deliveryFee),
      otherFees: String(otherFees),
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
    // against the goods portion (`goodsTotal`, above). Ian, 2026-08-28: inbound freight is added to the item's price,
    // which happens in the landed-cost derivation, not by inventing a line for it here.
    const lines = await validateInvoiceLines(trx, actor.orgId, input.lines ?? [], String(goodsTotal), input.storeId);
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

/** Human labels for `VerifyInvoiceAttestation`'s own keys — never the literal key in a sentence. */
const ATTESTATION_LABEL: Record<keyof VerifyInvoiceAttestation, string> = {
  supplier: 'the supplier',
  invoice: 'the invoice number and date',
  items: 'the items',
  price: 'the prices',
};

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
    if (!invoice) throw gone(`verifyInvoice: supplier invoice ${invoiceId} does not exist.`, 'supplier invoice');
    await authorize(trx, actor, 'verify_supplier_invoice', { storeId: invoice.storeId });

    if (invoice.status !== 'pending') {
      throw refuse(
        `verifyInvoice: supplier invoice ${invoiceId} is ${invoice.status}, not pending.`,
        `This invoice is ${invoice.status}, not pending.`,
      );
    }

    // ⛔ Segregation of duties. The DB enforces it too; this is the sentence a human can act on.
    if (invoice.createdBy === actor.personId) {
      throw refuse(
        'verifyInvoice: you logged this invoice, so you cannot also verify it. Verification is a ' +
          'second pair of eyes — ask a manager who did not enter it, or an admin.',
        'You logged this invoice, so you cannot also verify it. Verification is a second pair of ' +
          'eyes — ask a manager who did not enter it, or an admin.',
      );
    }

    const missing = (Object.keys(attestation) as (keyof VerifyInvoiceAttestation)[]).filter(
      (k) => !attestation[k],
    );
    if (missing.length > 0) {
      const labels = missing.map((k) => ATTESTATION_LABEL[k]);
      const joined = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}` : labels[0]!;
      throw refuse(
        `verifyInvoice: confirm every part of the bill before verifying it — still unconfirmed: ` +
          `${missing.join(', ')}. Verifying means you checked the supplier, the invoice details, ` +
          'the items and the prices against the photo.',
        `Confirm every part of the bill before verifying it — still unconfirmed: ${joined}. ` +
          'Verifying means you checked the supplier, the invoice details, the items and the ' +
          'prices against the photo.',
      );
    }

    const supplier = await apRepo.getSupplierById(trx, actor.orgId, invoice.supplierId);
    if (!supplier) throw gone(`verifyInvoice: supplier ${invoice.supplierId} does not exist.`, 'supplier');
    if (supplier.status !== 'active') {
      throw refuse(`verifyInvoice: ${supplier.name} is ${supplier.status}, not active.`, `${supplier.name} is ${supplier.status}, not active.`);
    }

    const isCommissaryMirror = !!supplier.counterpartyStoreId;
    if (!isCommissaryMirror) {
      if (!invoice.receiptFileId) {
        throw refuse(
          `verifyInvoice: supplier invoice ${invoiceId} has no receipt photo — upload one before ` +
            'verifying. A photo of the paper is the evidence the whole gate rests on (DEF-055).',
          'This invoice has no receipt photo — upload one before verifying. A photo of the paper ' +
            'is the evidence the whole gate rests on.',
        );
      }
      // ⭐ T-141's real check, not a truthiness test: the file must exist, in this org, and belong
      // to this invoice's store. A receipt from somewhere else is not evidence for this bill.
      const file = await filesRepo.getById(trx, actor.orgId, invoice.receiptFileId);
      if (!file) {
        throw refuse(
          `verifyInvoice: supplier invoice ${invoiceId} names a receipt file that does not exist in this org.`,
          'This invoice names a receipt file that does not exist in this org.',
        );
      }
      if (file.storeId && file.storeId !== invoice.storeId) {
        throw refuse(
          `verifyInvoice: supplier invoice ${invoiceId} names a receipt belonging to another store — ` +
            'a photo from somewhere else is not evidence for this invoice.',
          'This invoice names a receipt belonging to another store — a photo from somewhere else is not evidence for this invoice.',
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
        const innerUserMessage = err instanceof Error ? (err as { userMessage?: unknown }).userMessage : undefined;
        // Rewrap: keeps the inner userMessage (rule 5) rather than re-deriving one from `.message`.
        // ⚠️ Presentable, not `instanceof RefusalError` — `AuthorizationError` (e.g. S2's
        // `transfer_funds` refusal on a cross-store draw inside `approveExpense`) carries a
        // `userMessage` too and is not a `RefusalError`; the same `isPresentable`-shaped check
        // `apps/erp/src/lib/error-shape.ts` uses (including its `instanceof Error` guard, so a
        // thrown non-Error can't TypeError here), duplicated since domain cannot import it.
        throw refuse(
          `verifyInvoice: supplier invoice ${invoiceId} cannot be verified — draft expense ${d.id} ` +
            `failed to post: ${reason}`,
          typeof innerUserMessage === 'string' && innerUserMessage.trim() !== ''
            ? innerUserMessage
            : 'This invoice could not be verified — posting one of its draft expenses failed. Check the draft and try again.',
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
 *
 * T-361 / DEF-492 — the cash-on-delivery rule reaches this function through `createExpense`,
 * which it calls below; there is no separate copy of it here.
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
    if (!supplier) throw gone(`recordPayment: supplier ${input.supplierId} does not exist.`, 'supplier');

    const parsedAmount = parseMoneyInput(input.amount, 'recordPayment: the amount', 'The payment amount');
    const amount = Number(parsedAmount);
    if (amount <= 0) throw refuse('recordPayment: a payment has to be greater than zero.', 'A payment has to be greater than zero.');
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
    const open = await apRepo.openItems(trx, actor.orgId, input.supplierId, input.storeId);
    const byExpense = new Map(open.map((o) => [o.expenseId, o]));
    let allocatedTotal = 0;
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
      const applied = Number(a.amountApplied);
      if (applied <= 0) {
        throw refuse(
          `recordPayment: allocation for expense ${a.expenseId} must be greater than zero.`,
          `The allocation for ${await expenseKey(trx, actor.orgId, a.expenseId)} must be greater than zero.`,
        );
      }
      if (applied > Number(item.outstanding) + 0.005) {
        throw refuse(
          `recordPayment: expense ${a.expenseId} has only ₱${item.outstanding} still owed — ` +
            `₱${a.amountApplied} does not fit.`,
          `${capitalise(await expenseKey(trx, actor.orgId, a.expenseId))} has only ₱${item.outstanding} still owed — ₱${a.amountApplied} doesn't fit.`,
        );
      }
      allocatedTotal += applied;
    }
    if (allocatedTotal > amount + 0.005) {
      throw refuse(
        `recordPayment: allocations total ₱${allocatedTotal.toFixed(2)}, more than the ` +
          `₱${input.amount} handed over — a payment cannot allocate more than it pays.`,
        `Allocations total ₱${allocatedTotal.toFixed(2)}, more than the ₱${input.amount} handed over — a payment cannot allocate more than it pays.`,
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
    const creditApplied = Number(input.creditApplied ?? '0');
    if (creditApplied > 0) {
      // ⭐ A distinct decision from recording the payment itself, checked separately even though
      // only manager+ ever holds `record_ap_payment` anyway (this file's own top authorize call).
      await authorize(trx, actor, 'apply_supplier_credit', { storeId: input.storeId });
    }
    if (creditApplied < 0) throw refuse('recordPayment: creditApplied cannot be negative.', 'The credit applied cannot be negative.');
    if (creditApplied > amount + 0.005) {
      throw refuse(
        `recordPayment: creditApplied (₱${creditApplied.toFixed(2)}) cannot exceed the ` +
          `₱${input.amount} payment it is funding.`,
        `The credit applied (₱${creditApplied.toFixed(2)}) cannot exceed the ₱${input.amount} payment it is funding.`,
      );
    }
    if (creditApplied > 0) {
      // T-369 S0·N3: serialise with every other reader/mover of this supplier's credit (another draw,
      // or `voidPayment` handing an overpayment back) BEFORE reading the balance it is about to spend.
      await advisoryLocksRepo.lockSupplierCredit(trx, input.supplierId);
      const balance = Number(await apRepo.advancesPositionOf(trx, actor.orgId, input.supplierId));
      if (creditApplied > balance + 0.005) {
        throw refuse(
          `recordPayment: ${supplier.name} holds only ₱${balance.toFixed(2)} of return credit — ` +
            `₱${creditApplied.toFixed(2)} does not fit.`,
          `${supplier.name} holds only ₱${balance.toFixed(2)} of return credit — ₱${creditApplied.toFixed(2)} doesn't fit.`,
        );
      }
    }

    // ⭐ Only the CASH portion draws the money account — a payment fully funded by credit draws
    // nothing from it at all, so `checkDraw` (an overdraft check on a real account) is skipped
    // rather than asked about a draw of zero.
    const cashPortion = Math.max(0, amount - creditApplied);
    const warning = cashPortion > 0 ? await checkDraw(trx, actor.orgId, account, cashPortion, 'recordPayment') : undefined;

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
      ...(creditApplied > 0
        ? [
            {
              accountCode: ADVANCES_CODE,
              storeId: input.storeId,
              credit: creditApplied.toFixed(2),
              partyType: 'supplier' as const,
              partyId: input.supplierId,
              lineMemo: `Return credit applied — ${supplier.name}`,
            },
          ]
        : []),
      ...(cashPortion > 0
        ? [
            {
              accountCode: account.glAccountCode,
              storeId: input.storeId,
              credit: cashPortion.toFixed(2),
              ...(account.glAccountCode === '1140'
                ? { partyType: 'money_account' as const, partyId: account.id }
                : {}),
              lineMemo: `Payment to ${supplier.name}`,
            },
          ]
        : []),
    ];

    const { id: paymentId } = await apRepo.insertApPayment(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      supplierId: input.supplierId,
      businessDate: input.businessDate,
      amount: parsedAmount,
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
      await apRepo.insertApPaymentAllocations(trx, paymentId, allocations);
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
  if (tx) return run(tx);
  return transaction(run);
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
  tx: Tx | null,
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
  if (tx) return run(tx);
  return transaction(run);
}
