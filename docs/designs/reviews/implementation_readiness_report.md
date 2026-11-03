# Goldfish Review Report (Stage 9, Implementation Readiness)

**Target:** `docs/designs/channel-settlement-upload.md` (lines 383-570, Detailed Implementation Plan)
**Lenses:** `implementation_readiness` (IR), `codebase_details` (CD), `style` (ST). Findings deduplicated; the lens that raised each is tagged.
**Verdict:** NOT READY. A builder would have to make design decisions in at least nine places. Counts: 9 Blocker, 20 Major, 24 Nit.

Verified correct (CD): next migration is 0213 (journal head idx 212 `0212_t464_pos_tablet_pairings`); journal format `{idx, version:"7", when, tag, breakpoints:true}` and the +86,400,000 date grid; every named file and route folder exists; `closeBlockers`, `firstOpenDateOnOrAfter`, `recordChannelSettlement`, `previewChannelSettlement`, `outstandingFor`, `FILE_PURPOSES`, `auditLogRepo.append` exist; loan position is derived from the ledger, so several 2400 legs need no loan-side change.

## Prioritized Findings (Blockers -> Major -> Nits)

### B1. Staging table columns are not specified - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 411, 421-423 (prose at 189-192)
* **Discrepancy Description**: No column names, types, nullability, FKs, enum CHECKs or index predicates for the four staging tables. Undecided: how "one version per key" is stored (`is_current` flag or version number) and which column the partial unique index uses; where all amount kinds live (only `commission` and `platformFee` are booked); where invoice number, "changed since booked", "unexplained", Foodpanda fee month, allocation override and loan-check result are stored; line-kind enumerations (loan-line, other-line, platform list).
* **Rationale & Recommendation**: Add a per-table column table (money as numeric(14,2), `org_id` composite FKs, exact CHECKs) in the plan or an appendix.

### B2. No mapping from a staged line to the settlement input - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 479, 489 (items 26, 30)
* **Discrepancy Description**: Item 30 says only "builds the settlement input from the stored line". `grossAmount`, `outstandingCleared`, `variance`, `netDeposited`, `reference`, `settledOn`, `destinationMoneyAccountId`, loan legs, `businessDate` and `salesDayId` are unmapped. Foodpanda week: the deposit books once on the last day, but the T-150 identity needs `netDeposited` = gross minus fees every day and `netDeposited` cannot be negative; earlier-day value is undefined. Item 26 drops the fee-relocation rule ("nearest earlier day with enough sales") and the once-per-invoice rule.
* **Rationale & Recommendation**: Add a field-by-field mapping with a worked Grab day and a worked Foodpanda week; carry the relocation and once-per-invoice rules into item 26.

### B3. Loan-check algorithm contradicts Component F; override has no home - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 483 (item 28) vs design line 201; 411; 518
* **Discrepancy Description**: Component F: fixed-order allocation (older loan first, each up to expected amount) with admin override. Item 28: find matching splits, return "admin must choose" if several fit. Neither says how a row splits across two loans. The override has no repo function, action, UI control (item 46) or capability. `settlement_loan_lines` has no UPDATE grant. Behaviour for a loan with NULL `repayment_amount` is undefined.
* **Rationale & Recommendation**: Pick one algorithm and write it stepwise; add override files and capability; define NULL-amount behaviour; state grants.

### B4. The eleven blockers have no owner - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 480 (item 27) vs design line 204
* **Discrepancy Description**: Item 27 covers five checks. Nothing assigns "store not matched", "negative net deposit", "destination account", "posted settlement exists", "period closed", "earlier day not decided", "not current version". Several depend on `previewChannelSettlement`, which needs the input from B2. Unclear whether recorded figure and verified state are re-read at approval or taken from the snapshot.
* **Rationale & Recommendation**: Name one function composing all blockers and its caller; state re-read versus snapshot.

### B5. Approval order and "no file for this day" undefined - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 441, 489 (design line 204)
* **Discrepancy Description**: No definition of where "earlier days" starts. Pre-go-live days, zero-sales days and never-uploaded days would block later days forever. No repo query enumerates store-days without a staged line.
* **Rationale & Recommendation**: Define the earliest day and the zero-sales rule; add repo queries.

### B6. Grab two-file pairing undefined - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 470-471, 479, 486 (items 21, 22, 26, 29)
* **Discrepancy Description**: Day lines need Transactions and Transfers together but uploads are one row per file. Not stated: kind detection, pairing key, single-file behaviour, "newest supersedes" when only one file is replaced.
* **Rationale & Recommendation**: Specify pairing key (store and month, or batch) and staging with one file present.

### B7. A CHECK cannot count rows in another table - Severity: Blocker
* **Reviewer Lens:** `codebase_details` (+ `implementation_readiness`)
* **Affected Scope:** 414, 426
* **Discrepancy Description**: Plan replaces `channel_settlements_loan_shape_check` "so a non-zero loan deduction needs at least one leg" and enforces sum of legs = deduction "in the posting function". The existing check reads `loan_deduction` and `loan_id` on one row (`packages/db/schema/channel-settlements.ts:135-138`); after `loan_id` is dropped no CHECK can reference the legs table. RULES section 6.3 says the database enforces money identities.
* **Rationale & Recommendation**: Decide: drop the check and enforce in domain with tests (state the exception), or add a deferred constraint trigger. Also name the 0194 composite FK on `loan_owner_store_id` to drop.

### B8. Same-organization FK census contradicts item 17 - Severity: Blocker
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 411, 414, 417, 457-459
* **Discrepancy Description**: Item 17 says "modify only if the test asks". `same-org-fk-exemptions.ts:33,44` is pinned by value and can only shrink; `t398-s1-same-org-fk-census.test.ts:54,269-277` pins `OPEN_BASELINE {count:223, sha256}`. Every FK in the six new tables needs a composite `(org_id, col)` twin, which needs `(org_id,id)` unique indexes on parents. Only persons, stores, `money_accounts`, `stored_files` have them today; `sales_channels`, `loans`, `channel_settlements` and others need new ones. Dropping `loan_id` makes the exemption entry at `same-org-fk-exemptions.ts:74` stale (census test line 135 fails). The pin must drop 223 to 222 with a new hash. The census test file is not in the file list. Derived tables (legs) need `assert_same_org_via_parent` triggers.
* **Rationale & Recommendation**: List the new parent unique indexes in 0213/0214, delete the exemption, update the pin, add the test file, make item 15's scope a decision.

### B9. Audit catalogue entries missing - Severity: Blocker
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 489, 545
* **Discrepancy Description**: Approve, reject and defer "write the audit log", but `auditLogRepo.append` throws `UNKNOWN_AUDIT_ACTION` for actions not in `packages/db/src/audit/catalogue.ts`, and `tests/unit/t402-s1a-action-coverage.test.ts:78-97` fails on gaps. Actions must be dotted `<area>.<verb>`. Neither file is in the plan.
* **Rationale & Recommendation**: Add catalogue entries (category, sensitivity, scope, viewers, entity; model `catalogue.ts:99`) for upload, approve, reject, defer and the AI-fallback decision.

### M1. Migration and journal sequencing - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 420, 426, 453, 456 (slices 392, 396, 398)
* **Discrepancy Description**: Item 4 appends all three journal entries at once but 0214 ships in slice 6 and 0215 in slice 8; the tag-to-file test fails in between. Items 6, 15, 16 register and classify tables that do not exist until later.
* **Rationale & Recommendation**: Tag every target-file item with its slice; journal and register each migration in its own slice.

### M2. 0214 detail gaps - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 412-414, 457
* **Discrepancy Description**: Legs table needs `org_id` and composite FKs to `stores` and `loans`; uniqueness of (settlement, loan) and zero-amount legs undecided; `stored_files_purpose_check` constraint name needed (drop and re-add, as in 0204/0205); item 17's "only if the test asks" hedge is not optional.
* **Rationale & Recommendation**: State each constraint explicitly.

### M3. Libraries and caps undecided - Severity: Major
* **Reviewer Lens:** `implementation_readiness` (+ `codebase_details` N1)
* **Affected Scope:** 391, 466-467, 500, 505
* **Discrepancy Description**: Slice 1 picks libraries yet item 20 hand-writes a CSV reader; `packages/etl/src/master-data/sheets.ts:20` already has `parseCsv` (domain may not import etl). No numeric caps for size, zip entries, expansion, read time. Magic-byte check is vague; `fileBytesMatchType(contentType, bytes)` has no purpose argument. Server-action limit is 26 MB (`apps/erp/next.config.js:51`); content types unspecified (Windows sends CSV as `application/vnd.ms-excel`, zip as `application/x-zip-compressed`).
* **Rationale & Recommendation**: State the caps, CSV decision (move parseCsv to a shared leaf or justify a copy), content types; or gate slices 3-4 on slice 1 writing them into the spec.

### M4. Column-mapping data not codable - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 470, 475, 479
* **Discrepancy Description**: No header strings for Grab or Foodpanda, no row-kind values beyond Payment/Completed/Processing; mapping rows like "adjustments and ads", "residual" are prose; sales-date timezone unstated (Grab "Created On" vs Manila).
* **Rationale & Recommendation**: Make slice 1 output exact headers, kind values and timezone rule into the spec as a gate.

### M5. Manager visibility and redaction - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 441, 489, 518
* **Discrepancy Description**: Repo lists are store-scoped but the company-wide loan check needs all stores' lines; unscoped reads not named; manager view for "waiting for other stores' files" is undefined; goal 7 redaction has no implementing item.
* **Rationale & Recommendation**: Add an unscoped internal read and a redacted view model.

### M6. Item 11 contradicts the design - Severity: Major
* **Reviewer Lens:** `implementation_readiness` (+ `style`)
* **Affected Scope:** 441; design 118, 173, 175
* **Discrepancy Description**: "List stores with an active Grab channel and code" contradicts the design (lookup includes inactive channels, covers Foodpanda; loan check waits on stores with an open loan or deduction, not channel status). Line 456 also relies on counting "the six new tables".
* **Rationale & Recommendation**: Restate as "list channels by platform with codes, active or not" or delete; name the six tables on line 456.

### M7. Slice 8 behaviour and the settled-on rule have no file - Severity: Major
* **Reviewer Lens:** `implementation_readiness` + `codebase_details`
* **Affected Scope:** 497, 489, 398, 537-546; design 216
* **Discrepancy Description**: Item 33 says keep `settledOn` as the caller's date, but Component H.3 sets a rule (sales date, arrival date, or `firstOpenDateOnOrAfter` at `repo/fiscal-periods.ts:567`, which no item assigns). No item places it (likely `approveDay`). No domain function for "defer with reason". Deferral uniqueness (channel and period) and re-defer undefined. `channelReceivableUnsettled` key and severity, and detector census tests unspecified.
* **Rationale & Recommendation**: Add items for each; state that the caller supplies `settledOn` under H.3.

### M8. Capability wiring incomplete; permissions unnamed - Severity: Major
* **Reviewer Lens:** `codebase_details` + `implementation_readiness`
* **Affected Scope:** 502, 509-512, 44, 511
* **Discrepancy Description**: `capabilities.ts` needs the `Capability` union (line 75), `CAPABILITIES` array (326), scope (453), area (692), matrix (826), label (1184). Item 44 points to `packages/auth/tests/` but pinned guards are root `tests/unit/`: `capability-matrix.test.ts` (count; `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` at 225-228, 447-458) and `t337-capability-areas.test.ts` (116 keys; oracle lists 56-62, 134-157). Admin-yes/manager-no capabilities join the elevated set. Capability for "may see the review screen" and for loan allocation override unnamed. `override_period_lock` (`capabilities.ts:249`) means "post into a closed period"; a deferral posts nothing.
* **Rationale & Recommendation**: List all structures and tests; name the capabilities; justify or replace `override_period_lock` for deferral.

### M9. Slice 5 ships buttons that do nothing - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 395, 532
* **Discrepancy Description**: Visible approve/reject controls before the callers exist is the DEF-137 pattern; `domain-actions-have-callers` flags it.
* **Rationale & Recommendation**: Wire reject in slice 5 or hide both until slice 7.

### M10. Consumer list for the loan columns incomplete - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 214, 520
* **Discrepancy Description**: H.1 names "the settlement summary" and "the T-178 wastage matcher" without paths. Grep found `loan_owner_store_id` and `recognizeGain` only in files items 6, 12, 33, 48 already cover.
* **Rationale & Recommendation**: Verify the two consumers exist; add paths or say they do not.

### M11. Refusal reasons not enumerated - Severity: Major
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 486, 562
* **Discrepancy Description**: Verification demands a test per refusal reason, but no list or message strings exist.
* **Rationale & Recommendation**: Add a reason-code table (upload refusals plus blockers).

### M12. Test plan gaps and wrong test paths - Severity: Major
* **Reviewer Lens:** `implementation_readiness` + `codebase_details`
* **Affected Scope:** 529-530, 532; line 48
* **Discrepancy Description**: Missing: 0214 backfill test (promised line 273), store-code unique index (case, whitespace), duplicate fingerprint, cross-org, compare-and-set race, fee relocation, "covers fewer days" warning, interest-gap display, "changed since booked" from a loan change, deferral amount mismatch. Cases have no assertions. `apps/erp/tests/integration/t343-s5-5s-followups.test.ts` (708-758, 995-996) also uses the single-loan input; item 48 lists only `5v`. Root tests `route-capability-coverage.test.ts`, `nav-route-reachability.test.ts`, `no-ungated-read-surface.test.ts` not listed; `domain-actions-have-callers.test.ts` is at repo-root `tests/unit/`, not apps/erp.
* **Rationale & Recommendation**: Add the tests with assertions; correct paths.

### M13. Void guard claim does not match code - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 497, 489
* **Discrepancy Description**: Plan says void "still refuses while a loan payment stands, for each leg". `voidChannelSettlement` has no such guard; `channel-settlements/index.ts:866-871` says it is unnecessary because repayment is a leg inside the same entry.
* **Rationale & Recommendation**: Remove the claim; otherwise the builder invents a refusal in the most sensitive file.

### M14. Acknowledgement contract and form UI unspecified - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 497, 520, 33; 363-377
* **Discrepancy Description**: No name or shape for the new `RecordSettlementInput` field or `channel_settlements` column. Replacing `recognizeGain` also touches `SettlementPreview.needsGainAcknowledgement`, `ComputedSettlement` (`index.ts:129,150`), `previewChannelSettlement`. `InsertSettlementInput` (`repo/channel-settlements.ts:72-86`) and `ChannelSettlementRow` (49-50) will not compile once `loanId`/`loanOwnerStoreId` drop. `SettlementForm.tsx:130-246` and `actions.ts:58-158` carry these through hidden fields; "move to legs" is not a UI spec. `lib.ts` and `typed-forms.ts` in that folder are unchecked.
* **Rationale & Recommendation**: Define names, identity-check interaction, variance booking at 6420 above tolerance with reason, and the multi-leg form.

### M15. File module work undecided - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 435, 448-450, 500-502
* **Discrepancy Description**: Item 14's "wherever purposes are listed" is vague. Needed: extend `LIMIT_PURPOSES` (`limits.ts:14`; compile-time equality at `files/index.ts:43-46`); `PURPOSE_CAPABILITY` entry (`index.ts:49`) is one entry for upload and read, but the plan wants two capabilities; `EXTENSIONS` (`index.ts:68`) falls back to `.bin` for csv/zip; `FILE_REFERENCES` (`repo/files.ts:227-234`) must register the new upload file column, and the existing withholding-certificate entry will accept the new purpose. Phasing: after slice 2, `typecheck` fails on `_SamePurposes` and the missing key; move items 9, 14, 36-38 into slice 2.
* **Rationale & Recommendation**: Name each edit and decide the split-capability design.

### M16. Month-close guard files incomplete - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 537-545
* **Discrepancy Description**: Detectors are SQL in `packages/db/src/repo/findings.ts`, not listed. `keyPeriod` (`findings/index.ts:383`) recognises only a trailing `:YYYY-MM`; a key like `channelReceivableUnsettled:<channelId>:2026-10` is needed. `KIND_LABEL` (`apps/erp/src/app/findings/lib.ts:84-108`) needs an entry, so "no screen work" is wrong. The gate must live in a domain function (`findings/actions.ts:28-29`, `t440-s9-auth-first-guard`) that authorizes, validates reason, inserts the deferral and audits; none is planned. `acknowledgeFinding` uses `close_period`; state deferral is separate. 0215 lacks unique-key and superseding-row decisions.
* **Rationale & Recommendation**: Add these items and decisions.

### M17. Loan edit function does not exist - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 503, 522 (items 35, 39, 50)
* **Discrepancy Description**: `packages/domain/src/loans/index.ts` exports `createLoan`, `disburseLoan`, `recordLoanPayment`, `reverseLoanEntry`; no update. `createLoan` authorizes `manage_chart_of_accounts` (line 57), not `edit_loan_repayment_amount`. `LOAN_ADD_RULES` is in `field-rules/loans.ts`, not listed. The loans page route needs `view_financial_reports` (`route-capability.ts:81`), so managers may not see it. No edit form exists in `loans/actions.ts`; item 50 must add, not modify.
* **Rationale & Recommendation**: Specify a new `updateLoanRepaymentAmount`, its gate, the field rule file, and who sees the page.

### M18. Sales-channel edit gating - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 504, 521
* **Discrepancy Description**: `createSalesChannel`/`updateSalesChannel` authorize `manage_store_settings` (store-scoped, `sales-channels/index.ts:39,156,208,246`). Admin-only platform and code edits need a new function under `edit_platform_store_code`, with code format, trim and duplicate-code refusal text. `/settings` route requires `manage_store_settings` (`route-capability.ts:53`).
* **Rationale & Recommendation**: Define the new function and validations.

### M19. Route gating and nav - Severity: Major
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 517-518, 523, 532
* **Discrepancy Description**: `nav.tsx` is pure data (header lines 15-20); filtering comes from `apps/erp/src/lib/route-capability.ts` (`ROUTE_CAPABILITY`, `navHrefAllowed`). Routes absent from it are readable by any signed-in person (lines 26-27), and `/channel-settlements/*` has no entry, so the new pages would be open. Item 51 "shown by permission" is unachievable in `nav.tsx` alone.
* **Rationale & Recommendation**: Add `route-capability.ts` with an any-of entry (for example `upload_settlement_files`, `record_ar_collection`); every new page calls `requirePageAccess` or `requireActor`.

### M20. Undefined or vague terms in the plan - Severity: Major
* **Reviewer Lens:** `style`
* **Affected Scope:** 479, 483, 532 (items 26, 28, 57)
* **Discrepancy Description**: "the regular deduction" is undefined (`platformFee` elsewhere); "Commission to commission and every other charge..." is awkward; "split into groups matching each open loan's repayment amount" is vague; "the number-box tests" is not a file name or glob.
* **Rationale & Recommendation**: Rewrite as "map commission columns to `commission` and all other charges and taxes to `platformFee`"; name the Component F allocation rule; name the test files or a glob.

### N1. Undefined host reference - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 385
* **Discrepancy Description**: "either droplet" is undefined for a new reader.
* **Rationale & Recommendation**: Name the hosts or write "any production host".

### N2. Provisional migration numbers - Severity: Nit
* **Reviewer Lens:** `style` + `implementation_readiness` + `codebase_details`
* **Affected Scope:** 389, 420
* **Discrepancy Description**: "T-398 may hold 0213 and 0214" is ambiguous; no check to confirm the next three numbers before slice 2; numbers reserved at spec time so other lanes do not take them.
* **Rationale & Recommendation**: Say "may have reserved"; add a confirm-against-`_journal.json` step and reserve the numbers.

### N3. Inconsistent term - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 396
* **Discrepancy Description**: "variance acknowledgement" vs "acknowledgement of the difference" at lines 68, 98, 215.
* **Rationale & Recommendation**: One term.

### N4. Process commentary - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 401
* **Discrepancy Description**: "(the earlier Goldfish review suggested this)" is review history.
* **Rationale & Recommendation**: Delete or move.

### N5. Jargon and repeated shorthand - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 414, 563
* **Discrepancy Description**: "posts-adjacent data", "gated on the full suite".
* **Rationale & Recommendation**: "data that feeds posting"; "requires the full integration suite on a fresh gate database" (stated once).

### N6. List marker spacing - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 415
* **Discrepancy Description**: "3. " one space; others use two.
* **Rationale & Recommendation**: Match.

### N7. "date grid" undefined - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 420
* **Rationale & Recommendation**: Say "one day apart" or cite the journal rule.

### N8. Item 1 index and grant details - Severity: Nit
* **Reviewer Lens:** `implementation_readiness` + `codebase_details`
* **Affected Scope:** 411
* **Discrepancy Description**: Index uses `lower(code)` but Component A ignores surrounding spaces; `platform` CHECK values unstated; "empty" should mean NULL; whether `settlement_loan_lines` and `settlement_other_lines` are insert-only and whether deferrals get UPDATE/DELETE grants (ADR-012 section 4a).
* **Rationale & Recommendation**: Use `lower(trim())` or trim on write; list CHECK values and grants.

### N9. "may be derived" hedge - Severity: Nit
* **Reviewer Lens:** `style` + `implementation_readiness`
* **Affected Scope:** 453
* **Rationale & Recommendation**: State the scope (see B8).

### N10. Mixed item formats - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 467, 471, 475, 476, 480, 490
* **Discrepancy Description**: Items 20, 22, 24, 25, 27, 31 use inline descriptions; 19, 21, 23, 26, 28-30 use the Type/Scope/Proposed Changes block.
* **Rationale & Recommendation**: Pick one.

### N11. Subjective wording - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 467, 496
* **Discrepancy Description**: "a small CSV reader"; "the most sensitive file in this plan".
* **Rationale & Recommendation**: Drop "small"; write "Posts money; changes require the full integration suite".

### N12. "section I" vs Component I - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 475
* **Rationale & Recommendation**: Use "Component I".

### N13. Item 55 is one long sentence - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 530
* **Rationale & Recommendation**: Split into a list of the ~14 cases.

### N14. M1-M4 labels break numbering - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 535-546
* **Discrepancy Description**: M4 names no path ("Tests (Create)"); M2 modifies `channel-settlements.ts` already covered by item 12 (line 442).
* **Rationale & Recommendation**: Give M4 a path; merge M2 into item 12.

### N15. Repeated statements - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 385/550, 385/559, 568/570
* **Discrepancy Description**: "one spec per slice", "never on a droplet", and the HTML provenance comment versus the "Drafted with EGM" footer repeat.
* **Rationale & Recommendation**: Keep one of each.

### N16. Verification commands not named - Severity: Nit
* **Reviewer Lens:** `style`
* **Affected Scope:** 560-561
* **Discrepancy Description**: "Both clean." is a fragment; scripts unnamed.
* **Rationale & Recommendation**: Name `npm run typecheck` and `npm run lint` (confirm script names).

### N17. Bible listed in implementer scope - Severity: Nit
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 554 (item 63)
* **Discrepancy Description**: RULES section 14 treats a spec listing `PROJECT_BIBLE.md` in scope as a defect.
* **Rationale & Recommendation**: Move to a "planner actions, not implementer" note.

### N18. Field rules and audit for other free text - Severity: Nit
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 502-503, 518 (items 35, 40, 50)
* **Discrepancy Description**: Field rules cover only acknowledgement reason and repayment amount; reject reason, deferral reason and platform code format missing; audit entries for code and amount edits unstated.
* **Rationale & Recommendation**: Add them.

### N19. "Modify" without content - Severity: Nit
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 532 (item 57)
* **Rationale & Recommendation**: State what is added to each sweep and baseline.

### N20. Fixture redaction unstated - Severity: Nit
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 528 (item 53)
* **Rationale & Recommendation**: State redaction rules (customer ids, bank digits).

### N21. Repo namespace export unnamed - Severity: Nit
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 436, 439
* **Discrepancy Description**: Export in `packages/db/src/index.ts` not named; existing pattern is `export * as channelSettlementsRepo` (line 194).
* **Rationale & Recommendation**: Name it (for example `settlementIntakeRepo`).

### N22. README updates not listed - Severity: Nit
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** file list
* **Discrepancy Description**: READMEs exist in `packages/db/schema`, `packages/db/src/repo`, `rls`, `audit`, `packages/domain/src`, `packages/db/migrations`.
* **Rationale & Recommendation**: List them.

### N23. October figures rely on fixtures not in the repo - Severity: Nit
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** 563
* **Discrepancy Description**: 30 of 31, 4,473.51, 591.24 depend on fixtures; `packages/domain/tests/fixtures` does not exist.
* **Rationale & Recommendation**: State that slice 1 supplies them.

### N24. Insert-only/grant and unspecified ordering nits folded - Severity: Nit
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** 411, 453
* **Discrepancy Description**: Covered above (N8, N9); retained as a count placeholder for the "only if the test asks" wording at line 457, which belongs with B8.
* **Rationale & Recommendation**: Resolve with B8.
