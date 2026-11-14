# payroll

## Overview

Payroll at `/payroll`. Pay-run previews and posting, effective-dated statutory reference rates and final/13th-month pay.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/payroll`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `preview`, `payrollStoresFor`, `runsFor`, `slipsFor`, `rosterFor`, `premiumSettingsFor`, `cashAccountsFor`, `periodsForMonth`, `currentPeriod`, `periodLabel`, `peso`, `listStores`, `withOrgPrincipal`, `listActingPersons`, `StoreOption`, `PayRunRow`, `PayslipRow`, `PayRunPreview`, `PayPeriod`, `derivePeriods`, `payoutDateFor`.
- [actions.ts](./actions.ts) — `setPayRateAction`, `postPayRunAction`, `voidPayRunAction`.
- [page.tsx](./page.tsx) — `PayrollPage`.
- [rates](./rates/README.md) — Payroll rates at `/payroll/rates`. Pay-run previews and posting, effective-dated statutory reference rates and final/13th-month pay.
- [separations](./separations/README.md) — Separations at `/payroll/separations`. Pay-run previews and posting, effective-dated statutory reference rates and final/13th-month pay.
- [thirteenth-month](./thirteenth-month/README.md) — 13th-month pay at `/payroll/thirteenth-month`. Pay-run previews and posting, effective-dated statutory reference rates and final/13th-month pay.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `postPayRun`, `setPayRate`, `voidPayRun`, `recordApproval`, `postPayRunAction`, `setPayRateAction`, `voidPayRunAction`; persistence or external operations belong to those called services.
- Repository calls: `payrollRepo.listPayRuns`, `payrollRepo.getPayRun`, `payrollRepo.listPayslips`, `payrollRepo.employmentsForStore`, `payrollRepo.rateInForceOn`, `attendanceConfigRepo.findLive`, `moneyAccountsRepo.listMoneyAccounts`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 23,257 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
