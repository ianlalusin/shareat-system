# 26 — Reporting, dashboards & insights: what v1 actually built, and what it actually used

**Date:** 2026-09-04 · **Prompted by Ian:** planning what comes after Phase 3 (complete, 20/20)
**Feeds:** `docs/plans/phase-6-reporting-and-dashboards.md`

Source: `C:\Users\ianla\webapps\ERP-rebuild` (read-only) and, for §D, `C:\Users\ianla\webapps\POS`
(also read-only — restaurant-operations KPIs turned out to live there, not in the ERP). Three
parallel read-only research passes, each cross-checked against live production Firestore data with
a strictly read-only probe (`.get()`/`.count()` only, zero writes, credentials never copied out of
the reference repo's own `.env.local`, probe scripts kept only in the session scratchpad). Every row
below is `[VERIFIED]` (code and/or live query read directly) unless marked `INFERRED` (from a prior
session's memory note, not independently re-read this pass).

**Read as REQUIREMENTS, not as design** (bible §1.2b) — a v1 capability's existence proves a real
business need; its implementation may still be wrong, unused, or actively misleading.

---

## Surprises — read this section first

The single fact that should most change how Phase 6 gets planned: **almost everything in this area
that COULD drift from reality DOES drift from reality, in production, right now** — and almost
everything genuinely well-used (Sales Report, the OIL detector engine) is the plain, boring,
non-AI, non-incremental-counter kind of feature. The pattern repeats three independent times:

1. **Every hand-maintained "summary" counter found in this pass has independently, verifiably
   drifted in production.** `dashboardSummary/live` (ERP) needed a dedicated 6-task hardening pass
   just to make its own drift *visible* (§B). POS's `dashPresets` rolling-window tiles inflate
   3×–11× until a nightly cron corrects them, because the live delta path can only add a receipt's
   contribution to a window, never subtract one once it ages out (§B). This is the **same** disease
   `docs/tasks/110-reporting-views-and-screens.md` already found in the *ledger* (34 of 115 v1
   account balances disagreeing with v1's own maintained counters) — this pass confirms it again,
   independently, in the *dashboard/KPI* layer. **Phase 6 should carry zero incrementally-maintained
   summary tables.** Compute every KPI as a live `GROUP BY` query over fact rows; add a materialized
   view only if a specific query proves too slow, refreshed transactionally, never by increment.

2. **Three separate "manager writes a paragraph about today and signs off" surfaces exist
   (Manager Daily Review, Manager Daily Report, Task Inbox), and all three show close to zero
   organic adoption** — 1 / 2 / 4 documents, ever, across all 7 stores, each clustering almost
   exactly on its own ship date (near-certainly ship-day smoke tests, not habitual use). This
   reframes `docs/CAPABILITY-GAPS.md`'s existing "consolidate, don't triple-port" call: the real
   open question is not *which one wins the merge*, it's **whether the business has actually adopted
   this workflow at all** — worth asking Ian directly before Phase 6 commits to rebuilding any of
   the three (§A.3).

3. **The AI insights layer is really three features bundled under one label, with wildly different
   effort and wildly different measured value** — and the cheapest, most-used third of it (OIL, the
   deterministic lapse-detection engine) **is not an AI feature at all** and is currently
   mis-classified in `CAPABILITY-GAPS.md` as part of the "nice-to-have AI" bundle. 441 findings have
   actually been resolved by managers at the two engaged stores. The genuinely-AI two-thirds (the
   narrative briefing layer, and "Ask ERP") show real but store-concentrated adoption and
   near-zero adoption respectively (§C).

4. **Restaurant-operations KPIs — average spend, peak hour, sales-by-time-of-day — live entirely in
   POS today, not in the ERP.** A full-repo grep of ERP-rebuild found zero matches for any of them.
   Phase 6 must explicitly decide whether "reporting & dashboards" absorbs these, or leaves them
   with POS (§D) — silence here just reproduces the current split by default.

5. **Two live, present-tense integrity gaps found in passing, not previously logged**: `voidSales-
   DayAction`'s own doc-comment claims a snapshot-recompute cascade its code never runs (§A.4); and
   commissary/branch-order receiving disputes have no aging backstop — 4 of 9 currently-open
   disputes across two stores already exceed the 15-day threshold that a *different* wastage-dispute
   path in the same codebase treats as serious enough to need an automatic forced-resolution cron
   (§B, finding 2).

---

## A. Sales reporting & manager daily-accountability surfaces

**Read directly, in full or substantially:** `sales-report.actions.ts` (1028 lines),
`sales-report-adjustment.actions.ts` (797 lines), `sales-day.actions.ts` (389 lines),
`sales-report-draft.actions.ts`, `daily-review.actions.ts` (356 lines), `manager-daily-report
.actions.ts` (314 lines), `manager-tasks.actions.ts` (211 lines), `types/manager-daily-report.ts`,
`app/manager/daily-report/page.tsx`, `app/dashboard/page.tsx` (recognition-status section).

### A.1 Sales Report / Sales Day — the real, proven core

| Capability | What problem it solves | Who uses it | Where in v1 | In ErpV2 plan? | Verdict |
|---|---|---|---|---|---|
| Sales-day lifecycle: open → submitted → verified → (partially_remitted →) remitted / voided | The core daily revenue-booking workflow | Cashier submits; manager/admin verifies/remits/voids | `sales-day.actions.ts:49-160,319-388,167-309`; `sales-report.actions.ts:39-380` | Phase 2 (named explicitly) | CORRECT — proven at scale: **348 real documents across 5 live stores** |
| Auto-remit from posted transfers (2026-04-20 rewrite) | Dropped the old manual multi-leg remit UI; `applyRemittanceStatusFromTransfers` auto-flips status from posted cashier→office/online transfers | System, on every transfer post/void | Old writer `sales-report.actions.ts:39-380` kept but no longer called from the UI | Phase 2 | [VERIFIED] a live code path the UI no longer calls — decide whether ErpV2 needs a manual multi-leg remit at all, or only the transfer-derived auto-flip |
| Sequential-verification create-block | Refuses to create/submit a NEWER day while an OLDER one is open/unverified for that store; editing a draft, backfilling an older date, and Start Shift are never blocked | Cashier/manager; admin bypasses | `sales-day.actions.ts:23-42,319-356` | Phase 2 (already ported — this is v1's precedent for T-123's own create-block) | CORRECT — `[VERIFIED]` live: **0 stuck open/submitted days** at any real store; every open/submitted doc found belongs to the TEST store's QA fixtures |
| Verified-only revenue recognition | Only verified/partially_remitted/remitted days count toward the income statement, dashboard, and month roll-up | 3 P&L readers kept in sync | `dashboard/page.tsx:479-483` (`RECOGNIZED_SALES_STATUSES`) | Phase 2 | CORRECT — a deliberate accrual-timing rule to restate explicitly, not re-derive |
| Sales Report Adjustment — the ONLY sanctioned correction to a locked report | `reopenSalesReportAction` is disabled outright; the only correction path restates the doc in place and re-posts the same journal `sourceId` so `computeDeltas` auto-deltas every downstream rollup, rather than a second offsetting entry | Admin only, reason required | `sales-report-adjustment.actions.ts:1-27,214-434,437-487,489-551` | Phase 2 | CORRECT — a carefully-designed, audit-safe correction pattern worth preserving verbatim |
| Adjustment void is LIFO-only; expense-domain adjustments cannot be auto-reversed at all | Only the most recent adjustment can be voided; older ones voided newer-first; an expense adjustment void is terminal (a correction is a new expense) | Admin | `sales-report-adjustment.actions.ts:562-719,586-593,687-702` | Phase 2 | CORRECT |
| Button-only sales-day creation (2026-06-20 policy) | The ONLY creator of a `salesDays` doc is the Create/draft-save action — commissary branch-sale mirrors no longer auto-create one | System policy | `INFERRED`, prior-session memory | Phase 2/3 boundary | **Flag for Ian**: commissary branch-sale AR/journal posts immediately, but the revenue is deferred from the P&L until a human clicks Create+Verify for that day — a real recognition-timing gap worth a deliberate decision, not inherited silently |
| Cash-remittance flicker (first-save-of-a-new-day race) | A double-write race briefly flashed Cash Remittance negative on a brand-new day's first save | Cashier | Diagnosed against now-retired `sales-day.client.ts` | n/a | **[VERIFIED] already fixed as a side-effect of an unrelated migration** — the whole client-write lane was retired for a single server action (`sales-report-draft.actions.ts:89-94`), removing the two-write race's precondition. Not independently regression-tested; watch for reintroduction if a future refactor splits the write again |
| Void-staleness (3 related gaps, prior session) | (1) channel-AR re-record collision after a void — **fixed**, slot-based ids; (2) `salesSummaryMonthShifts` never reconciled on shift void — **confirmed moot**, no shift-void path exists (consistent with §A.2's zero-usage finding); (3) a remitted-then-voided day's stale doc leaking into the dashboard window — **fixed**, `isRecognizedSalesDay` now excludes `voided` | n/a — integrity | `ar-channel.actions.ts:100-201`; `dashboard/page.tsx:479-487`, both `[VERIFIED]` this pass | Phase 2/3 | Two real fixes confirmed still live |
| **NEW — `voidSalesDayAction`'s doc-comment overclaims its own behavior** | Docstring claims voiding "removes it from the month index, and enqueues ledger/snapshot recompute" (`sales-day.actions.ts:164-165`); the function body (`167-309`) does neither — no month-index write exists anywhere in the repo for this collection, and there is no call to the `cascadeSnapshots` chain the sibling Adjustment flow explicitly runs | n/a | `sales-day.actions.ts:164-165` vs `167-309`, `[VERIFIED]` — grepped repo-wide for "month index", zero hits outside the comment | Phase 2/3 | **Reported, not yet in `DEFECTS-REGISTER.md`** — a void should trigger the same downstream re-derivation an equivalent-size adjustment does; ErpV2's transaction model should make this structural, not optional |

### A.2 Shift Report — built, proven, unused

| Capability | Where in v1 | Live-data finding | Verdict |
|---|---|---|---|
| Per-shift cash handover, mirroring the day report; multi-shift netting via a POS-baseline subtraction algorithm (`aggregateShiftPosBaseline`, `posSalesPull.ts:169`) so a shift pull never double-counts a multi-shift day; writes ONLY a slim month-index projection, never revenue/AR/GL (`sales-summary-shift-item.ts:1-38`) | `SalesReportForm.tsx` shift mode (`INFERRED`, prior memory); baseline algorithm and projection shape `[VERIFIED]` this pass | **`stores/{s}/cashRemits` and every `.../shifts` subcollection are empty at all 7 stores, including the TEST store — zero documents, ever, including from QA's own smoke tests.** | Real engineering investment (a dedicated netting algorithm, its own projection writer, a shipped crash-fix per prior memory) against **zero real invocations**. **Do not port as a peer feature of Sales Report.** Ask Ian whether shift-level handover is a felt need before building an equivalent; if yes, consider extending the day-report's existing same-day-edit affordance instead of a parallel surface |

### A.3 Manager Daily Review vs. Manager Daily Report vs. Task Inbox

`docs/CAPABILITY-GAPS.md`'s claim — *"three overlapping day-accountability surfaces... flagged for
consolidation, not triple-porting"* — is correct that they overlap, and this pass sharpens what the
overlap actually is: not the same six numbers shown three times, but **the same "manager writes
prose and signs off" ritual**, instantiated three times with three different data shapes and
trigger conditions. v1 has already partly consolidated two of the three: Task Inbox and Manager
Daily Report render on the **same page** (`/manager/daily-report/page.tsx:1-69`, one `<h1>Daily
Report</h1>`, both stacked in one component tree, sharing the framing comment *"strictly one report
per store per calendar day"*) even though they still write to two separate collections through two
separate action files.

| | Manager Daily Review | Manager Daily Report | Task Inbox |
|---|---|---|---|
| Core shape | **Auto-computed** — 8 sections pulling live from OIL findings, attendance, low-stock, branch-orders, AI insight | **Manually authored** — N admin-defined recurring text-answer questions (frozen per-report at first save) + a free-form log | **Ticket queue** — any staff raises free text; manager closes with a ≥20-char report or leaves a progress note |
| Persisted | `dailyReviewSummary/{dayKey}` — stores only the sign-off; the 8 sections are recomputed live every load, never stored | `managerDailyReports/{dayKey}` | `managerTasks/{id}` — not day-scoped |
| Closure | `ack:{managerUid,ackAt,note}` — re-openable | `status:'draft'\|'submitted'` — re-openable | `status:'pending'\|'done'\|'cancelled'` — **"In Progress" is a DERIVED label** (`pending && updates.length>0`, `types/manager-daily-report.ts:17,86`, `[VERIFIED]`), never a 4th stored status |
| Self-resolution guard | none found | none found | **Yes** — a raiser cannot resolve their own task unless admin |

**Live-data verdict, ever, across all 7 stores:**

| Surface | Documents, ever | Stores touched | Notes |
|---|---|---|---|
| Manager Daily Review | **1** | 1 (Lipa), dated 2026-06-23 | Matches the exact shipping date — near-certainly the ship-day smoke test |
| Manager Daily Report | **2**, both `status:'draft'`, never submitted | 1 (Lipa), 2026-08-24 and 2026-08-30, 6 days apart | Genuine attempted engagement — 10 recurring answers filled each time — but abandoned before Submit, twice |
| Task Inbox | **4** (3 done, 1 pending) | 2 (Lipa ×3, Malvar ×1) | All created in the exact 3-day ship window; `updates: 0` on every task — the flagship "log progress" feature has never been used once |

**Recommendation:** given real usage is close to statistical zero for all three, this is not
primarily a "which shape wins" decision — it's a **"does the business actually want this workflow"**
decision that should go to Ian before any of the three is re-planned. If yes, the evidence favors
building on the Task Inbox + Daily Report shape (already unified on one page, the only one showing
any sign of a manager returning unprompted) over the Daily Review shape (an auto-aggregated feed
duplicating pages that already exist, drawing sign-offs from nobody).

### A.4 Capabilities with no home in the plan (this sub-area)

- **Shift Report as a standalone port** — do not carry into Phase 6 as a named deliverable.
- **The commissary auto-create-suppression / button-only-creation interaction** — a real recognition-timing rule currently living only as an emergent side-effect of a UI-discipline commit; Phase 2/3 boundary work should make it an explicit, named rule.
- **`voidSalesDayAction`'s missing snapshot cascade** — worth a `DEFECTS-REGISTER.md` row.
- **The "manager writes prose and signs off" pattern itself** — a real, repeatedly-attempted business need with zero evidence any of the three attempts stuck. Worth asking Ian directly why, rather than a fourth attempt at the same shape.

---

## B. Dashboards & KPI surfaces

**Read directly, in full or substantially:** `app/dashboard/page.tsx` (1111 lines),
`commissary-dashboard.actions.ts`, `dashboard-summary.actions.ts`, `dashboard/summary-freshness.ts`,
`dashboard-attention.actions.ts`, `docs/superpowers/plans/archive/2026-08-05-dashboard-performance
-hardening.md` (full). Cross-repo (POS, also read-only): `analytics/delta-core.ts`,
`use-dashboard-analytics.ts`, `peak-hours-card.tsx`, `api/cron/rebuild-presets/route.ts`.

### B.1 ERP-rebuild main manager/owner dashboard

| Capability | Refresh model | Read cost | Verdict |
|---|---|---|---|
| Top financial KPIs (Sales/Expenses/Net Income), range-selectable | On-demand `getDocs`, not realtime (fixed by the 2026-08-05 hardening pass, see B.2) | 2 range-scoped `salesDays` queries + 2 `expenseSummaryMonthDays` queries + 2 loan-interest calls per render | [VERIFIED] CORRECT, but a **live, unfixed redundant-fetch gap**: the fixed rolling-30-day query and the "month" preset's month-to-date query hit the *same* collection over heavily overlapping ranges with no caching between them — cheap today (≤~130 docs/store), never swept by either general read-cost audit because this page got its own earlier, narrower hardening pass instead. Fold into Phase 6's read-model rather than re-audit |
| Live Cash/Online balance tiles | On-demand, `limit(500)` | One capped query — **and the cap is detected and surfaced**: hitting exactly 500 fires a console error and an amber "this may be a floor, not the real figure" banner | [VERIFIED] CORRECT — carry this exact discipline forward: **never cap a money figure without a visible incompleteness flag** |
| `dashboardSummary/live` KPIs (Active Staff, AR/AP Outstanding, Pending Cash Requests) | Incrementally maintained (`FieldValue.increment`, ~16 call sites) + self-heal on page-mount if stale >6h | 4 collection queries inside a transaction, 9–156 docs | [VERIFIED] a real, documented drift-prone pattern (§B.2) — do not port the increment mechanism; the 4 source queries are cheap enough to just run live |
| AP trio, explicitly labeled "as of `<rebuiltAt>`" rather than presented as live | Rebuild-only, no incremental path | Same 4-query rebuild | [VERIFIED] CORRECT and worth naming explicitly: **when a figure can't cheaply stay live, label its true age rather than pretend precision** |
| Manager Tasks open count | On-demand | `getCountFromServer` — a count aggregation, never reads the underlying docs | [VERIFIED] CORRECT — cheapest possible shape; Postgres equivalent is a plain `count(*) WHERE status='pending'` |
| "Attention Today" rail (low stock + flagged AI insights) | `localStorage`, per-store-per-day cache | Own comment: *"reads several inventory collections, so the client caches this per-store-per-day"* | [VERIFIED] CORRECT mitigation; Phase 6 should decide whether this becomes a server-side cached view instead (removes the day-1 cache-miss cost from every user's first visit) |
| Sales-by-channel / daily-sales charts | Shares the rolling-30-day fetch above | Same redundant-fetch gap | [VERIFIED] |
| Expense-by-category donut | Client aggregation of already-fetched rows | Zero extra reads | [VERIFIED] CORRECT, free reuse |

### B.2 The dashboard summary projection — a drift history, not a hypothetical

| Finding | Detail | Verdict |
|---|---|---|
| Drift is named and previously fixed, repeatedly | The 2026-08-05 hardening plan (all 6 tasks read in full, all confirmed still live in code) had to retrofit: failure-visibility on 15 of 16 increment sites that silently swallowed write failures; honesty-labeling for the AP trio (looked live, was actually rebuild-only); integrity-check coverage widened from 2 of 7 fields with no auto-fix; elimination of 5 open realtime listeners including one **fully unbounded** `accounts` query; a staleness indicator that didn't exist before | [VERIFIED] — the richest single piece of evidence in this whole report for *why not to re-port the mechanism*: five separate fixes were needed for one design choice |
| **Live-probe: one real store's dashboard is 5.2 days stale, right now** | `dashboardSummary/live` self-heals ONLY when a human opens `/dashboard` and finds it >6h stale — no cron backstop. SharEat Padre Garcia's summary doc was last rebuilt 2026-08-30, **123.7 hours stale** at probe time, because nobody has opened that store's dashboard since | [VERIFIED], live query this session | Direct argument for Phase 6: either a scheduled refresh for any cached view, or — better, per B.1 — no cached view at all, since a live query has no staleness state to blind-spot on |
| **Live-probe: the "self-bounding" commissary-dispute assumption is trending false** | Code comment argues open commissary/branch-order disputes never need a projection because "disputes get resolved." Live data: **2 of 5 open disputes at Lipa and 2 of 4 at Malvar already exceed 15 days old** — the same threshold a *different* wastage-dispute path in this codebase treats as serious enough to need an automatic 15-day forced-resolution cron | [VERIFIED], live query this session | Not a crash risk at current volume (an unfiltered query is cheap regardless) — but the assumption underneath it is roughly 40-50% false today, not proven true. Flag for `CAPABILITY-GAPS.md`: does receiving-dispute aging need an equivalent backstop? |

### B.3 Shell load performance

The persistent-app-shell fix (`AppFrame.tsx`, moving `RequireAccess`+`AppShell` out of the
per-navigation `template.tsx` remount, day-scoped + localStorage-persisted sidebar badge counts)
is confirmed present in the code (`[VERIFIED]` file existence; internal mechanics `INFERRED` from
prior-session memory, not re-read line-by-line — low marginal value against this report's actual
scope). Relevant to Phase 6 because the dashboard is the highest-traffic page in the app (default
admin/manager landing view) — its query shape sets the read-cost floor for the whole app.

### B.4 Commissary dashboard

`getCommissaryDashboardSummaryAction` runs 3 parallel, filtered queries (in-flight, open-disputes,
month-received) instead of an older unfiltered full-collection scan. Two of the three are genuinely
bounded by business lifecycle; the third (open disputes) is bounded only by human follow-through,
and live data (§B.2) shows that follow-through is inconsistent. One quirk carried over, not fixed:
a received order with a discrepancy still holds its *dispatched* amount in `totalAmount` (never
written back by `confirmReceiptAction`), so `monthReceivedTotal` can overstate actual received value
on any month with a discrepancy (`INFERRED` from prior memory, consistent with current code read
this pass — `commissary-dashboard.actions.ts:98`). Flag for Phase 6's commissary-KPI design to
decide deliberately.

### B.5 Read-cost audits already on record

Two general read-cost sweeps exist (`fd65dc5`/`834ca7b` 2026-07-23; `e843c36` 2026-08-13,
`INFERRED` from prior memory) — **neither touched `dashboard/page.tsx`**, because it got its own
earlier, narrower hardening pass (B.2) that solved a bigger problem (open sockets, an unbounded
query) without addressing the redundant-fetch gap in B.1. Not urgent at today's volumes (14–127
`salesDays` docs/store, 2–12 `expenseSummaryMonthDays` docs/store, confirmed by live probe) — flag
as known, low-priority, fold into the new read-model rather than re-audit.

---

## C. The AI insights / briefing / "OIL" layer

**Read directly:** `daily-insights.actions.ts`, `oil-insights.actions.ts`, `ai-helper.actions.ts`,
`ai/orchestrator.ts`, `ai/signals.ts`, `ai/audit.ts`, `ai/genkit-config.ts`, `ai/store-ai-enabled
.ts`, `ai/insights-window.ts`, `ai/integrity/compute.ts`, `ai/flows/sections.ts`, `ai/help/manual-
search.ts`, `ai/help/tools.ts`, `api/cron/daily-insights/route.ts`, `apphosting.yaml`.

### C.1 Capabilities

| Capability | What it does | Where | Verdict |
|---|---|---|---|
| Daily insights cron pipeline | Per-store AI narrative briefing, generated unattended every morning (one store per 5-min tick, 6–8am Manila) | `api/cron/daily-insights/route.ts:1-51`; `ai/orchestrator.ts:52-161` | CORRECT mechanism — see usage split in C.2 |
| Master per-store AI toggle + per-section gating | Opt a store out of all AI spend/risk in one switch; mute one section without losing the rest | `ai/store-ai-enabled.ts:13-17`; `admin/stores/ai-insights-settings.tsx:44-73` | CORRECT — a real, working kill-switch. 3 of 7 stores currently have it off |
| Manual "regenerate now", cost-capped | `daily-insights.actions.ts:35-74`, capped at 2/store/day (`insights-window.ts:14`), cron-exempt | CORRECT — a deliberate cost guard, not incidental |
| Signal extraction (8 modules) | Turns raw operational reads into compact per-section prompt JSON — real business data (sales deltas vs. 4-week baseline, OIL findings, checklist completion, food-cost ratio), not fabricated | `ai/data/{sales-revenue,expenses,cash-banking,customer-experience,operations,branch-watchlist,inventory-cogs,marketing}.ts`; wired `flows/sections.ts:56-181` | CORRECT |
| Local (non-AI) short-circuit for empty signal | Skips the LLM call entirely when there's nothing to say (measured: no customer feedback on 89% of days) | `flows/sections.ts:77-89`, `ai/local-sections.ts` | CORRECT — a real cost/latency optimization worth preserving |
| Top-of-Mind synthesis | One 3-bullet celebrate/fix/decide card summarizing the other 8 sections, 2nd-phase run | `flows/sections.ts:152-168`; `orchestrator.ts:126-140` | CORRECT |
| **OIL — "Open Items & Lapses"**, a deterministic, zero-AI-cost engine | Rule-based daily sweep for 13 kinds of operational lapse (open receipts, unliquidated advances, orphan expenses, missing categories, new-vendor flags, price spikes, unverified sales days, stale meat slabs, unresolved dispatch variance, missed checklists, missing usage records, attendance flags) | `oil-insights.actions.ts:3`; compute core `ai/integrity/compute.ts:49-342`; 13 detectors in `ai/integrity/detect.ts` | **CORRECT and materially under-classified** — plain SQL-shaped logic, not an AI feature at all; the strongest usage evidence in this whole report (see C.2) |
| OIL snooze / resolve / rescan | Suppress a false positive with a reason, permanently clear a handled one, or force a recheck | `oil-insights.actions.ts:242-378` | CORRECT |
| OIL manager responsiveness scorecard | Composite 0-100 (40% action-rate / 30% briefing-open coverage / 30% speed-to-resolve) | `oil-insights.actions.ts:684-885,724-763` | CORRECT — real accountability mechanism with real resolved-finding data behind it |
| AI provider hub (5-provider abstraction) | Swap model/provider via a Firestore-configured admin page, no redeploy | `ai/genkit-config.ts:1-157`, `ai/hub/{router,registry,capabilities}.ts` | INFERRED CORRECT engineering, but the single most complex, provider-quirk-laden part of the whole system — **do not port the abstraction layer wholesale** |
| AI cost accounting | Logs every call's tokens and computes real peso cost from published provider pricing | `ai/audit.ts:1-187` — `MODEL_PRICING_USD_PER_MTOK` (23-66), `estimateCostPesos` (72-82), `logAiCall` (156-186) | CORRECT — genuinely tracks real spend (see C.2 for the actual figure) |
| Ask ERP — natural-language help chat | Staff ask "how do I record X?" instead of hunting the manual | `ai-helper.actions.ts:45-107` | CORRECT idea, **near-zero real usage** — see C.2 |
| Ask ERP manual retrieval — **already fixed in v1, not a live defect** | `ai/help/manual-search.ts:4-17`'s own comment: the FULL ~18,600-token manual **was** inlined on every call ("cost ~₱0.32/question... exceeded Groq's 12,000 TPM cap by 55%"), then replaced by keyword-scored retrieval — only a compact section-title index is inlined; the model calls a `searchManual` tool on demand, capped at 3 sections / 12,000 chars | `manual-search.ts:53-58,73-121`; `ai/help/tools.ts:10-12` | **[VERIFIED] a "was broken, already fixed" finding** — port the retrieval design, not the original inlining |
| Ask ERP record-search / expense-category-suggestion tools | Answers "where's my Aug 3 cash request?" via real Firestore lookups, gated by the caller's own policy context — never the model's | `ai/help/tools.ts:15-31` (`.strict()` schema explicitly defends a prompt-injection scope-escalation via tool-call args) | CORRECT, genuinely defensive — but see usage before deciding it's worth porting |

### C.2 Live-data probe results

7 stores total; 4 have `aiInsightsEnabled: true` (Lipa, Malvar, Davao, Padre Garcia), 3 off.

**Daily-insights generation is rock-solid** (240/240 possible store-days over the last 60 days, all
4 enabled stores; 3,489 total AI calls logged all-time) — **but viewing is wildly uneven**:

| Store | Briefings generated (60d) | Times ever opened | OIL findings ever resolved |
|---|---|---|---|
| Lipa | 60/60 | **76** | 244 |
| Malvar | 60/60 | **84** | 197 |
| Davao | 60/60 | **5** | 6 |
| Padre Garcia | 60/60 | **0** | 0 (and 0 findings ever raised across 88 days of computed history) |

**Ask ERP: 13 calls, ever**, across the whole 7-store, ~4-month-old system, all inside a single
8-day window (2026-08-19 to 2026-08-26), only 3 of 7 stores, zero calls in the 9 days since. Reads
as exercised once during rollout and abandoned, not a habit.

**Actual AI spend, measured, not estimated**: **₱45.81 total over 60 days across all 4 enabled
stores** (₱0.19/store/day average). Annualized at current scale: ~₱280/year; ~₱500/year even at all
7 stores enabled. Production is pinned to `AI_PROVIDER=groq`, `openai/gpt-oss-120b`
($0.15/$0.60 per Mtok). Cost is a rounding error in this business's budget either way.

### C.3 Assessment (bible §13 row 163 / RULES §4 — a number, not an adjective)

**This is three features under one label, not one:**

1. **OIL (detection + scorecard)** — not an AI feature. All 13 detectors are plain threshold/date
   logic over data Phases 2–5 already produce in Postgres. Zero LLM tokens. Strongest usage evidence
   in the whole report (441 resolved findings, two engaged stores). **Effort to build natively:
   ~4–6 engineer-days** (13 detectors as SQL, a persisted daily-slice table, snooze/resolve/rescan,
   the scorecard aggregation — no new infra, no provider integration). **Value: high, verified.**
   `CAPABILITY-GAPS.md` currently bundles it under "nice-to-have AI, deferred" — that's defensible
   for the AI narrative half but arguably wrong for OIL specifically; flagged per bible §13 row 164
   rather than silently reclassified.
2. **AI narrative layer** (8 generators + Top-of-Mind + the 5-provider hub) — genuinely complex
   (Groq's 12k TPM cap, structured-output gaps across 3 provider families, model-retirement
   redirects). Faithfully porting the multi-provider hub is not worth it for a 4-store-active
   feature. **Minimal single-provider port, reusing OIL's Postgres queries as signal extraction:
   ~5–7 engineer-days. Faithful multi-provider port: ~15–20 days.** **Value: real but store-
   concentrated** — 2 of 4 enrolled stores barely or never engage, despite 88 days of generation for
   the never-opened one. Run cost is trivial either way; the argument against is engineering effort
   against uncertain, store-dependent adoption, not cost.
3. **Ask ERP** — **13 uses ever, in one 8-day burst, 4+ months in.** The textbook "tested, shipped,
   zero ongoing usage" pattern this project explicitly watches for. **Effort to port: ~5–8 days.**
   **Value: near-zero, measured.**

**Self-hosted vs. API**: API-based is unambiguously correct at this call volume (~9 calls/store/day)
— self-hosting any model capable of decent summarization would cost far more in GPU/infra than the
measured ₱0.19/store/day.

**Industry precedent**: for OIL's detection half, Metabase/Grafana Alerting (free, self-hostable)
could replace the *plumbing* of a simple threshold alert, but OIL's specific detectors (unliquidated-
advance aging, dept-aware missing-usage inference, dispatch-variance netting, price-spike-vs-rolling-
baseline) are domain-specific enough to still need custom SQL underneath — a BI tool replaces
plumbing, not business logic, and the accountability loop (snooze-with-reason, scorecard) has no
off-the-shelf equivalent anyway, and is the cheap part regardless. For the narrative-summary half,
there's no meaningful off-the-shelf substitute for "call an LLM with today's numbers" other than
doing exactly that, cheaply, as v1 already does. For Ask ERP, a plain searchable FAQ page (no AI, no
tokens) would likely satisfy the *observed* demand (13 questions in 4 months) at a fraction of the
build cost.

### C.4 Recommendation

**Split the decision by sub-feature.** Build **OIL + the manager scorecard now, as part of Phase 6**
— cheap, zero-AI-cost, the only piece with verified substantial usage; reclassify it out of
"nice-to-have AI" in `CAPABILITY-GAPS.md`. **Defer the AI narrative-briefing layer past Phase 6** —
trivial cost, but uncertain, store-dependent adoption doesn't yet justify 5–20 engineer-days; if
rebuilt later, do it as a thin Groq-only summarizer over numbers the dashboard already computes,
not a separate 8-module extraction layer. **Do not port Ask ERP** — offer a static help page first;
build the LLM chat again only if that turns out to be insufficient.

---

## D. Restaurant-operations KPIs — these live in POS, not ERP-rebuild

**Scope correction, stated plainly because it matters for planning ownership**: a full-repo grep of
ERP-rebuild for `avgBasket`, "Avg Spending", `peakHour`, and `dashPreset` returned **zero matches**.
ERP-rebuild's own dashboard shows only aggregate Sales/Expense/Net totals — no per-guest/per-bill
average spend, no peak-hour widget. All of the below are POS-repo capabilities today.

| Capability | What it does | Where (POS) | Verdict |
|---|---|---|---|
| Avg spend, split by session mode | `avgDineIn` = net dine-in sales ÷ headcount, package-mode-only (per-guest); `avgAlacarte` = net walk-in sales ÷ transaction count (per-bill, no headcount exists for à la carte) | `use-dashboard-analytics.ts:50-75` | [VERIFIED] fixed and live — the old single blended metric read **0** on any à-la-carte-only day (dividing dine-in-only net by dine-in-only guests). **Do not build one blended "avg spend" metric in Phase 6** — the two populations aren't comparable, and forcing one number reintroduces the same bug in a new codebase |
| Peak-hour chart | Sums hourly maps from day-metric docs into 24 fixed buckets, client-side; keyed to **arrival day** (session start), not payment day, deliberately, so a cross-midnight session's hour reflects when guests actually arrived | `peak-hours-card.tsx:44-70` | CORRECT — pure client reduction, no extra reads; the arrival-vs-payment-day distinction is a real decision to restate explicitly if Phase 6 owns this metric |
| `dashPresets` rolling-window tiles | Cached rollup docs for cheap "Today"/"This Month"/etc. rendering | `analytics/delta-core.ts:119-143` | **This is the dashPreset inflation bug, real and structural, only mitigated, not fixed**: the live delta path only ever ADDS a receipt to whichever windows currently include its date — no mechanism to subtract once a day ages out, observed 3×–11× inflation on "This Month" before a nightly cron corrects it (`api/cron/rebuild-presets/route.ts:9-18`). A second bug (host-local midnight instead of Manila time, misrouting today's receipts into `yesterday`) was fixed in a separate commit. **This is the clearest counter-example in the whole report for why Phase 6 should carry zero rolling-window counters** — every window should be a `SUM(...) WHERE day BETWEEN ...` query or a materialized view refreshed from fact rows, never a separately-accumulated counter, even as a "cache" |

**Phase 6 must explicitly decide**: does the rebuild's reporting surface absorb POS's sales-analytics
KPIs (avg spend, peak hour), or does it stay POS's concern with the ERP side covering only
financial/inventory/staff KPIs? Silence here reproduces the current split by default.

---

## E. Capabilities with no home in the plan (consolidated)

| Capability | Why it matters | Recommendation |
|---|---|---|
| Restaurant-operations KPIs (§D) | Entirely POS-owned today; no phase plan names which app owns this | Phase 6 must decide ownership explicitly |
| A dashboard-specific materialized-view/read-model rule | `docs/tasks/110-reporting-views-and-screens.md` bans maintained summary rows for *ledger* balances (trial balance, income statement) but doesn't yet extend that rule to *operational* KPI dashboards | State in writing that bible §4.2 rule 7 / line 1575 applies to every dashboard tile, not just accounting statements — `dashboardSummary/live` and `dashPresets` are the concrete counter-examples |
| Commissary/branch-order receiving-dispute aging, no backstop | v1 has a 15-day auto-charge backstop for order/channel *wastage* disputes but none for *receiving* disputes; live data shows these already trend past 15 days | `CAPABILITY-GAPS.md` row: does the business want an equivalent backstop, or is manual follow-up sufficient at current volume (9 open disputes across two stores, mostly under 20 days)? |
| The "manager writes prose and signs off" pattern (§A.3) | Real, repeatedly-attempted business need, zero evidence any attempt stuck | Ask Ian directly before a fourth attempt |
| Shift Report (§A.2) | Fully built, zero real usage anywhere | Do not port as a named Phase 6 deliverable |
| OIL's mis-classification as "nice-to-have AI" (§C.3) | It isn't AI, it's cheap, and it's the best-used capability in this whole report | Reclassify in `CAPABILITY-GAPS.md`; build now |

---

**Probe artifacts** (read-only, all `.get()`/`.count()` only, credentials read in place from
ERP-rebuild's own `.env.local` and never copied elsewhere): scripts left in the session scratchpad,
safe to delete. No writes were made to any Firestore project or reference repo by this research pass.
