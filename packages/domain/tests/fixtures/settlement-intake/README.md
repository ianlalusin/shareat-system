# Redacted settlement fixtures (T-511 slice 1 staging)

Made 3 Nov 2026 from Ian's sample folder by a deterministic script (same input gives the same bytes). Originals are NOT here. This folder is gitignored (`docs/discovery/fixtures-staging/`); slice 3 copies what it needs into `packages/domain/tests/fixtures/settlement-intake/`.

What stays: every header row (byte for byte), UTF-8 BOM, LF line endings, column order, quoting, number formats, date formats, amounts, dates, Store ID, Merchant ID, Settlement IDs, Category/Type/Subcategory/Status, vendor codes, partner names, store names, generic descriptions (withholding tax text, chargeback text, compensation text, campaign text).

Substitution rule: the same original value always maps to the same substitute (so the Linked Transaction ID still points at its row), different originals map to different substitutes, and character classes are kept (digit stays digit, upper stays upper, lower stays lower, dashes and fixed prefixes stay).

Checks run on these copies (all passed): 30 of 31 payouts per store tie to the centavo by Settlement ID, Banay Sept + Oct tie together, loan sums per day tie (591.24, then 2,363.12, then 1,771.88), the Lipa +150,000 disbursal payout, Foodpanda row and column identities. Results are in `docs/discovery/grab-foodpanda-settlement-files.md`.

## Grab (CSV, 68-column Transaction kind and 10-column Transfers kind)

Redacted in Transaction files: `Transaction ID`, `Linked Transaction ID` (shared substitute map, loan rows included), `Long Order ID`, `Short Order ID`, `Booking ID`, `Partner transaction ID 1/2` (empty in all samples) are substituted. `Appeal link` and `Customer refund Item` become constants when filled (`https://help.grab.com/merchant/en-ph/REDACTED`, `REDACTED ITEM`). `Description` is kept when generic (17 of 17 non-empty descriptions were generic).
Redacted in Transfers files: `Bank Account` becomes `0000`, `Bank Statement Code` becomes `0000000000`, `Bank Name` becomes `BANK REDACTED`.

| File | What it is |
|---|---|
| grab-lipa-oct-transactions.csv | Lipa, Transaction kind, 1 to 31 Oct, 586 rows (1 loan disbursal, 45 loan deductions, 2 rows with a Linked Transaction ID) |
| grab-lipa-oct-transfers.csv | Lipa, payout kind, 31 payouts |
| grab-malvar-oct-transactions.csv | Malvar, Transaction kind, Oct, 148 rows |
| grab-malvar-oct-transfers.csv | Malvar, payout kind, 31 payouts |
| grab-banay-oct-transactions.csv | Banay-banay, Transaction kind, Oct, 208 rows (6 rows with a Linked Transaction ID) |
| grab-banay-oct-transfers.csv | Banay-banay, payout kind, 31 payouts |
| grab-banay-sep15-30-transactions.csv | Banay-banay, 15 to 30 Sep, 95 rows (the payout seam: its trans-only rows tie the Oct 1 payout) |
| grab-banay-sep15-30-transfers.csv | Banay-banay, 15 to 30 Sep payouts, 16 payouts |
| grab-malvar-jun-advertisement-transactions.csv | Malvar, 23 Jun to 4 Jul, 210 rows, 3 `Advertisement` rows (tax column additive), 2 rows with a Linked Transaction ID |
| grab-malvar-jun-jul-transfers.csv | Malvar, payouts 1 Jun to 15 Jul, 43 rows (wider than the June transaction file, so some payouts have no rows) |

## Foodpanda (zip with exactly 2 entries: `<YYYYMMDD>_<12 digits>.xls` which is really OOXML, and `.pdf`)

Redacted: `Official Document Number` (16 digits, first 10 kept), `Invoice Number` (12 digits, first 3 kept) in both sheets and in the file name, `Order Code` (vendor prefix kept, the rest substituted; a reversal row keeps the same substitute as its original), the PandaGO order code in Appendix B descriptions, the workbook author id, workbook timestamps. The workbook was patched at the XML level, so everything else is the real structure: shared strings, UTF-8 BOM in the XML parts, Excel tables, the uncached `=SUBTOTAL` last row, header newlines, percent text cells, `mm-dd-yy` dates, and the real quirk that `sharedStrings.xml` carries a wrong `uniqueCount`. The PDF is replaced by a tiny synthetic stub (the real PDF holds invoice data).

| File | What it is |
|---|---|
| foodpanda-lipa-oct5-34col.zip | Lipa, invoice dated 30 Sep, 34 columns, 336 orders, 1 reversal, 2 customer-refund rows, 7 self-pickup, 6 charge rows |
| foodpanda-lipa-oct19-34col-feerow.zip | Lipa, invoice dated 15 Oct, 34 columns, 285 orders, 1 reversal, 2 refund rows, 1 fee-only row without delivery mode |
| foodpanda-malvar-oct12-34col.zip | Malvar, invoice dated 7 Oct, 34 columns, 57 orders (1 fee-only row), 8 charge rows |
| foodpanda-banay-oct19-34col.zip | Banay-banay, invoice dated 15 Oct, 34 columns, 49 orders, 17 charge rows |
| foodpanda-lipa-jul15-32col.zip | Lipa, invoice dated 15 Jul, 32 columns (no Surcharge Fee, no Cancellation Fee, letters shifted), 313 orders |
| foodpanda-lipa-oct5a-appendix-b-only-pandago.zip | Lipa, Appendix B only (no Appendix A sheet): PandaGO delivery fee, PandaGO COD (negative), withholding tax; this is the PandaGO example |

## Synthetic files (no real data; made for tests)

| File | What it is |
|---|---|
| hostile-zip-11-entries.zip | 11 entries (cap 10) |
| hostile-zip-expands-over-5mb.zip | 2 entries; the pdf expands to 6 MB of zeros; the zip is 23 KB; headers tell the truth |
| hostile-zip-lying-size.zip | 1 entry; the headers say 100 bytes, the stream inflates to 6 MB |
| hostile-zip-nested-archive.zip | contains `inner.zip` |
| hostile-zip-bad-extension.zip | contains `payload.exe` (plain text bytes) |
| hostile-zip-path-traversal.zip | an entry named `../escape.pdf` |
| hostile-xlsx-unknown-extra-column.xlsx | Foodpanda workbook with an extra header `Mystery Column (ZZ)` |
| hostile-xlsx-missing-order-date.xlsx | Foodpanda workbook with the `Order Date` column removed |
| variant-xlsx-openpyxl-inline-strings.xlsx | NOT hostile: a valid workbook written by another generator (inline strings, absolute relationship targets). exceljs crashes on it, read-excel-file reads it |
| hostile-grab-missing-settlement-id-column.csv | Transaction CSV, 15 rows, `Settlement ID` column removed |
| hostile-grab-category-no-trailing-space.csv | Transaction CSV, 15 rows, `Category` without the trailing space (trim matters) |
| hostile-grab-header-only.csv | header row only |
| hostile-empty.csv, hostile-empty.zip, hostile-empty.xlsx | 0 bytes |
| hostile-not-a-zip.zip | plain text named .zip |

The PDF stubs inside the synthetic zips are the same synthetic stub. The two `hostile-xlsx-*` files and the zips that wrap an xlsx reuse the redacted Malvar 7 Oct workbook.
