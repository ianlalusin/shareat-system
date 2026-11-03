# Grab and Foodpanda settlement files: what the real files contain (T-511 slice 1)

Read-only discovery, 3 Nov 2026, on Ian's sample folder (`C:\Users\ianla\SE\FOODPANDA INVOICES\2026`: OCT = Lipa, Malvar, Banay-banay; July and June for layout comparison). Produced by a Sonnet discovery agent with Python `-I`; PDFs and the unzipped June Foodpanda files were not opened. No customer names, phones, addresses, order ids, bank digits or raw rows appear here. Read as REQUIREMENTS for the readers, not as design.

Scope: OCT folder (3 stores, Oct 2026 + one Sep 15-30 Banay pair) and, for layout comparison only, the July folder (3 Grab export pairs, `lipa/malvar` CSVs, 4 July zips) and `June\_Grab`. No customer names, phones, addresses, order ids, bank digits or raw rows appear here. Python run with `-I`; zips extracted to `probe_extract\<name>`, `.xls` copied to `.xlsx` and opened read-only. PDFs not opened. The June Foodpanda `.xls` files (already unzipped, not zips) and the `aug` folder (no settlement files, only a PDF and a JPEG) were NOT opened.

## 0. Surprises (read first)
1. Grab `Category` has a TRAILING SPACE: values are `"Payment "` and `"Adjustment "` (but `Loans`, `Advertisement` have none). Trim before matching.
2. Grab `Total` for a payment row = `Net Sales + Channel Commission` exactly. The tax column is informational (already inside the 25% commission), not subtracted again. Net MDR / Tax on MDR / Marketing success fee / Order commission are empty or 0 in every file.
3. Control total holds to the centavo: every payout whose orders are in the file ties (90/90 Oct payouts that can be tested; the 3 untestable ones tie against the other file). Loan deductions, WHT, chargebacks are all INSIDE Net Total.
4. Foodpanda Appendix A ends with a `=SUBTOTAL(...)` table-total row with NO cached values (reads as None with data_only, as formula strings otherwise). Appendix B has the same. Parser must skip it and recompute.
5. Foodpanda Appendix A has TWO layouts: 34 columns (July 22 onward, incl. Oct) and 32 columns (the July 15 file: no Surcharge Fee, no Cancellation Fee, every letter after R shifted). Percent columns are TEXT cells (`"22.32"`, `"15.0"`). Lipa also gets a second Appendix-B-only invoice (`lipa oct 5a`, PandaGO items, negative COD) with no Appendix A sheet.
6. Platform Fee description month is unrelated to the invoice week (`PF for the month of September 2026 (W4)` appears on a 30 Sep and an Oct 2 invoice; `August` also on a 30 Sep one; `June` on a July one). PandaGO description date is month-first `M.DD.YYYY`.
7. Grab loan rows carry NO loan id or description; `Receiving account / Source of fund` is the constant text `In-store earnings`. Lipa has up to 2 deduction rows per payout, indistinguishable except by `Transaction ID` and amount.

---
## 1. GRAB, file format (both kinds)
| Property | Finding |
|---|---|
| Encoding / BOM | UTF-8 with BOM (EF BB BF) on every file (21 files checked). No other non-ASCII bytes. |
| Delimiter / quoting | Comma. RFC-4180 quoting; only the header `"Tax on GrabFood/GrabMart commission, adjustments, ads"` needs quotes. No embedded newlines (lines = rows + 1, 0 ragged rows). |
| Line ending | LF only, no CRLF, final line terminated. Read with `newline=''`. |
| Header whitespace | None stray in any header. Same 68-col / 10-col header in June, July and Oct (md5 identical). |
| Numbers | Plain decimal point, no thousands separator, no currency symbol, no parentheses. Negative = leading `-`. Variable decimals: 0, 1 or 2 places (`150000`, `2011.5`, `-455`). Empty cell = not applicable (distinct from `0`). |
| Dates | `d Mon yyyy h:mm AM/PM`, English 3-letter month (`Sep`, `Oct`), NON-padded day and hour, no seconds, no time zone marker. Same format in `Created On`, `Updated On`, `Transfer Date` (trans file) and `Date`, `Transfer Date` (payout file). Transfer Date may be empty. |
| File names | Original exports are `Transaction_Store_<from>_to_<to>_<17digits>.csv` / `Transfers_Store_...csv` (June/July). The OCT files were renamed by hand (`lipa grab trans oct 1 to 31.csv`, `... payment.csv`, `banay sept 15 to 30.csv`). Identify kind by header row, never by name. |

### Header row, Transaction kind (68 columns, in order)
Merchant Name, Merchant ID, Store Name, Store ID, Updated On, Created On, Type, Category, Subcategory, Status, Transaction ID, Linked Transaction ID, Partner transaction ID 1, Partner transaction ID 2, Long Order ID, Short Order ID, Booking ID, Order Channel, Order Type, Payment Method, Receiving account / Source of fund, Terminal ID, Channel, Offer Type, Grab Fee (%), Points Multiplier, Points Issued, Settlement ID, Transfer Date, Amount, Tax on Order Value, Restaurant Packaging Charge, Non-Member Fee, Restaurant Service Charge, Offer, Discount (Merchant-Funded), Delivery Fee Discount (Merchant-Funded), Delivery Charge (Grab Online Store), Delivery Charge (Merchant Delivery), GrabExpress Delivery Service Fee, Net Sales, Net MDR, Tax on MDR, Grab Fee, Marketing success fee, Delivery Commission, Channel Commission, Order commission, Step-up commission, GrabKitchen Commission, GrabKitchen Other Commission, Withholding Tax, Total, Tax on MDR (%), Delivery Commission (%), Channel Commission (%), Order Commission (%), "Tax on GrabFood/GrabMart commission, adjustments, ads", Tax on Total GrabKitchen Commission, Cancellation Reason, Cancelled by, Reason for Refund, Description, Incident group, Incident alias, Customer refund Item, Appeal link, Appeal status

### Header row, payout ("payment"/Transfers) kind (10 columns)
Date, Store Name, Store ID, Settlement ID, Net Total, Status, Transfer Date, Bank Statement Code, Bank Name, Bank Account
(Bank Account is a masked 4-char value; Bank Statement Code is a phone-like code. Do not persist either.)

## 2. GRAB Transaction file content (Oct files, 3 stores: 942 rows incl. cancelled; + Sep file 95)
Distinct values, summed over the 3 Oct files (Banay 208, Lipa 586, Malvar 148 data rows):

| Type | Category (trimmed) | Subcategory | Status | Banay | Lipa | Malvar |
|---|---|---|---|---|---|---|
| GrabFood | Payment | (empty) | Transferred | 173 | 503 | 136 |
| GrabFood | Payment | (empty) | Completed | 20 | 34 | 3 |
| GrabFood | (empty) | (empty) | Cancelled | 3 | 1 | 3 |
| GrabFood | Adjustment | Deduction - Eater Compensation | Transferred / Completed | 2 / 1 | 1 / 0 | 0 |
| GrabFood | Adjustment | Withholding Tax Remittance (non-taxable) | Transferred / Completed | 1 / 1 | 1 / 0 | 1 / 0 |
| GrabFood | Adjustment | Compensation - Orders | Transferred | 0 | 0 | 1 |
| GrabFinance | Loans | Loan Deduction | Transferred / Completed | 7 / 0 | 43 / 2 | 4 / 0 |
| GrabFinance | Loans | Loan Disbursal | Transferred | 0 | 1 | 0 |

- Not present in OCT, but present in `June\_Grab`: Category `Advertisement` (3 rows). Status set overall: Completed, Transferred, Cancelled.
- Store ID, Merchant ID, Store Name are filled on EVERY row including GrabFinance and Cancelled; one value per file. Store Names seen: `SharEat - Banay-Banay`, `SharEat Lipa - San Carlos`, `SharEat - Malvar`.
- Status meaning: Transferred = payout done (Transfer Date filled). Completed = in a payout still `Processing` or not yet listed (Transfer Date empty). Cancelled = no Settlement ID, no Transfer Date, all money columns 0.
- Order Type values: Auto-Paid (all Payment rows), Auto-Chargeback (chargeback adjustments), Manually Paid, Not Paid (cancelled), empty. Payment Method: Cash / Cashless / empty. Order Channel: `GrabFood app & web`.

### Sign conventions (Total column is what feeds Net Total; Amount equals Total on adjustments)
| Kind | Amount | Total | Notes |
|---|---|---|---|
| Payment (962 rows over 4 files) | always > 0 | always > 0, incl. Cash orders (all 87+190+54 cash rows positive) | Net Sales = Amount + Discount (Merchant-Funded) (exact on every row). Total = Net Sales + Channel Commission (exact, 962/962) |
| Loan Deduction | empty | always < 0 (-49.87 to -1771.88) | Grab Fee column = 0; no order ids |
| Loan Disbursal (Lipa, 1 row) | empty | > 0, round figure | Only Total filled |
| Adjustment, Deduction - Eater Compensation | < 0 | = Amount | Chargeback; has Linked Transaction ID pointing to the original order row in the SAME file (all found), plus Incident group/alias, Appeal status |
| Adjustment, Withholding Tax Remittance | < 0 | = Amount | Tax column = 0; no Linked Transaction ID |
| Adjustment, Compensation - Orders | > 0 | = Amount | Description `Canceled Order Compensation` |
| Advertisement (June only) | < 0 (pre-tax) | < 0, = Amount + tax column | Tax column negative and additive here (unlike Payment) |
| Cancelled | empty | 0 | |

### Which header holds each charge
| Charge | Header string | Behaviour seen |
|---|---|---|
| Commission | `Channel Commission` | Negative, exactly 25.0% of Net Sales on every Payment row (962/962). Delivery Commission, Order commission, Step-up commission, GrabKitchen Commission, GrabKitchen Other Commission: 0 or empty. The `...Commission (%)` columns are empty. |
| Tax on commission | `Tax on GrabFood/GrabMart commission, adjustments, ads` | Negative on Payment rows, = 10.7% of the commission (the 12% VAT inside 25%). Informational for Payment (already inside commission). On Advertisement it is additive. 0 on WHT rows. |
| MDR | `Net MDR`, `Tax on MDR`, `Tax on MDR (%)`, `Grab Fee` | Empty in every file. `Grab Fee` = 0 only on loan rows. |
| Marketing | `Marketing success fee` | 0 on Payment rows. Ads arrive as separate Category=Advertisement rows, description text like `<campaign name> - 99% OFF! - 2026-05-29` (ISO date at the end). |
| Withholding tax | `Withholding Tax` column is always 0. Real WHT is an Adjustment row, Subcategory `Withholding Tax Remittance (non-taxable)`, Description `Withholding Tax on Gross Remittance <Mon> <d>-<d>, <yyyy>` (half-month period, e.g. Sep 16-30, Oct 1-15) | Posted 7-9 Oct (Sep 16-30 period) and, for Banay, 30 Oct (apparently Oct 1-15); about one row per store per half month. |
| Compensation | Adjustment rows (see above) | Chargeback description: `Chargeback due to a customer incident on dd-mm-yyyy*` (day-first, trailing asterisk). |
| Discount | `Discount (Merchant-Funded)` | Negative or 0 (19 of 962 rows nonzero). Offer, Non-Member Fee, Service Charge, Packaging, Delivery columns are 0 or empty. |

### Loan rows: which loan?
No field names the loan. Description, Order ids, Offer Type are empty on every loan row. `Receiving account / Source of fund` = the single text `In-store earnings` (all 57 loan rows). `Grab Fee (%)` = 0. `Transaction ID` is unique per row (10 digits + 2 letters + 20 digits) and carries no loan meaning. Rows per payout: Banay 1 or 2, Lipa 1 or 2 (15 of the 30 payouts with loan rows have 2), Malvar 1. Loan deduction amounts vary daily (distinct amounts per store: 7, 13+, 4), so it is a percentage-of-sales repayment, not a fixed instalment. Deduction/payout payment-total ratio ranged 1.4% to 65.5%. A spec cannot attribute a deduction to a specific loan from these files.

## 3. GRAB payout file (Oct: 31 rows per store; Sep 15-30 Banay: 16 rows)
- Headers: payout id = `Settlement ID` (12 chars, `SPH` + 9 upper-case alphanumerics, unique per row); money = `Net Total` (always >= 0 here, plain decimal); payout date = `Date` (always 01:4x-01:5x AM); bank transfer time = `Transfer Date`.
- `Status` values (302 rows, all files): `Completed` 296, `Processing` 6. Exactly one Processing row per store in Oct (the last one, Date 31 Oct); its `Transfer Date` is empty.
- One payout per calendar day. Oct files: `Date` 1 Oct to 31 Oct (31 payouts). `Transfer Date` 1 Oct to 30 Oct afternoon (about 13:30-15:30). Transfer minus Date: same day 22x, +1 day 4x (payout dated Sunday), +2 days 4x (payout dated Saturday, paid Monday), per store.
- Each payout covers exactly ONE order-created day: the previous day (every one of 183+515+138 payment-row/payout links: payout Date day = Created On day + 1).
- Sep file (Banay): `Date` 15 Sep to 30 Sep, 16 payouts, all Completed.
- Cross-file seam: the first payout of a month (Date 1 Oct 01:5x) pays orders created 30 Sep, so its rows live in the previous month's transaction file; the orders of 31 Oct (payout Date 1 Nov) are in the Oct trans file with no payout row yet.

## 4. GRAB control-total check (Net Total vs sum of Transaction `Total` by Settlement ID, all kinds included, Decimal exact)
| Store | Payouts | Exact match | Not matched | Trans Settlement IDs with no payout row |
|---|---|---|---|---|
| Banay Oct | 31 | 30 | 1 | 1 (10 rows, Oct 31 orders, Completed) |
| Lipa Oct | 31 | 30 | 1 | 1 (23 rows incl. 1 loan deduction) |
| Malvar Oct | 31 | 30 | 1 | 1 (1 row) |
| Banay Sep 15-30 | 16 | 15 | 1 | 1 (8 rows, Sep 30 orders) |

The one unmatched payout in each file is the FIRST row (Date 1 Oct, or 15 Sep): its orders (created 30 Sep / 14 Sep) are outside the transaction file window, so the sum is "absent" (not a difference). Proof: the Sep Banay file's 8 trans-only rows sum to 2011.50, equal to the Net Total of the Oct Banay payout dated 1 Oct (2011.50). So with adjacent months concatenated, every payout ties exactly, 0.00 difference. The Processing payout ties too (Completed trans rows sum to its Net Total). Loan deductions, loan disbursal (+150000 round figure in Lipa), WHT and chargebacks all net into Net Total, so settlement posting must include them.

## 5. GRAB time zone / which day an order belongs to
- `Created On` has no zone and no offset: bare local wall-clock. Order hours seen: Banay 09-19, Malvar 10-21, Lipa 08-23 (59 Lipa orders at 22:00-23:59, none at 00:00-07:59).
- Read as UTC and converted to Asia/Manila (+8), 79 of 193 Banay, 303 of 537 Lipa and 71 of 139 Malvar payment orders (35-56%) would change calendar day, and Lipa 22:xx-23:xx orders would land at 06:xx-07:xx next morning (implausible for a restaurant). Read as Manila local, all evidence is consistent: payout `Date` day = order day + 1 for 100% of links, payout time-of-day ~01:50 AM. Conclusion: treat all Grab timestamps as Asia/Manila wall-clock; an order's business day = the calendar date printed in `Created On`. Payout Date is the NEXT day; Transfer Date is same day as payout Date (or Monday for weekend payouts). The file itself never states the zone, so state it as an assumption in the spec.
- No order is created between 00:00 and 07:59 in these data, so the midnight edge case is not exercised by the sample.

## 7. GRAB sizes and row counts (bytes / data rows excl. header)
| File | Bytes | Rows |
|---|---|---|
| banay grab trans oct 1 to 31.csv | 91,151 | 208 |
| banay grab oct 1 to 31 payment.csv | 5,796 | 31 |
| lipa grab trans oct 1 to 31.csv | 253,469 | 586 |
| lipa grab oct 1 to 31 payment.csv | 5,625 | 31 |
| malvar grab trans oct 1 to 31.csv | 64,043 | 148 |
| malvar grab oct 1 to 31 payment.csv | 5,630 | 31 |
| banay sept 15 to 30.csv / ... payment.csv | 42,406 / 3,065 | 95 / 16 |
Largest seen anywhere (July, pre-Oct): trans 298,714 B / 691 rows; payout 12,264 B / 68 rows. A monthly Lipa file is the realistic ceiling: ~0.25-0.3 MB, ~700 rows.

---
## 8. FOODPANDA zips (13 in OCT; 4 more in July for layout comparison)
Zip entry names are consistent: exactly 2 entries, `<YYYYMMDD>_<12-digit invoice number>.xls` and `.pdf`, same stem. The date = Appendix A `Invoice Date (C)`; the 12 digits = `Invoice Number (B)` (verified on all 17). Zip names are user labels (`lipa oct 5`) and do NOT equal the invoice date: `oct 5` zips hold invoices dated 30 Sep; `oct 12` -> 7 Oct; `oct 19` -> 15 Oct; `oct 26` -> 22 Oct. Appendix B's invoice date is 2-5 days later than Appendix A's (e.g. A 7 Oct, B 12 Oct).
The `.xls` is really OOXML (starts `PK`), 15 internal parts (12 for the B-only invoice), with Excel Tables (A = table1, B = table2); cell dates carry number format `mm-dd-yy`.

## 12. Zip caps data (13 OCT zips; July zips are inside the same ranges)
| Metric | Value |
|---|---|
| Entries per zip | 2 always (xls + pdf); nothing else, no nested archives, no directories, no unsafe names |
| Max compressed zip | 103,675 B (lipa oct 5); min 63,356 (lipa oct 5a) |
| Max expanded (sum of entries) | 156,285 B (lipa oct 5); compression ratio 1.5-1.6 |
| Max single entry | pdf 103,715 B (all pdf 92,129-103,715); xls max 54,569 B |
| Max xlsx internal expanded | 437,451 B across 15 parts (lipa oct 5) |
| Max xlsx rows | Appendix A: 336 order rows (+header +total row = max_row 338). Appendix B: 17 items (banay oct 19) |
| Order rows per week | Banay 41-59, Lipa 275-336, Malvar 47-76 |
Oct totals: 1,653 order rows across 12 Appendix A sheets (1,610 FOODPANDA delivery, 33 SELFPICKED, 5 customer-refund Y, 2 reversal X, 3 no-delivery-mode fee rows). Suggested caps: 1 MB zip, 5 MB expanded, 10 entries, 5,000 Appendix A rows, 200 Appendix B rows (about 10x headroom).

## 9. Foodpanda sheets and exact header rows
Sheets: `Appendix A` (orders), `Appendix B` (charges). `lipa oct 5a` has ONLY `Appendix B`.
No hidden columns, no freeze panes. Last row of each sheet is the Excel table total row (formulas, no cached values).

### Appendix A, 34-column layout (all 12 Oct files and the 3 July-22 files)
0 `Official Document Number(A)` | 1 `Invoice Number (B)` | 2 `Invoice Date (C)` | 3 `Partner Name (D)` | 4 `Vendor Code (E)` | 5 `Order Code (F)` | 6 `Reversal (G)` | 7 `Order Date (H)` | 8 `Delivery Mode (I)` | 9 `Customer Refund (Wastage)` (no letter) | 10 `Gross Food Value / Product Value By Customer (K)` | 11 `Container Charges Paid By Customer (L)` | 12 `MOV Paid By Customer (M)` | 13 `Partner Delivery Fee Paid By Customer (N)` | 14 `Voucher Paid By Vendor (O)` | 15 `Discount Paid By Vendor (P)` | 16 `Pandabox Voucher Paid By Vendor (Q)` | 17 `Sales Revenue Via foodpanda After Partner Funded Discounts (R) =K+L+M+N-O-P-Q` | 18 `Surcharge Fee (S)` | 19 `1/2% Withholding Tax (T)` | 20 `Waiting Time Fee (U)` | 21 `Cancellation Fee (V)` | 22 `foodpanda Commission Base (W)` | 23 `foodpanda Commission Percentage (X)` | 24 `foodpanda Commission (Y)` | 25 `Pandabox Fee Paid By Vendor (Z)` | 26 `Customer Targeting Fee Percentage (AA)` | 27 `Customer Targeting Fee Paid By Vendor (AB)` | 28 `Delivery Fee Campaign Paid By Vendor (AC)` | 29 `Tax On Partner Charges (AD) =(U+V+Y+Z+AB+AC)*12%` | 30 `Expanded Withholding Tax (AE) = (Y+Z+AB)*2%` | 31 `Already Received Amount By Vendor (AF)` | 32 `Cancelled Orders (Wastage)` + newline text `*Partial=(K*40%)-T` newline `**Full=R-T-U-Y-Z-AB-AC-AD+AE-AF` | 33 `Balance to be paid to Partner (AH)= R+S-T-U-V-Y-Z-AB-AC-AD+AE-AF` + newline `Wastage - Partial= (K*40%)-T`
Headers contain embedded newlines and formula text: match by prefix (`Balance to be paid`, `Order Date`), never by full string.

### Appendix A, 32-column layout (only `lipa 12.zip`, invoice 15 Jul)
Columns 0-17 identical to the 34-col layout. Removed vs 34-col: `Surcharge Fee (S)` and `Cancellation Fee (V)`. Letters renamed: `1/2% Withholding Tax (S)` (idx 18), `Waiting Time Fee (T)` (19), `foodpanda Commission Base (U)` (20), `Commission Percentage (V)` (21), `Commission (W)` (22), `Pandabox Fee (X)` (23), `Customer Targeting Fee Percentage (Y)` (24), `... Paid By Vendor (Z)` (25), `Delivery Fee Campaign (AA)` (26), `Tax On Partner Charges (AB) =(T+W+X+Z+AA)*12%` (27), `Expanded Withholding Tax (AC) = (W+X+Z)*2%` (28), `Already Received (AD)` (29), `Cancelled Orders (Wastage)` (30), `Balance to be paid to Partner (AF)= R-S-T-W-X-Z-AA-AB+AC-AD` (31). Moved: every column after R shifts left 1-2 positions, so index-based reading breaks. Added: none. Oct has no 32-col file; parser should map by header text (strip the letter suffix) not by position.

### Appendix B, 11 columns, identical in all 17 files
0 `Official Document Number` | 1 `Invoice Number` | 2 `Invoice Date` | 3 `Category` | 4 `Description` | 5 `Vendor Code` | 6 `Subject to VAT rate` | 7 `Quantity` | 8 `Unit Price` | 9 `Net Total` | 10 `EWT`

## 10. Foodpanda value facts
- No order status column. The "type/status" signals are: `Delivery Mode` (FOODPANDA 1,610+5+2, SELFPICKED 33, empty 3 on fee-only rows), `Reversal (G)` (`X` on 2 rows in Oct, else empty; reversal row has negative K/R/commission/balance and the SAME Order Code as the original), `Customer Refund (Wastage)` (`N` / `Y`; Y=5 in Oct; on those rows the `Cancelled Orders (Wastage)` column equals the Balance), cancellation fee rows (Delivery Mode empty, K=R=0, `Cancellation Fee (V)` 50.0, balance -56.0 = 50 + 12% VAT).
- `Order Date (H)`: Excel date serial (reads as datetime at 00:00:00), date only, NO time of day, no zone. So the business day = the date printed; no Manila/UTC ambiguity, but also no order times to match against Grab-style timestamps. Weekly span Thu-Wed typically (7-8 days); a few late reversal/refund rows carry Order Dates up to 18 days before the invoice date, so period = Invoice Date backwards, not min(Order Date).
- Vendor code: Appendix A col E (`Vendor Code (E)`) repeated on every order row, upper-case: Banay `MB92`, Lipa `O6JZ`, Malvar `A08X`. Appendix B col F same code in lower-case, and again at the end of every Description (`... : MB92` / `...:mb92`). No single header cell; derive from first data row and compare case-insensitively.
- Partner Name (col D): `SharEat - Banay-Banay`, `SharEat Lipa (Samgyupsal Store)- San` (note: not "San Carlos"), `Shareat - Santiago Malvar` (lower-case s). These differ from the Grab Store Names, so the store map needs vendor code or a per-platform alias table.
- Invoice number: `Invoice Number (B)`, 12 digits, one per file, also the file stem. `Official Document Number(A)`: 16 digits starting `2000000004`, one per file, same in Appendix B of that file. Invoice period: no field; `Invoice Date (C)` is the period end (a Wednesday or Thursday in Oct) and equals the last Order Date. Periods are contiguous: 23-30 Sep, 1-7 Oct, 8-15 Oct, 16-22 Oct (lengths 7-8 days).
- Cell types: money = float or int (not text); percentage cells (cols 23 and 26 in the 34-col layout) are TEXT (`"22.32"`, `"15.0"`); `Order Code` is text `xxxx-xxxx-xxxx` (14 chars); Delivery Mode, Reversal, Refund text. Commission percentage is 22.32 on all rows except 1 row in 3 files (a fee-only row with no percentage).

## 11. Do the Foodpanda totals tie?
The xlsx has no invoice grand-total cell (only the uncached SUBTOTAL row; the PDF holds the printed total and was not opened). What CAN be verified from the xlsx alone, all 15 order sheets, 100% of rows:
- R = K+L+M+N-O-P-Q on every row.
- Commission Y = W x X% (to 0.01) on every row; Tax On Partner Charges AD = (U+V+Y+Z+AB+AC) x 12% on every row (up to 0.025 off on 14 rows in 2 Lipa files, because the formula runs on unrounded inputs; rounding only); Balance AH formula holds on every row (0 failures).
- The table identity holds on column sums: sum of per-order Balance = sum(R)+sum(S)-sum(T)-... recomputed from column totals, difference 0.00 on all 15 files (e.g. Banay 7 Oct invoice: 50 orders, sum Balance 12,225.25 = recomputed 12,225.25).
- Expanded Withholding Tax (AE) is 0 on every row of every file even though its header says (Y+Z+AB) x 2%. So EWT is not deducted at order level; Appendix B `EWT` is 0 on all items too.
- Surcharge (S), Delivery Fee Campaign (AC), Already Received (AF), Voucher (O), Container (L), MOV (M), Partner Delivery Fee (N) are 0 on all rows in Oct. Pandabox Voucher (Q) nonzero on 11-42% of Lipa/Malvar rows. Waiting Time Fee (U) nonzero on a few rows per week.
- NOT verifiable here: that Sum(Balance) minus Appendix B (net + 12% VAT) equals the bank payout (needs the PDF/bank line). Appendix B is NOT included in column AH.

### Appendix B items
| Category | Description pattern | VAT | Notes |
|---|---|---|---|
| `Organic Placement (CPC)` | `Organic Placement (CPC)  2026-10-01  : MB92` (two spaces each side of an ISO date, then `: <vendorcode>`) | ` 12%` (leading space) | One row per CPC line per day, often 2 per day; date = the day of the ads, inside the invoice week. 5-16 rows per invoice |
| `Platform Fee` | `PF for the month of September 2026 (W4):mb92` (month name + year + week tag, no space before colon) | ` 12%` | Exactly one per invoice, 223.21 net (= 250.00 incl. 12% VAT). Month named in the text does NOT match the invoice month (lagging by 1-2 months) |
| `Delivery Service Fees`, `Pandago COD`, `1/2% Withholding Tax` | `PandaGO Order-9.24.2026-o6jz-<6 char code>` (month-first M.DD.YYYY with dots) | ` 12%` / `  0%` (two leading spaces) | Only in `lipa oct 5a` (Appendix B only): 89.29, -476.00 (COD collected, NEGATIVE), 1.68 |
`Quantity` always 1.0; `Unit Price` = `Net Total`; `EWT` 0 (int). Net Total is pre-VAT; VAT is `Subject to VAT rate` x Net Total (12% or 0%), no VAT column. Negative amounts exist only on the PandaGO COD item.

## 13. Davao
No Davao files anywhere under `2026` (searched names, case-insensitive). The only stores in any data are Banay-Banay, Lipa (San Carlos) and Malvar, in both Grab and Foodpanda files.

## Parser-spec implications (one line each)
- Match header text, not column index (Foodpanda has 2 layouts and embedded newlines; Grab Category has trailing space).
- Skip the Foodpanda trailing SUBTOTAL row; recompute totals; accept an Appendix-B-only invoice.
- Treat Grab Created On as Asia/Manila; payout Date = business day + 1; assign payout by Settlement ID, never by date arithmetic.
- Tie check: SUM(Total) by Settlement ID must equal payout Net Total; a payout with no rows in the window is "outside window", not an error.
- Do not store Bank Account, Bank Statement Code or Transaction IDs of loan rows beyond what posting needs.

---
## Library check (3 Nov 2026)

Method: throwaway npm project outside the repo; each candidate also installed alone for its own `npm audit`; GitHub advisory database queried per exact version (`gh api advisories?ecosystem=npm&affects=<pkg>@<ver>`; the query was proven on `xlsx@0.18.5`, which returns 2 high advisories); real reads of the 6 redacted Foodpanda zips (34, 32 and Appendix-B-only layouts) plus 3 bare workbooks; hostile zips from the fixture set. Weekly downloads are npm's last-week figure (26 Oct to 1 Nov 2026). Everything ran on Node v24.14.1 (local). Repo `engines` is `node >=20`, CI uses Node 22; Node 20 and 22 were NOT available to test here. Declared engines: yauzl `>=12`, read-excel-file `>=18`, fflate none, exceljs `>=8.3`.

| Package | Version | Published | Licence | Advisories (npm audit / with --omit=dev / GitHub DB) | Packages in tree, size | Weekly downloads | Buffer API (no disk) | Caps | Layouts read | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| fflate | 0.8.3 | 2026-05-16 | MIT | 0 / 0 / none | 1 (no deps), 0.8 MB | 144.2 M | yes (`unzipSync`, streaming `Unzip`) | listing without inflating (filter returns false); real-byte cap only by pushing the streaming `Unzip` in 256 B to 1 KB slices (refused after 5.3 to 6.3 MB, one chunk of up to 1 MB); `unzipSync` trusts the declared size (lying zip: returns 100 bytes silently, no error, no CRC check); names not validated | n/a (zip only) | usable, needs hand-written guards |
| yauzl | 3.4.0 | 2026-06-07 | MIT | 0 / 0 / none | 2 (`pend`), 0.15 MB | 71.1 M | yes (`fromBuffer`) | entry count known before any read; per-entry declared sizes before inflating; `validateEntrySizes` (default) refuses the lying zip after the first 16 KB chunk; bad names refused at open (`../escape.pdf`); real-byte cap through stream `data` events plus `destroy()` (refusal at cap plus 16 KB) | n/a (zip only) | **CHOSEN (zip)** |
| exceljs | 4.4.0 | 2023-10-19 (npm record touched 2024-12-20) | MIT | **9 moderate / 9 / none on the package itself** (transitive: `minimatch` GHSA-g3hv-75wg-m249, `uuid` GHSA-w5hq-g745-h8pq, through archiver, glob, readdir-glob, zip-stream; npm's only fix is a downgrade to 3.4.0) | 193, 46.7 MB | 26.1 M | yes (`xlsx.load(buffer)`) | none (a 100 MB part is inflated and parsed: 7.2 s, +296 MB RSS) | 34-col, 32-col, Appendix-B-only read; throws `TypeError` on a valid workbook written by openpyxl (absolute relationship targets). Biggest sheet (336 rows) 136 ms cold, 49 ms warm, heap +30 MB | rejected (open advisories, no release since 2023, size, crash on a valid file) |
| read-excel-file | 9.3.14 | 2026-10-29 | MIT | 0 / 0 / none | 7 (fflate shared, saxen, unzipper-esm, worker-f, graceful-fs, node-int64), 5.5 MB | 4.8 M | yes (`readSheet(buffer, 'Appendix A')` from `read-excel-file/node`; 0 filesystem writes counted during a yauzl plus read-excel-file run) | none inside (a 100 MB part: inflated and read in 6.5 s, +200 MB RSS, then an error) | 34-col, 32-col, Appendix-B-only and the openpyxl variant all read; all five Appendix A sheets give the same Balance sum as Python (14,512.09, 81,972.28, 70,018.44, 85,747.71, 9,700.16). Biggest sheet 49 ms cold, 41 ms warm, heap +11.6 MB | **CHOSEN (xlsx)** |

**Chosen pair: yauzl 3.4.0 (zip) with read-excel-file 9.3.14 (xlsx).** Reason: both have no open advisory on the exact version and none in their dependencies, both read from a Buffer without touching disk, yauzl enforces names, counts and sizes by default, and read-excel-file read every layout and variant, including a file exceljs crashes on. The acceptance rule is met except "tests pass in `packages/domain`": nothing is installed in the repo in this slice, so that part is for slice 3.

What the readers do with the Foodpanda quirks (read-excel-file, default options):
- Header newlines come through as `\r\n` (exceljs gives `\n`): normalise line endings before matching, and match by prefix as the spec says. Text cells are trimmed by default (`trim:false` exists).
- The uncached `=SUBTOTAL` last row reads as an empty row and is dropped (trailing empty rows are ignored); exceljs returns it as `{formula: ...}` without the leading `=`. If Foodpanda ever caches the totals the row would read as numbers with empty Order Code and Order Date, so the reader must also skip any row with no Order Code.
- Percent cells are strings (`"22.32"`), `Order Date` is a `Date` at 00:00:00Z (use the UTC fields), money is a JS number (a `parseNumber` option can return exact decimals).
- 32 versus 34 columns, by header text: Balance is column 31 versus 33, commission 22 versus 24, `Order Date` 7 in both; Surcharge Fee and Cancellation Fee are absent in the 32-col file (treat as 0).
- Real-file quirks: `sharedStrings.xml` carries a wrong `uniqueCount` (470 declared, 125 strings) and a UTF-8 BOM sits at the start of the XML parts; both libraries cope; never trust `uniqueCount`.

**Finding that changes the guard design: the `.xls` entry is itself a zip, and neither xlsx library caps what it inflates.** A 121 KB workbook whose shared-strings part inflates to 100 MB costs 6.5 s and +200 MB with read-excel-file and 7.2 s and +296 MB with exceljs, and the 5 second read limit cannot interrupt a synchronous parse. So the cap has to be a pre-flight with yauzl on the inner archive (entry count, declared total, `validateEntrySizes` on read) before the workbook reaches read-excel-file; the same bomb is refused at that step ("declared total 100.1 MB"). Outer zip cases measured with the fixture set, for both zip libraries: 11 entries, 6 MB expansion, nested archive and bad extension are all refused from the listing alone (nothing inflated, 0.0 to 1.3 ms); path traversal is refused by yauzl at open (fflate passes the listing); empty and not-a-zip files fail with a clear error in both; the lying-size zip passes a listing-only check in both and is caught only when reading (yauzl: error after 16 KB; fflate: only the streaming guard).

Caps evidence (section 4.1 of the spec): largest Grab CSV 298,714 B (691 rows, July) against 2 MB, which is 6.7x, so raise to 3 MB for 10x; Foodpanda zips 103,675 B compressed against 1 MB (9.7x), 156,285 B expanded against 5 MB (32x), 2 entries against 10; Appendix A 336 rows against 5,000 (15x); Appendix B 17 rows against 200 (11.8x); xlsx inner archive 437,451 B across 15 parts (no cap in the spec yet; add 5 MB expanded and 30 entries, 11x and 2x). Real read times are at most 49 ms (cold) for the biggest sheet, so 5 s is generous; as a time limit it is unenforceable without a worker thread, and the size caps are the real defence (worst case at 5 MB is about 0.3 s).

---
## Redaction and tie results (3 Nov 2026)

Fixtures: 32 files plus a README in `docs/discovery/fixtures-staging/redacted/` (gitignored, not committed): 10 Grab CSVs, 6 Foodpanda zips, 16 synthetic files (7 zips, 3 xlsx, 6 csv or empty). Built by a deterministic script kept outside the repo; two full builds were byte-identical (sha256 of all 32 files). Foodpanda workbooks were patched at XML level (not re-saved), so shared strings, tables, BOMs, header newlines and the uncached SUBTOTAL row are as in the real files; only invoice number, official document number, order codes, PandaGO code, author id and timestamps changed, and the PDF is a synthetic stub.

Redaction checks: in all 10 Grab CSVs every non-redacted cell equals the original (0 differences), the header row is byte-identical, BOM and LF are kept, and no redacted cell kept its original value; link structure holds (Lipa 2 of 2 linked rows, Banay 6 of 6, June Malvar 2 of 2 still point at the right substitute row); the substitute map is one-to-one. A scan for every original redacted value of 6 or more characters found no match in any output file except Short Order IDs, which live in a space of only 1,000 values per prefix and so collide with other orders' substitutes by chance (no row keeps its own). A phone, email and bank-name scan found only substituted order ids that look like numbers. In the 6 Foodpanda workbooks the only cell values that differ are the substituted ones; data types and number formats are equal.

Ties on the REDACTED copies (Decimal, centavo exact):

| Check | Result |
|---|---|
| B1 Grab payouts, SUM(Total) by Settlement ID against Net Total | Lipa 30 of 31 tie, Malvar 30 of 31, Banay Oct 30 of 31, Banay Sep 15 to 30 15 of 16; no payout differs; the one unmatched payout in each file is the first of the period (Date 1 Oct, or 15 Sep) and has no rows in the file. Each file also has 1 Settlement ID with rows and no payout row (Lipa 23 rows, Malvar 1, Banay Oct 10, Banay Sep 8: the last day's orders) |
| B1 Banay Sep and Oct together | 47 payouts, 46 tie, 0 differ; the only absent one is the 15 Sep payout (its rows are in August); the Oct 1 payout (Net Total 2,011.50) equals the Sep file's trans-only rows (2,011.50) |
| B2 company-wide daily loan deductions, store-day = payout Date minus 1 | store-days 1 to 12 Oct: 591.24 each (Lipa only); 13 to 26 Oct: 2,363.12 each (spread over Lipa, Malvar, Banay); **27 Oct: 2,363.11 (one centavo under, Lipa and Malvar)**; 28 to 30 Oct: 1,771.88 each (Lipa only); 31 Oct: 1,771.88 (Lipa's loan row, its payout of 1 Nov is not in any file, assigned by `Created On` 31 Oct). Store-day 30 Sep cannot be tested for Lipa and Malvar (their September files are not in the sample; Banay has no September loan rows). The step from 591.24 to 2,363.12 happens between store-day 12 Oct and 13 Oct, so "until 12 Oct" holds by store-day; by payout Date it is "until the payout dated 13 Oct". 1,771.88 + 591.24 = 2,363.12 |
| B3 Lipa +150,000 Loan Disbursal | sits on the payout dated 13 Oct 2026 (store-day 12 Oct; bank Transfer Date 13 Oct 1:27 PM), 21 rows in that settlement; Net Total 154,473.51, sales part 154,473.51 minus 150,000 = 4,473.51, as expected for the 12 Oct store-day; the payout dated 12 Oct (store-day 11 Oct) is 4,301.76 with no disbursal |
| B4 Foodpanda, per row R = K+L+M+N-O-P-Q, Balance formula, and column-sum identity (header-text lookups) | Banay 15 Oct invoice 49 rows, Lipa 30 Sep 336, Lipa 15 Oct 285, Malvar 7 Oct 57, Lipa 15 Jul (32-col) 313: R identity 0 failures, Balance identity 0 failures (max difference 0.00 on every file), column-sum difference 0.00 on all five (sum Balance 14,512.09, 85,747.71, 70,018.44, 9,700.16, 81,972.28). The 32-col file is read by header text: Balance at column 31 (34-col: 33), commission at 22 (24), Surcharge Fee and Cancellation Fee absent. `lipa oct 5a` (Appendix B only): 3 items, net sum -385.03 (89.29 + 1.68 - 476.00); no Appendix A sheet. Every Appendix A sheet ends with the uncached SUBTOTAL row |
