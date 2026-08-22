# ERP-rebuild — Module & Route Discovery

Source: `C:\Users\ianla\webapps\ERP-rebuild` (Next.js 16 App Router, TS strict, Firebase, Tailwind/shadcn). Read-only pass over `src/app/**`, `src/components/**` (top level), `src/lib/routes.ts`, `src/components/shell/sidebar-nav.tsx`, root docs (`CLAUDE.md`, `AGENTS.md`, `README.md`), `docs/**`, `TODO-*.md`, and the existing Guardian map (`AGENTS/ERP Guardian/ERP_MAP.md`) for cross-check. `inactive projects` was not touched.

**Route surface:** 149 `page.tsx` (53,670 LOC total, ~360 LOC/page avg), 6 `layout.tsx`, 20 `api/**/route.ts`. Combined with detail-client companions behind thin `[id]` wrappers, effective UI surface is materially larger than the raw page-file count suggests (see §2 notes).

---

## 1. Module Map

| Module | Purpose | Route count |
|---|---|---|
| Auth & Account | Sign-in/up, approval-pending gate, local-user (kiosk) session, profile/security, searchable user manual | 10 |
| Dashboard | Home KPI/status dashboard (executive pulse) | 1 |
| Insights (AI) | AI-generated daily/period business briefings, flagged open-items log, manager-vs-manager comparison, responsiveness scoring | 4 |
| Performance | Ratio/trend/margin metering (manager) + store-wide employee leaderboard (all staff) | 2 |
| Activity Log | Audit trail of user actions, flaggable/annotatable | 1 |
| Financial | Sales reporting, receipts, expenses, recurring bills, suppliers, AP, AR, payments, cash requests | 22 |
| Cashier | Cashier-facing credit-sale + AR-collection entry | 1 |
| Accounting | Balance sheet, equity, liabilities (loans+reimbursement tab wrapper), assets (fixed+prepaid tab wrapper), loans, reimbursement | 7 |
| Inventory | Item master, stock balances, deliveries/receiving, usage, meat sub-ledger, production (cut/convert/cook), commissary↔branch ordering, POS↔stock mapping, stockroom/count sessions, assets, prepaid | 21 |
| Manager | Cash/bank accounts, budgets, channel settlement (Grab/FoodPanda), daily report/review, memos, cross-module reports hub, per-store settings hub, staff hub | 35 |
| Operation | Attendance/time-clock/biometrics, checklist, infractions, overtime, salary advance, payroll, wastages, (dead) staff-logs | 17 |
| Cookbook / Branch Cookbook / Production Recipes | Global recipe reference (commissary-authored), branch-facing read-only view, inventory-linked production recipes | 6 |
| Admin & Onboarding | User/store management, staff-identity linking, global configuration (expense entries, AI provider hub, attendance credentials, UI/UX preview), danger-zone settings, legacy-migration (deprecated), onboarding authoring/grading; staff-facing onboarding hub | 16 |
| API (non-page) | Session cookie mint, 9 cron endpoints, Flutter mobile-inventory bridge (8 routes), memo file streaming, wastage-email ingest | 20 |

Module boundaries below follow the physical `src/app/` top-level folders, which is also how `sidebar-nav.tsx` groups them (with a few cross-cutting exceptions noted inline — e.g. Payroll/Salary-Advance/Attendance live under `operation/` but are surfaced in the sidebar's **Staff Hub** tile group, and `financial/sales-report` is linked from the **Manager** nav group despite living at `/financial/...`).

---

## 2. Per-Route Inventory

Legend for **Type**: `list` (bounded/paginated collection view), `detail` (single-record view/workflow), `form` (create/edit surface, may be embedded in list or detail), `report` (read-only aggregation/printable), `dashboard` (KPI/mixed-widget landing), `hub` (link-out index page), `redirect` (routing shim only). **LOC** is `page.tsx` alone; where the page is a thin `[id]` wrapper delegating to a sibling `*-details-client.tsx` (a repo-wide convention), the companion file's LOC is added in parentheses.

### Auth & Account (10 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/login` | form | Firebase Auth | 35 | Thin wrapper around `LoginForm` |
| `/` (auth root) | redirect | — | 20 | Client-side role router: unauth→login, inactive→pending, else→dashboard |
| `/signup` | form | `users` (new profile) | 29 | Wraps `SignupForm` |
| `/pending` | dashboard | `users` (approval status) | 77 | Waiting-for-approval landing |
| `/welcome` | dashboard | — | 22 | Static post-signin card |
| `/home` | form | `localUsers` | 276 | Kiosk-style per-store local-user PIN switcher |
| `/local-user-login` | form | `localUsers` | 359 | Same pattern as `/home`, standalone route |
| `/account/profile` | form | Firebase Auth profile | 289 | Email/password/photo, Google account link |
| `/account/security` | form | Firebase Auth | 202 | Password change |
| `/account/manual` | report | static content | 541 | Searchable user manual (mirrors `docs/user-manual.md`); TODO comment: should render from the .md directly |
| `/activity-log` | list/report | `activityLogs` | 493 | Flag/comment/export on audit-trail entries |

### Dashboard (1 route)

| `/dashboard` | dashboard | `dashboardSummary` projection + live counts | 1110 | Executive KPI pulse; single largest "core" business page by LOC |

### Insights — AI briefing (4 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/insights` | hub | `dailyInsights`/`periodInsights` | 97 | Links to Daily/Period AI views (rendered via shared components, not sub-routes) |
| `/insights/compare` | report | `salesDays` + `oilDays` | 235 | Two-period comparison, one explicit AI call at the bottom |
| `/insights/flagged` | list/report | OIL (open-items-&-lapses) month slices | 339 | Grouped by month; per-month "managers' performance" modal |
| `/insights/performance` | report | manager scorecard | 198 | Manager-vs-manager responsiveness score, full-page version of the flagged-list modal |

### Performance (2 routes)

| `/performance` | report | `performanceSummary/live` projection | 469 | Margins/ratios/growth/utilities/cross-store; ~1 read on open, never rebuilds on mount |
| `/performance/team` | list (leaderboard) | `staffPerfMonth` projection | 424 | Store-wide, ALL staff see everyone's score; sensitive detail (conduct/₱) gated per-viewer |

### Financial (22 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/financial/sales-report` | dashboard/form | `salesDays`, `cashRemitShifts` | 1554 | **Largest page.tsx in the app.** Daily/shift sales entry + verification/remittance workflow |
| `/financial/sales-report/new` | form | `salesDays` | 382 | Create a day/shift sales report |
| `/financial/receipts` | list | `receipts` | 255 | |
| `/financial/receipts/[id]` | detail | `receipts` | 19 (+616) | Thin wrapper → `receipt-details-client.tsx` |
| `/financial/expenses` | list | `expenses` (ExpenseV2) | 304 | **Reference implementation** for `useFirestoreServerPagination` + `DateRangeSearch` (per `CURRENT_STATE.md`) |
| `/financial/expenses/[id]` | detail | `expenses` | 19 (+365) | → `expense-details-client.tsx` |
| `/financial/recurring-expenses` | list/form | `recurringExpenses` | 630 | Auto-pay bill definitions; feeds `/api/cron/recurring-expense-autopay` |
| `/financial/suppliers` | list | `suppliers` | 127 | |
| `/financial/suppliers/[id]` | detail | `suppliers` | 19 (+468) | → `supplier-details-client.tsx` |
| `/financial/ap` | list | AP aging projection (`ap_open`) | 179 | |
| `/financial/ap/[id]` | detail | AP by supplier | 20 (+523) | → `ap-details-client.tsx` |
| `/financial/ar` | list | AR customers | 310 | |
| `/financial/ar/[customerId]` | detail | AR customer ledger | 1027 | Second-largest financial page |
| `/financial/ar/[customerId]/tx/[transactionId]` | detail | AR transaction/credit sale | 334 | |
| `/financial/ar/[customerId]/col/[collectionId]` | detail | AR collection/payment | 711 | |
| `/financial/ar/aging` | report | AR aging buckets | 239 | |
| `/financial/payments` | list | supplier payments | 176 | |
| `/financial/payments/new` | form | supplier payment | 16 | Wraps `PaymentForm` |
| `/financial/payments/[supplierId]/[paymentId]` | detail | supplier payment | 21 (+419) | → `payment-details-client.tsx` |
| `/financial/payments/[supplierId]/[paymentId]/edit` | form | supplier payment | 72 | |
| `/financial/cash-requests` | list | `cashRequests` (petty cash) | 187 | |
| `/financial/cash-requests/[id]` | detail | `cashRequests` | 19 (+1192) | → `cash-request-details-client.tsx`; **largest detail-client in the app** (release→expense→return/shortage chain) |
| `/financial/payment-settings` | redirect | — | 4 | → `/manager/settings/payment-settings` |

### Cashier (1 route)

| `/cashier/credit-sales` | form/list | AR credit sales + collections | 1004 | Cashier-facing entry point into the AR module |

### Accounting (7 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/accounting/balance-sheet` | report | account balances / journal | 340 | Gated by `RequireFinancialReports` |
| `/accounting/equity` | list/form | owner equity accounts | 379 | |
| `/accounting/liabilities` | hub (tab wrapper) | — | 31 | Re-renders `LoansContent` + `ReimbursementContent` from the two routes below |
| `/accounting/assets` | hub (tab wrapper) | — | 31 | Re-renders `AssetsContent` (from `/inventory/assets`) + `PrepaidContent` (from `/inventory/prepaid`) |
| `/accounting/loans` | list/form | `loans` | 456 | |
| `/accounting/loans/[id]` | detail | loan + amortization schedule | 353 | |
| `/accounting/reimbursement` | list/form | `reimbursements` | 299 | |

### Inventory (21 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/inventory/items` | list/form | item master | 421 | |
| `/inventory/stocks` | report/dashboard | `itemBalances`/`inventoryBalances` | 686 | Per-location on-hand; branch reads not yet cut over to per-location (open gap, see §6) |
| `/inventory/deliveries` | list | `deliveries` | 397 | + supplier-returns card (`SupplierReturnsList`) |
| `/inventory/deliveries/[id]` | detail/form | delivery + `inventoryLedger` | 1365 | **Largest inventory page** — receive/void/allocate + per-line supplier return |
| `/inventory/usage` | form/list | `itemStockLedger` / usage records | 836 | Per-department daily usage; frozen-room warning |
| `/inventory/meat` | list | meat sub-ledger (slab/sliced) | 474 | |
| `/inventory/meat/[id]` | detail | `meatInventoryLedger` | 446 | Append-only across revisions (`:r{n}:` legs) |
| `/inventory/production` | list/form | production records (cut/convert) | 929 | |
| `/inventory/production/[id]` | detail | production record | 601 | |
| `/inventory/production/payments` | list/form | slicer/production-staff payments | 338 | |
| `/inventory/assets` | list/form | fixed assets (store-scoped) | 13 (+426) | → `assets-content.tsx`; also reused by `/accounting/assets` |
| `/inventory/prepaid` | list/form | prepaid expenses | 443 | Content reused by `/accounting/assets` |
| `/inventory/commissary` | list | commissary orders (commissary side) | 239 | |
| `/inventory/commissary/[id]` | detail | commissary order fulfilment | 1257 | Third-largest page in the app |
| `/inventory/commissary/items` | list/form | `commissaryItemConfig` (pricing) | 919 | Manager-only |
| `/inventory/commissary-import` | form | commissary item mapping bulk import | 242 | |
| `/inventory/commissary-mappings` | list/form | commissary↔branch item map | 519 | |
| `/inventory/branch-orders` | list | branch orders (branch/kiosk side) | 312 | |
| `/inventory/branch-orders/[id]` | detail | branch order + realtime `OrderChat`/`OrderLog` | 1027 | One of the few intentional realtime-listener surfaces |
| `/inventory/pos-mappings` | form | POS item → stock item map | 683 | One-time setup, manager-only |
| `/inventory/pos-usage` | form/list | POS sold-items → usage draft | 707 | Deliberately a full page, not a modal (sort/save-draft/hand-off workflow) |
| `/inventory/stockroom` | dashboard/form | `itemBalances` per location + count sessions | 800 | Start/advance/close count session; Frozen-room badges |

### Manager (35 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/manager/accounts` | list/dashboard | `accounts` (cash/bank/e-wallet) | 1287 | |
| `/manager/accounts/[domainKey]` | detail | cash-movement domain | 630 | |
| `/manager/accounts/online-accounts` | list/form | online payment accounts | 264 | |
| `/manager/accounts/snapshots` | report | `dailySummary` snapshots | 203 | Admin-oriented ledger-snapshot viewer |
| `/manager/budgets` | list | `expenseBudgets` | 271 | |
| `/manager/channel-settlements` | form/report | channel settlements + AR | 1317 | Grab/FoodPanda payout reconciliation; unzips advice files client-side (`fflate`) |
| `/manager/daily-report` | form | `managerDailyReports` | 69 | Thin; Task Inbox visible to all staff, checklist+log manager-only |
| `/manager/daily-review` | dashboard/checklist | cross-module day-health aggregate | 287 | Integrity items, attendance, inventory, branch orders, AI "Top of Mind" |
| `/manager/memos` | list | `memos` | 121 | |
| `/manager/memos/[id]` | detail/workflow | `memos` | 361 | draft→in_review→approved→signing-kiosk→print |
| `/manager/reports` | hub | — | 391 | Links to the 5 report routes below |
| `/manager/reports/daily` | report | `dailySummary` | 294 | |
| `/manager/reports/balance-sheet` | report | account balances | 251 | Gated variant alongside `/accounting/balance-sheet` |
| `/manager/reports/pl` | report | income statement (P&L) | 815 | |
| `/manager/reports/ledger` | report | journal/GL | 323 | |
| `/manager/reports/insights-wrapup` | report | AI OIL accountability wrap-up | 321 | Weekly/monthly acknowledgment + PDF |
| `/manager/settings` | hub | — | 147 | |
| `/manager/settings/organization` | form | positions/locations/departments | 86 | Merged tabbed page (see redirects below) |
| `/manager/settings/positions` | redirect | — | 8 | → `organization` (deep-link) |
| `/manager/settings/locations` | redirect | — | 8 | → `organization?tab=locations` |
| `/manager/settings/departments` | redirect | — | 8 | → `organization?tab=departments` |
| `/manager/settings/expense-entries` | form | per-store expense-entry enable/disable | 325 | |
| `/manager/settings/meat` | form | meat product master | 812 | |
| `/manager/settings/stocks` | form | per-store inventory config | 626 | |
| `/manager/settings/payment-settings` | form | payment methods config | 661 | |
| `/manager/settings/salary-advance` | form | salary-advance settings | 368 | |
| `/manager/settings/printer` | form | thermal printer config | 285 | |
| `/manager/settings/insights` | form | AI anomaly/open-item thresholds | 160 | Per-store override of `DEFAULT_INSIGHT_CONFIG` |
| `/manager/settings/local-users` | form | `localUsers` | 48 | Delegates to admin's `LocalUsersTab` |
| `/manager/settings/attendance` | form | attendance settings | 5 (+816) | → `attendance-settings-client.tsx` |
| `/manager/settings/wastages` | form | wastage settings | 5 (+212) | → `wastage-settings-client.tsx` |
| `/manager/staff-hub` | hub | — | 110 | Tiles: Staff, Salary Advance, Biometrics, Overtime, Payroll, Attendance |
| `/manager/staff-hub/performance-config` | form | performance-score weight config | 212 | "RED ZONE" sensitive metrics, off by default |
| `/manager/staff-hub/pos-mapping` | form | POS↔ERP staff link | 197 | |
| `/manager/staff` | list | `staff` | 266 | |
| `/manager/staff/[id]` | detail | `staff` | 19 (+780) | → `staff-details-client.tsx` |

### Cookbook / Branch Cookbook / Production Recipes (6 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/cookbook` | list | recipes (global) | 230 | Commissary/regular-store authoring |
| `/cookbook/[id]` | detail | recipes | 6 (+571) | → `recipe-details-client.tsx` |
| `/branch-cookbook` | list | recipes (`branchVisible` flag) | 171 | Read-only branch/kiosk view |
| `/branch-cookbook/[id]` | detail | recipes | 6 (+261) | → `branch-recipe-details-client.tsx` |
| `/production-recipes` | list | production recipes | 197 | Inventory-linked (ingredient consumption) |
| `/production-recipes/[id]` | detail | production recipes | 6 (+265) | → `recipe-details-client.tsx` |

### Operation (17 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/operation/attendance` | list/dashboard | attendance sessions | 1034 | 20-day review table + quick-pick review dialog |
| `/operation/attendance/time-clock` | form | attendance sessions | 1070 | Kiosk clock in/out — PIN/card/fingerprint/face |
| `/operation/attendance/time-clock/history` | list | attendance sessions | 40 | Read-only, reuses manager hub's `AttendanceLogsTab` |
| `/operation/attendance/break-log` | list/form | break logs | 258 | |
| `/operation/attendance/biometrics` | form | biometric credentials | 5 (+381) | → `biometrics-client.tsx`; also hosts App-login link, passcode, NFC, fingerprint, face enrollment |
| `/operation/checklist` | form | checklist submissions | 411 | |
| `/operation/checklist/settings` | form | checklist templates | 339 | |
| `/operation/infractions` | list | infractions | 235 | Manager/admin-gated 2026-08-21 (was staff-visible — OC-44) |
| `/operation/infractions/[staffId]` | detail | staff infraction history | 268 | |
| `/operation/infractions/setup` | form | infraction types | 175 | |
| `/operation/overtime` | form | overtime records | 5 (+164) | → `overtime-client.tsx` |
| `/operation/payroll` | dashboard/form | payroll runs/payslips | 1052 | Per-staff pay/void; whole-period Post removed, only void of historical runs remains |
| `/operation/salary-advance` | list | salary advances | 497 | |
| `/operation/salary-advance/[staffId]` | detail/form | staff salary-advance ledger | 401 | |
| `/operation/staff-logs` | dead stub | — | 15 | **Dead** — placeholder text, unlinked from nav (see §7) |
| `/operation/wastages` | list | wastages | 395 | Channel (Grab/FoodPanda) + internal |
| `/operation/wastages/[id]` | detail/form | wastage record | 490 | |

### Admin & Onboarding (16 routes)

| Route | Type | Primary entity | LOC | Notes |
|---|---|---|---|---|
| `/admin/users` | list | `users` | 164 | Tabs: Users + Local Users |
| `/admin/users/[uid]` | detail | `users` | 11 (+439) | → `user-details-client.tsx` |
| `/admin/stores` | list/form | `stores` | 141 | |
| `/admin/stores/[id]` | detail | `stores` | 11 (+349) | → `store-details-client.tsx` |
| `/admin/staff-identities` | list/form | `staffIdentities` | 443 | Cross-store staff identity linking |
| `/admin/configurations` | hub | — | 64 | |
| `/admin/configurations/expense-entries` | list | `expenseEntries` (global master) | 109 | |
| `/admin/configurations/expense-entries/[id]` | detail | `expenseEntries` | 7 (+122) | → `details-client.tsx` |
| `/admin/configurations/ui-ux-sample` | dashboard (internal tool) | — | 1398 | **Largest page.tsx in the app by raw LOC** — 3-theme design-system comparison tool, NOT a business feature |
| `/admin/configurations/attendance` | form | per-store clock-method credentials | 175 | |
| `/admin/configurations/ai-hub` | form/dashboard | AI provider hub | 395 | Drag-reorder priority list; writes `appSettings/aiProviders` |
| `/admin/settings` | form | store data reset / projections / integrity | 538 | Danger-zone: `resetStoreDataByCategory`, `rebuildProjectionsAction`, `runIntegrityChecksAction` |
| `/admin/legacy-migration` | form | AP/AR/cash/staff-advance backfill | 757 | **Deprecated** — go-live migration tool, Phase-2 archive candidate (see §7) |
| `/admin/onboarding` | hub (tabs) | onboarding docs/exams | 641 | Merged Docs/Exams/Proposals (admin-only) + Progress + Grading tabs |
| `/admin/onboarding/edit/[id]` | form | onboarding doc | 335 | |
| `/admin/onboarding/exam/[id]` | form | onboarding exam | 350 | |
| `/onboarding` (staff-facing, separate module root) | hub/list | onboarding progress | 256 | |
| `/onboarding/doc/[id]` | detail | onboarding doc | 356 | |
| `/onboarding/exam/[id]` | form | exam attempt | 266 | |

### Layouts (6)

`src/app/layout.tsx` (81 LOC, root HTML shell + font/theme/SW-unregister scripts), `(auth)/layout.tsx` (11), `admin/layout.tsx` (9, role gate), `financial/layout.tsx` (7), `inventory/layout.tsx` (7), `insights/layout.tsx` (35).

---

## 3. API Routes (`src/app/api/**/route.ts`)

| Route | Method | Purpose | Caller |
|---|---|---|---|
| `/api/auth/session` | POST, DELETE | Mint/refresh/clear the `__session` cookie from a Firebase ID token | Client `FirebaseProvider`, on every auth-state/token change |
| `/api/cron/attendance-sweep` | POST | Flag attendance sessions left `open` past `maxShiftHours` as `needs_review`/`missing_out` | Cloud Scheduler (Bearer `CRON_SECRET`) |
| `/api/cron/budget-reissue` | POST | Auto-reissue expense budgets (daily/weekly/monthly/etc. cycles) | Cloud Scheduler |
| `/api/cron/daily-insights` | POST | Generate AI daily insight for one store per call (5-min cadence) or `?all=1` for all | Cloud Scheduler |
| `/api/cron/daily-snapshot` | POST | Nightly `dailySummary` ledger snapshot, yesterday + day-before catch-up | Cloud Scheduler |
| `/api/cron/loan-autodeduct` | POST | Post due scheduled loan repayments | Cloud Scheduler |
| `/api/cron/rebuild-performance` | POST | Rebuild `performanceSummary/live` + `staffPerfMonth` per store | Cloud Scheduler |
| `/api/cron/reconcile` | POST | Account-balance vs. posted-journal reconciliation; writes drift logs | External scheduler (comment says "GitHub Actions, Firebase Scheduler, etc.") |
| `/api/cron/recurring-expense-autopay` | POST | Auto-pay due recurring expenses (fixed-amount only; variable-amount → pending+alert) | Cloud Scheduler |
| `/api/cron/wastage-auto-charge` | POST | 15-day backstop: auto-charge overdue undispositioned channel wastages | Cloud Scheduler |
| `/api/deliveries/receive` | POST | Receive a draft delivery into stockroom | Flutter mobile inventory app (Firebase ID token) |
| `/api/deliveries/void` | POST | Void a delivery, cascading to linked expense/receipt + stock reversal | Flutter mobile inventory app |
| `/api/ingest/wastage-email` | POST | Parse forwarded FoodPanda/Grab wastage emails → create wastage record | Cloudflare Email Worker bridge (shared secret, `runWithVerifiedPrincipal`) |
| `/api/inventory/count` | POST | Commit a physical stock count (or single-item adjustment) at one location | Flutter mobile inventory app |
| `/api/inventory/thresholds` | POST | Set store-wide low-stock thresholds | Flutter mobile inventory app |
| `/api/inventory/transfer` | POST | Room-to-room stock transfer | Flutter mobile inventory app |
| `/api/meat/adjust` | POST | Single-sided meat stock adjustment (+in/−out) | Flutter mobile inventory app |
| `/api/memos/document` | GET | Stream a memo's attached PDF/Word file same-origin (bypasses Storage CORS) | Client browser / Capacitor WebView memo viewer |
| `/api/production/cook` | POST | Cook a production recipe (consume ingredients, produce output) | Flutter mobile inventory app (manager-required) |
| `/api/production/void-record` | POST | Void a posted cut/convert production record | Flutter mobile inventory app |

All Cloud-Scheduler-triggered routes share the same shape: `Bearer <CRON_SECRET>` (or `x-cron-secret` header) auth, `?date=`/`?store=` override params, idempotent re-runs. All Flutter-facing routes go through a shared `authenticateInventoryApi()` helper (verified Firebase ID token + explicit store-access check, since the wrapped server actions often omit that check themselves).

---

## 4. Cron / Scheduled Work

Nine of the twenty API routes are cron endpoints (`/api/cron/*`, listed in §3), all driven by **Google Cloud Scheduler** hitting the route with a bearer secret — there is no in-process scheduler. `docs/CURRENT_STATE.md` confirms two of these (`budget-reissue`, and the fingerprint-rules deploy) were verified live as of 2026-07-04.

**Cloud Functions are not used for scheduling.** `functions/src/index.ts` is a 6-line stub:
```ts
import * as admin from "firebase-admin";
admin.initializeApp();
// Export all triggers from their respective files.
// This is where you would add future triggers for other collections.
```
No triggers are exported. A v2 rebuild should not assume any live logic lives in Firebase Cloud Functions — everything scheduled runs through the Next.js API routes above.

---

## 5. Shared UI Primitives

These carry over largely unchanged to a rebuild — they're the load-bearing reusable layer, not page-specific code.

- **Data table system** (`src/components/tables/`): `data-table.tsx` is the main component, composed with `data-table-desktop.tsx`/`data-table-mobile.tsx` (responsive split), `data-table-column-header.tsx`, `data-table-column-filter.tsx`, `data-table-filter-bar.tsx`, `data-table-toolbar.tsx`, `data-table-view-options.tsx`, `data-table-pagination.tsx`, `data-table-skeleton.tsx`. Paired with `DateRangeSearch.tsx` + `src/hooks/use-firestore-server-pagination.ts` for the "high-volume transactional list" data-access pattern (reference impl: `/financial/expenses`, per `docs/CURRENT_STATE.md`).
- **Linked detail pattern** (`src/components/details/LinkedTable.tsx`, referenced from most list pages): parent→child drill-down table, the "AppSheet `REF_ROWS` equivalent" (per `CLAUDE.md`). Used by suppliers, expenses, payments, receipts, cash-requests, staff, budgets, admin users/expense-entries.
- **Editors as sheets/modals** (`src/components/editor/EditSheet.tsx`, `RecordEditor.tsx`; also `src/components/ui/app-modal.tsx`, `src/components/modals/FormModal.tsx`): wraps forms (`SupplierEditor`, `ReceiptEditor`, `PaymentForm`, etc.) so users don't lose page context.
- **Money & date primitives**: `src/components/money/{MoneyInput,MoneyText}.tsx`; `src/components/dates/{NativeDateInput,NativeDateTimeInput,LateNightDateWarning,half-hour-time-select}.tsx`.
- **App chrome / shell** (`src/components/shell/`): `AppShell.tsx`/`AppFrame.tsx` (layout), `sidebar-nav.tsx` (role + store-kind + per-user-grant gated nav, the single richest piece of access-control-as-UI in the app), `KioskShell.tsx`/`KioskSidebar.tsx`/`KioskBottomNav.tsx` (separate kiosk-mode chrome for local-user stations), `header.tsx`, `PageHeader.tsx`, `FloatingActionGrill.tsx`/`FloatingDock.tsx` (houses the Ask ERP chat FAB + calculator + notifications), `TimeClockButton.tsx`, `store-switcher.tsx`, `user-switcher.tsx`/`user-nav.tsx`, `pin-entry-modal.tsx`/`change-pin-modal.tsx`, `CalculatorPopover.tsx`, `dark-mode-toggle.tsx`/`theme-transition.tsx`.
- **Store/access gates**: `src/components/store/RequireStoreSelected.tsx` and `RequireStoreKind.tsx` wrap nearly every store-scoped page; `src/components/access/RequireFinancialReports.tsx` gates the manager-report routes.
- **Views**: `src/components/views/{CardView,ItemCard}.tsx` — card-grid alternative to the data table, used on a few browse-heavy pages.
- **shadcn/Radix primitive set** (`src/components/ui/`) — full component library (dialog, select, tabs, badge, switch, etc.) plus house-built additions: `bubble-toast.tsx`, `pin-numpad.tsx`, `searchable-select.tsx`, `status-badge.tsx`, `typed-confirm-dialog.tsx`, `purge-voided-button.tsx`, `sidebar.tsx`. Per `CLAUDE.md`: "DO NOT edit arbitrarily."
- **Charts**: Recharts (per stack notes in `ERP_MAP.md`), used across dashboard/performance/insights.

---

## 6. Module Dependency Notes

- **Financial ← Inventory**: receipts/deliveries feed AP + expense recording; wastage GL postings (`wastage-expense.builder.ts`) reference inventory wastage records as a net-zero pair; commissary delivery cost flows into financial expenses (`commissary-delivery-cost-poison` landmine — a delivery's cost can silently double-book if this isn't respected).
- **Financial ← Sales/POS**: `/financial/sales-report` feeds `dailySummary`, the dashboard, and the income statement; `/manager/channel-settlements` reconciles POS-recorded channel AR against uploaded Grab/FoodPanda payout files.
- **Accounting ← Financial**: balance-sheet/equity/liabilities/assets all read the single journal-backed GL (`stores/{s}/accounts` + `journal` + `dailySummary`) that financial server actions post into — the "sale ≠ collection, expense ≠ payable ≠ cash movement" invariant lives at this boundary.
- **Manager Reports ← everything**: `/manager/reports/{daily,pl,ledger,balance-sheet,insights-wrapup}` aggregate financial + inventory + attendance data via **projections**, not raw recomputation (Guardian's standing rule: reading raw collections to recompute a dashboard number is an anti-pattern).
- **Insights/Performance ← Sales + Inventory + Attendance + Wastage**: AI daily/period insights and `performanceSummary`/`staffPerfMonth` cut across nearly every domain; rebuilt nightly by `/api/cron/rebuild-performance` and `/api/cron/daily-insights`, not computed ad hoc on page load.
- **Operation/Payroll ← Attendance**: payroll computation (`src/lib/payroll/compute.ts`) derives gross pay from attendance session hours (span-based shift anchoring, `resolveStartAnchor`); salary-advance charges net against payroll.
- **Operation/Infractions + Staff-Hub/Performance-Config → Performance/Team**: infraction points and salary-advance charges optionally fold into the public staff score, manager-gated behind a "RED ZONE" toggle that defaults off.
- **Inventory/Commissary ↔ Inventory/Branch-Orders**: commissary "sells" to branches — dispatch (commissary side) and receipt (branch side) are a paired cross-store workflow, each half store-scoped under its own `stores/{storeId}` doc.
- **Cookbook/Production-Recipes → Inventory**: production recipes are inventory-linked; cooking a recipe (`/api/production/cook`, `production-recipe.actions.ts`) consumes ingredients and produces output directly against inventory ledgers.
- **Admin/Legacy-Migration → Financial**: one-time backfill actions (`legacy-import.actions.ts`, etc.) write directly into AP/AR/cash-balance/staff-advance schemas that the financial pages later read as if organically created — a rebuild that ports the financial module without this context could misinterpret opening-balance-shaped data.
- **Onboarding (staff) ↔ Admin/Onboarding**: same underlying docs (`onboardingDocs`/`onboardingExams`), gated differently — admin authors, staff consumes; merged onto one admin page (tabs) as of a recent refactor.
- **Ask ERP (cross-cutting, no dedicated route)**: the help assistant embedded in `FloatingActionGrill` reads across nearly every module via tool calls closed over the resolved `PolicyContext`, grounded on `docs/user-manual.md` (bundled at build time, not fetched live). Worth flagging for v2 scoping as a cross-cutting concern rather than a module.
- **Architectural note for v2 scoping**: `FRAPPE_MIGRATION_CONTEXT.md` and `ERPNEXT_MIRROR_LOG.md` (repo root) describe an in-flight migration where this app's accounting core is being demoted from source-of-truth to "capture + display" in favor of a self-hosted ERPNext/Frappe backend. This is the single biggest piece of context bearing on how much of the Financial/Accounting module should be reimplemented as-is vs. redesigned as a thinner client.

---

## 7. Dead or Deprecated Surface

1. **`/operation/staff-logs` — confirmed dead.** Page body is literally: *"Staff log viewing functionality will be implemented here."* (`src/app/operation/staff-logs/page.tsx:10`). Explicitly unlinked from both `sidebar-nav.tsx` (comment at `src/components/shell/sidebar-nav.tsx:134-140`: *"Staff Logs is gone too — it was a stub page... a dead link for everyone"*) and `KIOSK_NAV` (per `ERP_MAP.md` §0, 2026-08-21 entry). **Safe to drop entirely in v2.**

2. **`/admin/legacy-migration` and its supporting code — TODO-deprecation-cleanup.md Phase 2, explicitly "do not delete yet."** Covers: the whole `admin/legacy-migration/` directory, `legacy-import.actions.ts` (5 import actions), `backfill-legacy-projections.actions.ts`, the single legacy function each inside `asset.actions.ts` and `prepaid.actions.ts`, two legacy journal builders (`legacy-balance-import.builder.ts`, `asset-legacy-import.builder.ts`), and two legacy-import UI dialogs. Trigger to archive: "after confirming all active stores have completed go-live migration" — not yet confirmed as of the file's last update. Given the ERPNext/Frappe migration context above, this whole one-time-use subtree is a strong candidate to **exclude from a v2 rebuild** rather than port.

3. **Pure redirect stubs** (not dead, but zero-logic routing shims kept only for old bookmarks): `/manager/settings/positions`, `/manager/settings/locations`, `/manager/settings/departments` (all → `/manager/settings/organization?tab=X`), `/financial/payment-settings` (→ `/manager/settings/payment-settings`). A v2 rebuild has no legacy bookmarks to preserve, so these 4 routes can simply not exist.

4. **`requireOwnerOtApproval` config flag — dormant.** Declared in `src/types/attendance-config.ts:152,217` (default `false`), read by **nothing** (verified by repo-wide grep, per `docs/2026-08-21-doc-drift-and-dormant-flag.md` Finding 3), and not exposed in any settings screen. Either a genuinely unbuilt feature (second owner-approval tier above manager for overtime) or cruft — don't silently port it as if it does something in v2; the source doc explicitly says "decide, don't leave as-is."

5. **`docs/ACTION_POLICIES.md:37` documents a "revive a voided record" capability that was deleted 2026-08-06.** Not a route/code issue, but a doc-drift trap: a v2 rebuild scoping permissions off that doc could reintroduce a revive/unvoid path that was deliberately removed (void is now permanent by design, per the same finding).

6. **`TODO-duplicate-to-new-record.md`** — spec-only, deliberately never built (confirmed 2026-08-18 in `CURRENT_STATE.md`). A feature idea explicitly decided against; do not resurrect without confirming with Ian.

7. **`TODO-performance-page.md` P3 (slow-moving/dead-stock analysis via an `itemMovementStats` projection)** — spec'd, not built. Not dead so much as never-shipped; don't assume it exists when scoping the Performance module for v2.

8. **Pattern to watch, not a specific dead route**: per `ERP_MAP.md` §0 (2026-08-21), two inventory features (`SupplierReturnDialog`, `SupplierReturnsList`, `CountSessionControl`) had live, permission-gated server actions with **zero UI callers** for over a month before being wired up. This codebase has a track record of server actions shipping well ahead of their UI — worth an explicit "orphaned action" sweep (`grep` exported action names with zero importers) before assuming the current route surface is the full feature set to port.

9. **`TODO-channel-settlement-clearing.md`** referenced in `CURRENT_STATE.md` as "file not found in the current tree" — likely renamed/merged/superseded; flagged there as needing verification, not confirmed gone.
