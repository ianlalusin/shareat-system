# Shareat System v2 — Completion Blueprint
_Drafted by: Sonnet 5 (master-planner skill), session 2026-09-05. **Status: PROPOSED — not yet reviewed by the Opus planner.** Per `docs/RULES.md` §3.1a, planning/architecture docs are normally an Opus job; this one exists because Ian asked for it directly in this session. Treat it as a strong draft, not bible-equivalent, until an Opus pass reviews it. Not committed to git yet — Ian's call._

> **This document is deliberately separate from `docs/ROADMAP.html`.** ROADMAP.html is the live, same-day-maintained, task-granular tracker — it is authoritative on "what's built" and must not be re-derived or duplicated here. This document answers a different question: **what does "a complete, hardened v2 app" actually mean end-to-end, what's missing to get there, and what's the fastest realistic path** — including two things ROADMAP.html doesn't cover: the full v1→v2 page catalog under the four verbs, and a proposal for the one phase ("Phase 7 — peripheral modules") that has no plan document yet.

---

## 1. Project Overview

Shareat System (internally still "ERPv2" in older memory) is a from-scratch Postgres re-platform of the live production ERP (`ERP-rebuild`, read-only reference). It is **not a rewrite** — same business, same daily workflows, corrected accounting, one shared backend for four front-ends (ERP/POS/CUSTOMER/Website) eventually. **Confirmed:** production is already live at `erp2.shareat.net` (T-205, shipped 2026-09-04), running a real Oct–Dec pilot ahead of a books-first cutover on 2027-01-01 (ADR-005/007).

## 2. Business Goal

Replace an ERP with **no nominal ledger** (single-leg postings, hand-maintained P&L unions, silently-invisible new accounts) with a system where the database itself enforces balance, period, and immutability — while staying familiar enough that a cashier or store manager isn't relearning their job. **Confirmed** (`project_erpv2` memory, bible §0–2).

## 3. Scope of this document

**In scope:** (a) reconciling what Ian asked for — signup/login/pending/404 — against what's actually built; (b) a full v1→v2 module/page catalog using the four verbs (duplicate/correct/add/delete), because no such single catalog exists today; (c) proposing the content of **Phase 7 (peripheral modules)**, which `docs/plans/` has no file for; (d) synthesizing the defects/capability-gaps/compliance items that matter for "complete," which today live scattered across three separate registers; (e) a fast-track timeline.

**Out of scope, deliberately:** re-deriving Phase 1–6 status (ROADMAP.html owns this), re-litigating decided ADRs, POS/CUSTOMER/Website app builds (ADR-003 keeps those on their own repos through Q1), the bible/ADR text-drift fix (DEF-153 — that's an Opus-planner documentation pass, not new planning).

## 4. Current State Snapshot — verified 2026-09-05

| Phase | Status | Source |
|---|---|---|
| 0 Foundation | Done | ROADMAP.html |
| 1 Accounting spine | Done | ROADMAP.html; DEF-080/081 closed same day via T-111 |
| 2 Money-moving source docs | Active, ~complete | Waves 0–5 complete; T-136 partial by design; T-187 (service charge) deliberately unbuilt pending Ian |
| 3 Inventory | **Done, 20/20** | Exit gate met 2026-09-04 |
| 4 Attendance | **Done** | Shipped |
| 5 Payroll | Active, 16/18 | T-190/T-193 (statutory contributions/remittance) **gated on real data**, not code — 0 of 126 staff carry SSS/PhilHealth/Pag-IBIG/TIN today |
| 6 Reporting & dashboards | Active, ~10% done | Only T-209a (balance sheet) shipped; T-209b/c, T-210–216 not started |
| 7 Peripheral modules | **Not started — a one-line stub in ROADMAP.html, no `docs/plans/` file** | This document proposes real content — §6 below |
| 8 Cutover | Not started | Dated 2027-01-01 (ADR-005) |

**74 page routes** exist under `apps/erp/src/app/` — this is a far more built-out app than "planning from scratch" framing would suggest. Verified live (dev server started this session, seeded, browsed): sales-days, findings, staff, attendance, payroll, inventory, balance-sheet all render real, working screens with real business logic (13th-month pay, FIFO valuation, pooled remittance, a live self-auditing "Findings" engine). This is a genuine strength — the **Findings** page in particular (§7) is already a more sophisticated health-check than v1 ever had, keep and extend it rather than building a separate "issues" screen in Phase 7.

## 5. Auth/shell reconciliation — what Ian asked for vs what exists

Ian asked for a complete app "with sign up, log in, pending, not found pages." Verified by browsing the running app:

| Page | v1 has it | v2 status | Recommendation |
|---|---|---|---|
| **Login** | `(auth)/login` | ✅ **Built, upgraded** — `/sign-in`, store + 6-digit PIN, server-decided identity, no client-supplied actor (T-138) | Duplicate — done, better than v1 |
| **Signup** | `(auth)/signup` | ❌ 404s. **By design, not an oversight** — staff are provisioned by an admin/manager via `/staff/hire`, not self-registration | ✅ **DECIDED 2026-09-05 — Ian: no self-service signup, ever, for anyone.** Delete, don't port. Matches the two prior incidents (v1's signup flow demoted an admin and caused a lockout) and the capability matrix's deliberately narrow, admin-mediated account creation |
| **Pending (approval)** | `/pending`, `/welcome`, `/onboarding/*` | ❌ 404s. Not applicable to the hire-not-signup model | **Delete the v1 concept** (nobody self-registers, so nobody waits for approval). But **add** a distinct, smaller thing v2 is currently missing: a friendly screen for a person who *has* an employment record but no active credential yet (freshly hired, PIN not yet issued) — right now that person's sign-in attempt likely just fails with the generic PIN-wrong message. Small, cheap, worth doing (§6, shell row) |
| **404 / not-found** | Default Next.js pages exist informally | ❌ **Confirmed missing** — no `not-found.tsx` anywhere in `apps/erp/src`. Verified live: `/signup`, `/pending`, and a nonsense route all render Next's generic "This page could not be found," inheriting the real nav bar (looks unfinished, not broken, but visibly unpolished) | **Add.** Small task, high visual payoff — this is the cheapest "looks complete" win available |
| **Error boundary** | N/A | ❌ **Confirmed missing** — no `error.tsx`/`global-error.tsx` anywhere | **Add** alongside 404. An unhandled exception today shows Next's raw dev overlay or a blank prod screen instead of a recoverable page |
| **Home/dashboard** | `/dashboard`, `/home` | ❌ **Confirmed missing** — root `/` is the literal unmodified Phase-0 scaffold text with one manual link to `/attendance/lane`. 74 feature pages exist and none of them is reachable from `/` | **This is the single highest-value gap.** Already named T-211 (Phase 6, not started) — this document doesn't duplicate that task, just flags it as the top completeness priority, sequenced first in §9 |

**Net finding:** three of the four things Ian named (signup, pending, 404) map to one real decision (confirm the hire-not-signup model) and one real, small, unowned gap (404/error pages). The fourth (login) is already done and better than v1. The thing that actually reads as "incomplete" to anyone opening the app today isn't auth at all — it's the missing dashboard.

## 6. The v1 → v2 catalog — every v1 page, one verb, one line

Built from a full route inventory of both repos (130+ v1 routes under `ERP-rebuild/src/app`, 74 v2 routes under `apps/erp/src/app`) plus `CAPABILITY-GAPS.md`, `DEFECTS-REGISTER.md`, and this session's live click-through. **Duplicate** = v1 pattern kept, already built better in v2. **Correct** = v1 had it, v2 fixes a known defect. **Add** = missing in v2, genuinely needed. **Delete** = redundant, superseded, or a v1 anti-pattern not worth carrying.

### Already complete — no action (the strong majority)
**Financial/accounting** (assets, balance sheet, equity, liabilities, loans, AP, AR, cash requests, expenses, payments, sales report, suppliers) and **inventory** (all 13 v1 inventory pages: items, deliveries, commissary variants, stockroom, stocks, usage, meat, pos-mappings, production, branch-orders, prepaid) are **Duplicate + Corrected, Done** — Phases 1–3 cover these more completely than v1 ever did (party-required subledgers, FIFO instead of average cost, one commissary↔branch pipeline instead of ad hoc transfers). **Attendance** (all 5 v1 attendance pages) is **Duplicate + Corrected, Done** — Phase 4. **Cashier/credit-sales** folds into AR — **Duplicate**, done. This is genuinely the bulk of the v1 app, and it is genuinely finished. Say so plainly to Ian: the "hard 80%" of a correctness-focused ERP rebuild is already behind you.

### Shell — propose as immediate, small tasks (not yet in any phase file)
| v1 / gap | Verb | Why |
|---|---|---|
| Home dashboard | **Add** (already T-211, Phase 6 — just sequence it first) | §5 |
| `not-found.tsx` | **Add**, new | §5 — no owner exists yet |
| `error.tsx` / `global-error.tsx` | **Add**, new | §5 |
| "Credential not yet issued" state on sign-in failure | **Add**, small | Replaces v1's `/pending`/`/welcome` concept without reintroducing self-registration |
| `(auth)/signup`, `/pending`, `/welcome`, `/onboarding/exam` (the HR-exam variant), `/local-user-login` | **Delete** (don't port) | Superseded by hire-flow + PIN sign-in; porting them would reintroduce the exact self-service-account risk this project has already rejected twice |
| `account/profile`, `account/security` | **Unresolved — verify** | `/staff/[id]/credentials` may already cover credential/security self-service; a plain "my profile" view for a signed-in staff member wasn't confirmed either way this session |
| `account/manual` | **Delete** | v1's static help-manual page tied to the old "Ask ERP" feature; low value, not accounting-critical |

### Phase 7 proposal — peripheral modules (ROADMAP.html has a one-line stub, no `docs/plans/` file; this is the gap this document earns its keep on)
| v1 module | Verb | Notes |
|---|---|---|
| `admin/users`, `admin/stores` | **Add — high priority** | `FILE-MAP.md` already flags this explicitly: `assignRole()` exists, capabilities (`manage_users`, `enrol_staff`, `grant_capability`) exist and are tested, but **no screen calls any of them** and **no `stores` route exists anywhere**. This is the "done but uncalled" landmine (`reference_shareat_done_but_uncalled` memory) sitting in the open right now — a fully authorized, fully tested capability nobody can actually invoke. Highest-value Phase 7 item |
| `manager/memos`, `manager/memos/[id]` | **Add** | No v2 equivalent found. Real v1 usage evidence exists (staff memo + roster reconciliation was a shipped v1 feature per project memory) |
| `performance`, `performance/team`, `manager/staff-hub/performance-config` | **Add + Correct** | No v2 equivalent found. v1's version had a known structural defect (shift-report attribution blocker, unresolved in v1) — Phase 7 should fix that root cause, not just port the screen |
| `operation/checklist`, `checklist/settings` | **Add** | Opening/closing operational checklists. No v2 equivalent found; genuinely daily-use in food service |
| `operation/infractions`, `infractions/setup`, `[staffId]` | **Add** | Ties to attendance/HR discipline; v1 gated this to managers-only via nav (a nav-only fix per memory, page+rules were left open even in v1) — Phase 7 should close it properly with a real capability row, not a nav hide |
| `cookbook`, `branch-cookbook`, `production-recipes` | **Add — low priority** | Standardized-recipe reference content. Operationally useful, not money-critical; fine to sequence last |
| `onboarding`, `onboarding/doc/[id]`, `admin/onboarding` | ✅ **DECIDED — Add, redesigned (Correct + Add)** | v1's version was wrongly assumed tangled with the old signup gate — it isn't; it's a genuinely separate, well-built training/compliance system (handbook/rules/training/menu docs with versioned acknowledgment, MC + open-ended exams, staff-proposed content with admin review, per-item and per-staff progress tracking). **Ian, 2026-09-05: "even I who designed it don't fully understand it — streamline it, clear beginning and end, a progress, so no staff can jump to end without steps start and middle."** See the redesign spec directly below this table |
| `admin/configurations/ai-hub` | **Correct, fold into Phase 6** | Already tracked there under the OIL/insights work (T-213/214) — don't duplicate as a separate Phase 7 item |
| `admin/legacy-migration` | **Delete** | Fully superseded by `packages/etl` — v2's replay-harness mechanism is strictly better (immutable landing table, reconciliation, re-runnable) |
| `admin/configurations/ui-ux-sample` | **Delete** | Dev-only scaffold, not user-facing |
| `admin/staff-identities` | **Proposed — likely delete** | v1's identity-dedup tool exists because v1 has no clean persons/stores spine; v2's `organizations/stores/persons` schema (bible §4) may make this moot entirely. Verify after Phase 7's user-management screen ships, don't build proactively |
| `manager/budgets` | ✅ **Not a gap at all — already T-215 (Phase 6).** Earlier drafts of this document called it "possibly abandoned" then "unowned"; both were wrong | `ROADMAP.html` already names **T-215 "Expense budgets,"** one-lined as "budget vs. actual as a query over `journal_lines`," with its own caveat "may move to Phase 7 without argument." The real finding: v1's actual feature (per-store, per-month envelopes, **auto-reissue on a live daily cron**, confirmed working end-to-end) is richer than T-215's current one-line scope — its implementer should read `budget-editor.tsx` before building, not just the query. **Ian, 2026-09-05: confirmed in scope**, which T-215 already was |
| Activity log (v1: `/activity-log`) | **Add** | v2 already has `packages/db/schema/audit-log.ts` — the schema exists with (very likely) no viewer screen. Same "done but uncalled" pattern as user-management. Cheap add given the schema is already there |

#### Onboarding — redesigned, not ported as-is (decided 2026-09-05)

v1's model is a **library**: five content kinds (handbook/rules/training/menu/exam), each independently completable in any order, versioned with forced re-acknowledgment on edit, staff-proposed drafts routed through an admin approve/reject queue, and exams split into auto-graded multiple-choice plus manually-graded open-ended with its own grading queue. Ian's own assessment: too many moving parts for its purpose. v2 replaces it with a **single ordered track**:

- **One sequence of steps** per track (start with one universal "New Hire" track; per-position tracks are a later, separate decision, not day-one scope). Each step is either *a short document to read and acknowledge* or *a short multiple-choice check* — the kind taxonomy (handbook/rules/training/menu) collapses into just "step N's content," since the ordering already carries the meaning.
- **Strict gating:** a staff member sees step `current_step_index` only. Earlier steps show as completed; later steps are locked and not previewable. This is the literal fix for "no staff can jump to end without steps start and middle."
- **One number tracks progress**, not a scattered per-item collection: `current_step_index` + `completed_at` per staff member. The staff view is a vertical stepper: "Step 2 of 5 — House Rules."
- **Cut, deliberately:** content versioning/forced re-ack (if a step's content changes, it just changes — this is a handbook, not a signed legal document), the staff-proposal/admin-review pipeline (admin/manager edits the track directly), and open-ended manually-graded questions (multiple-choice only — a comprehension check, not a certification exam, so immediate retry on failure rather than a review queue).
- **Manager view:** one table, staff × current step, to see at a glance who's stuck and where.
- **Four-verb call:** *Correct* the structure (collapse five independent kinds + versioning + proposal pipeline into one linear, gated track) while *keeping* what worked (real content, a comprehension check at the end).

This is a proposed shape, not yet built — flag if the single-universal-track starting scope is wrong before it's built.

## 7. Confirmed gaps and risks that block calling this "complete" — synthesized from three separate registers

These are pulled together here because they currently live scattered across `DEFECTS-REGISTER.md`, `CAPABILITY-GAPS.md`, and this session's own live testing — no single place states them as one punch-list today.

1. **No dashboard, no 404, no error page** — §5. Cheapest, most visible fixes available.
2. **User/role management has zero UI** — the capability exists and is tested; nobody can use it. (§6, Phase 7 top item)
3. **Two live compliance exposures, both need an Ian decision, not just engineering:** SC/PWD discount ID/name capture — nothing captures it anywhere today, and the statutory register (T-137) has nothing to register without it; and BIR 1601-E expanded withholding tax on supplier payments — neither v1 nor v2 handles it, and it's a live exposure the day a store pays rent or a contractor.
4. **T-187 (service-charge distribution) is an active landmine, not a future one:** `2160` accrues with no clearing mechanism. **Do not enable service charge in POS before this exists** — this is an operational tripwire, worth putting in front of whoever manages POS config, not just this codebase.
5. **PIN sign-in has no rate limiting** (DEF-063, a 6-digit PIN with no throttle). Explicitly deferred by Ian once already — but the Oct–Dec pilot is exactly the "real staff" population that deferral was conditioned on ending before. Worth a second look now that the pilot is live, not a new finding.
6. **Payroll's last two tasks are blocked on HR data, not code** (T-190/T-193 — 0 of 126 staff have SSS/PhilHealth/Pag-IBIG/TIN on file). This is the single item on this whole blueprint that engineering velocity cannot shorten — it should start **today**, in parallel with everything else, as an HR/ops action item with its own owner.
7. **Process risk, not a single defect:** the defects register shows a repeated pattern — domain logic shipped and tested with zero UI callers for days, caught only by live smoketesting despite a 2,258-test suite. `docs/RULES.md` §9 already requires a live smoketest as part of definition-of-done; the gap is enforcement, not the rule. Recommend making "does a screen actually call this" an explicit checklist line in whatever wraps up each Phase 7 task, since Phase 7 is exactly the kind of "wire a screen to existing domain logic" work where this bites hardest (the user-management gap above is a live example of it happening in Phase 2's own capability work).
8. **Documentation drift:** `HANDOFF.md` is ~10 days stale and materially understates progress (still says "Phase 1 complete, T-122 in flight"); `PROJECT_BIBLE.md`/ADR-002 still describe an infrastructure design (Cloud SQL + Firebase App Hosting) that was rejected in favor of the real DO-Postgres deployment (DEF-153). Neither blocks shipping, but both actively mislead the next cold session — worth a short Opus-planner pass, flagged here rather than fixed here (not this session's role per §3.1a).

## 8. Trying it with real data — the mechanism already exists

Ian asked to "copy real data from v1 and try it out to discover edge cases." That mechanism **already exists and has already run once**: `packages/etl` + `packages/etl-firestore` is a purpose-built, read-only, re-runnable capture-and-audit pipeline (`npm run capture -- --store <code> --collection <name> --fetch`, landing into an **immutable** Postgres table, then `npm run audit -- --as-of <date>` reconciling against it — the audit step touches no Firestore at all, per its own invariant). It already pulled **19,358 real v1 documents** and that pass is what originally found DEF-043 through DEF-050 (AP/AR never seeded, depreciation stopped, franchise-modeled-as-branch). This session's own live click-through independently surfaced a real example of exactly the kind of thing this mechanism is for: the seeded "Smoketest Commissary" store's Findings page correctly flagged its own FIFO-vs-ledger mismatch (₱2,240 vs −₱910) — the self-auditing design works as intended, on live data, right now.

**Update 2026-09-05 — Ian approved the re-run; count-only pass completed this session.** `npm run capture` (no `--fetch`, so zero documents actually read — this is the tool's own built-in dry-run) was run across the 4 real operating stores (Lipa, Malvar, Banay-Banay, Davao) for 13 collections not covered by the original 19,358-document pull: attendance (`attendanceSessions`, `attendanceRawTaps`, `breakLogs`), inventory (`itemStockLedger`, `deliveries`, `stockTransfers`, `stockCounts`, `branchOrders`, `wastages`, `posUsagePulls`), and payroll (`payrollStaffPayouts`, `salaryAdvances`, `payrollAdjustments`).

**Result: 10,916 documents counted.** Notably uneven across stores — Lipa alone accounts for ~8,540 of them (5,987 `itemStockLedger` rows, 898 `stockTransfers`, 635 `salaryAdvances`), while Davao (opened ~2026-08-16) has almost nothing yet, as expected for a new store. `payrollStaffPayouts` is 0 everywhere — v1 never wrote to that collection, confirming it's the "legacy/superseded" one per the data-model discovery doc; the real historical payroll data (if any) would be in `payrollRuns`/`payslips`, not captured here since those are marked legacy too.

**One concrete payoff already: this unblocks a specific, currently-blocked test.** `tests/golden/attendance-adjudication.test.ts` (T-157) is a real, named golden-master test sitting in the repo today, explicitly skipped with the comment *"BLOCKED: the corpus is not captured... needs Ian"* — waiting on exactly `--collection attendanceSessions`. That data is now counted and ready to fetch.

**Still pending, deliberately not done automatically:** the actual `--fetch` (landing real documents, including staff names and other PII, permanently into the immutable `etl_source_documents` table — per `secrets/README.md`, that table then has to be treated as production data itself: never exported, never copied into a shared report or fixture). Count-only was the explicitly agreed first step; running `--fetch` on these same 52 targets is the natural next action and is small (10,916 documents, well under the original 19,358-document pull) — flagging it as ready to go on the next go-ahead rather than assuming it.

## 9. Build phases and the fast-track timeline

Two velocity scenarios, because the evidence for each is real: Phase 3's 20 tasks shipped in roughly 3–4 days (2026-09-01 to 09-04) using **four parallel, isolated-database implementation lanes** (`reference_parallel_lanes_isolated_test_dbs` memory) — a demonstrated, not theoretical, capability of this team. Below assumes that pattern continues where tasks are independent enough to lane.

| Window | Work | Depends on |
|---|---|---|
| **Now → +1 week** | Shell sprint: dashboard (T-211), `not-found.tsx`, `error.tsx`, credential-not-issued state. All four are small and independent — one parallel lane, done fast | Nothing — start immediately |
| **Now, in parallel, ongoing** | HR starts collecting SSS/PhilHealth/Pag-IBIG/TIN for all 126 staff | Not blocked by any of the above — this is the true long pole, start it today regardless of engineering pace |
| **+1 → +3 weeks** | Phase 2 stragglers (T-136 close-out) + Ian's decisions on §7 items 3–4 (SC/PWD capture, BIR 1601-E, service-charge go/no-go) — decisions first, code follows | Needs Ian's time, not just engineering capacity — the actual bottleneck of this phase |
| **+2 → +5 weeks** | Phase 6 bulk: T-209b/c, T-210–216 (AR/AP aging, cash flow, sales reporting, dashboard tie-in, insights wave 2, scorecards, budgets, recurring-expense automation) — laneable, several independent tasks | Dashboard (T-211) benefits from landing early since other Phase 6 screens will link into it |
| **+3 → +7 weeks** | Phase 7 (§6, now fully decided): user/role management **first** (unblocks a tested-but-uncalled capability), then activity-log viewer, memos, performance+team, checklists, infractions, the redesigned onboarding track, cookbook/recipes last | User-management should not wait — it's cheap and already fully specified by the existing capability matrix. (T-215 expense budgets stays Phase 6, per its own existing scope — not new to this plan) |
| **+5 → +8 weeks** | Compliance/risk closure (§7 items 3, 4, 5), fresh ETL capture+audit re-run (§8), full live-smoketest pass across every module per RULES.md definition-of-done | Needs the SC/PWD and BIR decisions landed first |
| **~2026-11-15** | **Go/no-go gate** (existing ADR-007 milestone — this plan targets landing everything above before it, not instead of it) | — |
| **Nov–Dec 2026** | Pilot continues live (already in progress) | — |
| **2027-01-01** | Cutover (ADR-005) | — |

**Honest caveat:** the 8-week end date assumes parallel lanes stay available and, more importantly, assumes Ian's own decision throughput on the Unresolved items below keeps pace — several tasks above cannot start until a specific yes/no lands. The single non-negotiable long pole is the payroll HR data collection, which is calendar time, not engineering time, and should start today independent of everything else in this document.

## 10. Skill / session routing

| Area | Owner | Why |
|---|---|---|
| Shell pages (dashboard, 404, error) | `fullstack-engineer` skill, Sonnet lanes | Small, independent, well-specified by §5 |
| Phase 7 module build-out | Sonnet parallel lanes, coordinator pre-wiring shared files (per `reference_parallel_lanes_isolated_test_dbs`) | Same demonstrated pattern as Phase 3 |
| SC/PWD, BIR 1601-E, service-charge decisions | Ian, directly — not delegable | Compliance/business calls, not implementation |
| Bible/ADR drift (DEF-153), HANDOFF.md refresh | Opus planner | RULES.md §3.1a — documentation-of-record edits are an Opus job |
| Fresh ETL capture+audit re-run | Whoever holds the `secrets/` capture service-account credentials today | Touches real production Firestore at scale — deliberate, not delegated to a fresh subagent |
| Review of this document itself | Opus planner, before merging any part of it into `docs/plans/` | This document's own status line — it is a Sonnet draft |

## 11. Assumptions & Open Questions

**Confirmed**
- Production is live at erp2.shareat.net since 2026-09-04; ROADMAP.html is current and authoritative on phase status.
- No signup, pending, or custom 404/error page exists in v2 today; login (`/sign-in`) is built and upgraded over v1.
- 74 page routes exist; the accounting/inventory/attendance core is functionally complete and, per live testing, working correctly (balance sheet ties, Findings engine correctly flags a real inventory mismatch on seeded data).
- User/role-management UI does not exist despite the underlying capability being built and tested.
- The v1→v2 real-data ETL/audit mechanism already exists and has already run once at scale (19,358 documents).
- **DECIDED, Ian, 2026-09-05: no self-service signup, ever, for anyone.** §5's Delete recommendation is final.
- **DECIDED, Ian, 2026-09-05: `manager/budgets` is in scope for v2.** It was never actually unowned — `ROADMAP.html` already names it T-215 (Phase 6). Corrected finding: v1's real feature (auto-reissue on a verified daily cron) is richer than T-215's current one-line scope; its implementer should read v1's source before building.
- **DECIDED, Ian, 2026-09-05: onboarding is in scope, redesigned per §6's new subsection** — a single linear, gated track, not v1's five-kind library with proposal/versioning/open-ended-grading machinery.
- Count-only ETL pass (§8) completed 2026-09-05: 10,916 documents counted across attendance/inventory/payroll for the 4 real stores. Zero documents actually read (count-only). This unblocks T-157's golden-master test, currently skipped pending exactly this data.

**Inferred**
- Phase 7's proposed scope (§6) is inferred from v1's route catalog and this project's own capability-gaps register, not from an explicit Ian request for each item — the four-verb assessment here is this document's judgment call, meant to be argued with, not treated as decided.
- `account/profile`/`account/security` v1 equivalents may already be partly covered by `/staff/[id]/credentials` — not confirmed either way this session.

**Proposed**
- The onboarding redesign's starting scope — one universal "New Hire" track rather than per-position tracks (§6) — proposed, not yet built or Ian-reviewed in detail.
- The Phase 7 module priority order in §6/§9 (user-management → activity-log → memos → performance → checklists → infractions → onboarding → cookbook last).
- Two-scenario timeline in §9, with the aggressive end contingent on continued parallel-lane use.

**Unresolved (Ian must answer)**
1. **Run the actual `--fetch` on the 52 counted ETL targets (§8)?** Count-only is done (10,916 documents, zero read); the fetch step lands real PII permanently into the immutable landing table. Small in scope relative to the original pull, but flagged for an explicit go rather than assumed.

**Deferred**
- POS/CUSTOMER/Website app builds (ADR-003, staged through Q1 — explicitly not this document's scope).
- `admin/staff-identities` — revisit only after the user-management screen ships and only if it turns out still needed.
- Per-position onboarding tracks (beyond the single universal "New Hire" track) — later decision, not day-one scope.

## 12. AI Handoff Summary

Shareat System v2 is much further along than a cold reader of `HANDOFF.md` would believe — that file is ~10 days stale; trust `docs/ROADMAP.html` instead. The accounting spine, inventory, and attendance phases are genuinely done and correct, verified live in this session (dev server on 9008, seeded data, real screens rendering real numbers that tie). What actually reads as "unfinished" to a first-time visitor is narrow and cheap to fix: there is no home page (root `/` is a placeholder despite 74 built feature pages existing), no custom 404 or error page, and no screen for the user/role-management capability that already exists and is already tested. None of Ian's other three named gaps (signup, pending) are real gaps at all — v2 deliberately replaced v1's self-service signup with an admin-driven hire flow, for reasons this project has already learned the hard way twice, and **Ian confirmed that's final on 2026-09-05.** The one substantive new contribution of this document is **Phase 7**, which has a one-line stub in `ROADMAP.html` ("Admin, onboarding, memos, performance, checklists, cookbook") but no actual plan file: eight peripheral v1 modules (user/store admin, activity log, memos, performance, checklists, infractions, cookbook, and a redesigned onboarding) assessed under the project's own four-verb discipline and, as of this session, all decided in-scope — prioritized by which ones unblock already-built-but-uncalled capabilities first. A scoped, count-only ETL pass ran this session (10,916 documents counted, zero read) and unblocked a specific named test (T-157) that was sitting skipped waiting for exactly this; the actual `--fetch` is the one remaining open action. The load-bearing constraint on "soonest possible" is not code anymore — it's a real-world HR data-collection task (staff statutory numbers) that should start today regardless of engineering pace. Do not amend `PROJECT_BIBLE.md` or `docs/ROADMAP.html` from this document directly; route confirmed decisions through the Opus planner per `docs/RULES.md` §3.1a and §14.

---

**Plan scope snapshot:** the full v2 app across shell/auth, all 130+ v1 pages (four-verb catalog), a proposed and now-decided Phase 7, and a completed count-only ETL scan — orchestrating the UI/UX, data-flow, fullstack, accounting/inventory, QA, and integration lenses, weighted toward fullstack (most gaps are "build a screen for an already-correct backend") and UI/UX (the dashboard gap).
**Certainty snapshot:** roughly 75% Confirmed (four prior Unresolved items decided this session, plus the ETL count executed), 15% Proposed (the onboarding redesign's exact shape, Phase 7 order, the timeline), 8% Inferred, 2% genuinely Unresolved (just the ETL `--fetch` go-ahead).
**Single recommended next step:** approve the `--fetch` on the already-counted 52 ETL targets, and greenlight the shell sprint (§9, week 1) — both are small, independent, and each closes a concrete, named gap (T-157's golden test; the dashboard/404) immediately.
