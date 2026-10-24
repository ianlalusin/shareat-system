/**
 * T-389 (DEF-617): the AP forms that keep what was typed after a refused save. Not a `'use server'` file, so the pages
 * and `ap/actions.ts` import the same definitions. Only user-editable controls are listed: never a hidden id.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/**
 * The supplier edit form. The record is the supplier id.
 * Q1 (Ian: kept conservative, bible row for T-389): `bankAccountNumber` is NOT listed and is also on the helper's
 * SENSITIVE list, so a refused save reopens with the stored number and this hint.
 */
export const SUPPLIER_EDIT = defineTypedForm({
  form: 'supplier.edit',
  fields: [
    'name',
    'representativeName',
    'contactNo',
    'email',
    'address',
    'tin',
    'vatStatus',
    'classification',
    'status',
    'issuesOfficialReceipt',
    'termsMode',
    'creditTermsDays',
    'bankName',
    'bankAccountName',
    'notes',
  ],
  notKeptHint: 'The account number is not kept after a refused save. Check it before saving.',
});

/** The invoice lines form: 5 rows x 5 controls. The record is the invoice id. `line<i>_description` is not a control. */
export const INVOICE_LINES = defineTypedForm({
  form: 'invoice.lines',
  fields: [/^line[1-5]_(itemId|quantity|purchaseUnit|conversionFactor|unitPrice)$/],
});

/**
 * T-475 R14: the verify form. A refused verify (a missing tick, an unmapped draft, a closed month) reopens with the four
 * ticks and the closed-month override still filled in. The record is the invoice id.
 */
export const VERIFY_INVOICE = defineTypedForm({
  form: 'ap.verifyInvoice',
  fields: ['attestSupplier', 'attestInvoice', 'attestItems', 'attestPrice', 'periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote'],
});
