# Goldfish Annotated Review Report (Stage 9, Implementation Readiness)

Status: resolved (2026-11-03, auto accept). The Detailed Implementation Plan was rewritten to apply all 52 fixes (items renumbered 1 to 71, each tagged with its slice, one item format). N24 needed no action. A re-audit (implementation_readiness_report_2.md) then found 3 blockers and 19 majors, which were fixed without a further audit (the re-audit cap was used); 12 small items from it were not all applied (see the final message of the review).

**Target:** `docs/designs/channel-settlement-upload.md` (DetailedRange, lines 383-570)
**Source findings:** `implementation_readiness_report.md` (9 Blocker, 20 Major, 23 distinct Nit)
**Elephant checks done in code:** B9 (`UNKNOWN_AUDIT_ACTION` exists in `packages/db/src/repo/audit-log.ts`), M13 (`voidChannelSettlement` has no loan-payment guard; `index.ts:866-871` says it is structurally unnecessary), M19 (`apps/erp/src/lib/route-capability.ts` has no `channel-settlements` entry). Not re-checked: the other file, line and count claims. The builder verifies them when writing each slice spec.

**Tally:** 52 PROPOSE FIX, 0 CONTEST, 1 no action (N24, a duplicate of N8/N9/B8).
**Principle for the edits:** field-level detail (column types, message strings, header names) belongs in the per-slice task spec, not this design. Those findings get one line in the plan saying which slice spec owns them and what it must decide. Design-level gaps (a contradiction, a wrong claim, a missing file, a missing decision) are fixed in the plan now.
**Owner questions:** none new. B7 and M8 contain choices with a proposed default; they are marked.

## Blockers

### [B1] Staging table columns not specified - `implementation_readiness`
*   ***AI Suggestion:*** PROPOSE FIX (partial: the decisions, not the column list)
*   ***Proposed Edit:*** Item 1 (migration 0213) and item 4 (schema): add "Decisions fixed here": money is `numeric(14,2)`; one current version per key is stored as a `version` integer plus an `is_current` boolean with a partial unique index on (org, channel, sales date) where `is_current`; every foreign key to a parent has an `org_id` composite twin (see B8); line kinds and the platform list are CHECK-constrained enumerations. "The exact column list for each table is the slice 2 spec's deliverable; it must also say where invoice number, 'changed since booked', 'unexplained', the Foodpanda fee month, the allocation override and the loan-check result are stored."

### [B2] No mapping from a staged line to the settlement input - `implementation_readiness`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Items for `stage.ts` and `review.ts`: add a mapping table, staged line to `RecordSettlementInput`: `grossAmount` = order value; `netDeposited` = gross minus commission and `platformFee` minus loan deduction (disbursal excluded); `deductions` = commission and `platformFee`; `loan legs` = the day's allocated legs; `businessDate` = sales date; `salesDayId` = the verified sales day; `settledOn` per Component H item 3; `reference` = payout id (Grab) or invoice number (Foodpanda); destination account = the channel's. Carry into `stage.ts`: the once-per-invoice Platform Fee (column) rule and the relocation rule ("nearest earlier day with enough sales"). For a Foodpanda week, each day's entry clears that day's gross less that day's fees, so `netDeposited` is never negative; the single week deposit is the sum of the entries' `netDeposited`, booked against the invoice reference, not as one entry. "A worked Grab day and a worked Foodpanda week are the slice 7 spec's first section."

### [B3] Loan-check algorithm contradicts Component F; override has no home - `implementation_readiness`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Item `loan-check.ts`: use Component F's rule only (fixed order, older loan first, each up to its expected daily amount; a row may split across two loans; remove "admin must choose"). A loan with no `repayment_amount` makes the day "no matching loan recorded" (blocks). Add the override: repo function to store the allocation on the staged loan lines, a domain function `overrideLoanAllocation` (admin only, reuses `edit_loan_repayment_amount`), a control on the review screen, and an UPDATE grant on `settlement_loan_lines`.

### [B4] The eleven blockers have no owner - `implementation_readiness`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** `day-checks.ts` item: one function `dayBlockers(line, context)` composes the full list from Component F, and `approveDay` and the review screen both call it. Re-read at approval, not from the snapshot: the recorded figure, the verified state, the posting preview (`previewChannelSettlement`, for the T-150 blockers), the period state and the earlier-day state. The snapshot on the line is for display only.

### [B5] Approval order and "no file for this day" undefined - `implementation_readiness`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Decision 9 and `day-checks.ts`: "earlier days" start at the channel's first staged day (the first day any upload covered). A day before it never blocks. A day after it with no staged line blocks only if it has recorded sales for the channel (a zero-sales day does not). Add a repo query: days with recorded channel sales and no current staged line. Add a test for each case.

### [B6] Grab two-file pairing undefined - `implementation_readiness`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** `ingest.ts`, `grab-*.ts` items: the file kind is detected from the header words. The pairing key is store (from the Store ID) plus calendar month of the file's own dates. A day line is staged only when both files for that key are present; with one file present the upload shows "waiting for the Transfers file" (or Transactions), stages nothing and cannot be approved. Replacing one file of a pair re-stages the pair's days. Tests: one file only, both, replace one.

### [B7] A CHECK cannot count rows in another table - `codebase_details`
*   ***AI Suggestion:*** PROPOSE FIX (a decision with a proposed default)
*   ***Proposed Edit:*** Item 2 (0214): drop `channel_settlements_loan_shape_check` and the 0194 composite foreign key on `loan_owner_store_id`. Enforce "sum of legs = loan deduction, and a non-zero deduction has at least one leg" with a deferred constraint trigger (RULES section 6.3: the database enforces money identities), registered in `packages/db/src/triggers/registry.ts`, plus the domain check and an integration test. The task spec may choose an in-code check instead only if it records the exception to RULES section 6.3.

### [B8] Same-organization FK census contradicts item 17 - `codebase_details`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Replace item 17's "only if the test asks" with a required item: add `(org_id, id)` unique indexes on every parent a new table references that lacks one (`sales_channels`, `loans`, `channel_settlements` and the fiscal period table, if referenced), in 0213 or 0214 as each is needed; give each new foreign key a composite twin; use `assert_same_org_via_parent` triggers on derived tables (the legs table); delete the stale exemption for `loan_id`; update the census pin (`OPEN_BASELINE`, count and hash) in `t398-s1-same-org-fk-census.test.ts`; add that test file to the plan.

### [B9] Audit catalogue entries missing - `codebase_details`
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Proposed Edit:*** Add item: `packages/db/src/audit/catalogue.ts` (Modify): entries, dotted `<area>.<verb>`, for settlement file upload, approve, reject, defer receivable, allocation override, platform-code edit and repayment-amount edit, each with category, sensitivity, scope, viewers and entity (modelled on the existing entries). Add `tests/unit/t402-s1a-action-coverage.test.ts` to the tests to update. The AI fallback gets its entry in its own task.

## Major

### [M1] Migration and journal sequencing - PROPOSE FIX
Tag every target-file item with its slice. Item 4 (journal): "each migration appends its own journal entry in its own slice". Items 6, 15, 16 (registry, classification, exemptions): register only the tables the slice creates.

### [M2] 0214 detail gaps - PROPOSE FIX
Item 2: the legs table has `org_id` with composite FKs to `stores` and `loans`; unique on (settlement, loan, owner store); each leg amount above zero. Name the existing `stored_files_purpose_check` constraint to drop and re-add (as in migrations 0204 and 0205).

### [M3] Libraries and caps undecided - PROPOSE FIX
Slice 1's spec fixes the libraries and the numeric caps (size, zip entries, expanded size, read time), and the accepted content types (Windows sends CSV as `application/vnd.ms-excel` and zip as `application/x-zip-compressed`); the server action limit is 26 MB. CSV reader: move `parseCsv` from `packages/etl/src/master-data/sheets.ts` into a shared leaf package that both can import, instead of writing a second one. Slices 3 and 4 are gated on that spec.

### [M4] Column-mapping data not codable - PROPOSE FIX
Slice 1 exit criterion: exact header strings, row-kind values and the sales-date time zone rule (Manila) for Grab and Foodpanda, written into the spec.

### [M5] Manager visibility and redaction - PROPOSE FIX
Item 10 (repo): add an unscoped internal read for the company-wide loan check, never returned to a manager as rows. Add a redacted view model for managers: their own stores' lines in full, other stores as a count and a state ("waiting for other stores' files"), loan balance and other stores' payments hidden (Goal 7).

### [M6] Item 11 contradicts the design - PROPOSE FIX
Restate as "list channels by platform with their codes, active or not". Name the six new tables where they are counted.

### [M7] Slice 8 behaviour and the settled-on rule have no file - PROPOSE FIX
`approveDay` supplies `settledOn` under Component H item 3 (so item 33 changes to "the caller supplies `settledOn`"). Add `firstOpenDateOnOrAfter` (`repo/fiscal-periods.ts`) as the reused helper. Add a domain function `deferReceivable` (authorize, validate reason, insert, audit). Deferral is unique per channel and period; deferring again supersedes the earlier row. The finding key is `channelReceivableUnsettled:<channelId>:<YYYY-MM>`, severity hard, with a detector census test.

### [M8] Capability wiring incomplete; permissions unnamed - PROPOSE FIX
Item 41 lists every structure in `capabilities.ts`: the `Capability` union, `CAPABILITIES`, scope, area, matrix, label. Tests to update are in the repo-root `tests/unit/`: `capability-matrix.test.ts` (count; the elevated set for admin-yes manager-no grants) and `t337-capability-areas.test.ts`. Name: seeing the review screen reuses `record_ar_collection`; the allocation override reuses `edit_loan_repayment_amount`; deferral reuses `override_period_lock` only for its admin-only bar (stated in the plan; adding a dedicated capability is the alternative).

### [M9] Slice 5 ships buttons that do nothing - PROPOSE FIX
Slice 5 wires reject (it posts nothing) and hides approve until slice 7.

### [M10] Consumer list for the loan columns incomplete - PROPOSE FIX
Name the consumers: the settlement summary is `toSummary` in `channel-settlements/index.ts`. For the T-178 wastage matcher, verify before the spec that it reads these columns; if it does not, delete the mention.

### [M11] Refusal reasons not enumerated - PROPOSE FIX
Slice 4 spec deliverable: a reason-code table (upload refusals plus the blocker list) with message text, and a test per code.

### [M12] Test plan gaps and wrong test paths - PROPOSE FIX
Add the missing tests: 0214 backfill, store-code unique index (case and spaces), duplicate fingerprint, cross-org, compare-and-set race, fee relocation, "covers fewer days" warning, interest-gap display, "changed since booked" from a loan change, deferral amount mismatch. Correct paths: `domain-actions-have-callers.test.ts` is at repo-root `tests/unit/`; add `apps/erp/tests/integration/t343-s5-5s-followups.test.ts` and the root route and nav tests (`route-capability-coverage`, `nav-route-reachability`, `no-ungated-read-surface`). Each case gets its assertion in the spec.

### [M13] Void guard claim does not match code - PROPOSE FIX (confirmed)
Remove "still refuses while a loan payment stands, for each leg" from item 33 and Component H. Replace with "void reverses the whole entry, including every leg, as today".

### [M14] Acknowledgement contract and form UI unspecified - PROPOSE FIX
Name the input field `acknowledgeDifference: { reason: string }` and the column `difference_reason`. List what changes with it: `SettlementPreview.needsGainAcknowledgement`, `ComputedSettlement`, `previewChannelSettlement`, `InsertSettlementInput` and `ChannelSettlementRow` (they stop compiling when the loan columns drop), `SettlementForm.tsx`, `actions.ts`, and the folder's `lib.ts` and `typed-forms.ts`. The form change: a legs list in place of the single loan field.

### [M15] File module work undecided - PROPOSE FIX
Name each edit: `LIMIT_PURPOSES` in `limits.ts`; `PURPOSE_CAPABILITY` in `files/index.ts` (one entry for upload and read, so upload uses `upload_settlement_files` and reading follows `record_ar_collection` through a documented exception, or the task spec splits it); `EXTENSIONS` (csv and zip); `FILE_REFERENCES` in `repo/files.ts`. Move items 9, 14 and 36 to 38 into slice 2 so typecheck passes after the purpose is added.

### [M16] Month-close guard files incomplete - PROPOSE FIX
Add: `packages/db/src/repo/findings.ts` (the detector SQL); the period key in `keyPeriod` (`findings/index.ts`); a `KIND_LABEL` entry in `apps/erp/src/app/findings/lib.ts` (so "no screen work" becomes "a label and the defer action"); the gate lives in the domain function `deferReceivable`, with the action calling it; deferral is separate from `acknowledgeFinding` (which uses `close_period`). 0215 states the unique key and the superseding row.

### [M17] Loan edit function does not exist - PROPOSE FIX
New domain function `updateLoanRepaymentAmount` (admin, `edit_loan_repayment_amount`), plus its field rule in `field-rules/loans.ts` (`LOAN_ADD_RULES` neighbour). Item for the loans page: add an edit form (new, not a modification). Who sees the page: the page needs `view_financial_reports`; managers do not see the amount.

### [M18] Sales-channel edit gating - PROPOSE FIX
New domain function in `sales-channels` for platform and code, authorized by `edit_platform_store_code`, with: trim, case-insensitive duplicate refusal with a named message, and a format rule. The `/settings` route requires `manage_store_settings`; the admin-only fields are hidden from managers.

### [M19] Route gating and nav - PROPOSE FIX (confirmed)
Add `apps/erp/src/lib/route-capability.ts` to the plan: an entry for `/channel-settlements/upload` and `/review` (any of `upload_settlement_files`, `record_ar_collection`), and each new page calls `requirePageAccess` or `requireActor`. Change the nav item to "`nav.tsx` data plus the route entry". Note: `/channel-settlements` itself has no entry today; the task spec checks whether that is intended.

### [M20] Undefined or vague terms - PROPOSE FIX
Rewrite item `stage.ts`: "map commission columns to `commission` and all other charges and taxes to `platformFee`". Item `loan-check.ts`: "apply Component F's allocation rule". Replace "the number-box tests" with their file names or a glob.

## Nits (all PROPOSE FIX, mechanical)

*   **N1** "either droplet" becomes "any production host (159.223.46.224 or 159.223.78.207)". **N2** "T-398 may have reserved 0213 and 0214"; add a step: confirm the next three numbers against `_journal.json` and reserve them at spec time. **N3** one term, "acknowledgement of the difference", everywhere (slices, line 396). **N4** delete "(the earlier Goldfish review suggested this)". **N5** "posts-adjacent data" becomes "data that feeds posting"; state the full-suite gate once. **N6** list marker spacing. **N7** "date grid" becomes "one day apart, per the journal rule in ADR-012". **N8** index on `lower(trim(code))` (trim on write too); `platform` CHECK values `grab`, `foodpanda`; "empty" means NULL; state which tables are insert-only and which get UPDATE or DELETE grants (ADR-012 section 4a). **N9** state the legs table's scope: derived through its settlement. **N10** one item format (Type, Scope, Proposed Changes) for all domain items. **N11** drop "small" and "most sensitive"; write "Posts money; changes require the full integration suite". **N12** "Component I". **N13** split the test item into a list. **N14** M4 gets a path; M2 merges into item 12. **N15** keep one statement each of "one spec per slice", "never on a droplet", and the provenance footer. **N16** name `npm run typecheck` and `npm run lint` after confirming script names. **N17** move `PROJECT_BIBLE.md` to a "planner actions, not implementer scope" note. **N18** field rules and audit also for reject reason, deferral reason and platform code format. **N19** state what each sweep and baseline gets. **N20** fixture redaction rules: customer ids and bank digits removed. **N21** export `settlementIntakeRepo` (pattern `export * as channelSettlementsRepo`). **N22** list the READMEs to update (schema, repo, rls, audit, domain src, migrations). **N23** "slice 1 supplies the fixtures; `packages/domain/tests/fixtures` does not exist yet".
*   **N24** No action. A duplicate of N8, N9 and B8.

## What this does not do
*   It does not write the column tables, the reason-code table or the exact header strings. Those are slice spec deliverables.
*   It does not decide the open questions in the design (waiting-for-stores set, cancelled orders and the like). Those keep their proposed defaults.
