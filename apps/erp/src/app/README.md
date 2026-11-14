# app

## Overview

App Router pages, route handlers and server-action adapters for the ERP. Root layout and recovery boundaries wrap the signed-in dashboard and module screens.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/`; dynamic route segments are supplied through App Router params.
- [error.tsx](./error.tsx) — `ErrorBoundary`.
- [global-error.tsx](./global-error.tsx) — `GlobalError`.
- [layout.tsx](./layout.tsx) — `RootLayout`.
- [loading.tsx](./loading.tsx) — `Loading`.
- [not-found.tsx](./not-found.tsx) — `NotFound`.
- [page.tsx](./page.tsx) — `DashboardPage`.
- [admin](./admin/README.md) — Route namespace `/admin`. Organization, store, user and position-default administration.
- [ap](./ap/README.md) — Accounts payable at `/ap`. Supplier register, supplier invoice verification and accounts-payable payments.
- [api](./api/README.md) — Route namespace `/api`. ERP HTTP endpoints: health diagnostics and the development-only fixture-backed POS bridge.
- [attendance](./attendance/README.md) — Attendance review at `/attendance`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.
- [budgets](./budgets/README.md) — Budgets at `/budgets`. Category spending envelopes and their current use.
- [cash-requests](./cash-requests/README.md) — Cash requests at `/cash-requests`. Cash-request approval, release, settlement and ledger-derived float positions.
- [channel-settlements](./channel-settlements/README.md) — Channel settlements at `/channel-settlements`. Sales-channel payout previews, deductions, destination accounts and settlement recording.
- [clock](./clock/README.md) — Handlers and helpers at `/clock`. Offline attendance kiosk using device-authenticated Firebase client SDK reads and queued punches.
- [commissary](./commissary/README.md) — Route namespace `/commissary`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.
- [customers](./customers/README.md) — Customers at `/customers`. Customer credit, receivables, collections and wholesale price lists.
- [cutover](./cutover/README.md) — The conversion at `/cutover`. Conversion checklist, counted opening stock and opening balance-sheet figures.
- [dashboard](./dashboard/README.md) — Handlers and helpers at `/dashboard`. Pure inclusive business-date range helpers used by the ERP dashboard.
- [expenses](./expenses/README.md) — Expenses at `/expenses`. Expense drafts, posting, recurring templates and staff reimbursement payouts.
- [files](./files/README.md) — Route namespace `/files`. Authenticated upload and purpose-scoped evidence viewing routes.
- [findings](./findings/README.md) — Findings at `/findings`. Derived integrity observations, acknowledgements, close controls and response scorecards.
- [fixed-assets](./fixed-assets/README.md) — Fixed assets at `/fixed-assets`. Asset register, service dates, depreciation, disposal and opening valuation.
- [inventory](./inventory/README.md) — Stock on hand at `/inventory`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [items](./items/README.md) — Items at `/items`. Stock item master, variants, units, lifecycle and store sellability overrides.
- [liabilities](./liabilities/README.md) — Liabilities at `/liabilities`. Liability charges, payments and ledger-derived unpaid obligations.
- [loans](./loans/README.md) — Loans at `/loans`. Loan creation, disbursement, repayment and ledger-derived positions.
- [menu](./menu/README.md) — Menu at `/menu`. Menu catalogue, store prices, item requests and POS depletion-source controls.
- [money-accounts](./money-accounts/README.md) — Money accounts at `/money-accounts`. Money-account creation, naming and retirement with custody/instrument labels.
- [money-transfers](./money-transfers/README.md) — Money transfers at `/money-transfers`. Movement between money accounts and settlement between stores.
- [owners](./owners/README.md) — Owners at `/owners`. Owner contributions, drawings, receivable settlement and monthly close.
- [payroll](./payroll/README.md) — Payroll at `/payroll`. Pay-run previews and posting, effective-dated statutory reference rates and final/13th-month pay.
- [prepaid](./prepaid/README.md) — Prepaid expenses at `/prepaid`. Prepaid cost register, term confirmation, amortisation and write-off.
- [remittance](./remittance/README.md) — Remittance at `/remittance`. Cashier-to-office handover, variance resolution and cash-custody policy.
- [reports](./reports/README.md) — Handlers and helpers at `/reports`. Authorized financial report scopes, rendered statements, reconciliation and CSV exports.
- [sales-days](./sales-days/README.md) — Sales days at `/sales-days`. Manual or imported sales days, submission, verification and POS correction workflows.
- [service-charge](./service-charge/README.md) — Service charge at `/service-charge`. Ledger-derived service-charge float and distribution.
- [settings](./settings/README.md) — Settings at `/settings`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [setup](./setup/README.md) — Set up Shareat System at `/setup`. First-organization bootstrap from a verified setup identity.
- [sign-in](./sign-in/README.md) — Handlers and helpers at `/sign-in`. Email/Firebase, provisioned terminal and paired-tablet sign-in and session lifecycle.
- [staff](./staff/README.md) — Staff at `/staff`. Store-scoped staff roster, hiring, employment details and credential enrollment.
- [statutory-discounts](./statutory-discounts/README.md) — SC/PWD register at `/statutory-discounts`. SC/PWD discount recording and voiding register.
- [till](./till/README.md) — Till custody at `/till`. Till shifts, observed counts, close and staff-shortage charging.
- [trade](./trade/README.md) — Route namespace `/trade`. Wholesale order fulfilment, delivery receipt printing and customer returns.
- [wastage](./wastage/README.md) — Order wastage at `/wastage`. Order/channel wastage recording, dispute, settlement matching and charge reversal.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- `reportScope` resolves the signed-in organization, report capability and allowed store scope before reading report data.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Repository calls: `lowStockRepo.lowStock`, `cashRequestsRepo.openFloats`, `attendanceDaysRepo.countOpenToday`, `commissaryKpisRepo.inFlightOrders`, `commissaryKpisRepo.openDisputes`, `commissaryKpisRepo.receivedInRange`. These execute through the surrounding transaction context.
- Uses Next request cookies; helper-specific reads/writes are in the linked implementation.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 6 local production/configuration files scanned; 24,342 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
