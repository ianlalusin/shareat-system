# T-511 S8 — Real Foodpanda zip: many invoices in one zip, earlier-invoice deductions, same-day charges

Status: SPEC (Opus), 2026-11-15. Ian: "C:\Users\ianla\SE\FOODPANDA INVOICES\2026\nov\lipa nov 11.zip must handle that kind of file."
Branch `lane/t511-fp-lipa-nov11` (worktree `wt-fpnov`, base origin/main c7c5275). BOSS commits/merges. S8a first (no migration), then S8b
(migration 0258, ask BOSS to confirm the number on the board; its `when` = previous journal `when` + 86,400,000).

## What the real file is (measured 15 Nov, Sonnet probe + my own read)
Zip `lipa nov 11.zip` = 4 pairs (invoice workbook `.xls` + `.pdf`), store Lipa, partner code O6JZ. The `.xls` files are really OOXML.
- `20261107_200691218807` — weekly statement, 1–7 Nov, 255 order rows, sheets Appendix A (34 cols), B (7 CPC lines + Platform Fee), **C**.
- `20261031_200223033317` (+89.29, official doc 2000000005092538), `…200711317519` (+89.29, doc 2000000005094869), `…200372998561`
  (−89.29, doc 3000000000090835, "Incorrect Invoice Amount Reversal: 200223033317"): charge-only PandaGO invoices, same order date 31 Oct.
- **Appendix C** of the weekly = "Outstanding Amount From Previous Periods": rows `Invoice Number | Invoice Date | Invoice Period | Invoice
  Amount | Remaining Amount` = (2000000005092538, −100), (3000000000090835, +100), (2000000005094869, −100). Net −100. These numbers are the
  three small invoices' official document numbers. Foodpanda netted the open 100 (the re-bill) out of this payout.
- Printed bank amount (PDF) 60,760.98 = Σ per-order balance 62,727.35 − own period charges with 12% VAT 1,866.35 (net 1,666.38 + VAT 199.97)
  − Appendix C net 100.00 − 0.02 rounding.

## What fails today
1. The zip is refused whole: `ZIP_NO_WORKBOOK` "holds exactly one invoice workbook; it holds 4" (`safe-zip.ts:154-157`, `stored-upload.ts:42`).
2. Appendix C is never read (`xlsx-worker.mjs:244-246`, `foodpanda-workbook.ts:463`). The expected deposit is 100.00 too high, so the day
   would show "short by 100.00" and ask for a reason, booking 100 of variance instead of clearing the earlier charge.
3. Supersede (`ingest.ts:266-276`) keys on channel + kind + period only. Two DIFFERENT charge-only invoices with a dated line on the same day
   replace each other (the first becomes "replaced", unbookable).
4. The "same copy already booked" check (`charge.ts:95-104`: store, channel, date, net, description) would refuse the re-bill after the
   original and its reversal are booked (identical date/net/description), so the re-bill could never be booked.
5. A charge reaches only the carrier day of ITS OWN invoice (`invoiceCarrierFactsMany`, `repo/settlement-intake.ts:620-653`); a charge from
   another invoice is never netted (no column holds the Official Document Number).

## S8a — many workbooks in one zip (no migration)
- `openSettlementZip` accepts N workbooks. Caps (hostile-file limits, format constants, with the existing hostile tests updated to the new
  numbers and a test at each cap): entries 10 → 40, compressed 1 MB → 3 MB (= the per-file upload limit), expanded 5 MB → 15 MB. Nested
  archives, bad names, bomb ratios stay refused. A `.pdf` is paired to the workbook with the same base name; an unpaired pdf is ignored.
- `ingestSettlementFile` (or a thin caller in the upload action): a zip with ≥ 2 workbooks is split into one upload per workbook, processed in
  invoice-date order (then invoice number), EACH in its own transaction. Each stored upload is a re-packed deterministic mini zip (that
  workbook + its pdf; fixed timestamps) so `readSettlementBytes` (exactly one workbook) and the fingerprint work unchanged and re-uploading
  the big zip gives "already uploaded" per invoice. A zip with exactly one workbook keeps its original bytes (fingerprint continuity).
- One refused workbook never undoes the others. The result list shows one row per invoice: file name, invoice number, accepted /
  already uploaded / refused with the plain sentence. Authorization, channel/store match, audit rows: unchanged and per workbook.
- Tests: synthetic multi-workbook zips via `zipBytes`/`fpWorkbook` (`t511-s3-helpers.ts`), re-upload idempotence, one bad member among good
  ones, pdf pairing, caps. Plus ONE test over the real file that skips when `C:\Users\ianla\SE\FOODPANDA INVOICES\2026\nov\lipa nov 11.zip`
  is absent: 4 uploads accepted, invoice numbers and charge figures as above. UI result text plain, no codes.

## S8b — earlier-invoice deductions, same-day charges (migration 0258)
Decisions (mine, flagged to BOSS/Ian in the hand-back):
1. **Reader.** `FoodpandaCharge` gains `officialDocument` (Appendix B rows only; `FP_BANNED_KEYS` keeps banning it on orders; change that pin
   deliberately and say why). New `priorItems: { document, date, amount }[]` from Appendix C (sheet optional; absent = `[]`; blank rows
   skipped; at most 50; amount = signed "Invoice Amount" as printed, money parsed like the other sheets). Worker/host/`WorkerSheets` get a `c`.
2. **Migration 0258** (hand-authored, ADR-012 §5): `settlement_other_lines.official_document text` (nullable, partial index on
   (org_id, official_document) where not null) and `settlement_uploads.prior_items jsonb not null default '[]'` with a CHECK that it is a
   json array. No new table: registries and classification unchanged (the build will say if wrong). Journal idx 258, `when` = main's last + 1 day.
3. **Supersede.** Statements (uploads that read order rows) keep today's channel + kind + period key. Charge-only invoices (0 orders) are
   superseded only by an upload of the SAME invoice number with different bytes; never by period. Two different invoices on one date both
   stay current. Pin with tests (the two real small invoices + a same-invoice-number re-issue).
4. **Duplicate-copy check.** When both lines carry an official document number they are duplicates iff the numbers are equal; otherwise the
   old heuristic stays. Original (+100), reversal (−100) and re-bill (+100) all book; an exact re-upload still refuses.
5. **Netting.** The carrier day's charges = its own invoice's booked, un-netted charges ∪ booked, un-netted charges of the same channel whose
   `official_document` is listed in the carrier upload's `prior_items`. Chosen on the server from file facts, never from the form. Expected
   deposit = file net − Σ charge totals (net + VAT, signed). Cross-check: Σ over matched items of (−printed amount) must equal Σ matched
   charge totals, else blocker `prior_items_mismatch` in plain words ("Foodpanda says this payout settles earlier items worth X, but the
   charges on file add up to Y"). A listed document with no charge on file, or on file but not booked, is a blocker in plain words (upload /
   book it first; reject the day is the escape). Already-netted matches are informational (no double net). `chargeNetting` unchanged.
6. **Screen.** Carrier note and the charges panel list the earlier-invoice charges ("From earlier invoices: invoice 200711317519 … 100.00").
   `carrierNote` wording updated; five blocker/words entries added to `words.ts`; COMMANDS/labels unchanged.
7. Worked example (a test to the centavo, all three small charges booked first): weekly deposit total 60,760.98 = 62,727.35 − 1,866.35 −
   100.00 − 0.02 rounding; the three small charges link to that settlement; 1220 has no leftover from them. If the 0.02 lands elsewhere than
   the S3 rounding line, report it, do not hide it. Negative controls: C lists a document not on file → blocked; C amount ≠ charge totals →
   blocked; re-run approve → no second netting.

## Out of scope / accepted
Day lines still replace by sales date without the invoice number (existing S4 design, noted); reading the PDF; a UI for Appendix C items that
are not charges (blocked → reject the day); renders (sign-in blocked; Ian looks after merge).

## Order
S8a: Sonnet builder → Sonnet audit → fixer → gates. S8b: same, plus money audit (authorize-first, forged ids impossible, mismatch cases,
double-net, unbooked/unfound, supersede regression, migration fresh-install + upgrade from head). One hand-back per slice to BOSS.
