# Goldfish Review Report (Stage 9 re-audit)

**Target:** `docs/designs/channel-settlement-upload.md` (lines 383-543, "Detailed Implementation Plan")
**Reviewers:** `implementation_readiness`, `codebase_details`, `style` (merged and deduplicated)
**Previous report:** `implementation_readiness_report.md` (9 Blocker, 20 Major, 23 Nit)
**Counts now:** 3 Blocker, 19 Major, 12 Nit

Verdict: NOT READY. None of the 9 old Blockers is fully open, but 3 of them are only partly closed. The rewrite added 3 new Blockers, all ordering or location faults. Items 1-71 are numbered without gaps, every item has a slice tag, and the table counts agree (four staging tables, six new tables). Migration numbers 0213-0215 are free (journal ends at 0212). Nearly every other named path exists or is correctly marked Create.

## Status of the 9 previous Blockers

| # | Topic | Status | Evidence |
|---|---|---|---|
| B1 | Staging table columns | Addressed (assigned to slice 2 spec) | L440: version + `is_current`, partial unique index, `numeric(14,2)`, org composite twins, grants, six facts to place |
| B2 | Staged line to settlement input | Addressed, with new contradictions | L409-424 field table; contradiction on Foodpanda deposit (L424 vs design L93); `settledOn` slice ambiguity (L420, L475) |
| B3 | Loan-check algorithm and override | Addressed | L473 stepwise rule; override has repo fn (L450), action (L475), UI (L502), capability (L495), UPDATE grant (L440) |
| B4 | Eleven blockers with no owner | Partly addressed | L426, L472 name `dayBlockers`, but it needs the input builder that only exists in slice 7 (Blocker 1 below) |
| B5 | Approval order and "no file" | Addressed | L428, item 11 (L450); wording nit on "later day" |
| B6 | Grab two-file pairing | Addressed, residual gap | L430; key straddles month boundary (Major 9) |
| B7 | A CHECK cannot count legs | Partly addressed | L432 chooses deferred trigger; L441 drops the shape check, but no item creates the trigger (Major 1) |
| B8 | Same-org FK census | Partly addressed | L457 deletes stale exemption, but names the wrong test path (Blocker 3); L440 parent-index list incomplete (Major 2) |
| B9 | Audit catalogue | Addressed in content | L459; slice tags too late for slice 2 edits (Major 4) |

## Blockers

### 1. Slice 5 cannot build `dayBlockers` as specified - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness`
* **Affected Scope:** L426, L472 (item 30), L409, L475 (item 33), L481 (item 36), L504 (item 53)
* **Discrepancy:** Slice 5's `dayBlockers` calls `previewChannelSettlement` for the T-150 blockers (no destination account, negative net deposit, posted settlement exists, period closed). That call needs a `RecordSettlementInput` built from the staged line. The mapping is tagged slice 7 (L409) and the only builder lives inside `approveDay` (item 33, slice 7). Slice 6 then changes the preview input and output (legs, `acknowledgeDifference`, `needsGainAcknowledgement`), and neither item 36 nor item 53 lists `settlement-intake/day-checks.ts` as a consumer to update.
* **Recommendation:** Make the staged-line-to-input builder a pure function with its own item in slice 5, used by both `dayBlockers` and `approveDay`. Or move the T-150 blocker group to slice 7 and say the screen shows only intake blockers until then. Add `day-checks.ts` to slice 6's consumer list.

### 2. No item owns the slice 8 settled-on and deferral-aware behaviour - Severity: Blocker
* **Reviewer Lens:** `implementation_readiness` (style Major 6 merged)
* **Affected Scope:** L398, L212, L216, L420, L472 (item 30, slice 5 only), L475 (item 33, slices 5 and 7), L517 (item 63)
* **Discrepancy:** Slice 8 and Component H item 3 say the settled-on rule is built in slice 8. The only supplier of `settledOn` is `approveDay` (item 33, slices 5 and 7). The "period closed" blocker, which must skip a deferred day, lives in `dayBlockers` (item 30, slice 5 only). No slice 8 item modifies `review.ts`, `day-checks.ts` or the input builder. The deferral read (item 12) is never called from the approval path.
* **Recommendation:** Add slice 8 to items 30 and 33 and spell out the change. State that slice 7 uses the sales date with no deferral lookup. Without this, item 63's "deferred day books with `settledOn` in the open period" cannot pass.

### 3. Item 18 names a test file that is not there - Severity: Blocker
* **Reviewer Lens:** `codebase_details`
* **Affected Scope:** L457 (item 18)
* **Discrepancy:** The plan says `tests/unit/t398-s1-same-org-fk-census.test.ts`. The real file is `packages/db/tests/integration/t398-s1-same-org-fk-census.test.ts`. It is an integration test needing `TEST_DATABASE_URL` and a `_test` database name, so slices 2 and 6 need the integration suite on a gate database, not only `npm test`. `OPEN_BASELINE` is real (line 54, count 223). The exemption `'channel_settlements.loan_id->loans'` is real at `packages/db/src/rls/same-org-fk-exemptions.ts:74`.
* **Recommendation:** Correct the path and say which suite gates slices 2 and 6.

## Major

### 1. Legs-total trigger and same-org trigger have no creating step - Severity: Major
* **Lens:** `implementation_readiness`, `codebase_details`, `style`
* **Scope:** L441 (item 2), L455 (item 16), L457-458 (items 18, 19), L214
* **Description:** Item 2 drops `channel_settlements_loan_shape_check` and says "the legs trigger (item 19) replaces it", but item 19 only registers it in `triggers/registry.ts`. No item says migration 0214 creates the deferred legs-total trigger. Item 19 also registers an `assert_same_org_via_parent` trigger for the legs table, but that function does not exist in any migration (only in comments, the census test and `docs/tasks/398-padre-garcia-franchise-org.md` R3; it is T-398 S3/S4 work, not landed). The legs table is described three ways: own `org_id` with composite FKs (item 2), "derived through its settlement" (item 16), and trigger-guarded (items 18, 19). Component H says the check is "relaxed"; item 2 says dropped.
* **Recommendation:** Pick one design for the legs table. State that the migration creates both triggers, or name the T-398 dependency and the migration that creates the function. Make "relaxed" and "dropped" agree.

### 2. Parent `(org_id, id)` unique indexes are incomplete - Severity: Major
* **Lens:** `codebase_details`, `implementation_readiness`
* **Scope:** L440 (item 1), L442 (item 3)
* **Description:** Item 1 adds the index only for `sales_channels` and `loans`. `channel_settlements` and `sales_days` also lack one (checked in schema and migrations). `settlement_day_lines` stores the booked settlement id and the legs table references the settlement; a stored verified sales-day id needs it on `sales_days`; the deferrals table (item 3) keys on `fiscal_periods`, which needs one too (unverified).
* **Recommendation:** List every parent that gets an index. Otherwise the census-required composite twins cannot be created and the item 18 pin is wrong.

### 3. Slice 2 exports a repo file created in slice 4 - Severity: Major
* **Lens:** `implementation_readiness`
* **Scope:** L449 (item 10, slice 2), L450 (item 11, slices 4, 5)
* **Description:** Item 10 exports `settlementIntakeRepo` in slice 2, but the file is created in slice 4. Typecheck fails at the end of slice 2. The same fault applies to item 34 (slice 3 `index.ts` exports of files created in slices 4 and 5).
* **Recommendation:** Move the exports to the slice that creates the files, or create empty files earlier.

### 4. Slice 2 contents disagree with the slice list; its audit entries and sweeps are tagged too late - Severity: Major
* **Lens:** `implementation_readiness`, `codebase_details`
* **Scope:** L392 vs L489, L490, L505, L506 (items 44, 45, 54, 55); L459 (item 20); L518 (item 64)
* **Description:** L392 calls slice 2 an additive migration plus permissions, "safe to ship ahead of any code that uses it". Items 44, 45, 54, 55 put domain functions and two admin screens in slice 2. Item 20 lists audit entries for slices 4, 5, 7, 8 only, but the platform-code and repayment-amount edits ship in slice 2, and the audit log refuses uncatalogued actions (`UNKNOWN_AUDIT_ACTION`; t402 coverage test). Item 64 (slices 4, 5, 8) skips slices 2, 6 and 7 although they add actions and forms (t440 auth-first guard, t412 destructive census, number-box tests, touch-target baseline, `action-link-sweep`).
* **Recommendation:** Rewrite the slice 2 line. Tag item 20 with slice 2. Tag item 64 with 2, 6, 7.

### 5. Item 40 field-rule tags omit slice 5 - Severity: Major
* **Lens:** `implementation_readiness`
* **Scope:** L485 (item 40, "Slices 2, 6, 7, 8")
* **Description:** `rejectDay` (item 33, slice 5) requires a reason. The money-rule census fails in slice 5. Tag 7 has no rule that belongs to it.
* **Recommendation:** Add slice 5; check tag 7.

### 6. Plan contradicts the design on the Foodpanda deposit - Severity: Major
* **Lens:** `implementation_readiness`, `style`
* **Scope:** L424 vs design L93 (Decision 2)
* **Description:** L424: the deposit is the sum of the entries' `netDeposited` and "is not booked as one separate entry". Decision 2: "booked once, on the last day."
* **Recommendation:** Fix one of the two sentences.

### 7. `stage.ts` tagged "slices 4 and 7" with no split - Severity: Major
* **Lens:** `implementation_readiness`
* **Scope:** L471 (item 29), L424
* **Description:** Fee attach and relocation, and "unexplained" marking, are not assigned to a slice. Lines staged in slices 4 to 6 have no relocated fee and no re-stage step is stated. "Enough sales" is undefined (against order value or recorded figure).
* **Recommendation:** Say which part of item 29 is slice 7, and whether earlier staged lines are re-staged.

### 8. Goal 13's October blocked-day count cannot run in slice 1 - Severity: Major
* **Lens:** `implementation_readiness`
* **Scope:** design L71, plan L539, slice list L391
* **Description:** Slice 1 has no readers (slice 3) and no day-checks (slice 5), so there is nothing to count with.
* **Recommendation:** Move the count to the slice 5 exit, or call it a manual count.

### 9. Grab pairing key straddles month boundaries - Severity: Major
* **Lens:** `implementation_readiness`, `style`
* **Scope:** L430
* **Description:** The key is store plus "the calendar month of the file's own dates". Created On, transfer date and payout date can fall in different months (Grab pays about 01:45 next day, so the 31 Oct payout lands 1 Nov). A month-end day would show "waiting for the Transfers file".
* **Recommendation:** State which date drives the key, or assign the decision to slice 1.

### 10. `ingest` has no loan-change re-run step - Severity: Major
* **Lens:** `implementation_readiness`
* **Scope:** L474 (item 32, slice 4), L473 (item 31, slice 5), design L190, L515 (item 61)
* **Description:** Design L190 requires another store's new file to re-run dependent days' loan checks and flag booked days whose loan figures change. Item 32 only covers "booked with different figures". The loan logic arrives in slice 5, so nothing in slice 4 can detect it, yet item 61 tests it in slices 4-7.
* **Recommendation:** Add a slice 5 item that edits `ingest` for the cross-store re-run.

### 11. Item 61 omits tests the design requires - Severity: Major
* **Lens:** `implementation_readiness`
* **Scope:** L515
* **Description:** Missing: the deferred legs-total trigger refusing at commit; earlier-day rules (a day before the first staged day never blocks; a zero-sales gap does not); the correction flow (cancel, then approve the newer version); manager refusal "This file does not belong to your stores".
* **Recommendation:** Add them with slice tags.

### 12. Item 39 `keyPeriod` instruction is wrong - Severity: Major
* **Lens:** `codebase_details`
* **Scope:** L484 (item 39)
* **Description:** `keyPeriod` at `packages/domain/src/findings/index.ts:383` is `/:(\d{4}-\d{2})$/`. A key `channelReceivableUnsettled:<channelId>:<YYYY-MM>` already matches. "Extend so it recognises" will make the implementer invent a change.
* **Recommendation:** Replace with a test pinning the key shape.

### 13. Item 53 caller list is incomplete - Severity: Major
* **Lens:** `codebase_details`
* **Scope:** L504 (item 53), items 40, 62, 64
* **Description:** `packages/domain/tests/integration/t440-s6-money-refusals.test.ts:125` keys on `CHANNEL_SETTLEMENT_RECORD_RULES.loanAmount` and breaks if the rule is renamed. `apps/erp/tests/t440-s9-auth-first-guard.test.ts:243` names `recordChannelSettlement` and is not tagged for slice 6. The three `apps/erp/tests` files in item 53 exist. Also: "the form's single loan field becomes a list of legs" does not say how an admin enters and validates several legs.
* **Recommendation:** Add both files and the slice 6 tag.

### 14. Item 23 has no path and is marked Modify for a new package - Severity: Major
* **Lens:** `codebase_details`, `style`
* **Scope:** L465 (item 23); items 49, 64, 71 also lack a single path
* **Description:** `parseCsv` is real at `packages/etl/src/master-data/sheets.ts:20` (used by `store-map.ts` and t391 tests). No shared leaf package exists; the name is deferred to slice 1. Create is mislabelled Modify.
* **Recommendation:** Name the destination path and mark Create.

### 15. "Later day" wording inverts the rule - Severity: Major
* **Lens:** `style`
* **Scope:** L428 vs Component F and Decision 9
* **Description:** "A later day with no staged line blocks only if staff recorded sales." Component F and Decision 9 mean an earlier day than the one approved. "Staff recorded sales" and "zero-sales day" name the same test.
* **Recommendation:** Reword with "earlier" and one name for the test.

### 16. "All open channels" undefined - Severity: Major
* **Lens:** `style`
* **Scope:** L260, L482, L508
* **Description:** "Open" elsewhere means an open loan, open period, or active channel. The admin deferral may cover every active channel or only channels with a non-zero 1220 balance.
* **Recommendation:** Define it once.

### 17. Item 32 transaction scope contradicts the risk table - Severity: Major
* **Lens:** `style`
* **Scope:** L474 vs L275
* **Description:** Item 32: upload and new line versions in one transaction, per-file results. Risk table: staged one by one, each in its own transaction. One bad file rolls back a batch, or not.
* **Recommendation:** Choose one.

### 18. Item 33 redaction, audit and admin cases - Severity: Major
* **Lens:** `style`, `implementation_readiness`
* **Scope:** L475 (item 33)
* **Description:** Other stores shown "as a count and a state" for managers, but Goal 1 says a manager sees only their own stores and the state is unnamed; design Goal 7 shows the loan's owner store on a manager's own deduction (is the name shown when it is not their store?). "All write the audit log" includes the read `listReviewDays`. "Refuses the uploader" has no admin exception, while Goal 10 and Component G say an admin may approve any day.
* **Recommendation:** State each case.

### 19. Item 36 vs Component H on the wastage matcher - Severity: Major
* **Lens:** `style`, `codebase_details`
* **Scope:** L481 (item 36), L214
* **Description:** Component H lists the T-178 matcher as a consumer to update; item 36 says "checks whether" and deletes the mention otherwise. Repo check: `wastage/orders.ts` reads no loan columns, so the answer is likely "delete the mention".
* **Recommendation:** Decide and align both lines.

## Nit

1. L507 (item 56): "(any of `upload_settlement_files`, `record_ar_collection`)" attached to both routes lets a holder of `record_ar_collection` alone reach upload. Give each route its own capability. (`style`)
2. L488, L495 (items 43, 47): "one entry serves upload and read, so upload uses X and read follows the review screen's permission" reads two ways; "Approve and reject reuse `record_ar_collection`" repeats; "adding a dedicated capability is the alternative" leaves the deferral permission open though design J picks `override_period_lock`. (`style`, `implementation_readiness`)
3. L453 (item 14): `FILE_REFERENCES` at `packages/db/src/repo/files.ts:231` is `FILE_PURPOSES.filter(p => !GUARDED_PURPOSES.includes(p))`, so it accepts new purposes automatically. Say how to refuse (add to `GUARDED_PURPOSES`, which carries read-path meaning, or an explicit allow list). (`codebase_details`)
4. L459 (item 20): `def(action, category, sensitivity, scope, entity, owner, opts)` has viewers in `Opts`. Naming mix exists (snake_case, `destructive.approved`, `item.variant_set`). Nearest model is `set_channel_payout` (T-350), also the precedent for L495 `edit_platform_store_code`. (`codebase_details`)
5. L432 "RULES section 6.3" and L530 "RULES section 14": RULES.md says "There is no bible 6.3; a citation to it means this item", and row 14 is a table row. Also "Planner", "ADR-012 §5, §4a" and "0194" are used without a link. (`codebase_details`, `style`)
6. L215, L481 "tolerance" vs "safety limit" (L422, L515 "the limit"); same threshold? (`style`)
7. L407 "(see the end of this section)" points at nothing; ownership is stated in item 66 (L523). (`style`)
8. L473, L481 loan-check names are shortened versus Goal 6; "loan with no repayment amount" gives "no matching loan recorded" although the loan exists; "repayment amount" vs "expected daily repayment amount". (`style`)
9. L513-514, L539 (item 59): fixtures "for a month" do not say all four stores (Lipa, Malvar, Banay-banay, plus 12 and 13 Oct); "redacted real files" also covers synthetic hostile zips; "30 of 31 in each store" reads as pass and fail; "4,473.51" appears only here. (`style`, `implementation_readiness`)
10. Tag and format drift: "Slices 2, 6, 8" / "Slices 2 and 6" / "Slices 2 to 8" / "Slice 1 onward"; placeholders `tNNN`, `NNN`, `ADR-NNN`, "T-numbers" (L385); items 18 and 20 give `tests/unit/...` without a repo root; item 18 "the test file is in the plan" is empty; item 26 "orders sheet / charges sheet" vs Component C "Appendix A and B"; item 41 "server action limit is 26 MB" unclear (`next.config.js` `bodySizeLimit` '26mb' confirmed). (`style`)
11. L442 (item 3): `superseded-by` needs an UPDATE grant; deferral grants unstated. (`implementation_readiness`)
12. L426 "At approval it re-reads ... the snapshot": subject unclear and Component F calls the day checks pure; say `approveDay` builds the context. If slice 1 finds Grab loan rows name their loan, items 31, 33 and L502 become unnecessary and the plan does not say which drop. (`style`, `implementation_readiness`)

## Verified paths (codebase_details)

All of these exist and are correctly marked Modify: `packages/db/src/triggers/registry.ts`, `packages/db/src/audit/catalogue.ts`, `tests/unit/t402-s1a-action-coverage.test.ts`, `tests/unit/capability-matrix.test.ts` (pins 116), `tests/unit/t337-capability-areas.test.ts`, `apps/erp/src/lib/route-capability.ts` (`/channel-settlements` and `/findings` absent, as the plan implies), `packages/db/src/repo/findings.ts`, `apps/erp/src/app/findings/lib.ts` (`KIND_LABEL` at 84), `packages/domain/src/field-rules/loans.ts` (`LOAN_ADD_RULES` at 7), and the three `apps/erp/tests` files in item 53. Create-marked paths (0213-0215, `settlement-intake` schema, repo, domain, fixtures, upload and review pages) are confirmed absent. Wrong: `tests/unit/t398-s1-same-org-fk-census.test.ts` (Blocker 3). Not found as a real SQL function: `assert_same_org_via_parent` (Major 1). Claims that held: `export * as channelSettlementsRepo` at `packages/db/src/index.ts:194`; 0204/0205 redo `stored_files_purpose_check`; the 0194 FK `channel_settlements_loan_owner_store_id_same_org_fk`; `createLoan` gated by `manage_chart_of_accounts`; `xlsx` only in `apps/pos`; accounts 1220, 6420, 7100 seeded; T-150, T-178, T-350, T-398 resolve.
