# ap

## Overview

Accounts payable at `/ap`. Supplier register, supplier invoice verification and accounts-payable payments.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/ap`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `listSuppliers`, `getSupplier`, `SupplierWithPosition`, `listSuppliersWithPosition`, `listInvoices`, `getInvoice`, `InvoicePickerOption`, `listOpenInvoicesForPicker`, `listOpenItems`, `getPosition`, `storesWithOpenItems`, `moneyAccountsFor`, `today`, `INVOICE_LINE_ROWS`, `itemPickerFor`, `whoSells`, `invoiceLines`, `maskAccountNumber`, `matchesSupplier`, `VAT_STATUS_LABEL`, `CLASSIFICATION_LABEL`, `peso`, `listStores`, `withOrgPrincipal`, `listCategoriesGrouped`, `StoreOption`.
- [actions.ts](./actions.ts) — `editSupplierAction`, `createSupplierAction`, `recordInvoiceAction`, `setInvoiceLinesAction`, `verifyInvoiceAction`, `voidInvoiceAction`.
- [page.tsx](./page.tsx) — `ApPage`.
- [typed-forms.ts](./typed-forms.ts) — `SUPPLIER_EDIT`, `INVOICE_LINES`.
- [invoices](./invoices/README.md) — Route namespace `/ap/invoices`. Supplier register, supplier invoice verification and accounts-payable payments.
- [suppliers](./suppliers/README.md) — Suppliers at `/ap/suppliers`. Supplier register, supplier invoice verification and accounts-payable payments.
- [vat](./vat/README.md) — Invoices by VAT type and OR at `/ap/vat`. Supplier register, supplier invoice verification and accounts-payable payments.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `recordInvoiceAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createSupplier`, `recordInvoice`, `setInvoiceLines`, `claimUpload`, `recordInvoiceAction`; persistence or external operations belong to those called services.
- Repository calls: `apRepo.listSuppliers`, `apRepo.getSupplierById`, `apRepo.positionOf`, `apRepo.listSupplierInvoices`, `apRepo.getSupplierInvoiceById`, `apRepo.capacityOf`, `apRepo.openItems`, `moneyAccountsRepo.listMoneyAccounts`, `moneyAccountsRepo.balanceOf`, `itemsRepo.listItems`, `itemsRepo.itemsForSupplier`, `itemsRepo.suppliersForItem`, `itemsRepo.linesForInvoice`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 35,598 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
