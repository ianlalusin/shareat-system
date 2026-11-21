# v1 coverage review: what staff, managers and the owner do in v1 that v2 cannot do yet

> Read-only review, 2026-11-18, main at 9892641. v1 = `ERP-rebuild` (src/app, plus src/lib/actions). v2 = `apps/erp`.
> Read v1 as requirements (bible 1.2b to 1.2d). Method: v1 route list, sidebar, action exports and cron routes, then v2 routes, domain exports and schema.
> NOT verified: v1 live data volumes (Firestore is off limits; counts below come from docs/discovery or the 5 Sep capture note); v2 behaviour was read in code, never run; v2 UI quality not judged.
> Sibling files: `v1-audit-2026-12-31.md` is a balances audit, not a feature review.

## 0. What breaks on 1 Jan depends on the split (bible row 452)

From 1 Jan 2027 the v2 ERP is org-wide for AP, payroll and attendance, expenses, cash requests, customers/AR. Sales and stock stay in v1 for a store still on POS v1 until its switch date. Phase 7 modules stay live in v1 (row 302, Q11 a). "Breaks" below assumes that.

## 1. Counts per class (104 rows)

| Class | Meaning | Rows |
|---|---|---:|
| covered | v2 does the same job | 52 |
| differently | same goal, different design | 20 |
| partly | some of it | 6 |
| missing | no v2 equivalent | 16 |
| dropped | deliberate, with a citation | 10 |

NEW (not in CAPABILITY-GAPS, a task, a bible row or a decision file): 8 (section 3). Known but with no owner: 9 (section 4).
Key for the table: `GAPS` = docs/CAPABILITY-GAPS.md (dated section); `DEC#n` = settings-audit/DECISIONS-LOG.md (Ian, 3 Nov); `discNN` = docs/discovery/NN; size S under 2 lane-days, M 2 to 4, L 5+.

## 2. Full table

| area | v1 screen or action | v1 file | v2 route | class | known / NEW | size |
|---|---|---|---|---|---|---|
| sales | Daily or shift sales report, typed | financial/sales-report, /new | /sales-days, /new, /[id]/edit | differently | T-123; row 449 (POS receipts) | - |
| sales | Verify and post a sales day | sales-report.actions.ts | /sales-days/[id] | covered | T-123 | - |
| sales | Shift cash handover, till count | financial/sales-report (CashRemitShift) | /till, /remittance | differently | T-186, T-143 | - |
| sales | Void or adjust a day, shortage charge | sales-report-adjustment.actions.ts | /sales-days/[id], /remittance | covered | T-373, T-366 | - |
| sales | Cashier credit sale and AR collection | cashier/credit-sales | /sales-days (credit tender), /customers/[id] | differently | T-131, T-226 | - |
| sales | Daily and monthly sales targets | sales-target.actions.ts, performance | none in ERP (POS card only) | partly | DEC#6, no task | S |
| sales | Printed day report: sign-off sheet, thermal summary | manager/reports (Print tab) | none | missing | NEW | S |
| cash | Cash, bank, e-wallet accounts | manager/accounts, online-accounts | /money-accounts | covered | T-139 | - |
| cash | Per-account movement view | manager/accounts/[domainKey] | /reports/journal-lines (filter by account) | differently | - | - |
| cash | Account snapshots (dailySummary viewer) | manager/accounts/snapshots | none: ledger-derived | dropped | bible 4.2 rule 7 | - |
| cash | Cash requests: release, return, shortage | financial/cash-requests | /cash-requests | covered | T-144 | - |
| cash | Online and pooled remittance | online-remittance.actions.ts | /remittance | covered | T-143, T-152 | - |
| cash | Grab and Foodpanda settlement: upload, parse, record | manager/channel-settlements | /channel-settlements, /upload, /review, /record | covered | T-150, T-511 | - |
| cash | Transfers between accounts and stores | manager/accounts | /money-transfers | covered | T-139, T-369 | - |
| expenses | Expense list, detail, create (multi-method) | financial/expenses | /expenses, /new, /[id] | covered | T-122 | - |
| expenses | Expense category master | admin/configurations/expense-entries | /settings/expense-categories | covered | T-229 | - |
| expenses | Per-store category on/off | manager/settings/expense-entries | none | dropped | disc28 1.3 (0 of 5 stores used it) | - |
| expenses | Recurring bills with auto-pay | financial/recurring-expenses | /expenses/recurring | differently | row 183 (drafts, never auto-pays) | - |
| expenses | Budgets with auto-reissue | manager/budgets | /budgets | covered | T-215 | - |
| expenses | Reimbursement | accounting/reimbursement | /expenses/reimbursements | covered | T-208 | - |
| expenses | Receipts (supplier documents, photo) | financial/receipts | /ap/invoices/[id] with files | differently | T-130, T-442 | - |
| expenses | Excel export of expenses, receipts, AR, AP, cash requests, sales, advances by date range | manager/settings/excel-export-modal.tsx | CSV on 8 reports only | partly | NEW | S |
| suppliers/AP | Suppliers | financial/suppliers | /ap/suppliers | covered | T-188 | - |
| suppliers/AP | Delete a supplier, transfer its receipts (merge) | supplier-admin.actions.ts | none | missing | NEW | S |
| suppliers/AP | AP list, detail, invoices | financial/ap | /ap, /ap/invoices/[id] | covered | T-130, T-520 | - |
| suppliers/AP | Supplier payments (new, edit, detail) | financial/payments | /ap (allocate); void and re-record, no edit | differently | T-330, T-432 | - |
| suppliers/AP | AP aging | financial/ap | /reports/ap-aging | covered | T-209 | - |
| suppliers/AP | AR customers, ledger, collections | financial/ar | /customers, /customers/[id] | covered | T-131, T-226 | - |
| suppliers/AP | AR aging | financial/ar/aging | /reports/ar-aging | covered | T-209 | - |
| suppliers/AP | Payment-method settings | manager/settings/payment-settings | /settings/pos-link, payout picker on /channel-settlements | differently | GAPS 2026-09-06 | - |
| suppliers/AP | Supplier returns | inventory/deliveries (returns) | /inventory/returns | covered | T-170 | - |
| inventory | Item master and import | inventory/items | /items, /items/[id], /items/import | covered | T-145, T-391 | - |
| inventory | Stock on hand per room | inventory/stocks | /inventory, /inventory/locations | covered | T-160, T-161 | - |
| inventory | Stockroom count sessions | inventory/stockroom | /inventory/counts | covered | T-169 | - |
| inventory | Deliveries: receive, void | inventory/deliveries | /inventory/deliveries, /inbound | covered | T-166 | - |
| inventory | Daily usage and in-store wastage | inventory/usage | /inventory/usage | covered | T-168 | - |
| inventory | POS usage pull, POS item mapping | inventory/pos-usage, pos-mappings | /menu/usage-source | dropped | row 452, T-550 (spec) | - |
| inventory | Meat ledger, meat product master | inventory/meat, manager/settings/meat | /items plus /inventory/production | differently | T-176 | - |
| inventory | Production cut/convert/cook, slicer payments | inventory/production, /payments | /inventory/production (header labour_cost) | differently | T-176; GAPS 2026-09-05 | - |
| inventory | Production recipes | production-recipes | /inventory/production/recipes | covered | T-413 | - |
| inventory | Cookbook and branch cookbook | cookbook, branch-cookbook | none | missing | GAPS 2026-09-06, Phase 7 | M |
| inventory | Fixed assets and depreciation | inventory/assets | /fixed-assets | covered | T-124 | - |
| inventory | Prepaid and amortisation | inventory/prepaid | /prepaid | covered | T-125 | - |
| inventory | Commissary orders and fulfilment | inventory/commissary | /commissary/orders | covered | T-172 | - |
| inventory | Branch orders and order chat | inventory/branch-orders | /commissary/orders/[id] | covered | T-175 | - |
| inventory | Commissary pricing, mapping, bulk import | commissary/items, commissary-mappings, commissary-import | /commissary/catalogue, /items/import | differently | T-171 | - |
| inventory | Low-stock auto-order | low-stock.actions.ts | /inventory/low-stock | covered | T-223 | - |
| inventory | Room-to-room transfer | stock-transfer.actions.ts | /inventory/transfers | covered | T-167 | - |
| inventory | Opening stock | initial-inventory.actions.ts | /opening-balances/stock-count | covered | T-390 | - |
| inventory | Flutter handheld APIs (8 routes) | api/inventory, meat, production, deliveries | none | dropped | GAPS 3 (Ian 2026-08-23) | - |
| payroll/attendance | 20-day attendance review | operation/attendance | /attendance, /attendance/[dayId] | covered | T-195 | - |
| payroll/attendance | Time clock: passcode, NFC, QR, fingerprint, face | operation/attendance/time-clock | /clock (card and fingerprint only) | differently | row 322 | - |
| payroll/attendance | Fingerprint capture on the OTG reader | lib/biometric | slice A built, needs tablet and reader model | partly | T-314 | M |
| payroll/attendance | Break log with over-allowance deduction | operation/attendance/break-log | none (flat default break) | dropped | T-157b (1 break log in all v1) | - |
| payroll/attendance | Overtime | operation/overtime | /attendance adjustments | covered | T-157b, T-158 | - |
| payroll/attendance | Absence and leave | absentee.actions.ts | /attendance/leave | covered | T-436 | - |
| payroll/attendance | Attendance settings | manager/settings/attendance | /settings/attendance | covered | T-201 | - |
| payroll/attendance | Payroll run, payslip on screen | operation/payroll | /payroll | covered | T-189, T-190 | - |
| payroll/attendance | Print a single payslip | operation/payroll (printSlip) | none | missing | NEW | S |
| payroll/attendance | Pay additions and deductions per staff (allowance, co-op, loans) | payroll-addition/deduction.actions.ts | none (only charge agreements) | missing | DEC#1, no task | M |
| payroll/attendance | Salary advance: grant, repay, ledger, void, write-off | operation/salary-advance | none (1230 raised only by shortage, wastage, transit loss, drawing) | missing | NEW | M |
| payroll/attendance | Advance ceiling per store | manager/settings/salary-advance | none | missing | GAPS 2026-09-06; disc28 4 | S |
| payroll/attendance | Slicer per-piece pay | staff-payment.actions.ts | production labour_cost | differently | GAPS 2026-09-05 | - |
| payroll/attendance | Pay out salaries, post salary expense | payroll-staff-payout.actions.ts | /payroll post | covered | T-189 | - |
| staff | Staff list, detail, hire | manager/staff | /staff, /staff/hire, /staff/[id] | covered | T-202, T-590 | - |
| staff | Users and roles | admin/users | /admin/users | covered | T-219 | - |
| staff | Signature and photo | staff.actions.ts | /staff/[id] | covered | T-434 | - |
| staff | Cross-store identity link | admin/staff-identities | persons | differently | T-101 | - |
| staff | Local-user kiosk PINs | manager/settings/local-users, home | /staff credentials, /clock | differently | T-217; row 322 | - |
| staff | Positions | manager/settings/positions | /staff Positions tab | covered | T-297 | - |
| staff | Infractions: catalog, file, void, auto late and absent | operation/infractions | none. Late policy "points only" (settings/attendance/page.tsx:222) files nothing | missing | GAPS 2; ROADMAP Phase 7 | M |
| staff | Team performance leaderboard and config | performance/team, staff-hub/performance-config | none | missing | blueprint 6; Phase 7 | M |
| staff | Operational checklists: submit, verify, templates | operation/checklist | none | missing | blueprint 6; Phase 7 | M |
| staff | Memos: approval, frozen roster, kiosk signing, rejection | manager/memos | /documents (one document per employee, T-584) | partly | NEW (T-584 says "nothing to port"; disc15 10 disagrees) | M |
| staff | Onboarding docs, exams, progress | onboarding, admin/onboarding | none | missing | GAPS 2026-09-05 | M |
| staff | Manager Daily Report and Task Inbox | manager/daily-report | none | dropped | DEC#8 (Daily Report); Task Inbox: GAPS 3 "consolidate" | - |
| staff | Manager Daily Review | manager/daily-review | /findings and / | differently | phase-6 plan 4.3 | - |
| staff | Activity log: view, flag, comment, export | activity-log | none (rows written, no viewer) | partly | T-402 S4 | M |
| staff | Notification bell and push | notification.actions.ts, push.actions.ts | none | missing | GAPS 2 (nice-to-have) | M |
| staff | Account profile, password, manual | account/* | none | dropped | no self-service accounts 2026-09-05 (blueprint 6); own-PIN change unverified | - |
| reports | Income statement | manager/reports/pl | /reports/income-statement | covered | T-209 | - |
| reports | Balance sheet | accounting/balance-sheet | /reports/balance-sheet | covered | T-209 | - |
| reports | Ledger | manager/reports/ledger | /reports/journal-lines, /trial-balance | differently | journal lines have no export (NEW, see sec 3 #3) | - |
| reports | Daily summary report | manager/reports/daily | /reports/sales-rollup, /sales-days | differently | T-210 | - |
| reports | Performance: margins, ratios, growth, cross-store | performance | /reports/store-comparison, income-statement (no ratio view) | partly | blueprint 6; Phase 7 | S |
| reports | Executive dashboard | dashboard | / | covered | T-211, T-212 | - |
| reports | OIL findings | insights/flagged | /findings | covered | T-135, T-213 | - |
| reports | Manager responsiveness | insights/performance | /findings/scorecard | covered | T-214 | - |
| reports | OIL wrap-up with acknowledgement and PDF | manager/reports/insights-wrapup | none | missing | NEW | S |
| reports | AI briefings, compare, Ask ERP, AI hub | insights/*, admin/configurations/ai-hub | none | dropped | ADR-014; rows 248-251 | - |
| reports | All-store P&L and dashboards across v1 and v2 stores | all of the above, v1 covers every store | none | missing | row 452 consequence 2 ("nothing builds this yet"), no task | L |
| admin | Stores | admin/stores | /admin/stores, /[id] | covered | T-222 | - |
| admin | Organisation, locations, departments | manager/settings/organization | /settings/organization, /inventory/locations | covered | T-228, T-160 | - |
| admin | Danger zone: reset by category, rebuild, integrity | admin/settings | cutover purge script, /findings | differently | ADR-007; GAPS 2 | - |
| admin | Legacy migration tool | admin/legacy-migration | cutover wizard, packages/etl | dropped | blueprint 6 | - |
| admin | Printer settings | manager/settings/printer | /admin/pos-tablets | differently | T-546 | - |
| admin | Store readiness checklist | lib/stores/store-readiness.ts | /admin/stores/[id] | covered | T-222, T-243 | - |
| admin | UI sample, insights thresholds, staff-hub POS mapping | admin/configurations/ui-ux-sample etc. | none | dropped | GAPS 2026-09-06; row 452 | - |
| wastage | Order wastage disposition (Grab, Foodpanda) | operation/wastages | /wastage | covered | T-178 | - |
| wastage | Wastage by forwarded email | api/ingest/wastage-email | none (store opt-in column only) | missing | DEC#9; T-515 column, no route | M |
| wastage | Wastage settings | manager/settings/wastages | /settings/wastage-monitor | covered | T-230 | - |
| finance | Loans and repayments | accounting/loans | /loans | covered | T-126 | - |
| finance | Scheduled loan auto-deduct | loan.actions.ts | none | missing | disc13 "NOT PLANNED" | S |
| finance | Owner equity, liabilities | accounting/equity, liabilities | /owners, /liabilities | covered | T-127, T-128 | - |

## 3. NEW gaps, ranked by what breaks on 1 Jan

| # | Gap | Who, how often | What breaks on 1 Jan | Size |
|---|---|---|---|---|
| 1 | Salary advance flow | Managers and cashiers; Lipa alone held 635 advance documents in the 5 Sep capture | No way to hand staff an advance and recover it from pay. A cash request never clears and trips the open-float finding. Charges only reach 1230 via 4 paths; T-519 leaves "requested advances" out and nobody owns them | M |
| 2 | Print a payslip | Payroll clerk, every pay day | /payroll shows slips on screen, no print or PDF. Staff cannot be handed a payslip on the first January pay day | S |
| 3 | Exports for the books: journal lines, expenses, cash requests, sales days, AP/AR detail | Owner and accountant, monthly | Ledger view and list screens have no export; only 8 summary reports do | S |
| 4 | Printed sales-day report | Manager at day close | Paper sign-off sheet and thermal summary gone | S |
| 5 | Memo to all staff with acknowledgement | HR and managers, occasional | v2 documents are per employee. Broadcast, roster and refusal-to-sign are not carried. Ask Ian whether still wanted | M |
| 6 | OIL wrap-up with acknowledgement and PDF | Manager, weekly | Findings screen has no sign-off document | S |
| 7 | Merge or delete a duplicate supplier | Office, rare | Duplicates stay forever; v1 needed repair scripts for this | S |
| 8 | Staff change their own PIN (unverified) | Any staff | No self-service route found; reissue by a manager only | S |

## 4. Known but with no owner (already named, no task)

| Gap | Where known | Size | 1 Jan effect |
|---|---|---|---|
| All-store reports across v1 and v2 stores | row 452 | L | Owner sees costs for every store but sales only for POS v2 stores |
| Pay additions and deductions | DEC#1 | M | Payslips wrong for staff with allowances, co-op or loan deductions |
| Wastage email intake | DEC#9 | M | Grab and Foodpanda wastage typed by hand inside the 15-day window |
| Fingerprint capture hardware | T-314 | M | No finger punches without tablet and reader |
| Salary-advance ceiling | GAPS 2026-09-06 | S | Advances unbounded |
| Sales targets in the ERP | DEC#6 | S | Dashboard has no target |
| Loan auto-deduct | disc13 | S | Due repayments posted by hand |
| Phase 7 modules: infractions, checklist, team performance, onboarding, cookbook, activity viewer, notifications | ROADMAP Phase 7 | M each | Stay in v1 (row 302); v1 staff data goes stale once HR moves to v2 |
| Staff schedules, government salary loans | GAPS 2026-10-10, 2026-10-17 | M | Neither system has them |

## 5. Reports and exports

v1 reports and exports, and whether v2 has the same numbers:

| v1 report or export | v2 numbers? |
|---|---|
| P&L (screen, print) | yes, /reports/income-statement plus CSV |
| Balance sheet | yes, plus CSV |
| Ledger | numbers yes (/reports/journal-lines), no CSV |
| Daily summary | yes via /reports/sales-rollup plus CSV, no print |
| AR and AP aging | yes plus CSV |
| Channel settlement report | yes, /channel-settlements |
| Multi-sheet Excel (7 categories) | no, see sec 3 #3 |
| Printed reports (9 kinds, thermal or PDF) | no, see sec 3 #4 |
| Payslip print | no, see sec 3 #2 |
| Insights wrap-up PDF | no, see sec 3 #6 |
| Activity log export | no viewer yet (T-402 S4) |
| Performance ratios, margins | partly: components exist, no ratio view |
| AI daily and period briefings | no, deferred (ADR-014) |
| v2 only: trial balance, cash flow, expense items, store comparison, POS reconciliation, POS data, dual run, statutory month, leave | n/a |

## 6. Automatic jobs

| v1 job | v1 cadence | v2 counterpart | state |
|---|---|---|---|
| attendance-sweep | Cloud Scheduler | scripts/attendance-sweep.ts, hourly | covered |
| budget-reissue | daily 00:30 | scripts/budget-reissue.ts | covered |
| recurring-expense-autopay | daily | recurring-expense-draft, 02:00 Manila | differently: drafts, never pays (row 183) |
| wastage-auto-charge (15 day) | daily | order-wastage-backstop, 02:30 | covered |
| depreciation and amortisation (stopped after 30 Jun, DEF-044) | monthly | month-end, 15th 02:00 plus 03:00 retry | covered, better |
| loan-autodeduct | daily | none | missing (disc13) |
| daily-snapshot | nightly | none, ledger-derived | dropped |
| reconcile (balance vs journal) | external scheduler | findings subledger tie-out, depreciation detector, inter-entity-reconcile | differently |
| rebuild-performance | cron | none | dropped with the performance module (Phase 7) |
| daily-insights (AI) | 5 minute cron | none | dropped, ADR-014 |
| warmup | 05:50 | none needed | dropped |
| wastage-email ingest (Cloudflare worker, Apps Script) | per email | none | missing (DEC#9) |
| in-app and push notifications | per event | none | missing |
| v1 functions/ | none (6-line stub) | n/a | n/a |
| v2 only: firestore-relay, finding-observation, usage-auto-post, pos-day-import (stops 2027, T-551), pos-receipt-bridge (stop, row 452), lobby-nightly, fiscal-period-seed, db-backup, restore-drill, orphan-file-sweep | | | n/a |

## 7. Not read

v1 live data (Firestore off limits), so 1 Jan impact is judged from code and docs. Not opened: v1 components below page level, v1 firestore.rules, v1 tests. v2 not run or clicked; "covered" means a route and domain function exist, not that the screen was tried.
