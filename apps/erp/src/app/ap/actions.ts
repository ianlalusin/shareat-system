'use server';

/**
 * Server actions for the AP screens — suppliers, supplier invoices, payments. T-130.
 *
 * ⛔ The gates live in the services, not here — same discipline as liabilities/actions.ts.
 */
import { apRepo, moneyAccountsRepo } from '@shareat/db';
import { parseMoneyInput } from '@shareat/domain/money-input';
import { logger } from '@shareat/core/logger';
import { compare, formatMoney, money, ZERO } from '@shareat/core/money';
import {
  createSupplier,
  editSupplier,
  recordInvoice,
  setInvoiceLines,
  uploadFile,
  type InvoiceLineDraft,
  lineTotalFromParts,
  type UnrecognisedTermsMode,
  verifyInvoice,
  voidInvoice,
  recordPayment,
  voidPayment,
  suggestPaymentAllocation,
} from '@shareat/domain';
import { withOrgPrincipal, INVOICE_LINE_ROWS } from './lib';
import { authorize } from '@shareat/auth';
import { requireActor } from '../../lib/session';
import { closedMonthOf, closedMonths, periodOverrideProblem, readPeriodOverride } from '@/lib/period-override';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { INVOICE_LINES, SUPPLIER_EDIT } from './typed-forms';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The T-188 fields, read once and shared by create and edit.
 *
 * ⚠️ A checkbox that is OFF sends NOTHING, so `issuesOfficialReceipt` must be derived from a
 * companion hidden marker rather than from the checkbox alone — otherwise un-ticking it on an
 * edit form would be indistinguishable from not rendering the field, and the value would never
 * turn off. That is why `orPresent` exists.
 *
 * T-365 / DEF-506 — R8: absent means untouched, sent-blank means clear. A key the form did not
 * render must map to `undefined` (`editSupplier` leaves it alone), never to `null` (a clear) —
 * otherwise a partial edit form wipes every field it does not happen to show.
 */
function supplierFieldsFrom(fd: FormData) {
  const s = (k: string) => (fd.has(k) ? str(fd, k) || null : undefined);
  return {
    email: s('email'),
    representativeName: s('representativeName'),
    tin: s('tin'),
    classification: fd.has('classification')
      ? ((str(fd, 'classification') || null) as 'corporate' | 'individual' | 'other' | null)
      : undefined,
    issuesOfficialReceipt: fd.has('issuesOfficialReceiptPresent')
      ? fd.get('issuesOfficialReceipt') === 'on'
      : undefined,
    bankName: s('bankName'),
    bankAccountName: s('bankAccountName'),
    bankAccountNumber: s('bankAccountNumber'),
    creditTermsDays: creditTermsFrom(fd),
  };
}

/**
 * T-362 / DEF-495 — R4: the form offers an explicit choice, never a bare number box, so a person
 * cannot type `0` meaning "no credit" and switch credit ON. The value is passed raw and judged in
 * the domain after `authorize` (T-362 / DEF-495) — this only maps fields, it judges nothing.
 *
 * ⛔ Audit finding F1 (2026-09-29): an earlier version returned the unrecognised MODE string
 * itself as the raw days value — `termsMode='30'` with no `creditTermsDays` field then read as a
 * genuine 30-day entry, because `'30'` the mode selector and `'30'` a real day count are the same
 * string once they leave this function. `UnrecognisedTermsMode` flags "the MODE was unrecognised"
 * structurally, so the domain can refuse it without ever having to guess whether a string was a
 * selector or a day count.
 */
function creditTermsFrom(fd: FormData): string | null | undefined | UnrecognisedTermsMode {
  if (!fd.has('termsMode')) return undefined;
  const mode = str(fd, 'termsMode');
  if (mode === 'cod') return null;
  if (mode === 'credit') return str(fd, 'creditTermsDays');
  // An unrecognised mode is never silently read as COD, and never silently accepted just because
  // it happens to look like a valid day count either.
  return { unrecognisedTermsMode: mode };
}

/**
 * ⭐ **Corrects a supplier.** T-188 — the gap that motivated the task: `apRepo.updateSupplier`
 * existed with no caller and no screen, so a typo in a name was permanent.
 *
 * ⛔ The gate is `approve_supplier`, inside `editSupplier` — the same capability as create, and
 * deliberately not weaker. A name and a bank account number decide where money goes.
 */
export async function editSupplierAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const supplierId = str(formData, 'supplierId');
  const path = `/ap/suppliers/${supplierId}`;
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      editSupplier(tx, actor, {
        supplierId,
        name: str(formData, 'name'),
        address: str(formData, 'address'),
        contactNo: str(formData, 'contactNo'),
        notes: str(formData, 'notes'),
        vatStatus: (str(formData, 'vatStatus') || null) as never,
        status: (str(formData, 'status') || 'active') as never,
        ...supplierFieldsFrom(formData),
      }),
    );
  } catch (err) {
    // T-389 / DEF-617: a refused save keeps the typing in the signed flash so the record reopens holding it. The
    // account number is never kept (SUPPLIER_EDIT, Q1).
    return await redirectWithFlash(path, {}, { error: errorMessage(err), typed: keepTyping(formData, SUPPLIER_EDIT, supplierId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Supplier updated.' });
}

export async function createSupplierAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createSupplier(tx, actor, {
        name: str(formData, 'name'),
        address: str(formData, 'address') || null,
        contactNo: str(formData, 'contactNo') || null,
        notes: str(formData, 'notes') || null,
        ...supplierFieldsFrom(formData),
      }),
    );
    id = created.id;
  } catch (err) {
    return await redirectWithFlash('/ap', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/ap', { supplier: id }, { ok: `Supplier recorded.` });
}

/**
 * ⭐ The photo is UPLOADED here, never typed. The old form took a `receiptPhotoUrl` text box, so
 * `x` was a valid receipt — that is the hole this closes (Ian, 2026-08-28). The bytes go through
 * T-141's `uploadFile`, which strips EXIF, derives the storage path from the session, and writes
 * a `stored_files` row that `verifyInvoice` can actually verify exists.
 *
 * ⚠️ Upload and insert share ONE transaction, so an invoice can never reference a file that was
 * not written, and a failed insert leaves the bytes as an orphan for T-141's sweep — the cheaper
 * of the two failures, by that module's own reasoning.
 */
export async function recordInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let id = '';
  let warning = '';
  try {
    if (!storeId) throw new Error('Choose a store.');
    const photo = formData.get('receiptPhoto');
    const hasPhoto = photo instanceof File && photo.size > 0;
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      let receiptFileId: string | null = null;
      if (hasPhoto) {
        const uploaded = await uploadFile(tx, actor, {
          purpose: 'receipt_photo',
          storeId,
          contentType: (photo as File).type,
          bytes: new Uint8Array(await (photo as File).arrayBuffer()),
        });
        receiptFileId = uploaded.fileId;
      }
      return recordInvoice(tx, actor, {
        storeId,
        supplierId: str(formData, 'supplierId'),
        invoiceNo: str(formData, 'invoiceNo') || null,
        invoiceDate: str(formData, 'invoiceDate'),
        dueDate: str(formData, 'dueDate') || null,
        totalAmount: str(formData, 'totalAmount'),
        // T-379 S3b (DEF-569) - both fees ride with the bill; blank is 'no fee' and the domain parses and refuses.
        deliveryFee: str(formData, 'deliveryFee') || null,
        otherFees: str(formData, 'otherFees') || null,
        notes: str(formData, 'notes') || null,
        receiptFileId,
        // T-408 R1 - VAT type (blank = not recorded, so an old form post is unchanged), the amount typed from the paper,
        // and the OR flag ('' = the supplier's habit). The domain resolves 'supplier_default' and refuses contradictions.
        vatType: (str(formData, 'vatType') || null) as never,
        vatAmount: str(formData, 'vatAmount') || null,
        ...(str(formData, 'isOfficialReceipt') === 'yes'
          ? { isOfficialReceipt: true }
          : str(formData, 'isOfficialReceipt') === 'no'
            ? { isOfficialReceipt: false }
            : {}),
      });
    });
    id = result.id;
    warning = result.duplicateWarning ?? '';
  } catch (err) {
    return await redirectWithFlash('/ap', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/ap/invoices/${id}`, {}, warning ? { ok: 'Invoice logged.', warning } : { ok: 'Invoice logged.' });
}

/**
 * ⭐ Verification is an ATTESTATION, not a button. Ian, 2026-08-28: *"verified means right
 * supplier, right invoice data, right items, right price all verified plus an uploaded photo."*
 * All four are ticked by a human against the photo, and all four are recorded separately.
 */
/**
 * ⭐ Itemise a PENDING invoice — T-147, and the wiring T-145 was missing.
 *
 * `recordInvoice` has accepted lines since T-145 and no form ever sent any, so
 * `supplier_invoice_lines` was empty and every feature reading it (price history, the supplier
 * catalogue, T-146's OCR) had nothing to work with. Lines live HERE rather than on the create
 * form for two reasons: the supplier is known by now, so the item picker can be ordered by what
 * they have actually billed before; and verifying attests *"right items, right price"*, which is
 * only meaningful if the items are on the record before the tick.
 */
export async function setInvoiceLinesAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const invoiceId = str(formData, 'invoiceId');
  try {
    const lines: InvoiceLineDraft[] = [];
    for (let i = 1; i <= INVOICE_LINE_ROWS; i++) {
      const itemId = str(formData, `line${i}_itemId`);
      const quantity = str(formData, `line${i}_quantity`);
      const unitPrice = str(formData, `line${i}_unitPrice`);
      if (!itemId || !quantity || !unitPrice) continue;
      lines.push({
        itemId,
        description: str(formData, `line${i}_description`) || null,
        quantity,
        purchaseUnit: (str(formData, `line${i}_purchaseUnit`) || 'pcs') as never,
        conversionFactor: str(formData, `line${i}_conversionFactor`) || '1',
        unitPrice,
        // ⚠️ Computed, never typed. quantity x unit price IS the line total by definition, and a
        // third typed number is a third thing that can disagree with the other two.
        lineTotal: lineTotalFromParts(quantity, unitPrice),
      });
    }
    await withOrgPrincipal(actor.orgId, (tx) => setInvoiceLines(tx, actor, invoiceId, lines));
  } catch (err) {
    return await redirectWithFlash(`/ap/invoices/${invoiceId}`, {}, { error: errorMessage(err), typed: keepTyping(formData, INVOICE_LINES, invoiceId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/ap/invoices/${invoiceId}`, {}, { ok: 'Lines saved. Prices now feed the item history.' });
}

export async function verifyInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'invoiceId');
  try {
    // T-376 S1 (DEF-581), R5. T-364 order: nothing about the bill's month is said until the actor has proven
    // `verify_supplier_invoice` at the bill's store. The bill's date is read here, never from the form. The override
    // is forwarded ONLY for a closed month (an open one would ignore it; dropping it keeps the call honest).
    // Nothing ticked: no override to judge, so no extra read; the domain gates and posts as before.
    let periodOverride: ReturnType<typeof readPeriodOverride>;
    if (formData.get('periodOverrideConfirm') === 'on') {
      const invoice = await withOrgPrincipal(actor.orgId, async (tx) => {
        const found = await apRepo.getSupplierInvoiceById(tx, actor.orgId, id);
        if (found) await authorize(tx, actor, 'verify_supplier_invoice', { storeId: found.storeId });
        return found;
      });
      const inClosedMonth = !!invoice && !!closedMonthOf(await closedMonths(actor.orgId), invoice.invoiceDate);
      if (inClosedMonth) {
        const problem = periodOverrideProblem(formData);
        if (problem) throw new Error(problem);
        periodOverride = readPeriodOverride(formData);
      }
    }
    await withOrgPrincipal(actor.orgId, (tx) =>
      verifyInvoice(
        tx,
        actor,
        id,
        {
          supplier: formData.get('attestSupplier') === 'on',
          invoice: formData.get('attestInvoice') === 'on',
          items: formData.get('attestItems') === 'on',
          price: formData.get('attestPrice') === 'on',
        },
        periodOverride ? { periodOverride } : undefined,
      ),
    );
  } catch (err) {
    return await redirectWithFlash(`/ap/invoices/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/ap/invoices/${id}`, {}, { stamp: 'VERIFIED', ok: 'Verified. Expenses can now be recorded against it.' });
}

export async function voidInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'invoiceId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this invoice is being voided.');
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'supplier_invoice', id, ['void_supplier_invoice']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'void_supplier_invoice' });
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await voidInvoice(tx, actor, { invoiceId: id, reason });
      await recordApproval(tx, actor, approval, { capability: 'void_supplier_invoice', entityType: 'supplier_invoice', entityId: id, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash(`/ap/invoices/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/ap/invoices/${id}`, {}, { stamp: 'VOID', ok: 'Voided — every linked expense was reversed with it.' });
}

export interface AutoAllocateRequest {
  supplierId: string;
  storeId: string;
  amount: string;
  /** Boxes the operator has already typed into, by hand — never re-filled (Ian's ruling 2). */
  typed: { expenseId: string; amount: string }[];
}

export type AutoAllocateResponse =
  | { ok: true; allocations: { expenseId: string; amountApplied: string }[]; unallocated: string }
  | { ok: false; error: string };

/**
 * T-330 — "Auto-allocate (oldest first)" for a supplier payment. Mirrors
 * `previewSettlementAction`'s shape: called imperatively from the form so the proposal is on
 * screen before "Record payment" is pressed, and it computes nothing itself —
 * `suggestPaymentAllocation` is read-only (invariant 5); `recordPayment` is the one posting path.
 */
export async function autoAllocatePaymentAction(req: AutoAllocateRequest): Promise<AutoAllocateResponse> {
  const actor = await requireActor();
  try {
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const open = await apRepo.openItems(tx, actor.orgId, req.supplierId, req.storeId);
      const keys = await apRepo.orderingKeysForExpenses(tx, actor.orgId, open.map((o) => o.expenseId));
      return suggestPaymentAllocation(
        tx,
        actor,
        req.storeId,
        req.amount,
        open,
        keys,
        req.typed.map((t) => {
          // T-343 S5.5n / DEF-459 — logged before rethrowing: a malformed allocation amount is a
          // real-world typo worth seeing in the logs, not only on the screen the throw already
          // reaches.
          let amount: ReturnType<typeof parseMoneyInput>;
          try {
            amount = parseMoneyInput(t.amount, `suggestPaymentAllocation: the amount typed for expense ${t.expenseId}`, 'An amount you typed against an invoice');
          } catch (err) {
            logger.info({ err }, 'suggestPaymentAllocation: malformed allocation amount');
            throw err;
          }
          return { id: t.expenseId, amount };
        }),
      );
    });
    return { ok: true, allocations: result.allocations, unallocated: result.unallocated };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const supplierId = str(formData, 'supplierId');
  const storeId = str(formData, 'storeId');
  let message = '';
  try {
    if (!storeId) throw new Error('Choose a store.');
    const expenseIds = formData.getAll('allocateExpenseId').map(String);
    // T-328/7th-shape — this used to be `.filter((a) => a.amountApplied && Number(a.amountApplied) > 0)`.
    // `Number('abc') > 0` is false, so a mistyped allocation was silently dropped: no message, the
    // line just didn't exist, and the operator believed it had been recorded. Blank is still
    // skipped here (an unticked expense); anything else is left for `recordPayment`'s own
    // `parseMoneyInput` to accept or refuse with a readable sentence.
    const allocations = expenseIds
      .map((expenseId) => ({
        expenseId,
        amountApplied: str(formData, `allocateAmount_${expenseId}`),
      }))
      .filter((a) => a.amountApplied);

    // T-432 ruling 3: `source` is `float:<cashRequestId>` or a money account id. For a float the SERVER picks the
    // staff cash account of the POSTED store and ignores any posted account / request field; the domain judges the rest.
    const source = str(formData, 'source');
    let sourceAccountId = str(formData, 'moneyAccountId');
    let sourceRequestId: string | null = str(formData, 'cashRequestId') || null;
    const FLOAT_PREFIX = 'float:';
    if (source.startsWith(FLOAT_PREFIX)) {
      const requestId = source.slice(FLOAT_PREFIX.length);
      if (!UUID_SHAPE.test(requestId)) {
        throw new Error('That cash request could not be found. Refresh the page and pick it again.');
      }
      const staffCash = await withOrgPrincipal(actor.orgId, (tx) =>
        moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId, custodian: 'staff', instrument: 'cash' }),
      );
      if (!staffCash[0]) {
        throw new Error('This store has no staff cash account, so a cash request cannot pay a supplier here yet.');
      }
      sourceAccountId = staffCash[0].id;
      sourceRequestId = requestId;
    } else if (source) {
      sourceAccountId = source;
      sourceRequestId = null;
    }

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordPayment(tx, actor, {
        storeId,
        supplierId,
        businessDate: str(formData, 'businessDate'),
        amount: str(formData, 'amount'),
        moneyAccountId: sourceAccountId,
        cashRequestId: sourceRequestId,
        referenceNo: str(formData, 'referenceNo') || null,
        notes: str(formData, 'notes') || null,
        allocations,
      }),
    );
    message = `Paid. ₱${result.allocated} allocated${compare(money(result.unallocated), ZERO) > 0 ? `, ₱${result.unallocated} to supplier advance (overpayment)` : ''}.`;
    if (result.warning) message += ` ⚠️ ${result.warning}`;
  } catch (err) {
    return await redirectWithFlash(`/ap/suppliers/${supplierId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/ap/suppliers/${supplierId}`, {}, { ok: message });
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * T-369 S0 (DEF-550). The bill page's void panel posts here. ⛔ The reason is NOT checked here: the
 * domain's own sentence is the only one (I1/I7). The return path is built from ids that pass a uuid
 * shape check, never from a URL the form supplies.
 */
export async function voidPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const paymentId = str(formData, 'paymentId');
  const supplierId = str(formData, 'supplierId');
  const invoiceId = str(formData, 'invoiceId');
  const returnTo = UUID_SHAPE.test(invoiceId)
    ? `/ap/invoices/${invoiceId}`
    : UUID_SHAPE.test(supplierId)
      ? `/ap/suppliers/${supplierId}`
      : '/ap';
  let message: string;
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'ap_payment', paymentId, ['record_ap_payment']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'record_ap_payment' });
    const voided = await withOrgPrincipal(actor.orgId, async (tx) => {
      // Read in the same transaction, before the void, only to word the banner.
      const payment = await apRepo.getApPaymentById(tx, actor.orgId, paymentId);
      await voidPayment(tx, actor, {
        paymentId,
        reason: str(formData, 'reason'),
        ...(str(formData, 'voidOn') ? { voidOn: str(formData, 'voidOn') } : {}),
      });
      await recordApproval(tx, actor, approval, { capability: 'record_ap_payment', entityType: 'ap_payment', entityId: paymentId, storeId: target.storeId });
      return payment?.amount;
    });
    message = `Payment${voided ? ` of ${formatMoney(money(voided))}` : ''} voided — reversed, not deleted. The bills it paid are owed again.`;
  } catch (err) {
    return await redirectWithFlash(returnTo, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(returnTo, {}, { stamp: 'VOID', ok: message });
}
