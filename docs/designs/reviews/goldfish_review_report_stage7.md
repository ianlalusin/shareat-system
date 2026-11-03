# Goldfish Annotated Review Report

Status: resolved (2026-11-03). Owner rulings: #1 shortfall approvable, booked on the same sales day (variance or gain); #11 month close blocked while a platform receivable is unsettled, admin may defer with a reason, deferred days book on the payment-arrival date. All other proposed defaults accepted. Applied: all proposed fixes (#25 and #38 only in part). Contested: #34. The Stage 5 scope cut and the Stage 6 field-level detail are not applied (see the last section). The tally line below says 38/2; the correct split is 39 proposed fixes and 1 contest.

**Target:** `docs/designs/channel-settlement-upload.md` (FeatureRange, lines 1-287)
**Source findings:** `critic_report.md` (Stage 7). Stage 5 and 6 overlaps are noted per item, not re-listed.
**Code checks done by the Elephant:** `packages/domain/src/channel-settlements/index.ts` lines 339-384 (shortfall past tolerance is a hard refusal, only a gain has `recognizeGain`), line 447 (`outstandingFor` is per channel), and no `7200`/`splitPayment` anywhere in the file (all loan deduction goes to 2400).

**Tally:** 38 PROPOSE FIX, 2 CONTEST. 6 of the fixes need an owner decision first (marked **OWNER**). Those get a proposed default in the document, labelled "proposed, unconfirmed", until the owner rules.

## Blockers

### [1] Variance override does not exist in the posting - `design`, `structural`
*   **Scope:** lines 45, 73, 166, 170-173
*   ***AI Suggestion:*** PROPOSE FIX **OWNER**
*   ***Justification:*** Confirmed in code (index.ts:363-369): a shortfall past tolerance refuses with no override. Only a gain can be acknowledged. "No other change" in Component H is false if shortfalls are to be approvable.
*   ***Proposed Edit:*** Goal 10 and Component G/H: state the two cases. Gain above the limit: `recognizeGain` plus typed reason (stored on the staged line). Shortfall above the limit: **proposed default, release 1: stays refused**; the person corrects the sales day or rejects the day with a reason. A variance acknowledgement in the posting becomes a listed option for a later release. Remove "No other change".
*   **Owner question:** should an above-limit shortfall ever be approvable?

### [2] Per-day difference is not what the posting measures - `design`, `structural`
*   **Scope:** lines 38, 45-47, 119, 149, 162, 164-166
*   ***AI Suggestion:*** PROPOSE FIX **OWNER**
*   ***Justification:*** Confirmed (index.ts:447): the posting clears `min(channel balance, gross)`. Rejected days stay in that balance, so approving out of order can hide a gap.
*   ***Proposed Edit:*** Component G: at approval, the day's staged recorded figure must equal what the posting will clear. **Proposed default:** approve oldest unsettled day first; a day with an earlier pending or rejected day shows "earlier day not settled" as a blocker. Add this to the blocker list and add a test (approve day N while N-1 is unsettled). Name the masking as a risk in the new Risks section.

### [3] "Manager cannot post arbitrary figures" overstated; separation of duties - `design`
*   **Scope:** lines 74, 93, 95, 190, 222, 282
*   ***AI Suggestion:*** PROPOSE FIX **OWNER**
*   ***Justification:*** A manager can edit a file and upload it. The Transfers file is checked only against itself.
*   ***Proposed Edit:*** Principle 1 and Alternative C: reword to "the browser cannot send figures; a manager can still upload an edited file". Add the residual risk to Risks: nothing compares the booked deposit with the real bank or wallet deposit in release 1. **Proposed default:** the person who uploaded a file cannot approve its days; an admin may approve any. Bank-deposit check listed under Future Improvements.
*   **Owner question:** may the uploader also approve?

## Major

### [4] No Risks & Mitigations section - `design`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Add `## Risks & Mitigations` after the Technical Plan (table: risk, impact, mitigation). Rows: concurrent approve or upload, stale overwrite, closed period, negative per-day net, trusted uploader, file sensitivity and retention, zip bombs, reader failure mid-batch, re-reading stored files after a reader fix, out-of-order approval, loan interest split. Replace the "Risks to settle" bullets (199-203).

### [5] Silent override of T-150 sections 3 and 7; discount residual - `design`, `structural`, `style`
*   ***AI Suggestion:*** PROPOSE FIX (the residual part is **OWNER**)
*   ***Proposed Edit:*** Line 175 and 186: "This decision supersedes T-150 sections 3 and 7 for settlements booked from uploads. Only `commission` and `platformFee` are used; the other four kinds stay 0. A decision-log row is for the planner to add." Define the "residual of merchant-funded discounts" exactly or take it out of the mapping row until the owner confirms it; until then it is an unexplained amount and blocks.

### [6] Loan grouping does not match the scenario - `design`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Component F loan check: replace "groups" with per-loan totals for the day across all stores. Allocate by amounts, in a fixed order (older loan first) unless Grab rows carry a loan identifier; an admin can override the allocation. A row may be split across two loans. State plainly that it is **not yet known** whether Grab loan rows name a loan; slice 1 checks this on the real files and, if they do, the match is by id and the allocation step is dropped.

### [7] Multi-leg loan extension under-specified - `design`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Component H: name the columns `loan_id` and `loan_owner_store_id` and the check `channel_settlements_loan_shape_check`; say what happens to them (kept as the first leg, or dropped in the same migration, decided in the task spec); backfill one leg per existing loan settlement; void reverses every leg; consumers to update (settlement summary, T-178 wastage matcher, the screen, POSTING-PATTERNS). Gate: full T-150 integration suite. (This also answers the Stage 5 "two registers" point.)

### [8] Foodpanda per-day booking can go negative - `design`
*   ***AI Suggestion:*** PROPOSE FIX **OWNER**
*   ***Proposed Edit:*** Foodpanda decision bullet: add "if the last day's gross is smaller than the fees attached to it, the day is blocked with the message 'fees exceed sales on the last day'; **proposed default:** attach the fee to the nearest earlier day with enough sales". Say how one deposit is spread over the week's entries (`reference` = invoice number; the deposit is booked once, on the last day). Soften "adds up exactly" to "adds up to the invoice when no day is blocked".

### [9] Approval blocker list incomplete - `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Add one canonical named list of blockers (used by Goal 10, Principle 5 and Component F): no file, not paid, charges unexplained, store unmatched, no verified sales day, loan check not OK, no destination account on the channel, negative net deposit, a settlement already posted for the channel and day, period closed, earlier day unsettled.

### [10] Concurrency, stale uploads, cross-store dependence - `design`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Component D/G: approval compares the line's version and refuses if it is no longer current (already in the repo plan, now stated). A new upload that covers fewer days than the file it replaces shows a warning. When another store's lines change, dependent days' loan check is re-run and a booked day is flagged "changed since booked" if its loan figures change.

### [11] Closed-period behaviour blocking but undecided - `design`
*   ***AI Suggestion:*** PROPOSE FIX **OWNER**
*   ***Proposed Edit:*** Open Questions: restate as "T-150 refuses posting into a closed period (invariant 11). Late files are normal, so this will happen. **Proposed default:** the day shows 'period closed' as a blocker; an admin reopens the period under the existing close process, then approves." Keep it open until confirmed.

### [12] Loan interest versus principal split - `design`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX **OWNER**
*   ***Justification:*** Confirmed: the posting sends the whole loan deduction to 2400 (principal). Grab's daily deduction includes interest, so the loan balance falls too fast and `paid_off` can fire early.
*   ***Proposed Edit:*** Replace line 85 with a Risks row and an Open Question: "T-150 books the whole loan deduction as principal. Proposed default for release 1: keep that, show the loan's interest gap on the loan screen. Splitting interest (`splitPayment`, account 7200) is a later decision." Add how a loan ends against derived `paid_off`.

### [13] "Waiting for other stores' files" circular - `design`, `style`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Line 160 and 81: the set of stores to wait for is every store with an open loan deduction or a deduction seen in the period, not channel active status. Mark "proposed" until confirmed.

### [14] Upload scope, leakage, retention - `design`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Component B: a manager uploading a file whose code matches a store they do not manage gets "This file does not belong to your stores", with no store name. The duplicate-file lookup is scoped by organization and the caller's store permission. Original files are visible only to people who can see that store's review screen. Retention follows the stored-file rule; the retention period is for the task spec.

### [15] Core premise unverified under "Ready for review" - `design`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Set Status to **Draft**. Add "Slice 1 exit criteria" to the Technical Plan: confirm Grab "Amount" and Foodpanda column K against one real recorded store-day each, and confirm every Grab column mapping on real files.

### [16] Open Questions mixes decisions, requirements, questions - `style`, `structural`, `design`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Add `## Decisions Taken` (date, who) holding lines 66, 67 (split into three), 71. Move requirements (68, 69, 72) into the Technical Plan. Open Questions keeps only unresolved items, each with a proposed default and who decides. Remove first-person phrasing.

### [17] Same item open in one place and decided in another - `style`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** For ads, waiting-time, cancellation and compensation: mark "proposed, owner to confirm" wherever stated (67, 180, 183, 186, 271). Same for "code change applies to future uploads only" (79, 132) and the wait rule (81, 160).

### [18] Shown-versus-booked contradiction for adjustments and compensation - `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Add a small table, per row kind: in order value? in the Transfers control total? booked? Adjustments, compensation, Eater compensation, advertisement: not in order value, in the control total, booked as `platformFee`. Goal 4's "kept out of day totals" is reworded to "kept out of order value".

### [19] Terminology drift - `style`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Add a terms table after the Overview mapping doc terms to T-150 and schema names: store-day, sales date (`businessDate`), order value (`grossAmount`), review state (not the settlement `status`), staged line, platform (a channel), cancel (the existing void), v1 (the legacy ERP at `ERP-rebuild`). Write the Foodpanda column as "Platform Fee (column)" and the kind as `platformFee`.

### [20] PandaGO-only invoice "rejected" vs state model - `style`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Line 55: a PandaGO-only invoice shows the file status "PandaGO: not booked here". It has no store-day line, so it has no review state and nobody rejects it. Remove "is rejected with that reason".

### [21] Stale text around the mapping table - `style`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Delete "Needs decision columns block approval" (175). Line 270: drop "no clear home" (line 67 resolves it). Line 186: "commission and `platformFee` both land on 6400".

### [22] Loan-record claims stale and partly out of scope - `style`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Confirmed from `packages/db/schema/loans.ts`: start date, term in periods, rate, rate period, status and closed-on already exist.
*   ***Proposed Edit:*** Lines 72, 153, 284: one line. "This release adds one field to the loan record: the expected daily repayment amount. Weekly and semi-annual rate periods are a separate loans task." Delete the "end date or start plus term" question.

### [23] Goal 13 unmeasurable - `style`, `design`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Goal 13: "Provisional target: under 15 minutes a week, owner to confirm. Baseline: about one hour a week, as reported by the owner." Add the expected blocked-day rate from the October data as a slice 1 task.

### [24] Unverifiable claims stated as fact - `style`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Line 216: drop "Nobody has seen a file the plain reader cannot read." Lines 144, 222: "known security problems" becomes "has published security advisories (to be named in the task spec)". Cite v1 `parse-grab.ts`/`parse-foodpanda.ts` for browser parsing. Lines 138-139: "30 of 31 payouts in each store in October; the 31st is unexplained and is checked in the real-file test".

### [25] Same facts restated three or more times - `style`, `structural`
*   ***AI Suggestion:*** PROPOSE FIX (partial)
*   ***Proposed Edit:*** State the owner charge decision, the Foodpanda fee placement, the 1,779.17 vs 1,771.88 figures, the one-leg limit and the PandaGO rule once, in Decisions Taken or the Technical Plan. Elsewhere use one sentence and a link. Overview and Goals keep short summaries by design.

### [26] "Wins" and "truth" slogans conflict - `style`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Line 38: "the platform figure is the reference value for the comparison". Line 8 and 73: "the newest upload supersedes older ones". Line 73: "conflicts with" in place of "meets".

## Nits

### [27] Fixture date wrong - `design` (lines 80, 160) - PROPOSE FIX
Change to "591.24 a day until 12 Oct, then 2,363.12 a day from 13 to 27 Oct, then 1,771.88 a day". Verify the sum against the October files in slice 1 before it becomes a test.

### [28] Undefined references and soft deferrals - `style`, `design` - PROPOSE FIX
Cite or drop "the reviewers' advice" (209). Define "release 1" (slices 1 to 8 as now planned). Replace "follow-up work soon" with "after release 1; owner to date it".

### [29] Edge cases without a rule: closed store-day, rejected re-open - `design` - PROPOSE FIX
A store-day with no orders and no payout is not a gap: "Complete" checks the control file's payouts, not a continuous date run. Rejected days stay rejected unless an admin re-opens them (proposed default; owner to confirm).

### [30] Code uniqueness versus lookup - `structural` - PROPOSE FIX
Make a code unique per organization and platform across all channels, active or not. Rename or close frees it explicitly.

### [31] Staging key inconsistent - `structural` - PROPOSE FIX
Key is channel, sales date, version everywhere. Data flow box: "channel (store + platform)".

### [32] "Future Improvements" heading level - `structural`, `style` - PROPOSE FIX
Promote to `##` after Alternatives Considered.

### [33] Component and Alternative labels collide - `structural` - PROPOSE FIX
Components C1 to C12 (or keep letters A-L), Alternatives Alt-A to Alt-L. Move the verdict out of the Alternative A heading. Update the cross-references ("Alternative F").

### [34] Horizontal rules inconsistent - `structural` - **CONTEST**
*   ***Justification:*** The rules follow the EGM template, which puts rules between the Overview group, the Technical Plan and the Implementation Plan. A nit with no effect on readers; changing it adds no clarity.

### [35] Missing links and some alternatives - `structural` - PROPOSE FIX
Link T-150 (`docs/tasks/150-channel-settlement.md`), the capability matrix, the intake doc, and the v1 parser files on first use. Add three one-line alternatives: auto-book clean days, one settlement per loan leg, relaxing one-settlement-per-channel-day.

### [36] Vague wording, first person, heavy bold - `style` - PROPOSE FIX
Replace "clear message" with the named refusal reasons. Define "reader = deterministic parser, no AI" once. Remove first person ("I read", "files I opened", "Say so if"). Use "undecided" for "unchecked". Limit bold to state names and defined terms.

### [37] Units, dates, acronyms - `style` - PROPOSE FIX
PHP on first amount, ISO dates, glossary line for PG (a store opening later), CPC (cost per click ads), MDR (card fee), COD (cash on delivery), RLS, PIN. Add "Column letters refer to the sample files; the reader uses header words."

### [38] Alternatives formatting - `style` - PROPOSE FIX (partial)
Split Alternative F into F1 (spread over days) and F2 (separate entry). Move Alternative L's editorial to its Cons. Leave A as is.

### [39] Non-goals lack reasons - `style` - PROPOSE FIX
Add a reason to "Copying v1's extras" (60), and rewrite 62 as a full sentence. Note the owner confirmation of the cut, as RULES section 3 requires.

### [40] Permission wording circular - `style` - PROPOSE FIX
"A test that the role without the permission is refused." Name the reused permission `record_ar_collection`.

## What this does not cover
*   The Stage 5 finding to cut the release to slices 1-5 (smaller scope), the four-tables point, and the CSV/checksum reuse points are about scope and the Detailed Plan (lines 288+). They are not applied here. They belong to a scope decision by the owner, and to Stage 9 and the task specs.
*   The 11 Stage 6 blockers about missing schemas, signatures, caps and refusal texts are mostly field-level detail that the task specs should hold. Only the loan split steps, the money rules, the status transitions and the open-question defaults are added to the design here.
