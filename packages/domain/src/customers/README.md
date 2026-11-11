# Customers
## Overview
Customers and price lists (T-129, ADR-008): wholesale/credit counterparties, not retail diners. A customer exists only because a balance or credit relationship does. Owns create, status, reconcile, price lists and prices.

## Interface
- `index.ts`: `treatmentOf` (re-exported from `@shareat/db`), `createCustomer`, `setCustomerStatus`, `reconcileCustomer`, `createPriceList`, `setPrice`, type `CreateCustomerInput`.

## Invariants
- A retail diner is not a customer.
- Treatment is derived from links: `counterparty_store_id` means internal (eliminates), `counterparty_org_id` means inter-entity (real revenue), neither means external. `customer_group` never decides treatment.
- At most one of `counterpartyStoreId` / `counterpartyOrgId` may be set (refused here and by a CHECK).
- All writes authorize `manage_chart_of_accounts`.

## Side Effects
- Writes customers, price lists and prices via `customersRepo`; appends `audit_log` rows.
- `reconcileCustomer` stamps `reconciledAt` with `new Date()`.
- Opens a transaction via `transaction(...)` when `tx` is `null`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
