'use server';

/**
 * Server actions for the AP screens — suppliers, supplier invoices, payments. T-130.
 *
 * ⛔ The gates live in the services, not here — same discipline as liabilities/actions.ts.
 */
import { redirect } from 'next/navigation';
import { apRepo } from '@shareat/db';
import { parseMoneyInput } from '@shareat/domain/money-input';
import { logger } from '@shareat/core/logger';
import { formatMoney, money } from '@shareat/core/money';
import {
  createSupplier,
  editSupplier,
  recordInvoice,
  setInvoiceLines,
  uploadFile,
  type InvoiceLineDraft,
  type UnrecognisedTermsMode,
  verifyInvoice,
  voidInvoice,
  recordPayment,
  voidPayment,
  suggestPaymentAllocation,
} from '@shareat/domain';
import { withOrgPrincipal, INVOICE_LINE_ROWS } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
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
    back(path, { error: errorMessage(err) });
  }
  back(path, { ok: 'Supplier updated.' });
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
    back('/ap', { error: errorMessage(err) });
  }
  back('/ap', { ok: `Supplier recorded.`, supplier: id });
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
        notes: str(formData, 'notes') || null,
        receiptFileId,
      });
    });
    id = result.id;
    warning = result.duplicateWarning ?? '';
  } catch (err) {
    back('/ap', { error: errorMessage(err) });
  }
  back(`/ap/invoices/${id}`, warning ? { ok: 'Invoice logged.', warning } : { ok: 'Invoice logged.' });
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
        lineTotal: (Number(quantity) * Number(unitPrice)).toFixed(2),
      });
    }
    await withOrgPrincipal(actor.orgId, (tx) => setInvoiceLines(tx, actor, invoiceId, lines));
  } catch (err) {
    back(`/ap/invoices/${invoiceId}`, { error: errorMessage(err) });
  }
  back(`/ap/invoices/${invoiceId}`, { ok: 'Lines saved. Prices now feed the item history.' });
}

export async function verifyInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'invoiceId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      verifyInvoice(tx, actor, id, {
        supplier: formData.get('attestSupplier') === 'on',
        invoice: formData.get('attestInvoice') === 'on',
        items: formData.get('attestItems') === 'on',
        price: formData.get('attestPrice') === 'on',
      }),
    );
  } catch (err) {
    back(`/ap/invoices/${id}`, { error: errorMessage(err) });
  }
  back(`/ap/invoices/${id}`, { ok: 'Verified. Expenses can now be recorded against it.' });
}

export async function voidInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'invoiceId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this invoice is being voided.');
    await withOrgPrincipal(actor.orgId, (tx) => voidInvoice(tx, actor, { invoiceId: id, reason }));
  } catch (err) {
    back(`/ap/invoices/${id}`, { error: errorMessage(err) });
  }
  back(`/ap/invoices/${id}`, { ok: 'Voided — every linked expense was reversed with it.' });
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

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordPayment(tx, actor, {
        storeId,
        supplierId,
        businessDate: str(formData, 'businessDate'),
        amount: str(formData, 'amount'),
        moneyAccountId: str(formData, 'moneyAccountId'),
        cashRequestId: str(formData, 'cashRequestId') || null,
        referenceNo: str(formData, 'referenceNo') || null,
        notes: str(formData, 'notes') || null,
        allocations,
      }),
    );
    message = `Paid. ₱${result.allocated} allocated${Number(result.unallocated) > 0 ? `, ₱${result.unallocated} to supplier advance (overpayment)` : ''}.`;
    if (result.warning) message += ` ⚠️ ${result.warning}`;
  } catch (err) {
    back(`/ap/suppliers/${supplierId}`, { error: errorMessage(err) });
  }
  back(`/ap/suppliers/${supplierId}`, { ok: message });
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
    const voided = await withOrgPrincipal(actor.orgId, async (tx) => {
      // Read in the same transaction, before the void, only to word the banner.
      const payment = await apRepo.getApPaymentById(tx, actor.orgId, paymentId);
      await voidPayment(tx, actor, {
        paymentId,
        reason: str(formData, 'reason'),
        ...(str(formData, 'voidOn') ? { voidOn: str(formData, 'voidOn') } : {}),
      });
      return payment?.amount;
    });
    message = `Payment${voided ? ` of ${formatMoney(money(voided))}` : ''} voided — reversed, not deleted. The bills it paid are owed again.`;
  } catch (err) {
    back(returnTo, { error: errorMessage(err) });
  }
  back(returnTo, { ok: message });
}
