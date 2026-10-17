/**
 * T-440 field rules for app/ap. The supplier ADD form (CheckedForm on /ap). There is no TIN on this form (Audit A10);
 * "required when On credit" is cross-field and stays a server refusal (Q4).
 */
import { defineFieldRules } from './check';

export const SUPPLIER_ADD_RULES = defineFieldRules('ap.createSupplier', {
  name: { label: 'The supplier name', kind: 'text', requires: 'A supplier needs a name people will recognise.' },
  creditTermsDays: { label: 'Days to pay', optional: true, kind: 'number', integer: true, min: 0, max: 365 },
});

/** The "Log a supplier invoice" form on /ap (recordInvoiceAction). Cross-field checks (due before invoice date, fees over the total, VAT type) stay in the domain (Q4). */
export const SUPPLIER_INVOICE_LOG_RULES = defineFieldRules('ap.recordInvoice', {
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  supplierId: { label: 'The supplier', kind: 'text', requires: 'Choose a supplier.' },
  totalAmount: { label: 'The invoice total', kind: 'money', min: 0.01, requires: 'The invoice total must be an amount greater than zero.' },
  deliveryFee: { label: 'The delivery fee', optional: true, kind: 'money', min: 0 },
  otherFees: { label: 'The other fees', optional: true, kind: 'money', min: 0 },
  invoiceDate: { label: 'The invoice date', kind: 'date' },
  dueDate: { label: 'The due date', optional: true, kind: 'date' },
  vatAmount: { label: 'The VAT amount', optional: true, kind: 'money', min: 0 },
});

/** "Record a payment" on a supplier page (recordPaymentAction). The per-invoice allocation boxes are a repeated-line family (S8). */
export const SUPPLIER_PAYMENT_RULES = defineFieldRules('ap.recordPayment', {
  amount: { label: 'The payment amount', kind: 'money', min: 0.01, requires: 'The payment amount must be an amount greater than zero.' },
  source: { label: 'Where the money comes from', kind: 'text', requires: 'Choose where the money comes from.' },
  businessDate: { label: 'The payment date', kind: 'date' },
});

/** "Void invoice" on a bill page (voidInvoiceAction). */
export const INVOICE_VOID_RULES = defineFieldRules('ap.voidInvoice', {
  reason: { label: 'The void reason', kind: 'text', requires: 'Say why this invoice is being voided.' },
});

/** "Void this payment" (voidPaymentAction). The reversal date appears only for a payment in a closed month, and "required then" is the domain's. */
export const PAYMENT_VOID_RULES = defineFieldRules('ap.voidPayment', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this payment is being voided.' },
  voidOn: { label: 'The reversal date', optional: true, kind: 'date', requires: 'Pick a valid date for the reversal.' },
});

/** "Record an expense against this invoice" (recordInvoiceExpenseAction, which hands the post to the expense action). */
export const INVOICE_EXPENSE_RULES = defineFieldRules('ap.recordExpenseForInvoice', {
  categoryId: { label: 'The category', kind: 'text', requires: 'Choose a category.' },
  particulars: { label: 'The particulars', kind: 'text', requires: 'Particulars are required - say what the spend was for.' },
});
