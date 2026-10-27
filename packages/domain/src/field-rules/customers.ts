/**
 * T-440 field rules for app/customers. Created empty in S1 (Audit A9) so no sweep worker edits index.ts.
 * The sweep adds: export const <NAME>_RULES = defineFieldRules('<area>.<form>', { ... }) here, importing from './check'.
 */

import { defineFieldRules } from './check';
import { SUPPLIER_ADD_RULES } from './ap';

/** "Record a customer" on /customers (createCustomerAction). */
export const CUSTOMER_ADD_RULES = defineFieldRules('customers.createCustomer', {
  name: { label: 'The customer name', kind: 'text', requires: 'A customer needs a name people will recognise.' },
  /** T-398 S5c: the supplier rule itself (whole number 0 to 365, judged only when terms mode is On credit). Displayed; never used by the credit gate. */
  creditTermsDays: SUPPLIER_ADD_RULES.creditTermsDays,
});

/** The "Anchor" box on each customer row (reconcileCustomerAction). */
export const CUSTOMER_RECONCILE_RULES = defineFieldRules('customers.reconcileCustomer', {
  asOf: { label: 'The date they were verified at zero', kind: 'date', requires: 'Say which date they were verified at zero.' },
});

/** "New price list" (createPriceListAction). */
export const PRICE_LIST_ADD_RULES = defineFieldRules('customers.createPriceList', {
  name: { label: 'The price list name', kind: 'text', requires: 'A price list needs a name.' },
});

/** "Set a rate" on a price list (setPriceAction). Zero is allowed: a sample is genuinely free. */
export const PRICE_SET_RULES = defineFieldRules('customers.setPrice', {
  itemId: { label: 'The item', kind: 'text', requires: 'Choose an item.' },
  rate: { label: 'The rate', kind: 'money', min: 0, rangeSays: 'A rate cannot be negative. A negative price is a discount.' },
});

/** "Record payment" on a customer page (recordCollectionAction). The per-charge allocation boxes are a repeated-line family (S8). */
export const COLLECTION_RECORD_RULES = defineFieldRules('customers.recordCollection', {
  amount: { label: 'The amount collected', kind: 'money', min: 0.01, requires: 'The amount collected must be an amount greater than zero.' },
  platformFee: { label: 'The platform fee', optional: true, kind: 'money', min: 0 },
  collectionDate: { label: 'The collection date', kind: 'date' },
  moneyAccountId: { label: 'The account', kind: 'text', requires: 'Choose the account the money went into.' },
  creditApplied: { label: 'The store credit applied', optional: true, kind: 'money', min: 0 },
});

/** "Write off" a charge (writeOffChargeAction). */
export const CHARGE_WRITE_OFF_RULES = defineFieldRules('customers.writeOffCharge', {
  amount: { label: 'The write-off amount', kind: 'money', min: 0.01, requires: 'The write-off amount must be an amount greater than zero.' },
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this debt is uncollectible — a write-off without a reason is a hole.' },
});

/** "Void this charge" (voidChargeAction). */
export const CHARGE_VOID_RULES = defineFieldRules('customers.voidCharge', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this charge is being voided.' },
});

/** "Void collection" on a collections row (voidCollectionAction). */
export const COLLECTION_VOID_RULES = defineFieldRules('customers.voidCollection', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this collection is being voided.' },
});
