# 16 — Capability Inventory: Operations & Platform

Read-only discovery over `C:\Users\ianla\webapps\ERP-rebuild`. Scope per assignment: reporting/
dashboards, AI insights, manager daily review & task inbox, shift/day reporting surfaces, access
control & admin tools, store config, onboarding, notifications, cron jobs, audit/integrity,
checklists, cookbook, content/memos, APK/kiosk shells, data retention — i.e. everything that is
not itself a money-posting, goods-movement, or people/payroll transaction.

**Method note (per the owner's framing):** this repo is read as a requirements document. A
messy implementation does not mean the underlying need is invalid — it means the need is proven
(daily use) and the execution wants correcting. Every capability below is followed by a verdict
that is a *flag for Ian's decision*, never an assertion that something should be deleted.

Every claim is `[VERIFIED]` (read directly, cited `file:line`) or `INFERRED`. Phase references
are from `PROJECT_BIBLE.md` §10 (8-phase plan, 2026-08-22 resequencing).

---

## Capability table

Columns: **Category** (added for scannability — not part of the 5 requested columns, but keeps
this as one table instead of a dozen) · Capability · Problem it solves (business terms) · Who
uses it · Where in v1 · In the ERPv2 plan? (bible §10 phase, or **NOT PLANNED**) · Verdict
(flag, not assertion).

| Category | Capability | Problem it solves | Who uses it | Where in v1 | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|---|
| Dashboard | Executive KPI pulse | One screen answers "how's the business today" without opening five modules | Manager/admin, daily | `src/app/dashboard/page.tsx` (1110 LOC) `[VERIFIED]` | Phase 6 | CORRECT |
| Dashboard | Self-healing summary projection | A manager who opens a store whose summary was never built gets a correct number anyway, not a blank/error | Any store member (auto-triggered) | `rebuildDashboardSummaryAction`, `src/lib/actions/dashboard-summary.actions.ts:11-40` `[VERIFIED]` | Phase 6 | CORRECT |
| Dashboard | "Attention Today" rail | Surfaces low-stock + flagged-integrity items the manager would otherwise have to remember to go check | Manager/admin | `getDashboardAttentionAction`, `src/lib/actions/dashboard-attention.actions.ts:1-28` `[VERIFIED]` | Phase 6 (implied — not itemized) | CORRECT |
| Dashboard | Per-store sales target vs actual | Lets a store set a monthly sales goal so performance reporting can show progress against it, not just trend | Manager/admin | `upsertSalesTargetAction`, `src/lib/actions/sales-target.actions.ts:11-24` `[VERIFIED]` | Phase 6 (implied) | CORRECT |
| AI Insights | Daily AI business briefing | Owner/manager gets a written morning summary of yesterday instead of reading raw numbers across modules | Manager/admin | `getDailyInsightsDocAction`/`regenerateDailyInsightsAction`, `src/lib/actions/daily-insights.actions.ts:13,35` `[VERIFIED]`; cron `src/app/api/cron/daily-insights/route.ts` | NOT PLANNED (Phase 6 covers "insights" generically but no AI-authoring pipeline is named) | ADD (ask Ian: keep AI narrative layer, or replace with plain rule-based summary?) |
| AI Insights | Monthly/yearly AI period narrative | Same briefing need at a longer horizon (month/year close) | Manager/admin | `getMonthlyInsightAction`/`getYearlyInsightAction`, `src/lib/actions/period-insights.actions.ts:28,68` `[VERIFIED]` | NOT PLANNED | ADD (ask Ian) |
| AI Insights | Two-period comparison + AI read | Answers "how did this month compare to last / same month last year" without manual spreadsheet work, with a one-paragraph AI take | Manager/admin | `comparePeriodsAction`/`analyzeComparisonAction`, `src/lib/actions/insight-compare.actions.ts:58,80` `[VERIFIED]` | NOT PLANNED | ADD (ask Ian) |
| AI Insights | Open Items & Lapses (OIL) engine | Deterministic (non-AI) daily scan that finds operational lapses — missing checklist/usage reports, un-actioned findings — and tracks them to resolution | Manager/admin | `computeOilDailySliceAction` + lifecycle (snooze/resolve/unresolve/rescan), `src/lib/actions/oil-insights.actions.ts:128-388` `[VERIFIED]` | NOT PLANNED explicitly (Phase 6/7 don't name an integrity-finding engine) | ADD — this is load-bearing, see §"No home in the plan" |
| AI Insights | Flagged-items monthly log | A persistent, browsable record of every open item ever raised, grouped by month, so nothing quietly disappears | Manager/admin | `/insights/flagged` route (339 LOC) `[VERIFIED]`, reads `oilDays` via oil-insights actions | NOT PLANNED | ADD |
| AI Insights | Manager responsiveness scorecard | Turns "how fast do managers close flagged items" into a comparable score — an accountability mechanism, not just a report | Manager/admin (compares managers to each other) | `getManagerScorecardAction`/`getManagerScoreSummaryAction`, `src/lib/actions/oil-insights.actions.ts:739,762` `[VERIFIED]` | NOT PLANNED | ADD — see "Intent worth preserving" |
| AI Insights | Weekly/monthly accountability wrap-up + PDF | A signed, printable acknowledgment that the manager reviewed the period's open items — an audit artifact, not just a screen | Manager/admin | `getInsightWrapupAction`/`acknowledgeInsightWrapupAction`, `oil-insights.actions.ts:520,607`; route `/manager/reports/insights-wrapup` `[VERIFIED]` | NOT PLANNED | ADD |
| AI Insights | Per-store AI threshold tuning | Lets a store's manager tune what counts as "flag this" (anomaly/open-item thresholds) instead of one hardcoded rule for every store | Manager/admin | `getStoreInsightConfigAction`/`setStoreInsightConfigAction`, `oil-insights.actions.ts:65,86`; route `/manager/settings/insights` `[VERIFIED]` | NOT PLANNED | CORRECT (small, cheap to keep) |
| AI Insights | Cross-cutting "Ask ERP" help assistant | Any staff member gets a plain-language answer ("where's my cash request?", "how do I record a delivery?") grounded on the real user manual, without calling IT/a manager | Any signed-in staff | `askHelperAction`, `src/lib/actions/ai-helper.actions.ts:45`; tools in `src/lib/ai/help/tools.ts:1-50` `[VERIFIED]` | NOT PLANNED | ADD — flagged in `02-module-map.md` §6 as a cross-cutting concern too |
| AI Insights | AI provider hub (failover chain) | Keeps AI features working if one AI vendor is down/rate-limited/expensive, by trying providers in a configurable priority order | Admin | `getAiProvidersConfigAction`/`saveAiProviderLayoutAction`, `src/lib/actions/ai-provider-hub.actions.ts:14,108`; route `/admin/configurations/ai-hub` `[VERIFIED]` | NOT PLANNED | ADD if AI features are kept; otherwise moot |
| Performance | Manager performance dashboard | Gives a manager their own ratios/margins/trends/utilities without them building a spreadsheet | Manager (own store), admin (any) | `rebuildPerformanceSummaryAction`, `src/lib/actions/performance-summary.actions.ts:11` `[VERIFIED]`; route `/performance` (469 LOC) | Phase 7 ("performance") | CORRECT |
| Performance | Cross-store performance comparison | Lets an owner/admin with multiple stores rank them against each other without opening each store separately | Manager/admin with multi-store access | `getCrossStorePerformanceAction`, `src/lib/actions/cross-store-performance.actions.ts:24` `[VERIFIED]` | Phase 7 (implied) | CORRECT |
| Performance | Employee performance leaderboard | Gives every staff member visibility into how they and colleagues rank, as a motivational/transparency tool | All staff (public score), manager/admin (sensitive detail) | `rebuildStaffPerfMonthAction`/`getStaffPerfDetailAction`, `src/lib/actions/staff-perf.actions.ts:54,281` `[VERIFIED]` | Phase 7 ("performance") | CORRECT — but see "positive public / sensitive private" split in Intent section |
| Performance | Performance-score weight configuration ("RED ZONE") | Lets a store opt IN to folding infraction points / ₱ charged into the public score, off by default, because that's sensitive | Manager/admin | `savePerformanceConfigAction`, `staff-perf.actions.ts:173`; route `/manager/staff-hub/performance-config` `[VERIFIED]` | Phase 7 (implied) | CORRECT — preserve the off-by-default |
| Reporting | Manager reports hub (daily/P&L/ledger/balance-sheet) | Gives a manager the financial statements a bookkeeper would produce, without needing one | Manager/admin | `src/app/manager/reports/*` (5 routes), `getLedgerPageAction` etc., `src/lib/actions/reports.actions.ts:131-379` `[VERIFIED]` | Phase 6 ("as views/materialised views over the ledger") | CORRECT |
| Reporting | Bulk report export to Excel | Lets a manager hand a bookkeeper/accountant/auditor a spreadsheet instead of screen-reading the app | Manager/admin | `exportReportsWorkbook`/`getReportPrintData`, `src/lib/actions/report-export.actions.ts:181,221` `[VERIFIED]`; also `excel-export.actions.ts:21` (different export surface, category-based) | Phase 6 (implied) | DUPLICATE — two independent export mechanisms exist (`report-export` and `excel-export`); ask Ian which is canonical |
| Reporting | Custom date-range report snapshot | Answers "what happened between date X and Y" for an arbitrary window, not just preset periods | Manager/admin | `getCustomRangeSnapshotAction`, `reports.actions.ts:379` `[VERIFIED]` | Phase 6 | CORRECT |
| Manager ops | Task Inbox | Any staff member can raise a free-text request/issue to the manager; manager closes it with a response — a lightweight internal helpdesk | All staff (create), manager/admin (resolve) | `createManagerTaskAction`/`resolveManagerTaskAction`, `src/lib/actions/manager-tasks.actions.ts:27,146` `[VERIFIED]`; route `/manager/daily-report` | NOT PLANNED (Phase 7 doesn't name a task-inbox concept) | ADD |
| Manager ops | Manager Daily Report (recurring checklist + activity log) | A manager's own end-of-day accountability doc — did I check X, Y, Z today — distinct from the staff-facing operational checklist | Manager/admin | `upsertManagerDailyReportAction`/`submitManagerDailyReportAction`, `src/lib/actions/manager-daily-report.actions.ts:171,268` `[VERIFIED]` | NOT PLANNED | ADD — see overlap flag with Daily Review below |
| Manager ops | Copy recurring-report items across stores | Lets an owner roll out a new recurring daily-check item to every store at once instead of configuring each store by hand | Admin | `copyManagerRecurringItemsToStoresAction`, `manager-daily-report.actions.ts:104` `[VERIFIED]` | NOT PLANNED | CORRECT (small, cheap) |
| Manager ops | Manager Daily Review (day-health aggregate) | One screen pulling open integrity items, attendance, inventory, branch orders, and the AI "Top of Mind" into a single day-close checklist | Manager/admin | `getDailyReviewDataAction`, `src/lib/actions/daily-review.actions.ts:75` `[VERIFIED]` — explicitly READ-ONLY, aggregates other actions | NOT PLANNED | ADD — flagged as overlapping with Task Inbox / Manager Daily Report / OIL flagged list; **ask Ian which of these four day-accountability surfaces should survive as ONE** |
| Access control | Store approval / user lifecycle | Gatekeeps a new signup from touching real data until an admin explicitly approves them | Admin | `updateUserProfileAction`/`rejectUserAction`/`deactivateUserAction`, `src/lib/actions/user.actions.ts:32,174,178` `[VERIFIED]` | Phase 0/1 (§7.1 identity rule) | CORRECT — see Phase 0/1 identity redesign in bible §7.1 |
| Access control | Per-user manager grant flags (financial reports / inventory / void / charge-staff) | Finer-than-role permission toggles for specific sensitive capabilities, admin-settable per person | Admin | `UpdateUserProfilePatch`, `user.actions.ts:11-24` `[VERIFIED]`; enforced in `useAccess.ts`/`server-context.ts` (see `04-auth-and-permissions.md`) | Phase 0/1 (§7 rule 2: "(action, resource) tuples") | CORRECT — v2's tuple model should absorb these, not keep them as ad hoc booleans |
| Access control | Shared-terminal local-user login | Lets floor staff (cashier/cook/server) clock in and act at a shared terminal without a personal Firebase account | Local users (staff without logins) | `createLocalUserAction`/`verifyLocalUserPinAction`, `src/lib/actions/local-user.actions.ts:115,472` `[VERIFIED]` (fully detailed in `04-auth-and-permissions.md` §1.2, §7 gap 1) | Phase 0/1 (§7.1 v2 rule: signed server session at PIN-check time) | CORRECT — the NEED (shared-terminal login) is proven by daily use; the EXECUTION (client-asserted actor) is the known defect §7.1 already schedules to fix |
| Access control | Self-registration for local users, pending activation | Lets a new hire register their own PIN at the terminal instead of a manager typing it in, but stays inert until a manager flips it active | Staff (self), manager (activates) | `createLocalUserSelfAction`, `src/lib/actions/local-user.actions.ts:351-413` (`isActive:false` at line 396) `[VERIFIED]` | Phase 0/1 (implied by identity model) | CORRECT |
| Access control | Cross-store staff identity linking | Aggregates one person's salary-advance balance across multiple stores they work at, for a single combined view | Admin (today); manager per Tier-1d open decision | `upsertStaffIdentityAction`/`rebuildStaffIdentityBalanceAction`, `src/lib/actions/staff-identity.actions.ts:15,111` `[VERIFIED]`; **known open gap**: no store-scoping check on upsert/rebuild as of `docs/HANDOFF-2026-07-22-tier1d-and-tier5-ops.md:19-40` `[VERIFIED]` | NOT PLANNED explicitly (falls under "person" table unification, §7.1) | CORRECT — carry the NEED into the single-`person`-table design; the "manager vs admin-only" question is still open, ask Ian |
| Access control | Admin PIN (second-factor for sensitive admin actions) | An extra gate in front of especially sensitive admin actions, separate from the Firebase login itself | Admin | `admin-pin.actions.ts:11-49` (PBKDF2, 210k iterations) `[VERIFIED]` | NOT PLANNED | ADD if the underlying sensitive actions survive; **note**: the 15-min `adminSessions` record it writes (`admin-pin.actions.ts:108-113`) is `[VERIFIED]` (fresh grep, this pass) to have **no reader anywhere else in the codebase** — the "second factor" may be advisory-only today |
| Admin tools | Store/user directory management | Lets an admin see and manage every store and every user account from one place | Admin | `/admin/users`, `/admin/stores` routes `[VERIFIED]` (module-map §2) | Phase 7 ("Admin") | CORRECT |
| Admin tools | Selective store data reset (danger zone) | Lets an admin wipe ONE category of data (e.g. just expenses, or just sales reports) for a store — for fixing a botched go-live import or testing, without nuking everything | Admin | `resetStoreDataByCategory`, `src/lib/actions/admin-reset.actions.ts:65-88` (14 categories) `[VERIFIED]`; UI `src/app/admin/settings/page.tsx:22-35` | NOT PLANNED | ADD — see "Intent worth preserving" (this is a real recovery tool, not a toy) |
| Admin tools | Voided-record purge | Permanently removes records already marked void, for stores that want a clean slate instead of an ever-growing voided pile | Admin | `purgeVoidedRecordsAction`, `admin-reset.actions.ts:375` `[VERIFIED]` | NOT PLANNED | ADD (data-retention capability, see §Retention) |
| Admin tools | Guarded record void/delete with referential-integrity checks | Refuses to delete an item still in use (non-zero stock, referenced by a recipe) so deleting can't silently orphan other records | Admin | `adminVoidRecordAction`/`adminDeleteRecordAction`, `src/lib/actions/admin-record-ops.actions.ts:473,483`; guard at top of file `[VERIFIED]` | NOT PLANNED explicitly (v2's FK constraints make orphaning structurally impossible per bible §12 row 11, but the guarded ADMIN WORKFLOW itself still needs a home) | CORRECT — the workflow (who can force-delete, with what confirmation) is still a UX need even once FKs prevent the data corruption |
| Admin tools | Projection rebuild toolkit | One-click repair for 8 different derived/cached documents (dashboard summary, expense summaries, AP index, stockroom balances, performance summary, etc.) when they drift from source data | Admin | `rebuildProjectionsAction`, `src/lib/actions/rebuild-projections.actions.ts:33` (8 `RebuildTarget`s) `[VERIFIED]` | NOT PLANNED explicitly (v2's "derived data is a view" principle, bible §12 row 1, structurally avoids the NEED for most of these — but a materialised-view refresh tool is still an operational need) | CORRECT — re-scope as "refresh materialised view" tooling |
| Admin tools | One-button integrity audit (17 checks) | Lets an admin ask "is anything inconsistent in this store's books/inventory/AR right now" and get a single report, instead of manually cross-referencing collections | Admin | `runIntegrityChecksAction`, `src/lib/actions/integrity-check.actions.ts:45` — 17 distinct checks (accounts-vs-journal, duplicate items, channel AR vs sales, floating unallocated AR cash, unnetted clearing accounts, deliveries cleared without expense, payment allocations to voided expenses, branch-sale AR vs expense, salesDays vs posted journal, production summary vs records, etc. — full list grepped this pass) `[VERIFIED]` | NOT PLANNED as a discrete tool (individual checks' underlying DATA problems are covered in `06-accounting-gaps.md`; the AUDIT-TOOL capability itself is not named in any phase) | ADD — see "Intent worth preserving": each of the 17 checks encodes a real historical incident |
| Admin tools | Reconciliation log (passive nightly signal) | Lets an admin see, without re-running anything, whether last night's automated drift check found problems | Admin | `getLatestReconciliationLogAction`, `integrity-check.actions.ts:1108` `[VERIFIED]` | NOT PLANNED as a UI, though `reconcileAccounts` itself is Phase 1 content | CORRECT |
| Admin tools | UI/UX theme preview tool | Lets whoever picks the visual system compare 3 full theme profiles on the same component showcase before committing | Admin (internal use, not a business feature) | `/admin/configurations/ui-ux-sample` (1398 LOC — largest page.tsx in the app) `[VERIFIED]` | NOT PLANNED (and shouldn't need to be — it's dev tooling, not a v1 business feature) | DELETE-CANDIDATE — ask Ian whether to port anything, most likely just rebuild from scratch in v2's own design system |
| Store config | Store setup readiness registry | A single source of truth for "what does a store need before it can go live" — shared by the setup checklist UI, the server-side activation gate, and the human setup guide, so they can't silently disagree | Admin | `STORE_SETUP_STEPS`, `src/lib/stores/store-readiness.ts:34-60+` `[VERIFIED]` — explicit `auto` (system can default) vs `manual` (a real business decision, no safe default) distinction | NOT PLANNED | ADD — this exact "one source of truth, three consumers" pattern (§ comment in the file) is worth preserving as a DESIGN PRINCIPLE even if the mechanism changes |
| Store config | "Finish setting up this store" one-click provisioning | Runs every auto-satisfiable setup step (system accounts, settings docs) idempotently, then reports what still needs a human decision — replacing a fragile client-side fire-and-forget seed that used to fail silently | Admin | `provisionStoreAction`, `src/lib/actions/store-provision.actions.ts:52` `[VERIFIED]` — explicitly documents the prior failure mode it replaced | NOT PLANNED | ADD — see "Capabilities with no home" |
| Store config | Organization settings (positions/locations/departments) | Lets a store define its own job positions, physical locations, and departments rather than a fixed hardcoded list | Manager/admin | `listPositionsAction`/`upsertPositionAction`, `src/lib/actions/position.actions.ts:61,95` `[VERIFIED]`; route `/manager/settings/organization` | NOT PLANNED explicitly (Phase 3 needs "locations" for inventory; Phase 5 needs "positions" for payroll — but the CONFIG SURFACE itself isn't named) | CORRECT |
| Store config | Payment-method / printer / clock-credential config | Per-store hardware and channel configuration (which payment rails exist, which thermal printer, which clock methods are enabled) | Manager (payment/printer), admin (clock credentials) | `/manager/settings/{payment-settings,printer}`, `/admin/configurations/attendance` `[VERIFIED]` | NOT PLANNED explicitly | CORRECT |
| Store config | POS↔ERP store linking | Connects an ERP store record to its POS counterpart so cross-app data (sales pull, staff performance) can flow | Admin | `linkPosStoreAction`/`unlinkPosStoreAction`, `src/lib/actions/store.actions.ts:97,142` `[VERIFIED]` | NOT PLANNED (this is a cross-app seam; see `12-shared-infrastructure.md`) | ADD if the POS integration survives re-platforming as-is |
| Onboarding (staff) | Staff onboarding docs + exams | Gives new hires a structured, gradeable training path instead of ad hoc verbal training | Staff (consume), admin (author/grade) | `upsertOnboardingDocAction`/`gradeOnboardingExamSubmissionAction`, `src/lib/actions/onboarding.actions.ts:73,1000` (1341-LOC file, draft→review→publish workflow for both docs and exams) `[VERIFIED]` | Phase 7 ("onboarding") | CORRECT |
| Onboarding (staff) | Onboarding doc revision proposals | Lets someone other than the original author propose an edit to a published doc without unilaterally overwriting it — a lightweight review workflow | Manager/admin | `proposeOnboardingDocEditAction`/`rejectOnboardingDocDraftAction`, `onboarding.actions.ts:318,244` `[VERIFIED]` | Phase 7 (implied) | CORRECT |
| Checklists | Operational checklist templates + submissions | Standardizes recurring shift/department checks (opening, closing, sanitation, etc.) so nothing depends on memory | Staff (submit), manager (verify) | `submitChecklistReportAction`/`verifyChecklistReportAction`, `src/lib/actions/checklist.actions.ts:16,174`; `/operation/checklist`, `/operation/checklist/settings` `[VERIFIED]` | Phase 7 ("checklists") | CORRECT |
| Checklists | Checklist flag + supervisor verification | Lets a manager flag a submitted checklist as incomplete/wrong and requires an explicit verify step — a lightweight QA loop on the checklist itself | Manager/admin | `flagChecklistReportAction`, `checklist.actions.ts:125` `[VERIFIED]` | Phase 7 (implied) | CORRECT |
| Cookbook | Recipe reference library (commissary-authored) | Gives every branch a single, versioned source for how a dish/prep should be made, instead of tribal knowledge | Commissary/regular-store authors, all staff (read) | `upsertRecipeAction`, `src/lib/actions/cookbook.actions.ts:84` `[VERIFIED]`; routes `/cookbook`, `/branch-cookbook` | Phase 7 ("cookbook") | CORRECT |
| Cookbook | Branch-specific recipe variants | Lets one recipe have per-branch adjustments (e.g. different equipment, portioning) without forking the whole recipe | Commissary/manager | `upsertRecipeBranchVariantAction`, `cookbook.actions.ts:169` `[VERIFIED]` | Phase 7 (implied) | CORRECT |
| Content/Memos | Memo authoring + approval + acknowledgment workflow | Formal internal-communication trail — draft → review → approve → staff signs (kiosk) → print — for policy/HR communications that need proof-of-read | Manager (author/approve), all staff (acknowledge/sign) | `createMemoDraftAction` → `approveMemoAction` → `recordMemoSignatureAction`, `src/lib/actions/memo.actions.ts:95,375,547` (831-LOC file, 14 exported actions) `[VERIFIED]` | Phase 7 ("memos") | CORRECT |
| Content/Memos | Memo roster reconciliation | Ensures every current staff member is accounted for in a memo's sign-off list (catches new hires / departures relative to when the memo was issued) | Manager/admin | `reconcileMemoRosterAction`, `memo.actions.ts:457` `[VERIFIED]` | Phase 7 (implied) | CORRECT |
| Content/Memos | Memo document (PDF/Word) same-origin streaming | Lets a memo carry an attached policy document and have it open reliably in the kiosk/Capacitor WebView (which chokes on cross-origin Storage URLs) | All staff | `GET /api/memos/document` `[VERIFIED]` (module-map §3) | Phase 7 (implied) | CORRECT |
| Notifications | In-app notification bell (8 event types) | Gives managers/admins a passive heads-up on operational events without them having to go look — clock in/out, break start/end, sales report submitted, asset auto-capitalized (needs review), new tracked wastage to disposition, wastage auto-charged after 15 days | Manager/admin | `writeNotification`, `src/lib/server/notifications.ts:15-49`; call sites in `attendance-clock.actions.ts:342,413`, `break-log.actions.ts:122,177`, `expense.actions.ts:818`, `sales-day.actions.ts:368`, `wastage.actions.ts:404,1106` `[VERIFIED]` (all 8 call sites read this pass) | NOT PLANNED | ADD — see "Capabilities with no home" |
| Audit | Activity log (audit trail) with flag/comment/resolve | Every user action is logged; a manager can flag a suspicious entry, comment on it, and mark it resolved — turns a raw log into a working investigation tool | Manager/admin | `getActivityLogsAction`/`flagActivityLogAction`/`commentActivityLogAction`/`resolveActivityLogAction`, `src/lib/actions/activity-log.actions.ts:15,48,83,116` `[VERIFIED]`; route `/activity-log` (493 LOC) | NOT PLANNED explicitly (bible §7 rule 7 mandates "every mutation writes an audit row" — the STORAGE is planned, the INVESTIGATION WORKFLOW on top of it is not) | ADD |
| Audit | Per-user config-change audit log | Lets an admin see the last 10 changes made TO a specific user's profile (who approved/demoted/deactivated them, when) | Admin | `getUserAuditLogAction`, `src/lib/actions/user.actions.ts:254-278` (reads `configAuditLog`) `[VERIFIED]` | NOT PLANNED explicitly | CORRECT |
| Retention | Selective data reset by category (see Admin tools row above) | — cross-listed — | Admin | (see above) | NOT PLANNED | see above |
| Retention | Legacy go-live migration tooling | One-time backfill of opening AP/AR/cash/staff-advance balances when a store first migrated onto this ERP from whatever it used before | Admin, one-time | `/admin/legacy-migration` (757 LOC), `legacy-import.actions.ts` (5 actions) `[VERIFIED]`; repo's own `TODO-deprecation-cleanup.md:1-30` marks this "archive after go-live confirmed, don't delete yet" | NOT PLANNED (correctly — this is v1-specific, not a capability to port) | DELETE-CANDIDATE (for v2 code) but the CONCEPT — a bounded, auditable one-time opening-balance import tool — reappears as a real Phase-8 need per bible §10 ("opening-balance migration only") and ADR-005 |
| APK/Kiosk | Kiosk shell (shared-terminal UI mode) | Swaps the whole app chrome to a touch-friendly, restricted nav for a shared floor terminal, distinct from the desktop manager UI | Local users at kiosk stores | `KIOSK_NAV` allowlist, `src/lib/kiosk/kiosk-access.ts:1-80+`; `KioskShell.tsx`/`KioskSidebar.tsx`/`KioskBottomNav.tsx` `[VERIFIED]` | NOT PLANNED explicitly (Phase 4 covers the offline HOT LANE for attendance terminals specifically, not the general kiosk UI shell) | ADD — see "Capabilities with no home" |
| APK/Kiosk | Manager-only feature gating inside kiosk mode | Lets a kiosk store expose manager-level features (reports, settings) to a manager working the floor, while hiding them from cashier/kitchen staff at the same terminal | Kiosk managers vs kiosk staff | `managerOnly` flag per nav entry, `kiosk-access.ts` `[VERIFIED]` (also `04-auth-and-permissions.md` §3.1 — explicitly UX-only, not a security boundary) | NOT PLANNED | CORRECT — but the UX-only nature is a known gap, not a design to copy as-is |
| APK/Kiosk | Online WebView APK shell | Lets staff use the ERP as an installed Android app (fingerprint/NFC hardware access) while all business logic still ships as ordinary web updates | Staff/managers on Android devices | `docs` reference an "online webview shell" (loads `erp.shareat.net`) `[VERIFIED]` per `docs/DEPLOY-pending-2026-07-04.md:41-44`; per user memory `project_erp_apk_online_webview` | NOT PLANNED | ADD — ask Ian whether v2 needs a native/APK presence at all, or web-only is acceptable now |
| Cross-app platform | Scoped read-only bridge into POS | Lets ERP pull sales/inventory-usage/staff-metrics data from POS without giving ERP write access or a shared database | ERP server (system) | `POS_API_KEY`-scoped REST bridge, `src/lib/server/pos-api.ts:22-228`, 8 routes `[VERIFIED]`, fully detailed in `12-shared-infrastructure.md` §7 | NOT PLANNED as a named phase item, but implied wherever v2 needs POS data | ADD — this seam explicitly SURVIVES the 2027-01-01 cutover per bible §13 row 83 ("the POS→ledger seam SURVIVES the cutover until POSv2") |
| Cross-app platform | Wastage-email ingest bridge | Turns forwarded FoodPanda/Grab wastage notification emails into ERP wastage records automatically, so a channel wastage isn't only ever entered by hand | System (Gmail → Apps Script → ERP) | `POST /api/ingest/wastage-email` `[VERIFIED]` (module-map §3) | NOT PLANNED | ADD (small, cheap, already proven) |

---

## Capabilities with no home in the plan

Every row marked **NOT PLANNED** above, distilled to "what breaks operationally if this is
never built in v2." This is the primary deliverable of this document.

1. **The whole AI insights/briefing layer** (daily/monthly/yearly narrative, period comparison,
   Ask ERP). *If not built:* the owner and managers lose the "read one paragraph instead of five
   screens" habit this repo was clearly built to establish — Phase 6 says reports become "views
   over the ledger," which gives correct NUMBERS but not the SUMMARY. Ask Ian how much of the AI
   layer is worth re-implementing vs. accepting plain dashboards as the v2 replacement.

2. **OIL (Open Items & Lapses) — the deterministic daily lapse-detection engine, its flagged-log,
   and the manager responsiveness scorecard.** *If not built:* nothing catches "the closing
   checklist wasn't filed" or "usage wasn't logged for department X" automatically — someone has
   to remember to check. The scorecard's disappearance also removes the only mechanism that
   currently makes manager responsiveness measurable and comparable. This is the single largest
   gap in the plan for this domain — it is a real, actively-used accountability system with no
   named phase, and it is not "AI" in the sense the rest of §"AI Insights" is (it's deterministic
   rule evaluation over existing records) so it can't be waved off as an AI-nice-to-have.

3. **Manager Daily Review / Manager Daily Report / Task Inbox — three overlapping
   day-accountability surfaces**, none named in the phase plan. *If none is built:* there is no
   single "did today go okay" checklist for a manager to close out a shift against, and no
   channel for staff to raise a non-urgent issue to a manager short of a hallway conversation.
   **These three should likely be consolidated, not all three ported as-is — ask Ian which one
   (or a merge of the three) is the actual daily habit worth keeping**; porting all three
   preserves confusion, not intent.

4. **Store setup/provisioning tooling** (readiness registry + one-click provision). *If not
   built:* every new store's settings docs get created ad hoc, by hand, in whatever order
   whoever's onboarding it remembers — which is precisely the failure mode `store-provision.actions.ts`'s
   own header comment says it was built to fix (a client-side fire-and-forget seed that silently
   failed). Re-introducing that failure mode in v2 is avoidable for cheap: the pattern (one
   readiness registry consumed by the checklist UI, the activation gate, AND the human doc) is
   worth keeping even if the implementation changes.

5. **Admin danger-zone tooling** (selective category reset, voided-record purge, projection
   rebuild, one-button 17-check integrity audit). *If not built:* recovering from a bad import,
   a test-data contamination, or a drifted derived figure has no self-service path — every
   incident becomes an engineer task instead of an admin clicking a button. Some of the underlying
   NEED (projection drift) goes away structurally in v2 (views can't drift from their own
   source), but selective reset and a general "is anything wrong right now" audit are
   need-independent of the storage layer.

6. **In-app notifications (the 8-event bell)** and, separately, **the activity-log
   flag/comment/resolve investigation workflow**. *If neither is built:* managers lose the only
   passive heads-up mechanism that exists today (clock events, sales-report submission, assets
   needing review, wastage needing disposition) and lose the ability to turn a raw audit log into
   a working investigation (flag → discuss → resolve) rather than just a read-only list.

7. **Kiosk shell / shared-terminal UI mode**, distinct from the Phase-4 offline HOT LANE (which
   is attendance-specific). *If not built:* every kiosk-mode store either gets the full desktop
   manager UI on a floor terminal (wrong ergonomics, wrong information exposure to cashier/
   kitchen staff) or someone has to hand-roll a cut-down UI per store. This is a UX/routing
   concern, not a data concern, but it's a daily-use surface with no phase reference at all.

8. **Cross-store staff-identity linking.** *If not built:* a person working at two stores has no
   single place their combined salary-advance exposure is visible — each store sees only its own
   half. The bible's single-`person`-table design (§7.1) is the right container for this, but the
   AGGREGATION-ACROSS-STORES capability itself needs an explicit owner in the plan, not just an
   implication.

---

## Intent worth preserving

Business rules encoded in code that a straight re-platform could easily lose if only the "how"
is copied and the "why" is discarded.

- **"Positive public, sensitive private" split on staff performance.** The store-wide leaderboard
  (`/performance/team`) is visible to every staff member — a deliberate transparency/motivation
  choice — but infraction points, ₱ charged, and conduct sub-scores are gated to the staff member
  themselves or a manager/admin, and are fetched separately, never in the public projection doc.
  `staff-perf.actions.ts:1-9` header comment states this explicitly. **This split must survive
  even if the storage model changes** — it is a privacy decision, not an implementation detail.
- **RED ZONE toggle, off by default.** Folding infractions/₱-charged into the public score is
  opt-in per store (`savePerformanceConfigAction`), not the default. A rebuild that turns this on
  by default would be a real privacy regression relative to how the business actually runs today.
- **Manager self-dealing exclusions carry into non-financial approvals too.** The Task
  Inbox/cash-request pattern note in `manager-tasks.actions.ts:1-9` explicitly generalizes the
  "staff raises, manager resolves, never self-resolve unless admin" rule from cash requests to
  arbitrary task text — i.e. this isn't a money-specific rule, it's a general approval-workflow
  principle the business applies everywhere. Bible §7 rule 6 already captures this for money;
  it should be read as covering NON-money approvals too (memos, tasks, checklists) wherever a
  requester/approver split exists.
- **The 17 integrity checks each encode a real historical incident**, not hypothetical
  paranoia — e.g. "deliveries cleared without a backing expense," "payment allocations to voided
  expenses," "clearing/suspense accounts not netted to zero" read as postmortems turned into
  standing checks (`integrity-check.actions.ts`, checks enumerated this pass). Even where v2's
  schema makes the underlying bug structurally impossible (FK constraints, single writer per
  table per bible §12), the CHECK LIST itself is a catalog of "here is every way this business's
  books have actually gone wrong" and is worth preserving as a design-review checklist even if no
  code ships to re-run it.
- **Admin is always the last-resort override, but a demotion/deactivation of the last approved
  admin is blocked** (`user.actions.ts:51-61,126-135,204-213` per `04-auth-and-permissions.md`
  §1.5) — a lockout-prevention rule that must carry into v2's `authorize()` module explicitly,
  not be assumed to fall out of role hierarchy automatically.
- **Zero-auth sweep discipline** (`docs/ZERO-AUTH-SWEEP.md`): this repo learned, the hard way,
  that in Next.js any exported `'use server'` function is a reachable RPC endpoint regardless of
  whether any UI calls it — and that an org-wide cron *runner* action needs its OWN authority
  check (`isSystemAuthority`) independent of the route wrapper's `CRON_SECRET` check, because the
  action is independently reachable. **This exact class of bug (authority checked at the route,
  not the action/handler underneath it) is worth a standing lint/test rule in v2**, not just a
  one-time cleanup.
- **Referential-integrity guard before delete** (item still in use → refuse) is currently
  hand-written per action (`admin-record-ops.actions.ts`); v2's FK constraints make this
  structurally automatic, but the CONFIRM-ATION UX (what an admin sees when a delete is blocked
  and why) is still worth preserving as a pattern.

---

## Scheduled jobs

Nine cron routes exist in code (`src/app/api/cron/*`), all gated on `Authorization: Bearer
<CRON_SECRET>` (or `x-cron-secret` header), all POST-only, all idempotent by design. **Route
existing and route being on an actual Cloud Scheduler cadence are two separate facts** — this
repo's own docs confirm most of these are NOT verified scheduled as of the latest evidence found:

> `[VERIFIED]` — `docs/HANDOFF-2026-07-22-tier1d-and-tier5-ops.md:58` states, for
> `attendance-sweep`: *"no evidence the scheduler job was ever created (only `budget-reissue` +
> `recurring-expense-autopay` are confirmed). Nothing fires it on a schedule until the job
> exists."* The same doc's Tier-5 section only lists those same two as confirmed.
>
> `[VERIFIED]` — `docs/DEPLOY-pending-2026-07-04.md:47-49`, written the same day `budget-reissue`
> was confirmed live, explicitly lists `reconcile`, `daily-insights`, `daily-snapshot`,
> `loan-autodeduct`, `rebuild-performance`, and `wastage-auto-charge` as routes that still need a
> scheduler job created ("same pattern... if they still lack scheduler jobs").

No later doc in the repo contradicts this. **Best available reading: as of the last confirmed
evidence (2026-07-22), only 2 of 9 cron routes were verified actually firing on a schedule.**
This could not be re-verified in this read-only pass (no `gcloud`/Cloud Scheduler access) — flag
for Ian to confirm current live state before assuming any of the "unconfirmed" ones are running.

| Cron route | What it does | What it writes | Confirmed scheduled? | What breaks if it silently never runs |
|---|---|---|---|---|
| `budget-reissue` | Resets/rolls over expense budgets on their cycle (daily/weekly/monthly/etc.) | `expenseBudgets` docs | **`[VERIFIED]` YES** — created + verified 2026-07-04, `docs/DEPLOY-pending-2026-07-04.md:15-20` | Budgets never reset; every category looks perpetually over/under budget |
| `recurring-expense-autopay` | Posts due fixed-amount recurring bills automatically; flags variable-amount ones pending | Expense + journal legs, or a pending record + notification | **`[VERIFIED]` YES** — confirmed live, `docs/HANDOFF-2026-07-22-tier1d-and-tier5-ops.md:11` | Recurring bills (rent, subscriptions) silently stop posting; AP/cash goes stale without anyone noticing until the bill is overdue |
| `attendance-sweep` | Flags attendance sessions left `open` past the shift-hour cap as `needs_review`/`missing_out` | Attendance session status | **`[VERIFIED]` NOT confirmed** (explicitly flagged absent, 2026-07-22) | Forgotten clock-outs never surface for manager review — payroll hours silently wrong at the source, before payroll even runs |
| `daily-insights` | Generates the AI daily briefing, one store per call, 5-min cadence | `dailyInsights` docs | Not confirmed | The "morning summary" habit this feature exists for quietly stops working; no error, just an empty/stale insights page |
| `daily-snapshot` | Nightly ledger snapshot (`dailySummary`), yesterday + catch-up | `dailySummary` docs | Not confirmed | Every report/dashboard reading from `dailySummary` (multiple modules, per `02-module-map.md` §6) goes stale; catch-up logic masks this for a while, which makes the failure harder to notice, not easier |
| `loan-autodeduct` | Posts due scheduled loan repayments | Journal legs, loan schedule | Not confirmed | Staff loan repayments stop deducting on schedule; balances silently drift from what was agreed |
| `rebuild-performance` | Rebuilds `performanceSummary/live` + `staffPerfMonth` for every store | Performance projections | Not confirmed | `/performance` and the staff leaderboard go stale; the page's own "Refresh" button is the only fallback (manual, per-store, easy to forget) |
| `reconcile` | Checks every store's account balances vs. posted journal entries; monthly tie-out gate | `reconciliationLogs` | Not confirmed | The one nightly "do the books tie out" signal goes dark — drift accumulates invisibly until someone runs the manual integrity-check tool, if they think to |
| `wastage-auto-charge` | 15-day backstop: auto-charges overdue undispositioned channel wastages | Wastage record charge fields + notification | Not confirmed | Tracked (Grab/FoodPanda) wastages that nobody dispositions just sit forever uncharged instead of defaulting to the monitor/store after 15 days — the backstop the feature exists for never fires |

**Two further schedule-adjacent facts, both `[VERIFIED]` this pass:**
- The manual fallback for the two highest-value silent-failure cases (`rebuild-performance`,
  `daily-snapshot`) is a same-page "Refresh"/"Generate now" button
  (`rebuildPerformanceSummaryAction`, `generateDailySnapshotNowAction`) — real, but per-store and
  per-visit, i.e. no one is alerted that the automated job stopped; someone has to notice the
  page looks stale.
- `reconcile`'s output ("logs are written... and the response body lists every affected store so
  the caller can alert," per the route's own header comment) assumes an external caller acts on
  the response — but if the job was never scheduled in the first place, there is no caller to
  alert anyone at all. The alerting design depends entirely on the scheduling actually existing.
