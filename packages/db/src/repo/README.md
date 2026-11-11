# PostgreSQL repositories

## Overview

SQL and row-level operations for the business modules. The package barrel exposes repository namespaces; callers supply the transaction and business intent.

## Interface

- [access.ts](./access.ts): includes `RoleName`, `ActiveRoleRow`, `activeRoleForPerson`, `hasActiveAdmin`, `personIsActiveAdmin`, `personIsTerminal`, `listActiveAdminsWithPinState`, `hasOtherActiveAdmin`, `hasOtherActiveAdminWhoCanSignIn`, `lockOrgAccess`, `insertRole`, `revokeActiveRole`.
- [advisory-locks.ts](./advisory-locks.ts): includes `lockStoreCashCustody`, `lockReimbursementPayee`, `lockServiceChargeFloat`, `lockSupplierCredit`, `lockInterStorePair`, `lockDualRunWeek`, `lockPersonLeave`.
- [ap.ts](./ap.ts): includes `AP_CONTROL_CODE`, `ADVANCES_CODE`, `PARTY_TYPE`, `FULLY_RECORDED_TOLERANCE`, `SupplierRow`, `insertSupplier`, `getSupplierById`, `listSuppliers`, `updateSupplier`, `SupplierInvoiceRow`, `InsertSupplierInvoiceInput`, `insertSupplierInvoice`.
- [ar.ts](./ar.ts): includes `AR_CONTROL_CODE`, `STORE_CREDIT_CODE`, `BAD_DEBT_CODE`, `PLATFORM_FEE_CODE`, `PARTY_TYPE`, `ArChargeRow`, `InsertChargeInput`, `insertCharge`, `getChargeById`, `markChargePosted`, `markChargeVoided`, `ArPosition`.
- [attendance-adjustments.ts](./attendance-adjustments.ts): includes `AttendanceAdjustmentRow`, `InsertAdjustmentInput`, `nextAdjustmentId`, `listLive`, `listAll`, `findLiveOfKind`, `insertAdjustment`, `markSuperseded`.
- [master-links.ts](./master-links.ts): includes `MasterLinkRow`, `MasterLinkInput`, `linksFor`, `insertLink`.

## Invariants

- Keep business authorization above repositories; access.ts explicitly has no capability knowledge and must not import @shareat/auth.
- Pass the intended transaction/principal and retain each repository's org/store predicates. RLS and same-org foreign keys backstop rather than replace those predicates.
- Balances in AP and AR are derived from journal lines, not maintained totals.
- Use the declared advisory-lock keys and acquire the relevant lock before reading a cap that concurrent writers consume.

## Side Effects

- Repository calls read and mutate PostgreSQL rows and may acquire row or transaction advisory locks.
- Transaction ownership belongs to calling services except named client/principal helpers; SQL alone does not establish authorization.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
- Contract scan samples entry/schema files first (50 KB per directory, at most 300 lines per implementation); consult the owning source before changing an unlisted operation.
