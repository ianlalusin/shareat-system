# Goldfish Review Report (Zoom Out, Stage 5)

**Target:** `docs/designs/channel-settlement-upload.md` (lines 1-453)

**Context check:** passes. Objective is clear (replace about an hour a week of reading Grab and Foodpanda reports by hand). T-150 (`docs/tasks/150-channel-settlement.md:295-299`) deferred "batch upload and the parsers" as convenience, so this is the planned follow-on.

**Verdict:** root problem and the "reuse the T-150 posting" decision are right. The design is over-scoped for one release, duplicates several existing pieces, and sits too low in places. 0 Blockers, 8 Majors, 5 Nits.

## Prioritized Findings (Blockers -> Major -> Nits)

### 1. Release 1 bundles three features in 8 slices / 62 items - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 292-438 (also 72, 153, 207-211, 284, 298, 312-314, 393-394)
* **Discrepancy:** Release 1 mixes (a) reading and checking (readers, staging, day checks, review screen), (b) booking (approve/reject, posting change to carry several loan legs), and (c) a loan-module expansion (repayment amount, start/end date, rate, rate period). Alternative A (207-211) shows (a) alone delivers the hard part. The posting change (item 32, 393-394) is "the most sensitive file in this plan" and is gated on a migration that backfills and relaxes a CHECK on money tables (item 2, 312-314), yet slice 5 (298) already ships Approve/Reject unwired.
* **Recommendation:** Ship slices 1-5 as release 1 with approve/reject unwired. Release 2 is the posting change plus booking. Cut start date, term/end date, rate and rate period (lines 72, 153) from this feature; only `repayment_amount` is needed. Hold weekly and semi-annual rate periods (284) as a separate loans task.

### 2. Four new staging tables where two would do - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 146-151, 67, 186, 311, 318, 348-353
* **Discrepancy:** `settlement_loan_lines` and `settlement_other_lines` are child tables carrying rows that are shown, not posted. Stated reason is only "the staged line keeps each amount". Each table costs an RLS registry entry, a cutover classification and a same-org FK check.
* **Recommendation:** Keep `settlement_uploads` and `settlement_day_lines`. Store per-kind charge amounts, loan rows and non-sales rows as typed JSON; promote to tables when something must query them. Keep `settlement_loan_lines` only if the loan check (loan rows by day across stores) cannot run over JSON; say so explicitly.

### 3. Multi-leg loan fix leaves two registers of one thing - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 170-173, 311-314, 393-394, 85
* **Discrepancy:** `RecordSettlementInput.loan` is one leg (`packages/domain/src/channel-settlements/index.ts:76`); schema has `loanId`/`loanOwnerStoreId` (`packages/db/schema/channel-settlements.ts:80-82`) and a CHECK (135-138). The design adds a child table, backfills it, relaxes the CHECK, and keeps the old columns, which is the "two registers" trap in `packages/db/schema/loans.ts:11-27`. Principal/interest handling is also undecided: today all deducted pesos go to 2400 as principal (`index.ts:634-678`) while `splitPayment` exists (`packages/domain/src/loans/interest.ts:98`).
* **Recommendation:** (a) Prefer making only the posting function loop over legs inside the same journal entry (`index.ts:633-679` already treats repayment as a leg), holding leg detail on the staged line for audit. (b) If a child table stays, drop `loan_id` and `loan_owner_store_id` from `channel_settlements` in the same migration. Decide principal/interest before building legs; it changes the leg shape.

### 4. Reuse misses: CSV reader, checksum, upload capability, zip/xlsx library - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 361-364, 381-383, 402, 105, 134, 35-37, 144; items 18-19, 28, 37, 40, 41
* **Discrepancy:**
  * CSV: `parseCsv` exists at `packages/etl/src/master-data/sheets.ts:20-69` (BOM, CRLF, quoted commas, header-keyed rows). Item 19 plans "a small CSV reader". It sits in `packages/etl`, so domain cannot import it today. `apps/erp/src/lib/csv.ts` only writes CSV.
  * Fingerprint: SHA-256 is already computed by the stored-file path (`packages/domain/src/files/index.ts:161`; `checksum` column at `packages/db/schema/stored-files.ts:78`). Item 28 computes it again.
  * Upload plumbing: `uploadFile`/`runUpload` (`files/index.ts:108-185`) is reused correctly, but authorises via `PURPOSE_CAPABILITY[input.purpose]` (line 115); the design adds `upload_settlement_files` (item 41) when the existing mapping may suffice.
  * Zip/xlsx: no library in domain or root. Only `xlsx ^0.18.5` in `apps/pos/package.json:56`, the version the design forbids. A new dependency is unavoidable.
  * Grab/Foodpanda parsers: none exist in `packages/` or `apps/`; v1's are documented only (T-150 lines 264, 297-299). This is a rewrite, not a port.
* **Recommendation:** Move `parseCsv` to a shared package (core) and reuse it. Reuse the stored file's checksum as the fingerprint, with `settlement_uploads` holding a file reference only. Name the purpose-to-capability mapping explicitly. Pick one library that reads both zip and xlsx. State that the readers are a rewrite.

### 5. Altitude too low in Technical and Detailed Plan - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 134-144, 156-162, 361-388 (items 17-30, 44-45, 51-56)
* **Discrepancy:** Items 18-27 read as file-by-file code specs (`safe-zip.ts`, `store-match.ts`, `deduction-mapping.ts`, `day-checks.ts`), with zip limit mechanics (134, 363) and loan-group splitting detail (160, 380). Library choice is deferred (144), so file list and signatures cannot be firm while status says "Ready for review".
* **Recommendation:** Keep components A-L at interface level (inputs, outputs, invariants). Move the file-by-file list into the per-slice task specs the design promises (line 290, item 57). Fill in file lists only for slices 1-2 now.

### 6. Loan check is a subset-sum search working around a data gap - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 160, 380, 150, 7, 153, 85, 246
* **Discrepancy:** Section F splits a day's deductions into groups so each open loan sums to its expected daily amount, and flags ambiguity for an admin. The design already stores "platform transaction id" in `settlement_loan_lines` (150), so the files may identify the loan directly. The new admin-typed `repayment_amount` is a second source beside `scheduledInstalment` (`packages/domain/src/loans/interest.ts:138`); the design notes they differ (1,779.17 vs 1,771.88).
* **Recommendation:** Check whether Grab Transaction rows carry a loan or transaction id linking deduction to loan; if so match by id and drop the search. If not, record that in Open Questions. Keep the stored amount (Alternative G is sound) but label it on the loan form as "what the platform takes".

### 7. Open Questions block readiness - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 64-85 (also 53, 66-67, 71, 74-78, 188)
* **Discrepancy:** Status says "Ready for review" but 20 open items remain. Several shape release 1: who approves and whether the uploader may (74), reopening a rejected day (53, 75), closed period (76), PIN on approval (74), order-value column check against a real store-day (78), and the Grab column mapping which line 188 says "is from the column names only". Lines 66, 67, 71 are decisions already taken, not questions.
* **Recommendation:** Resolve or explicitly default each before task specs. Make the real-file items (78, 188) a slice-1 exit criterion. Move taken decisions to a "Decisions" list.

### 8. Approval re-implements an existing control - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 45, 73, 166, 396 (item 34)
* **Discrepancy:** `computeSettlement` already holds tolerance and gain acknowledgement (`channel-settlements/index.ts:318-390`); `previewChannelSettlement` returns every blocker (457-491); `recognizeGain` is already an input (84). Item 34 adds new field rules for reason and gain choice, and `review.ts` risks recomputing day checks.
* **Recommendation:** Approve must call the same preview/compute path. Reuse `recognizeGain`; add only the typed reason. Keep new Complete/Paid/Charges-explained checks in the new module and the arithmetic in T-150.

### 9. `platform` column and code uniqueness rule - Severity: Nit
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 132, 311, 338, 374, 225-229
* **Discrepancy:** `sales_channels` (`packages/db/schema/sales-days.ts:77-95`) already has `name` and the `is_remitted_daily` flag. `platform` may be derivable. A partial unique index among active channels plus a lookup that reads inactive ones is two rules for one need.
* **Recommendation:** State why `platform` cannot be derived. Use one rule: code unique per organization and platform across all channels, freed explicitly on rename (the Banay-banay closing argues against reuse).

### 10. Two migrations - Severity: Nit
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 309-314 (items 1-2)
* **Discrepancy:** Splitting additive from posting-change migration is right.
* **Recommendation:** Reconsider only if finding 3(a) removes the legs table.

### 11. Three new capabilities - Severity: Nit
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** line 190; items 41-43
* **Discrepancy:** `edit_loan_repayment_amount` and `edit_platform_store_code` are both admin-only; T-150 reused `set_channel_payout` for a similar setting (`index.ts:727-733`). Each capability costs a matrix row and a refusal test.
* **Recommendation:** Reuse an existing admin capability unless the audit trail needs a distinct name.

### 12. Unconsumed observability and reader-version columns - Severity: Nit
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** lines 197 (L), 148
* **Discrepancy:** Nothing in this release reads refusal counters or the reader version column.
* **Recommendation:** Keep a structured log line; drop counters and the column until a consumer exists.

### 13. Alternatives restate decisions - Severity: Nit
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** Alternatives section (D-I, K)
* **Discrepancy:** A, B, C, J, L are real alternatives. D-I and K are owner decisions restated as alternatives. The sibling doc `docs/designs/channel-settlement-upload-intake.md` is not linked as provenance.
* **Recommendation:** Compress D-I and K into the Decisions list from finding 7. Link the intake doc.

## Cut or defer for simplicity
Loan-form extras (1), two of four staging tables (2), second CSV parser and second checksum (4), file-by-file detail (5), subset-sum search if a transaction id exists (6), extra capabilities (11).
