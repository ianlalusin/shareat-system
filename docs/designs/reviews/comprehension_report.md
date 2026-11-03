# Goldfish Review Report

**Target:** `docs/designs/channel-settlement-upload.md` (`lines 1-453`; FeatureRange 1-287, DetailedRange 288-453)
**Stage:** 6 Comprehension Test. **Reviewer lens:** `comprehension` (single instance). **Standard:** re-implementation-standard.
**Verdict:** FAIL against the standard. Motivation, goals and file inventory are clear. Behavioral contracts are not: a new engineer would have to invent the reader and staged-line schemas, the loan-split algorithm, the approve/reject signatures, refusal texts, numeric caps, and the rounding and tolerance rules.
**Counts:** 11 Blocker, 13 Major, 6 Nit.

## Prioritized Findings (Blockers -> Major -> Nits)

### 1. Loan-split algorithm and "groups" undefined - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 41, 80, 160, 380
* **Discrepancy Description**: "Split them into groups so each open loan's group adds up to its expected daily amount" gives no algorithm. Missing: matching method, handling of deductions tied to no loan, whether one deduction may split across loans, what "more than one split fits" means, and how an admin chooses (no UI, storage or state). "Doesn't match" vs "no matching loan recorded" are not cleanly separated. "Open loan" is itself an open question (line 80).
* **Rationale & Recommendation**: The loan check cannot be implemented as written. Write numbered steps with a worked example (Lipa 12 Oct; 13 Oct three-store split), and specify choose-split storage and UI.

### 2. Money precision, tolerance and rounding unstated - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 41, 45, 66, 139, 160, 246
* **Discrepancy Description**: "Exactly" is required for control totals, loan sums and week-to-invoice, but amount type (centavos, decimal, float) is never given. The safety limit "greater of 50 pesos or 10% of sales" has no rounding mode, no rule for comparing against a signed difference, and no statement of which sales figure (file or recorded) the 10% applies to. Line 246 implies no tolerance but never says so.
* **Rationale & Recommendation**: Add one "Money" subsection: type and unit, comparison operator, rounding rule, "no tolerance" statement.

### 3. Approve/reject API contract missing - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 95, 164-168, 338, 386
* **Discrepancy Description**: No signatures, input types, result or error union, idempotency rule, or compare-and-set failure message. The gain-or-variance input has no type or values. Refusal codes ("blocked", "not current") are unlisted.
* **Rationale & Recommendation**: Give `approveDay` and `rejectDay` as typed signatures plus a refusal-code table.

### 4. Reader output and staged-line schemas undefined - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 111-117, 138-140, 148-151, 194, 365-376
* **Discrepancy Description**: Readers output "a list of store-days" and stage outputs "a line" with no field list. `settlement_day_lines` is a prose list ("charge amounts by kind"): no column names, types, nullability or enum values. "Reader version" and "pointer to the replacing upload" have no format. The per-file result shape returned to the UI is absent.
* **Rationale & Recommendation**: `stage.ts` and the migration cannot be written without invention. Add a schema section and TypeScript shapes for reader output, staged line and per-file result.

### 5. Numeric limits never given - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 105, 134, 363, 398, 424
* **Discrepancy Description**: "Size, type and zip limits", "per-purpose size limit", caps on compressed size, expanded size, entry count, and "a time limit on reading" have no values. Fixtures "too many entries" and "oversized expansion" cannot be built.
* **Rationale & Recommendation**: List each cap with its value, or name the constant and its owner.

### 6. User-facing refusal texts and reason list missing - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 37, 45, 97, 105, 113, 384, 445
* **Discrepancy Description**: "Clear message", "plain message", "names the column" recur with no strings. Line 445 requires a test for every refusal reason, but no list of reasons exists.
* **Rationale & Recommendation**: Add a table: reason code, trigger, message template.

### 7. "Ready for review" status vs open questions that block described behavior - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 4, 64-85 vs 16-49, 177-188, 384-386
* **Discrepancy Description**: Open: PIN to approve (74), reopening rejected days (75), period close (76), which stores count for "waiting" (81), refund handling (82), pre-week orders (84). The Detailed Plan builds `ingest.ts`/`review.ts` on them with no period-close behavior.
* **Rationale & Recommendation**: Split Open Questions into "decided" and "open, with the default the implementation uses".

### 8. Ads/6650 contradiction and first-person voice - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 39, 67, 180, 183, 186, 267-271
* **Discrepancy Description**: Line 67 leaves ads open ("I read 'all charges' that way. Say so if ads should stay in marketing"), while the mapping table, owner-decision paragraph and Alternative K treat ads on 6400 as settled. Line 180 folds marketing fee, Eater compensation and compensation credits into platformFee although Goal 4 lists charges, ads and marketing as separate tables.
* **Rationale & Recommendation**: State one decision, or mark open with an explicit default. Remove the "I"/"Say so" aside.

### 9. Loan-legs posting contract incomplete - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 68, 169-173, 181, 311-314, 392-394
* **Discrepancy Description**: Existing signatures of `computeSettlement` / `recordChannelSettlement` are not shown (only `loan: { loanId, amount, ownerStoreId }`). New input shape, debit/credit lines per leg (accounts "2400, or 1250/2150") and "the identity stays the same" / "single place fees are booked" are unexplained. `channel_settlements_loan_shape_check` is not quoted. Backfill owner store is unstated.
* **Rationale & Recommendation**: Show old and new input types, a debit/credit table per leg type, the check's old and new predicate, and the backfill rule.

### 10. "Changed since booked" and state transitions underspecified - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 46-47, 149, 168, 311, 383
* **Discrepancy Description**: "Different figures" has no field list or tolerance. Not stated: a second upload while a changed-since-booked pending exists; the old line's state after the admin cancels (states are only pending/booked/rejected); how approving the newer version interacts with the one-current-line unique index and what the prior version becomes.
* **Rationale & Recommendation**: Add a state-transition table covering upload, approve, reject, cancel, re-upload.

### 11. "Verified sales day" and recorded figure undefined - Severity: Blocker
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 38, 78, 119, 149, 162, 338, 377
* **Discrepancy Description**: The core comparison needs "the figure staff recorded for that channel and day", but the source table/field, gross-vs-net basis and "verified" meaning are never defined. Line 78 admits the match to Grab "Amount" is unconfirmed. When the recorded-figure snapshot is taken or refreshed is unstated.
* **Rationale & Recommendation**: Define source table and column, and the snapshot timing.

### 12. Unexplained project references - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 13, 96, 142, 146, 168, 188, 311
* **Discrepancy Description**: T-150, v1, ADR-012 §4a/§5, RLS, `app_current_org()`, CHECK, admin PIN used with no definition or link. `docs/GLOSSARY.md` is only planned as a modify target (line 434).
* **Rationale & Recommendation**: Add a glossary or link block near the Overview.

### 13. Domain terms undefined at first use - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 11, 13, 38, 46, 161, 177-188
* **Discrepancy Description**: "Store-day", "sales date" vs "order value", "staged line", "payout", "receivable", "deduction kind", "platformFee", "commission", "disbursal", "loan leg", "cross-store pair", "collection permission", "sales channel". "Order value (before discounts)" vs Foodpanda "Gross Food Value" not reconciled.
* **Rationale & Recommendation**: Short glossary near the Overview.

### 14. Grab column mapping not tied to real headers - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 138, 180, 188
* **Discrepancy Description**: Exact CSV headers and the row-kind values (loan, adjustment, cancelled, advertisement) are not given; "kind Payment" is the only one named. "Residual of merchant-funded discounts" unexplained. Line 188 admits the mapping is from column names only, yet it is used as normative.
* **Rationale & Recommendation**: List exact headers, row-kind values and sign conventions.

### 15. Foodpanda column letters vs "never by letter" - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 40, 66, 183
* **Discrepancy Description**: Mapping cites letters (Y, Z, AD, T, AB, AC, U, V, S, AE, K) without header words or which layout (June or October) they refer to, despite the shift between layouts.
* **Rationale & Recommendation**: Give exact header text per column and name the layout.

### 16. Foodpanda week/day rules ambiguous - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 66, 76, 84, 142, 371, 376, 424
* **Discrepancy Description**: "Last sales day of the invoice week" (max order date vs last day of week; line 142 says last sales date in file). Fee attached to a day posts into that day's period, colliding with the open period-close question. A charges-only invoice has no sales day, so the fee has no home. "Accept a workbook with no orders sheet" has no behavior.
* **Rationale & Recommendation**: Write explicit rules, including the charges-only case.

### 17. Fingerprint dedupe vs scope - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 105, 148, 311
* **Discrepancy Description**: Unique per organization, so a repeat upload by a manager without access to that store could return another store's result. Authorization vs dedupe ordering unstated. Hashed bytes unstated (whole zip vs inner xlsx).
* **Rationale & Recommendation**: State hashed bytes and authorize-before-dedupe.

### 18. Store-match rule inconsistencies - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 79, 132, 311, 338, 374
* **Discrepancy Description**: Case-insensitivity appears only in the migration. "Active first, else exactly one inactive, else none" omits two active matches (Goal 2 refuses). Duplicate inactive codes are allowed by the index but the rule is silent. No whitespace or leading-zero normalization. "Code change applies to future uploads only" is open at line 79 but stated flatly at line 132.
* **Rationale & Recommendation**: Replace with a decision table.

### 19. Grab status vocabulary and non-reconciling payout - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 138-139, 367
* **Discrepancy Description**: Only "Completed" and "Processing" are interpreted. Other statuses and unknown-status behavior are unspecified. One payout in 31 did not reconcile; whether production blocks or warns is unstated.
* **Rationale & Recommendation**: Enumerate statuses and the handling of a non-reconciling payout.

### 20. "Complete" and "residual" checks undefined - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 67, 157, 159, 365-377
* **Discrepancy Description**: "No gaps in the file's dates" conflicts with legitimate no-order days. The residual formula and Foodpanda's balance formula (`+S`, `+AE`) are not stated.
* **Rationale & Recommendation**: Give the reconciliation formula per platform.

### 21. Authorization and visibility rules unclear - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 36, 42, 160, 190, 408, 414-417
* **Discrepancy Description**: Approve/reject reuse `record_ar_collection` without justification. The loan check is company-wide, but a manager sees only own stores; what a manager sees when the check fails or waits on another store's file is undefined.
* **Rationale & Recommendation**: Add a visibility-by-role table.

### 22. Assumed environment knowledge in the Detailed Plan - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 290, 305, 311-317, 429
* **Discrepancy Description**: Droplet, gate database, port 9008, coordination board, plan mode, money-rule census, touch-target baseline, T-numbers, and the journal `when` rule (+86,400,000 per idx) are given without reasons or links.
* **Rationale & Recommendation**: Link repo conventions and define each on first use.

### 23. Inconsistent "clean day"/blocking lists - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 44-47, 97, 155-162
* **Discrepancy Description**: Goal 10's clean list omits "verified sales day" and "charges explained"; Principle 5 and Component F list different blockers.
* **Rationale & Recommendation**: One canonical named list of blocking conditions.

### 24. Disbursal matching and settlement equation missing - Severity: Major
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 69, 72, 161, 376
* **Discrepancy Description**: Matching by "same principal and start date" depends on fields the loan form does not yet capture (mandatory or not unstated). Net payout vs sales deposit vs receivable clearing amount is never written as an equation.
* **Rationale & Recommendation**: Write the settlement equation with the Lipa 12 Oct worked example.

### 25. Terminology duplication and drift - Severity: Nit
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 13, 42, 72, 85, 153, 246, 311
* **Discrepancy Description**: Repayment field named three ways ("real daily", "expected daily", `repayment_amount`). The 1,779.17 vs 1,771.88 text repeats in three places. "Stores a status for every store-day" vs no row for no-file days.
* **Rationale & Recommendation**: Unify the term and dedupe.

### 26. Open success target under "Ready for review" - Severity: Nit
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 3-5, 48, 77
* **Discrepancy Description**: Goal 13 has no number, so it is untestable.
* **Rationale & Recommendation**: Adopt the 15-minute proposal provisionally.

### 27. Unexpanded abbreviations and loose phrases - Severity: Nit
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 11, 17, 54, 143, 217
* **Discrepancy Description**: "PG", "MDR", "CPC", "COD", "Eater compensation", column "K"/"AD"; "1:45 AM" without timezone; "checked 2026-11-03" with no reference; "follow-up work soon" is not a spec.
* **Rationale & Recommendation**: Expand on first use.

### 28. Placeholder numbering - Severity: Nit
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 190, 309-312, 430-438
* **Discrepancy Description**: `tNNN`, `NNN`, `ADR-NNN`; migrations 0213/0214 asserted without saying how the index was determined.
* **Rationale & Recommendation**: Confirm the next index or state the rule.

### 29. Alternative L and figure provenance - Severity: Nit
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 153, 275-277
* **Discrepancy Description**: Alternative L's cons read as an argument against building; benefit unmeasured. "Grab takes 1,771.88" lacks loan identity and date.
* **Rationale & Recommendation**: Name the loan and date.

### 30. Slice 5 interim behavior and dependencies - Severity: Nit
* **Reviewer Lens:** `comprehension`
* **Affected Scope:** lines 297-299
* **Discrepancy Description**: "Visible but not yet wired" has no defined behavior (disabled? stubbed?). Slice 5's loan check needs open-loan listing not named as a slice deliverable; the posting change comes later in slice 6.
* **Rationale & Recommendation**: State interim behavior and dependencies per slice.
