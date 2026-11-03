# Goldfish Review Report (Stage 8 re-audit, Intermediate Zoom Out)

**Target:** `docs/designs/channel-settlement-upload.md` (lines 1-566)
**Reviewer lens:** `zoom-out`
**Earlier report:** `intermediate_zoom_out_report.md` (8 findings)

Verdict: all 8 earlier findings are addressed. The edits introduced no Blocker. Three Majors remain: an incomplete `settledOn` rule that contradicts the blocker list, a month-close guard that will fire every month and is not described as a routine, and migration numbers 0213/0214 that another task may already hold.

Counts: 0 Blocker, 3 Major, 6 Nit.

## Status of the 8 earlier findings

| # | Finding | Status | Evidence (current lines) |
|---|---|---|---|
| 1 | Close guard bypassed the findings feed | ADDRESSED | 257 (detector in the feed, "nothing is added inside `closeBlockers`"), 258, M1 534, M3 540 |
| 2 | Deferral table in the wrong owner, not registered | ADDRESSED | Item 2a 411-413 (migration 0215, settlement module), amount stored 258 and 413, registered 449 and 452, "six" tables is correct, schema item 5 at 422 |
| 3 | Wrong permission | ADDRESSED | 245, 258, 540 all name `override_period_lock` (admin only, `capabilities.ts:198`, `:988`; `close_period` is also granted to managers, `:980`). See Nit 3 |
| 4 | Uniqueness mismatch | ADDRESSED for the index | 172 and 407 agree ("all channels, active or not"). See Nit 1 (leftover lookup rule) |
| 5 | Old loan columns | ADDRESSED | 213, 410, 422 all say drop in 0214 after the backfill |
| 6 | Two acknowledgement mechanisms | ADDRESSED | 214 and 493 (one acknowledgement with a typed reason), 410 (reason column). See Nit 2 |
| 7 | Implicit `settledOn` | ADDRESSED in text, rule incomplete | 215 states the normal rule and the `firstOpenDateOnOrAfter` fallback. See Major 1 |
| 8 | Blockers repeating T-150 | ADDRESSED | 203 (first group taken from `previewChannelSettlement` and the database wall; the module adds only intake checks) |

Code facts re-verified: `findings/index.ts:356-358` (acknowledged hard finding still blocks close) and `:139-160` (period-scoped detectors exist); `outstandingFor` at `repo/channel-settlements.ts:168` takes no as-of date, so M2 is a real extension; `firstOpenDateOnOrAfter` at `repo/fiscal-periods.ts:567`, used at `recurring-expenses/job.ts:184`; `recognizeGain` at `channel-settlements/index.ts:84, 320, 370`, gain check `:363-377`, `settledOn` already an input `:78`; safety limit `max(50, 10%)` at `:42-45`; latest migration on disk and in the journal is 0212.

## Prioritized Findings

### 1. The `settledOn` rule is incomplete and contradicts the blocker list - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** 203, 215, 258-259, 123, 541, 189, 407
* **Discrepancy Description:** Line 215 says a "deferred day" books on the payment-arrival date, with a first-open-date fallback. Nothing says how a day is known to be deferred (a deferral is per channel and period, 258). The day-line columns (189, 407) hold a payout reference and paid state but no payment-arrival date, although `grab-transfers.ts` reads a transfer date (467). Blocker 203 and test M4 (541) say "period closed for the settled-on date" blocks a day, yet 215 and 123 move a closed arrival date forward to an open date, so that blocker can never fire on a deferred day.
* **Rationale & Recommendation:** Write one rule: `settledOn` = sales date, unless a deferral covers the channel and the sales date's period, then the arrival date, else the first open date on or after it. "Period closed" fires only for a non-deferred day. Add an arrival-date column to `settlement_day_lines` and to migration 0213.

### 2. Month close will block every month by design, and the design does not say so - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** 72, 99, 256-258, 123, 270
* **Discrepancy Description:** Grab pays about a day late and Foodpanda a week late, so the 1220 balance at month end is routinely non-zero on every Grab and Foodpanda channel, including active stores. The owner decision stands, but as written it means up to eight channel deferrals every month, and each one lapses if the balance moves. The hard finding also feeds the clear-rate score (`findings/index.ts:504-556`).
* **Rationale & Recommendation:** State the expected monthly routine and volume. Then either add one admin action that defers all open channels for a period (per-channel stays available), or define "unsettled" as older than a normal payout lag. Say whether the deferred amount is captured by the system at defer time, not typed. Owner may keep it as is; the design must still say so.

### 3. Migration numbers 0213 and 0214 may already be reserved by T-398 - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** 405-416, 4, 258, 392-394
* **Discrepancy Description:** `docs/tasks/464-pos-tablet-sign-in.md:4` says T-398 S3/S4 "move to 0213/0214". The numbers are free on disk today (latest is `0212_t464_pos_tablet_pairings.sql`) but are not safe. The design hard-codes 0213, 0214 and 0215 in the slice list, the Target Files and Component M.
* **Rationale & Recommendation:** Mark the numbers provisional and taken from the orchestrator at spec time. Have the journal item say "next three free numbers". Keep the order of the three migrations, not their numbers.

### 4. Dead store-match logic - Severity: Nit
* **Affected Scope:** 437, 473, 60, 172
* **Discrepancy Description:** The lookup still reads "active first, else exactly one inactive, else none". With uniqueness across all channels, active or not (172, 407), at most one channel can match.
* **Rationale & Recommendation:** Collapse to "one match or refuse".

### 5. Schema item 5 omits a column - Severity: Nit
* **Affected Scope:** 420-422 vs 410
* **Discrepancy Description:** Item 5 lists the legs table, the deferrals table, the column drop and the check change, but not the acknowledgement reason column added to `channel_settlements` by 0214.
* **Rationale & Recommendation:** Add it to item 5.

### 6. Permission label mismatch - Severity: Nit
* **Affected Scope:** 245, 258, 507
* **Discrepancy Description:** `override_period_lock` is labelled "post into a closed period" (`capabilities.ts:1249`). Deferring a receivable is not posting. Item 41 also does not name the area-map entries (`capabilities.ts:772-793`), which record every capability.
* **Rationale & Recommendation:** Say it is reused only for its admin-only bar. Item 41 should name the area map.

### 7. Component H counts do not match the slices - Severity: Nit
* **Affected Scope:** 211, 215, 392-394
* **Discrepancy Description:** "Three changes, all in migration 0214" is wrong for change 3. The settled-on date needs no schema change and lands in slice 8, not slice 6.
* **Rationale & Recommendation:** Reword to "two schema changes in 0214 plus one behaviour change".

### 8. Verification Plan misses 0215 and the new tests - Severity: Nit
* **Affected Scope:** 558, 541, 525
* **Discrepancy Description:** Line 558 says "both migrations" but there are three. No verification line covers the variance, acknowledgement or deferral tests; they appear only in M4. M4 also holds variance and order tests that belong in item 53, and the two overlap.
* **Rationale & Recommendation:** Add 0215 to the fresh-gate run. List each test once.

### 9. Existing consumers missing from Target Files - Severity: Nit
* **Affected Scope:** 213, 214, 46, 54-55
* **Discrepancy Description:** Component H says existing callers and the screen must change. The real `recognizeGain` and loan-leg callers are `apps/erp/src/app/channel-settlements/actions.ts` and `SettlementForm.tsx`, and tests `t351-settlement-preview-render.test.ts` and `t343-s5-5v-followups.test.ts`. Only `page.tsx` (46) and a few app tests (55) are listed.
* **Rationale & Recommendation:** Add those four files.

## Housekeeping
* Item "2a" (411) is awkward. Renumber so the migration items run 1 to 3.
* Status line (4) says "stages 5 to 7" and omits Stage 8.
* Slice 2 title (388) omits the four staging tables that 0213 creates.

## Still deferred (not re-raised)
Smaller release (fallback kept at 397); four staging tables; CSV reader reuse; capability count; plan altitude (file-by-file items).

## Checks that passed
* Counts agree: three journal entries (416), four staging tables, six new tables (items 14 and 15 list all six), three new capabilities (J and item 41).
* Migration 0214's description (410) covers the legs table, the backfill, the column drop, the shape check and the acknowledgement reason.
* Items 1-62 are sequential. M1-M4 sit in one contiguous block.
* Cross-references hold: Goal 10 to Component F, F to Goal 10 and Principle 5, decision 7 to H.2, decision 8 to M.
* Goal 14, decision 8, Component M, M1 and M4 agree that the amount is stored and that the detector skips only while the balance equals the deferred amount.
* Owner decisions honoured: a shortfall above the limit is approvable with a typed reason (Goal 10, 214, 493); month close is blocked with admin deferral (Goal 14, M); release 1 includes booking (Alt-A, slices 6-8).
