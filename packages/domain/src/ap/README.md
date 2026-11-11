# Accounts Payable
## Overview
Suppliers, supplier invoices and AP payments (T-130, gate retimed by T-196). Owns the supplier master, invoice recording/verification/voiding, payment allocation and the `2110` control account. Every AP figure is summed live from `journal_lines`, never stored; SQL lives in `packages/db/src/repo/ap.ts` and this file owns the rules and transactions.

## Interface
- `index.ts`: `AP_CONTROL_CODE`, `ADVANCES_CODE`, `createSupplier`, `editSupplier`, `setSupplierCounterpartyStore`, `reconcileSupplier`, `recordInvoice`, `setInvoiceLines`, `verifyInvoice`, `voidInvoice`, `recordExpenseForInvoice`, `recordPayment`, `voidPayment`, `suggestPaymentAllocation`, types `CreateSupplierInput`, `UnrecognisedTermsMode`, `EditSupplierInput`, `RecordInvoiceInput`, `RecordInvoiceResult`, `VerifyInvoiceAttestation`, `RecordExpenseForInvoiceInput`, `RecordExpenseForInvoiceResult`, `ApPaymentAllocationInput`, `RecordApPaymentInput`, `RecordApPaymentResult`, `ApOrderingKeys`, `SuggestApAllocationResult`.

## Invariants
- No expense, cash or credit, may POST until its supplier invoice is `verified`. Since T-196 this is a posting gate: a draft may sit against a `pending` invoice, and `verifyInvoice` posts every draft standing against it. `approveExpense` is the only posting path.
- `recordExpenseForInvoice` calls `createExpense` then `approveExpense` in one transaction; it authorizes on both capabilities, so only a role holding both can use the shortcut.
- `voidInvoice` reuses `voidExpense` (which handles budget release, cash-request liquidation, projections, CAPEX guards); it never reverses legs inline.
- Payment allocation uses `allocateOldestFirst`; a surplus becomes `1240` Advances to suppliers.
- Balances are never stored; they are summed from `journal_lines`.
- Refusals are `refuse(...)` with a plain sentence for the user.

## Side Effects
- Writes suppliers, invoices, invoice lines, payments and allocations via `apRepo`; appends `audit_log` rows.
- Posts and reverses journal entries (through expenses and the ledger); checks overdraft via `money-accounts`.
- Reads the clock (`new Date()`) when reconciling a supplier.
- Opens a transaction via `transaction(...)` when `tx` is `null`.
- Authorizes `approve_supplier`, `record_supplier_invoice`, `verify_supplier_invoice`, `void_supplier_invoice`, `record_ap_payment`, `apply_supplier_credit`, `transfer_funds`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
