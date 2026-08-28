'use server';

/**
 * Server actions for the AP screens — suppliers, supplier invoices, payments. T-130.
 *
 * ⛔ The gates live in the services, not here — same discipline as liabilities/actions.ts.
 */
import { redirect } from 'next/navigation';
import {
  createSupplier,
  recordInvoice,
  verifyInvoice,
  voidInvoice,
  recordPayment,
  voidPayment,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
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
      }),
    );
    id = created.id;
  } catch (err) {
    back('/ap', { error: errorMessage(err) });
  }
  back('/ap', { ok: `Supplier recorded.`, supplier: id });
}

export async function recordInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let id = '';
  let warning = '';
  try {
    if (!storeId) throw new Error('Choose a store.');
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordInvoice(tx, actor, {
        storeId,
        supplierId: str(formData, 'supplierId'),
        invoiceNo: str(formData, 'invoiceNo') || null,
        invoiceDate: str(formData, 'invoiceDate'),
        dueDate: str(formData, 'dueDate') || null,
        totalAmount: str(formData, 'totalAmount'),
        notes: str(formData, 'notes') || null,
        receiptPhotoUrl: str(formData, 'receiptPhotoUrl') || null,
      }),
    );
    id = result.id;
    warning = result.duplicateWarning ?? '';
  } catch (err) {
    back('/ap', { error: errorMessage(err) });
  }
  back(`/ap/invoices/${id}`, warning ? { ok: 'Invoice logged.', warning } : { ok: 'Invoice logged.' });
}

export async function verifyInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'invoiceId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => verifyInvoice(tx, actor, id));
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

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const supplierId = str(formData, 'supplierId');
  const storeId = str(formData, 'storeId');
  let message = '';
  try {
    if (!storeId) throw new Error('Choose a store.');
    const expenseIds = formData.getAll('allocateExpenseId').map(String);
    const allocations = expenseIds
      .map((expenseId) => ({
        expenseId,
        amountApplied: str(formData, `allocateAmount_${expenseId}`),
      }))
      .filter((a) => a.amountApplied && Number(a.amountApplied) > 0);

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

export async function voidPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const paymentId = str(formData, 'paymentId');
  const supplierId = str(formData, 'supplierId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this payment is being voided.');
    await withOrgPrincipal(actor.orgId, (tx) => voidPayment(tx, actor, { paymentId, reason }));
  } catch (err) {
    back(`/ap/suppliers/${supplierId}`, { error: errorMessage(err) });
  }
  back(`/ap/suppliers/${supplierId}`, { ok: 'Payment voided — reversed, not deleted.' });
}
