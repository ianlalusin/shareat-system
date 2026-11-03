# Goldfish Review Report (Stage 7 Critic Review)

**Target:** `C:\Users\ianla\webapps\shareat-system\docs\designs\channel-settlement-upload.md` (`lines 1-287`, everything before "## Detailed Implementation Plan")

**Reviewers:** `design`, `structural`, `style` (run in parallel, one instance each). Standard: `feature-spec-standard.md`.
**Note:** `agents/egm-style.md` does not exist on disk. The style reviewer used `agents/style.md`.
**Totals:** 3 Blocker, 23 Major, 14 Nit (after deduplication).

Verdict: not ready to pass. The Alternatives rule is met (A to L). Risks & Mitigations is not. Three money-path problems conflict with shipped T-150 code or with the trust model.

## Prioritized Findings (Blockers -> Major -> Nits)

### 1. Variance override does not exist in the posting - Severity: Blocker
* **Reviewer Lens:** `design`, `structural`
* **Affected Scope:** `45, 73, 166, 170-173` (goal 10, Open Question "Safety limit", Component H)
* **Discrepancy Description**: The design says an above-limit difference needs a typed reason and a confirmation that the gap is a gain or a variance. Component H says "no other change" to T-150 beyond loan legs. In `computeSettlement`, an above-tolerance variance (shortfall) is a hard blocker with no override. Only an above-tolerance gain has `recognizeGain`. `RecordSettlementInput` has no typed-reason field. The shortfall case the owner cares most about cannot be approved.
* **Rationale & Recommendation**: Choose one. Either specify a variance acknowledgement in `computeSettlement` and the preview (and where the reason is stored), list it in H as a T-150 change with tests, or state that above-limit shortfalls stay refused and must be fixed by correcting the sales day or rejecting. Remove "no other change".

### 2. Per-day difference is not the quantity the posting measures - Severity: Blocker
* **Reviewer Lens:** `design`, `structural`
* **Affected Scope:** `38, 45-47, 119, 149, 162, 164-166`
* **Discrepancy Description**: `outstandingFor` sums the 1220 balance for the whole channel (party = channel). `computeSettlement` clears `min(channel outstanding, gross)` and measures variance and gain against that. The design snapshots, compares and applies the safety limit per store-day against the staff-recorded figure. Rejected days "stay on the receivable" (46, 167), so they inflate the channel balance. Approving days out of order can mask a later day's gap and keep it from reaching the safety limit. The snapshot the approver sees can differ from what posts. Lines 164-166 say checks re-run but never say the posting reads the same figure.
* **Rationale & Recommendation**: State which figure drives the safety limit. Require the day's outstanding to equal the staged recorded figure at approval, or add a per-day outstanding to the posting. Add an ordering or rejected-day rule and a test for approving day N while day N-1 is unsettled. Otherwise record the masking as a named risk.

### 3. "Manager cannot post arbitrary figures" is overstated; separation of duties undecided - Severity: Blocker
* **Reviewer Lens:** `design`
* **Affected Scope:** `74, 93, 95, 190, 222, 282`
* **Discrepancy Description**: A manager can edit a CSV or xlsx and upload it. It passes parsing, and the Transfers control total only checks the file against itself. Nothing compares booked `netDeposited` with the real bank or wallet deposit (the PDF cross-check is deferred, 282). "May the uploader also approve?" is open (74), with a proposal of no PIN. This moves the trust boundary but does not close the v1 defect.
* **Rationale & Recommendation**: State what the control proves and what it does not. Decide separation of duties before build (uploader differs from approver, or an admin approves any non-zero difference or loan-bearing day). Add a bank-deposit reconciliation as a mitigation or as a named residual risk.

### 4. No Risks & Mitigations section - Severity: Major
* **Reviewer Lens:** `design`, `structural`
* **Affected Scope:** `199-203` (and scattered at `134, 197, 202-203`)
* **Discrepancy Description**: The standard requires failure modes, security implications, limits and mitigations. The doc has three deferral bullets. Missing: concurrent approve/upload races, stale overwrite, closed periods, negative per-day net, trust in the uploader, file sensitivity and retention, malicious or oversized files (zip-bomb limits appear only inside Component B), reader or library failure mid-batch, and re-reading a stored file after a reader fix (the reader version is stored, but there is no re-read policy).
* **Rationale & Recommendation**: Add a top-level "## Risks & Mitigations" table (risk, impact, mitigation, owner). Pull the scattered items into it.

### 5. Silent override of T-150 sections 3 and 7; discount residual booked to 6400 - Severity: Major
* **Reviewer Lens:** `design`, `structural`, `style`
* **Affected Scope:** `66-67, 175, 180-188, 269-271, 283`
* **Discrepancy Description**: All taxes, ads, withholding and compensation go to `platformFee` (6400). T-150 section 3 (marketing 6650, penalty 6410) and section 7 ("decided 2026-08-28", withholding 6800) say otherwise. The doc records the 2026-11-02 owner decision but does not say it supersedes those sections. RULES says only the Opus planner amends the bible. Line 175 ("accounts are from T-150") is wrong as written. The `marketing`, `vatOnFees`, `withholdingTax` and `penalty` columns will always be 0. Separately, the "residual of merchant-funded discounts" (180) is a P&L classification the owner ruling does not cover (GLOSSARY has discounts as contra-revenue 4900). It also conflicts with Principle 5 (unexplained amounts block) and the "charges explained" check (159) unless the residual is defined exactly.
* **Rationale & Recommendation**: Add "Supersedes T-150 sections 3 and 7 for platform-uploaded settlements" and name the decision-log row to write. Fix 175 to "two of six kinds are used; four stay 0". Define the residual precisely and get the owner to confirm it.

### 6. Loan grouping model does not match the scenario - Severity: Major
* **Reviewer Lens:** `design`
* **Affected Scope:** `28, 69, 160, 172`
* **Discrepancy Description**: Grab takes the shortfall from other stores in partial amounts (for example 2,000 from one, 363.12 from another). Line 160 splits row deductions into groups so each open loan's group equals its expected daily amount. With two open loans (591.24 and 1,771.88) one row can straddle both. The design also assumes Grab rows do not name a loan.
* **Rationale & Recommendation**: State whether Grab loan rows carry a loan identifier. If not, define allocation as per-loan totals across the day with a deterministic order or admin allocation, and make legs amounts, not row groups. Say how a straddling row posts.

### 7. Multi-leg loan extension is under-specified against the schema - Severity: Major
* **Reviewer Lens:** `design`, `structural`
* **Affected Scope:** `68, 171-172`
* **Discrepancy Description**: `channel_settlements` has single `loanId` and `loanOwnerStoreId` columns. `channel_settlements_loan_shape_check` requires `loanId` non-null when `loanDeduction <> 0`. The design says "identity stays the same" and "no other change" but not what happens to those columns or the CHECK, to migration or backfill of existing rows, to void behaviour, to `POSTING-PATTERNS.md`, or to consumers (`toSummary`, the T-178 wastage matcher, existing single-loan callers and screen).
* **Rationale & Recommendation**: Name the migration changes (relax or replace the CHECK, nullable or derived `loanId`), the legs table, and the consumers to update. Name the cross-store invariant test. Note T-150's full integration suite as a gate.

### 8. Foodpanda per-day booking can go negative; bank deposit split undefined - Severity: Major
* **Reviewer Lens:** `design`
* **Affected Scope:** `66, 182-183, 241`
* **Discrepancy Description**: The weekly Platform Fee (223.21) and dated CPC ads attach to one day, usually the last. If that day's gross is small, fees exceed gross, `computeSettlement` refuses, and `netDeposited >= 0` forbids a negative net. "Week's entries add up exactly to the invoice" (66) is not guaranteed. The design never says how seven per-day entries debit the bank when the payout arrives once.
* **Rationale & Recommendation**: Define the low-sales and zero-sales last day (carry the fee to the nearest day with enough gross, or post the week as a unit). State how the single deposit is split across entries, `settledOn` and `reference`.

### 9. Approval blocker list is incomplete - Severity: Major
* **Reviewer Lens:** `structural`
* **Affected Scope:** `Principle 5, Component F` (around 150-160)
* **Discrepancy Description**: The list omits blockers T-150 already enforces: no destination account on the channel, `netDeposited >= 0`, a posted settlement already existing, a closed period.
* **Rationale & Recommendation**: List every blocker the posting enforces so the screen can show them before approval.

### 10. Concurrency, stale uploads and cross-store dependence unaddressed - Severity: Major
* **Reviewer Lens:** `design`
* **Affected Scope:** `132, 164-168`
* **Discrepancy Description**: "Latest upload wins" is by upload order, so re-uploading an older or smaller file can overwrite newer pending figures. No row lock or version compare is specified for a concurrent upload or a concurrent approve by two managers. The company-wide loan check makes store A's approval depend on store B's lines. If B's file is replaced after A booked, A is not marked "changed since booked".
* **Rationale & Recommendation**: Add a version or lock check at approval, a warning when a new upload shrinks coverage or changes pending lines, and re-evaluation of dependent days when another store's lines change.

### 11. Closed-period behaviour is unresolved but blocking - Severity: Major
* **Reviewer Lens:** `design`
* **Affected Scope:** `76, 142, Alternative F`
* **Discrepancy Description**: Grab files arrive monthly after month end and Foodpanda's September fee arrives in October. T-150 invariant 11 refuses posting into a closed period. The design acknowledges this but leaves it open, so the expected steady state (late files) may be unapprovable. Open Question 76 is partly answered by invariant 11. Only the UX is open.
* **Rationale & Recommendation**: Decide before build: which `settledOn` is used, or an admin-only exception path.

### 12. Loan interest versus principal split - Severity: Major
* **Reviewer Lens:** `design`, `structural`
* **Affected Scope:** `20-33, 85, 159-161`
* **Discrepancy Description**: T-150 books the whole loan deduction to 2400 (principal). The loans schema says interest is 7200 and `paid_off` is derived from the ledger balance. Grab's daily deduction includes interest (85). Booking it all as principal makes the loan balance fall too fast and can fire `paid_off` early. Line 85 treats this as an accrual difference only. (The design reviewer did not read the loans domain closely. Verify.)
* **Rationale & Recommendation**: State how each deduction splits between principal and interest, and how "loan ends" interacts with derived `paid_off`.

### 13. "Waiting for other stores' files" rule is circular - Severity: Major
* **Reviewer Lens:** `design`, `style`
* **Affected Scope:** `81, 132, 160`
* **Discrepancy Description**: The wait rule counts stores with an active Grab channel. Banay-banay's channel goes inactive after closing, while its deductions still appear in late payouts. Lookup includes inactive channels (132), the wait rule does not. After closure the check never waits for that store's file and can give a false "doesn't match" or a false OK. Line 160 states the rule as fact while line 81 says "Proposed".
* **Rationale & Recommendation**: Base the set on stores with open loans or deductions seen in the period, not on channel active status. Mark it "proposed" until confirmed.

### 14. Upload scope, leakage and file retention - Severity: Major
* **Reviewer Lens:** `design`
* **Affected Scope:** `36, 132`
* **Discrepancy Description**: Not stated: what happens when a manager uploads a file whose code matches a store they do not manage. The refusal message, the fingerprint-reuse reply ("return the earlier result") and staged lines could leak or mis-stage another store's data. Retention and access control of stored original files (customer order IDs, possible personal data) are unspecified.
* **Rationale & Recommendation**: Refuse without detail. Scope the fingerprint lookup by org and store permission. State retention and per-store access for original files.

### 15. Core premise unverified while status says "Ready for review" - Severity: Major
* **Reviewer Lens:** `design`, `structural`
* **Affected Scope:** `4, 14-16, 38, 78, 188`
* **Discrepancy Description**: Goal 3 treats Grab "Amount" and Foodpanda column K as comparable with staff-recorded sales. Open Question 78 admits this is unconfirmed on a single real store-day each. Every Grab mapping is "from the column names only" (188). About 20 questions are open, several blocking (period close, who approves, re-open, order-value columns).
* **Rationale & Recommendation**: Verify the two columns on real data before sign-off, or mark the document "Draft" and list the blocking questions.

### 16. Open Questions section mixes decisions, requirements and questions - Severity: Major
* **Reviewer Lens:** `style`, `structural`, `design`
* **Affected Scope:** `64-85`
* **Discrepancy Description**: Lines 66, 67, 71 are labelled "decided by the owner". Lines 68-69 are requirements. Line 69 is a fact. Line 72 mixes requirement and question. Line 67 is a ~200-word bullet holding two decisions and a new question, with first-person phrasing. The section also precedes the architecture it depends on.
* **Rationale & Recommendation**: Add a "Decisions taken" section (date, source) and keep only unresolved items in Open Questions with owner and default. Split line 67 into three.

### 17. Same item "open" in one place and "decided" in another - Severity: Major
* **Reviewer Lens:** `style`
* **Affected Scope:** `67 vs 180/186/271; 132 vs 79; 160 vs 81`
* **Discrepancy Description**: Ads, waiting-time, cancellation and compensation are "open" at 67 but settled in the mapping (180, 183), Alternative K (271) and 186. "A code change applies to future uploads only" is design fact at 132 but "not yet confirmed" at 79.
* **Rationale & Recommendation**: Mark each "proposed, unconfirmed" wherever stated, or move it to Decisions.

### 18. Shown versus booked contradiction for adjustments and compensation - Severity: Major
* **Reviewer Lens:** `structural`
* **Affected Scope:** `39, 82, 139, 180`
* **Discrepancy Description**: Goal 4 and Open Question 82 put adjustments and compensation in a non-sales table "kept out of day totals". The mapping (180) books "adjustments and ads", "Eater Compensation" and "Compensation - Orders" into `platformFee`. The control-total rule (139: Transaction rows equal the Transfers Net Total) cannot hold if those rows are excluded.
* **Rationale & Recommendation**: State per row kind whether it is excluded from order value, included in net payout, and booked.

### 19. Terminology drift against T-150 and GLOSSARY - Severity: Major
* **Reviewer Lens:** `style`, `structural`
* **Affected Scope:** whole document (examples `13, 46, 149, 161, 183`)
* **Discrepancy Description**: "status" and "state" are both used for the review state, while T-150 `status` (draft/posted/voided) is on the settlement. "Sales date" versus `businessDate`; "order value" versus `grossAmount`; "safety limit" versus tolerance; one store-day is called store-day, day line, staged line, `settlement_day_lines`, channel-day. Booking is book, post, record. Payout is also "settlement" and "sales deposit". The Foodpanda column "Platform Fee" collides with the deduction kind `platformFee`. "Platform" versus the glossary term "channel". "Cancel" (47, 168, 190) versus "void" (code, GLOSSARY separates void from reversal). "v1" is never defined once.
* **Rationale & Recommendation**: Add a short terms table near the top mapping each doc term to its T-150 or schema name. Use "review state". Write the column as "Platform Fee (column)" and the kind as `platformFee`. Define "v1 = legacy ERP at `ERP-rebuild`".

### 20. PandaGO-only invoice "rejected" conflicts with the state model - Severity: Major
* **Reviewer Lens:** `style`, `structural`
* **Affected Scope:** `55 vs 46, 52`
* **Discrepancy Description**: The invoice "is rejected with that reason", but rejection records who decided and non-goal 52 says nothing posts without a person. It also has no sales-day line to carry a state. It is unclear whether the app auto-rejects.
* **Rationale & Recommendation**: Show it as a non-bookable "PandaGO: not booked here" file status, or require a person to reject it, or define an auto-reject state and decision record.

### 21. Stale or misleading text around the mapping table - Severity: Major
* **Reviewer Lens:** `style`, `structural`
* **Affected Scope:** `175, 177-184, 186, 270`
* **Discrepancy Description**: Line 175 says "'Needs decision' columns block approval", but no row says that. Line 270 says Surcharge Fee and Expanded Withholding Tax have "no clear home", which line 67 resolves. "Both kinds land on 6400" (186) reads as "both platforms".
* **Rationale & Recommendation**: Delete the "Needs decision" sentence. Write "commission and `platformFee` both land on 6400".

### 22. Loan-record change claims are partly stale and out of scope - Severity: Major
* **Reviewer Lens:** `style`, `structural`
* **Affected Scope:** `58, 72, 153, 284`
* **Discrepancy Description**: `loans` already has `startDate`, `termPeriods`, `paymentFrequency`, `interestRate`, `ratePeriod`, `status`, `closedOn`. The doc says the loan form "also gets" start date, term or end date, rate and rate period. The genuinely new items are the expected daily repayment and weekly or semi-annual rate periods. "End date versus start plus term unchecked" is answerable from the schema (term is in periods). Loan form changes also sit in a feature whose non-goals include "Creating loans" (58). The wording differs across 72, 153 and 284.
* **Rationale & Recommendation**: Add one line stating exactly what changes on the loan record in this release. Treat anything else as a separate task.

### 23. Goal 13 is unmeasurable - Severity: Major
* **Reviewer Lens:** `style`, `design`
* **Affected Scope:** `22, 48, 77`
* **Discrepancy Description**: "Falls to minutes. The target number is still to be set", while 77 proposes under 15 minutes a week. The "about an hour" baseline has no owner or period. No expected blocked-day rate is given. The design cites 1 of 31 payouts per store failing the control total and guesses "probably the last day" (138-139), which is unproven. If blocked days are common the weekly job will not be minutes.
* **Rationale & Recommendation**: Write "provisional target: under 15 minutes a week, owner to confirm". State the baseline source and an expected blocked-day rate from the October data.

### 24. Unverifiable or speculative claims stated as fact - Severity: Major
* **Reviewer Lens:** `style`
* **Affected Scope:** `93, 138-139, 144, 215-216, 222`
* **Discrepancy Description**: "Nobody has seen a file the plain reader cannot read" (216) when the reader is unbuilt and layouts changed between June and October (27). "Known security problems" for xlsx 0.18.5 (144, 222) names no advisory. The browser-parsing claim (93, 222) cites no v1 file:line. "The one left over was probably the last day" is speculation inside a control-total claim. "30 of 31 payouts in every store" is ambiguous.
* **Rationale & Recommendation**: State the sample size and period. Name the advisories (verify any CVE numbers before citing). Cite v1 file:line. Check the one exception and state it, or write "unexplained, to check in the real-file test".

### 25. Same facts restated three or more times - Severity: Major
* **Reviewer Lens:** `style`, `structural`
* **Affected Scope:** `53/75, 55/71/151/184, 54/217/281, 66/183/241, 67/186/271/283, 68/172, 69/161, 85/153/246`
* **Discrepancy Description**: Owner charge and tax decision, Foodpanda weekly fee placement, loan amounts 1,779.17 versus 1,771.88, one-loan-leg limit, disbursal, PandaGO rule, AI fallback and "rejected re-open" each appear in several sections.
* **Rationale & Recommendation**: State each fact once (in Decisions or the Technical Plan) and link to it.

### 26. "Wins" and "truth" slogans conflict - Severity: Major
* **Reviewer Lens:** `style`
* **Affected Scope:** `8, 38, 73`
* **Discrepancy Description**: Three slogans for which source wins: "platform file is treated as the truth" (38), "the file always wins" (73) and "the latest upload wins" (8, which means newest upload). "Truth" clashes with the repo rule that Postgres is the truth. "Meets the rule" (73) is figurative.
* **Rationale & Recommendation**: Use "platform figure is the reference value for the comparison" and "newest upload supersedes older ones". Write "conflicts with" for 73.

### 27. Dated fixture value is wrong or ambiguous - Severity: Nit
* **Reviewer Lens:** `design`
* **Affected Scope:** `80, 160`
* **Discrepancy Description**: The first loan's last deduction is given as 27 Oct (80), but 160 gives the daily sum 2,363.12 "after 12 Oct" for October. After 27 Oct only 1,771.88 should apply. This is a test fixture.
* **Rationale & Recommendation**: Correct before it becomes a test.

### 28. Undefined references and soft deferrals - Severity: Nit
* **Reviewer Lens:** `style`, `design`
* **Affected Scope:** `19, 54, 85, 209, 217, 281`
* **Discrepancy Description**: "The reviewers' advice" names no source (209). "Release 1" and "release-1" are never defined. "Follow-up work soon" is bolded three times and unmeasured.
* **Rationale & Recommendation**: Cite the advice or drop it. Define the releases. Say "after release 1; owner to date".

### 29. Edge cases without a rule: closed store-day, rejected re-open - Severity: Nit
* **Reviewer Lens:** `design`
* **Affected Scope:** `53, 75, 157, 162`
* **Discrepancy Description**: A store-day with no trading shows a date gap and would block under "Complete". Rejected looks terminal, but re-open is open, so a later corrected upload for a rejected day has no rule. The "re-open" statement at 53 and 75 also repeats.
* **Rationale & Recommendation**: State the closed-day rule and the rejected-day rule.

### 30. Code uniqueness versus lookup - Severity: Nit
* **Reviewer Lens:** `structural`
* **Affected Scope:** `132`
* **Discrepancy Description**: Codes are unique "among active channels" but lookup includes inactive ones, so an inactive and an active channel can share a code and trigger Goal 2's "more than one match" refusal.
* **Rationale & Recommendation**: Make uniqueness cover all channels or define precedence.

### 31. Staging key inconsistent - Severity: Nit
* **Reviewer Lens:** `structural`
* **Affected Scope:** `115, 149`
* **Discrepancy Description**: The data flow says "store + sales date + platform"; `settlement_day_lines` is keyed per "channel, sales date and version".
* **Rationale & Recommendation**: Pick one key.

### 32. "Future Improvements" heading level - Severity: Nit
* **Reviewer Lens:** `structural`, `style`
* **Affected Scope:** `279`
* **Discrepancy Description**: It is an H3 under "Alternatives Considered" but is not an alternative.
* **Rationale & Recommendation**: Promote to H2 or move after the Technical Plan.

### 33. Component and Alternative labels collide; unequal heading treatment - Severity: Nit
* **Reviewer Lens:** `structural`
* **Affected Scope:** Components A-L, Alternatives A-L (`~90-203, 205-278`)
* **Discrepancy Description**: Both use letters A to L. Components are bold paragraphs, Alternatives are H3s. Components I-L (mapping, permissions, screens, observability) are not components. The Alternative A heading carries a verdict in parentheses.
* **Rationale & Recommendation**: Use distinct labels (C1..., Alt-A...). Move verdicts to the Reason line.

### 34. Horizontal rules inconsistent - Severity: Nit
* **Reviewer Lens:** `structural`
* **Affected Scope:** `7, 87, 286`
* **Discrepancy Description**: Rules surround Technical Plan and the Implementation Plan, but none follow Overview or separate Open Questions from Alternatives.
* **Rationale & Recommendation**: Apply one convention.

### 35. Missing links and some alternatives - Severity: Nit
* **Reviewer Lens:** `structural`
* **Affected Scope:** whole document
* **Discrepancy Description**: "T-150" appears unlinked 5+ times (first at 13). No links to `docs/tasks/150-channel-settlement.md`, `CAPABILITY-MATRIX.md`, bible decision rows or v1 source files. Not considered as alternatives: auto-booking clean days, one settlement per loan leg instead of changing the identity, relaxing the 1-per-channel-day rule.
* **Rationale & Recommendation**: Link on first use. Add the missing alternatives or say why they were dropped.

### 36. Vague or subjective wording, first person, heavy bold - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** `30, 32, 37, 41, 54, 67, 70-72, 80, 97, 160, 216, 241, 258, 264`
* **Discrepancy Description**: "Clear message", "plain message", "odd rows", "supposed" in scare quotes, "unchecked" (should be "undecided"), "Default proposed: the loan record's status" (which value?), "the most accurate", "the most important difference to see", "hold and reject differ little". First person ("I read", "I opened") in a design doc. "None dominated the files I opened" has no count. "Plain reader" and "reader" are jargon, versus "parser" in T-150. Screen strings differ from check names ("loan check OK" at 41 versus **OK** at 160). "The last one is blocking" is ambiguous. Bold across prose dilutes emphasis.
* **Rationale & Recommendation**: Use counts and file names. Define "reader = deterministic parser, no AI" once. Restrict bold to state names and defined terms.

### 37. Units, dates and acronyms - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** `11, 13, 38, 66, 69, 85, 160, 183`
* **Discrepancy Description**: Bare amounts (223.21, 154,473.51, 1,779.17) have no currency on first use. Dates mix "12 Oct", "27 Oct" and "2026-11-02". "PG", "CPC", "MDR", "COD", "RLS", "PIN" are undefined. "About 20%" has no period or source. Columns are named by letter (Y, Z, AD, S, AE, K) while Goal 9 says "never by letter".
* **Rationale & Recommendation**: Add PHP on first use, ISO dates, an acronym gloss, and "letters refer to the sample files only; the reader uses header words".

### 38. Alternatives formatting - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** `207-211, 237-241, 273-277`
* **Discrepancy Description**: Alternative F mixes two options in one Pros/Cons (split over seven days; separate entry). Alternative L's Pros opens "The strongest argument against building it" and lists alternatives as pros. Alternative A says "roughly one reader, one new column and one screen".
* **Rationale & Recommendation**: Split F into F1 and F2. Move L's editorial and alternatives to separate lines. Quantify A.

### 39. Non-goals lack reasons - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** `60, 62`
* **Discrepancy Description**: Non-goal 62 is a sentence fragment. "Copying v1's extras" (60) lists three capabilities with no reason. RULES section 3 says removing a capability someone uses is Ian's call.
* **Rationale & Recommendation**: Add "owner confirmed on date" or a reason for each.

### 40. Permission wording is circular and unnamed - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** `190`
* **Discrepancy Description**: "A test that shows the refused role is refused" is circular. "The existing collection permission" is unnamed. CAPABILITY-MATRIX rows use `record_ar_collection` and `manage_store_settings`.
* **Rationale & Recommendation**: Write "a test that the role without the permission gets a refusal". Name the permission reused.
