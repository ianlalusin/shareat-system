# T-511 S1: Grab and Foodpanda settlement upload, spec, real-file facts, fixtures, libraries

**Status:** SPEC 3 Nov 2026, ACCEPTED by BOSS 3 Nov (build S1 with a Sonnet builder and a Sonnet auditor). Session "Foodpanda/Grab settlement upload feature". **Owner:** orchestrator (numbers from BOSS, 3 Nov). **Migrations reserved for the feature:** 0228, 0229, 0230 (this slice has none; 0226 T-508 and 0227 T-510 sort before them). **Lanes:** Sonnet builder for fixtures and the library check; Sonnet auditor. Spec written in plan mode; build starts only after BOSS accepts it.

**Design (the whole feature):** `docs/designs/channel-settlement-upload.md` (Draft, EGM-reviewed through Stage 9). **Real-file facts:** `docs/discovery/grab-foodpanda-settlement-files.md`. This spec covers slice 1 only. Slices 2 to 9 are listed in the design's Detailed Implementation Plan and each gets its own spec.

## 1. Why (Ian, 2 to 3 Nov)
The weekly job of reading Grab and Foodpanda reports and booking them takes about an hour. The target is 15 minutes a week or less. Ian's rules, in his words: "i want it like v1 it post what user approves", "the store code for foodpanda and grab must be set in store setting sales channel so the app can map which store the files belong to", "pandago is always separate", "ads on marketing", "1 click" (month-end deferral), "admin re open rejected days". Decisions are recorded in the design (Decisions Taken, 1 to 14).

## 2. What slice 1 does and does not do
Does: fix the facts the readers need, collect and redact fixtures, run the library check, set the caps, answer the open questions that real files can answer, and correct the design where the files disagree with it.
Does not: touch the database, write a reader, add a screen or change posting. No code, no migration, no CI run, port 9008 not used.

## 3. Facts from the real files (details in the discovery doc)
1. **A Grab payout is one store-day, and rows belong to it by Settlement ID.** Each payout's `Date` is the order day plus one. The sum of `Total` by Settlement ID equals the payout `Net Total` to the centavo (October: 30 of 31 payouts per store; the 31st payout's rows are in the previous month's file). Loan, withholding tax, chargeback and compensation rows all net into it. A payout whose rows are in another file shows "waiting for the earlier file".
2. **Grab money columns.** `Total` = `Net Sales` + `Channel Commission` (25%). `Tax on GrabFood/GrabMart commission, adjustments, ads` is already inside the commission for Payment rows; it is informational and is not booked again. `Net MDR`, `Tax on MDR`, `Marketing success fee`, `Order commission` are empty or 0. `Withholding Tax` is 0; real withholding tax is Adjustment rows (half-month periods). `Net Sales` = `Amount` + `Discount (Merchant-Funded)`. `Category` values have a trailing space.
3. **Grab loan rows do not name their loan.** Per-store deduction amounts vary day to day (Grab takes the rest from other stores when a payout is short); only the company-wide daily total is fixed. The design's company-wide check and allocation rule stand.
4. **Grab timestamps carry no time zone.** Treat as Asia/Manila wall clock (evidence: payout day = order day + 1 for every link; read as UTC, 35 to 56% of orders change day). An order's business day is the date printed in `Created On`. File kind is found from the header row, never from the file name (the October files were renamed by hand).
5. **Foodpanda layouts.** Appendix A has 34 columns (22 Jul onward, all October) or 32 (the 15 Jul file: no Surcharge Fee, no Cancellation Fee). Headers contain newlines and formula text, so match by header prefix, never by position. The last row of each sheet is an uncached `=SUBTOTAL` row: skip it and recompute. Percent cells are text. `Order Date` has no time. `Invoice Date` is the period end; some reversal and refund rows are dated up to 18 days earlier. The vendor code is on every order row.
6. **Foodpanda invoice total.** The xlsx has no invoice grand total (only the PDF). In release 1, "the week adds up" means the per-order balance equals the recomputed column identity, and the week's entries sum to recomputed Appendix A plus Appendix B. Reading the PDF total is a future improvement and is the real check against the bank payout.
7. **Foodpanda Appendix B.** Platform Fee (223.21 net, once per invoice) names a month unrelated to the invoice month. CPC ad rows carry an ISO date in the description. PandaGO rows carry a month-first date (`M.DD.YYYY`). `lipa oct 5a` is an Appendix B only invoice with a negative COD item.
8. **Stores in the sample:** Banay-banay, Lipa, Malvar only. No Davao files exist.

## 4. Decisions

**4.1 Caps (confirmed by the builder and the auditor, 3 Nov).** Zip: 1 MB compressed, 5 MB expanded, 10 entries. Inner xlsx (itself a zip): 5 MB expanded, 30 entries, checked with the zip library BEFORE the xlsx reader sees it (real max 437 KB over 15 parts). Grab CSV: 3 MB (raised from 2 MB; largest seen 298,714 B) and 10,000 rows. Foodpanda xlsx: 5,000 order rows, 200 charge rows. A 5-second read limit cannot interrupt a synchronous parse, so it is NOT an enforceable cap: the size caps are the defence (a 121 KB xlsx that inflates to 100 MB cost the xlsx reader 6.5 s and 200 MB). Never extract the lying-size or path-traversal fixture zips to disk. Allowed zip entry names: `.xls` (really xlsx) and `.pdf`. Nested archives refused.

**4.2 Libraries: CHOSEN (3 Nov): `yauzl` 3.4.0 (zip) and `read-excel-file` 9.3.14 (xlsx).** Both MIT, no advisories (npm audit and the GitHub advisory database, re-run by the auditor), both read from a Buffer. `exceljs` 4.4.0 rejected (9 moderate advisories via minimatch and uuid, 193 packages, last release 2023, crashed on a valid workbook). `fflate` 0.8.3 is clean but its sync API trusts header sizes and does not validate names. Pin `read-excel-file` (3 releases in 22 days; it needs Node >=20.12 for its dependency `saxen`, the repo floor is >=20, CI uses 22; Node 20 and 22 untested, so slice 3 runs them). The reader must skip any row with no Order Code, because read-excel-file drops the uncached SUBTOTAL row only as empty, and never trust a sharedStrings `uniqueCount`. Shortlist and method as run:
- Zip: `fflate` or `yauzl`. xlsx reader: `exceljs` (read-only) or `read-excel-file`. CSV: the existing `@shareat/core/csv` `parseCsv` (BOM, quotes, CRLF, line numbers); add header-keyed rows there only if Grab needs them.
- `xlsx` 0.18.5 is excluded (published advisories; still in `apps/pos/package.json`, not to be reused).
- The check, per candidate: published advisories (npm audit and the GitHub advisory database), licence, maintenance date, weekly downloads, install size, whether it can read from a Buffer without writing to disk, whether it can cap expanded size while streaming, and a read of all 15 sample xlsx files with the 32-column and 34-column layouts. Acceptance: no open advisory on the version chosen; a Buffer API; caps enforceable; both layouts read; tests pass in `packages/domain`.
- The result goes into the discovery doc as "Library check (date, versions, advisories)". The builder installs nothing in this slice beyond a throwaway check outside the repo.

**4.3 Header matching.** Grab: exact header strings after trimming. Foodpanda: header text with the letter suffix `(X)` removed and formula text after ` =` removed; match by the first words (for example `Order Date`, `Balance to be paid to Partner`). An unknown or missing required column stops the file and names it.

**4.4 Grab assignment.** Rows are matched to payouts by Settlement ID. A payout date is `Date`; its store-day is that date minus one day. Orders with no Settlement ID (Cancelled) are ignored for money. A payout with no rows in any uploaded Transaction file is "waiting for the earlier file"; its absence is not a difference.

**4.5 Sensitive fields.** The reader must not persist `Bank Account`, `Bank Statement Code`, or the Transaction IDs of loan rows beyond what posting needs. Order ids and customer fields are not stored.

## 5. Corrections to the design (applied in `docs/designs/channel-settlement-upload.md`)
- Grab rows are assigned by Settlement ID (replaces "pair by store and month").
- Grab mapping: commission = `Channel Commission`; the tax-on-commission column is not booked again; "residual of merchant-funded discounts" is the `Discount (Merchant-Funded)` column, handled per the BOSS ruling in section 8 (not `platformFee`); Adjustment rows (withholding, chargebacks, compensation) belong to the payout's store-day and are booked as `platformFee`; Advertisement rows (seen in June) book to `marketing` and their tax column is additive.
- Grab loan rows do not name a loan (the open question is answered).
- Foodpanda verification ties to recomputed totals, not the invoice total.
- CSV reader: `@shareat/core/csv`.

## 6. Fixtures (slice 1 deliverable)
Directory `packages/domain/tests/fixtures/settlement-intake/` (created in slice 3 with the readers; slice 1 prepares the files in the lane worktree under `docs/discovery/fixtures-staging/` outside the commit, or hands them to slice 3). Contents:
- Grab: one Transaction and one Transfers CSV per store for October (Lipa, Malvar, Banay-banay), plus Banay's Sept 15 to 30 pair (the payout seam). One June file with Advertisement rows.
- Foodpanda: zips for the 34-column layout (October), the 32-column layout (15 Jul), the Appendix-B-only invoice (`lipa oct 5a`), and a PandaGO example.
- Synthetic hostile files: too many entries, oversized expansion, nested archive, wrong extension, a zip bomb ratio sample, an xlsx with an unknown column, a Grab CSV with a missing column.
- **Redaction rules:** remove customer names, phones, addresses, order ids (Long Order ID, Short Order ID, Booking ID, partner transaction ids), Linked Transaction IDs where they identify orders (keep the link structure with substitute ids), bank account, bank statement code, and loan-row Transaction IDs (substitute). Keep amounts, dates, store ids, vendor codes, statuses and settlement ids. After redaction every control total (30 of 31 per store, 591.24 then 2,363.12 company-wide daily loan sums, the 12 Oct Lipa deposit of 4,473.51) must still tie; the builder re-runs those ties on the redacted copies.
- Not committed: the original files, the PDFs, and the sample parent folder (it holds unrelated files).

## 7. Exit criteria (all required)
1. Library check done for the shortlist, with versions and advisory results, and one zip and one xlsx library chosen (or a recorded reason none qualifies).
2. Caps in section 4.1 confirmed, or changed with the reason.
3. Redacted fixtures exist and every control total still ties on them (list the totals checked).
4. The design carries the corrections in section 5.
5. Open questions answered or re-assigned:
   - Loan id on Grab rows: no (done, fact 3). Time zone: Manila (done). Control total: ties by Settlement ID (done). Davao files: none in the sample; **Davao: re-assigned to Ian** (BOSS asking; not blocking S1).
   - **Does Grab "Amount" and Foodpanda "Gross Food Value (K)" match what staff record?** Needs one real store-day each. A read-only query of the recorded channel figure for two named days (one Grab, one Foodpanda) in production, run with Ian, compared by hand. Not done in this slice by the agent. If they differ, the design's order-value definition changes before slice 3.
6. No PII in the committed files: grep the fixtures and docs for the redacted field values.

## 8. Rulings (BOSS, 3 Nov 2026)
1. **Bible row 320 is superseded on the four points (CONFIRMED).** The intent stands: a person approves before anything posts, and the file is kept as evidence. Store-code mapping is Ian's own words; refusing the whole file is stricter than quarantining lines; staging tables do the job of the draft. **The PDF is accepted and STORED in release 1; parsing it is a named follow-up** (the only real check against the bank payout). BOSS writes bible row 425 at wrap-up; this lane does not edit the bible.
2. **Alt-P is rejected (CONFIRMED).** Nothing posts into a closed period. A deferral moves `settledOn` to an open date. `override_period_lock` is reused only as the admin-only gate.
3. **Merchant-funded discount is NOT `platformFee`.** The glossary makes discounts contra-revenue (4900); booking it as a fee overstates what Grab costs. Whether it is booked at all depends on exit criterion 5: if staff record the Grab sale NET of the discount, the discount was never in 1220 and booking it double-counts, so book nothing; if staff record the gross `Amount`, book it to 4900 as a signed leg (slice 6 adds the leg). Decide after the store-day comparison; both outcomes are recorded in the design. Ian can overturn.
4. **Davao: re-assigned to Ian.** BOSS is asking Ian. S1 is not blocked by it.
Guard: `docs/discovery/fixtures-staging/` holds real customer data until redacted. It is in `.gitignore` in the worktree (added before any file lands there). The builder's hand-back confirms `git status` never shows it.

## 9. Out
Staging tables, readers, screens, the posting change, the deferral and the month-close finding (slices 2 to 8); bible rows 425 to 427 (planner); reading the Foodpanda PDF; the AI fallback.

## 10. Next
Slice 2 spec (migration 0228: store codes, loan repayment amount, four staging tables, file purpose, permissions, the two admin edits) is written after this slice's exit criteria 1 to 4 pass.

## 11. S1 results (3 Nov 2026; builder Sonnet, auditor Sonnet, both with explicit model)
| Exit criterion | Result |
|---|---|
| 1 Library check | DONE. yauzl 3.4.0 + read-excel-file 9.3.14, see 4.2. Auditor re-ran npm view and npm audit, yauzl size checks and a Buffer read. Not run: tests in `packages/domain` (nothing installed in the repo this slice). |
| 2 Caps | DONE. Changed: Grab CSV 3 MB and 10,000 rows; inner xlsx 5 MB and 30 entries added; read-time limit dropped as unenforceable. See 4.1. |
| 3 Redacted fixtures | DONE. 32 files plus README in `docs/discovery/fixtures-staging/redacted/` (gitignored; moves to `packages/domain/tests/fixtures/settlement-intake/` in slice 3). Auditor: 0 sensitive cells kept their original value; only coincidental Short Order ID collisions; PDFs are synthetic stubs; link structure kept; Grab headers byte-identical. Control totals re-checked on the redacted copies: payouts tie 30 of 31 per store (Banay Sep+Oct 46 of 47); loan sums 591.24 for store-days 1 to 12 Oct, 2,363.12 for 13 to 26 Oct, **2,363.11 on 27 Oct**, 1,771.88 for 28 to 31 Oct; Lipa disbursal on the payout dated 13 Oct (store-day 12 Oct), Net Total 154,473.51, sales part 4,473.51; Foodpanda R and Balance identities 0 failures, column sums 0.00. |
| 4 Design corrections | DONE (section 5, and BOSS's rulings in section 8). Added by the results: the loan check allows 0.01 on a loan's last day (27 Oct: Lipa's only deduction was -591.23 instead of -591.24; the same figures are in the original files, so it is Grab rounding, not redaction). |
| 5 Open questions | Loan id: no. Time zone: Manila. Control total: ties by Settlement ID. 27 Oct: 0.01 rounding. Davao: re-assigned to Ian. **Store-day comparison (Grab Amount and Foodpanda column K against what staff recorded): NOT DONE. It needs a read-only production query with Ian, and it decides the merchant-discount booking (section 8, ruling 3).** |
| 6 No personal data in committed files | DONE after one fix: the auditor found a real Foodpanda invoice number in the design (M1); replaced. `git status` shows only `.gitignore`, `docs/designs/`, the discovery doc and this spec; `fixtures-staging` shows only as ignored. |

Auditor nits for slice 3: pin `read-excel-file`; accept a 10,000-row Grab cap and a 2 MB single-part cap; the scratch `extract\` folders of the builder held real unzipped Foodpanda files outside the repo and were deleted.
