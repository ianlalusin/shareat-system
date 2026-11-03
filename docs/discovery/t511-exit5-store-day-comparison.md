# T-511 S1 exit 5: store-day comparison (platform file figure vs the figure staff recorded)

Status: file side computed (3 Nov 2026), staff side waits for Ian to run one read-only command. Nothing here holds order ids, customer data or credentials.

## 1. Why this check exists, in plain words

Slice 3 will show the platform's order value next to what staff recorded for the same store, channel and day. The design assumes the two are the same kind of number. If they are not, the booking is wrong in one of two ways:
- Grab takes a small discount that the restaurant funds (`Discount (Merchant-Funded)`). If staff typed the gross amount, that discount must be booked as a cost. If staff typed the amount after the discount, booking it again would count it twice.
- Foodpanda has the same shape: column K is the gross food value, column R is what is left after the vouchers the restaurant funds.

One real day per platform answers it.

## 2. Where the staff-recorded figure lives (found in the repo, not guessed)

| Question | Answer | Evidence |
|---|---|---|
| Where do staff record Grab and Foodpanda sales for a day? | v1 Firestore: document `stores/{v1 store id}/salesDays/{YYYY-MM-DD}`, field `salesChannelBreakdown[channelId]`. Channel names are in `stores/{id}.salesChannels[]` (`channelId`, `name`, `isRemittedDaily`). | v1 `src/types/index.ts:1188-1241` (`SalesDayPlain`, `salesChannelBreakdown`), `:98-103` (`SalesChannel`); document path in v1 `src/lib/actions/ar-channel.actions.ts:431` |
| Is v1 still the book of record in October 2026? | Yes, until the 31 Dec to 2 Jan cutover. | `docs/ops/cutover-runbook.md:145` ("v1 stays the book of record") |
| Does v2 Postgres hold October channel figures? | Not reliably. v2 sales days for Lipa come from the POS feed since 12 Oct, with only a small typed "Platform sales" entry on top; sales are not double-entered; and the cutover purge removes every v2 sales day. | `docs/ops/lipa-pos-link-runbook.md:52-58` (typed form gone, platform entry stays), `docs/plans/remaining-build-plan.md:218` (Q3: "Sales come from the feed with no typing"), `docs/tasks/375-pos-v1-day-feed.md:292` (R8, platform sales typed), `packages/db/src/cutover/classification.ts:247-252` (`sales_days` purged) |
| What would the v2 column be? | `sales_day_channels.amount` (numeric(14,2), never negative) joined to `sales_days` (`status` open, submitted, verified, voided; verified is what posts). The schema says nothing about gross or net of discounts: that is exactly what this check settles. | `packages/db/schema/sales-days.ts:408-431`, `:204` |
| How is a v1 day verified? | `status` goes open, submitted, verified (then partially_remitted, remitted). Verified is what posts the sale. An admin can restate a verified day later (`hasAdjustments`, `preAdjustmentSnapshot`). | v1 `src/types/index.ts:1188-1191`, `:1410-1424` |
| Does this repo already read v1 safely? | Yes: `npm run dual-run -- extract` reads v1 on Ian's machine through a read-only client and the key in v1's `.env.local`, and its snapshot already includes `salesDays`. | `scripts/dual-run.ts:53-82`, `scripts/lib/dual-run-extract.ts:21,68`, `packages/etl/src/master-data/snapshot.ts:29-41` |

So the script reads v1 Firestore. If the v1 day is NOT FOUND, the next place to look is v2 (`sales_day_channels`), which would need a separate select-only script; ask before it is built.

## 3. The two store-days (Lipa, October 2026)

| Platform | Day | Why this day |
|---|---|---|
| Grab | 2026-10-12 (Mon) | 19 order rows, all Completed and Transferred, no Cancelled row, no Adjustment row, no refund, no linked row. **One order carries a merchant-funded discount (-54.00 on a 378.00 order)**, so gross and net differ and the test can tell them apart. Orders ran 09:40 to 22:17, so no order sits near midnight. |
| Grab (second day, for safety) | 2026-10-20 (Tue) | 22 order rows, same cleanliness. **Two** discounted orders (-54.00 each, total -108.00). Used because 12 Oct has only one discounted order: two days agreeing is stronger than one. Orders ran 10:09 to 23:18. |
| Foodpanda | 2026-10-12 (Mon) | 41 orders in the 8 to 15 Oct invoice (the only October Lipa Foodpanda file in the sample). It is the **only** day in that file with no waiting-time fee, no cancellation fee, no cancelled order and no reversal. Six orders carry a restaurant-funded Pandabox voucher (477.25 in all), so K and R differ. |

Why not the suggested 14 Oct: Grab has an Adjustment row that day and only 10 orders with no discount; Foodpanda has a fee-only row (a 50.00 cancellation fee, no delivery mode). Other Foodpanda days all carry waiting-time fees or cancelled orders (8, 9, 10, 11, 13, 15 Oct).

Two things about 12 Oct that do not affect the order comparison, stated so nobody is surprised: it was the day Lipa's Grab payout carried a +150,000.00 loan disbursal, and the payout date is the next day. The comparison uses order rows only.

The files are the redacted fixtures. Amounts and dates are kept exactly, so these figures equal the real ones.

## 4. File-side figures (exact, Decimal)

### Grab, Payment rows whose `Created On` date is the day (Manila time)

| | 2026-10-12 | 2026-10-20 |
|---|---:|---:|
| Order rows (count) | 19 | 22 |
| Rows with a merchant-funded discount | 1 | 2 |
| SUM `Amount` (gross) | **6,807.00** | **10,036.00** |
| SUM `Discount (Merchant-Funded)` | -54.00 | -108.00 |
| SUM `Net Sales` (= Amount + Discount, true on every row) | **6,753.00** | **9,928.00** |
| SUM `Channel Commission` | -1,688.25 | -2,482.00 |
| SUM `Total` (= Net Sales + commission) | 5,064.75 | 7,446.00 |
| Other Grab rows that day (not orders) | 2 loan rows: +150,000.00 and -591.24 | 2 loan rows: -591.24 and -1,771.88 |
| Payout `Net Total` (payout dated the next day) | 154,473.51 (13 Oct) | 5,082.88 (21 Oct) |

Payout check: 12 Oct, 5,064.75 + 150,000.00 - 591.24 = 154,473.51 (without the disbursal, 4,473.51, the known Lipa control total). 20 Oct, 7,446.00 - 591.24 - 1,771.88 = 5,082.88.

### Foodpanda, orders whose `Order Date` is 2026-10-12 (Appendix A, columns found by header text)

| | 2026-10-12 |
|---|---:|
| Orders (count) | 41 |
| SUM K `Gross Food Value / Product Value By Customer` | **16,042.00** |
| SUM O `Voucher Paid By Vendor` + P `Discount Paid By Vendor` + Q `Pandabox Voucher Paid By Vendor` | 0.00 + 0.00 + 477.25 = 477.25 |
| SUM R `Sales Revenue Via foodpanda After Partner Funded Discounts` (= K+L+M+N-O-P-Q; L, M, N are all 0.00 that day) | **15,564.75** |
| SUM `Balance to be paid to Partner (AH)` | 10,634.72 |

## 5. The command for Ian

Run it in your own terminal, in a checkout that has `npm install` done and this branch (`lane/t511-settlement-upload`) checked out. It only reads.

```
npx tsx scripts/t511-read-store-day-figures.ts
```

That reads Lipa, the channels whose names contain Grab or Foodpanda, and 2026-10-12 and 2026-10-20. Options if needed: `--store Lipa`, `--store-id <v1 store id>` (exact; Lipa's is `b9DzsnPbr1BUnY88lyT4`), `--channels Grab,Foodpanda`, `--dates 2026-10-12,2026-10-20`.

The key: nothing to set. The script reads `FIREBASE_SERVICE_ACCOUNT_KEY` from `C:/Users/ianla/webapps/ERP-rebuild/.env.local`, the same place `npm run dual-run -- extract` reads it. To use another file, set `T511_V1_ENV_FILE` to its path in your own shell. **Do not paste the key, the file or any connection string into chat. Paste only the script's output.**

Read-only guarantees: it can only read the store list and one store's `salesDays`; the client has no write call; it opens no database; it writes no file; on any failure it prints one fixed sentence and a short code, never the error text; it prints only the store name and id, channel names and ids, the date, status, verified or not, and amounts.

## 6. What the output looks like (so it can be sanity-checked)

```
Store: <Lipa's v1 name> (v1 store id b9DzsnPbr1BUnY88lyT4)
Channel pattern "Grab": "<name>" channelId <id>, active, not remitted daily (platform settles later)
Channel pattern "Foodpanda": "<name>" channelId <id>, active, not remitted daily (platform settles later)

Date 2026-10-12  stores/<store id>/salesDays/2026-10-12  FOUND
  status: verified   verified or later: yes   verifiedAt: <ISO time>
  admin adjustments: no
  totalSales <n>   sum of salesChannelBreakdown <n>
  discount columns on the day: totalDiscounts <n>, seniorDiscount <n>, pwdDiscount <n>, otherDiscount <n>, comps <n>
  legacy summary fields: foodpandaSales <n>, grabSales <n>, otherSales <n>
  channel "<Grab name>" (channelId <id>, matched "Grab")
    RECORDED salesChannelBreakdown[<id>] = <n>
  channel "<Foodpanda name>" (channelId <id>, matched "Foodpanda")
    RECORDED salesChannelBreakdown[<id>] = <n>

Date 2026-10-20 ...  (same shape; the Foodpanda figure for 20 Oct has no file side, ignore it)
```

The sales-day id is the date itself (v1 uses `YYYY-MM-DD` as the document id). "NOT FOUND" means v1 has no sales day for that date. If `admin adjustments: yes` appears, the line "before the first admin adjustment" is also printed: compare the one staff typed first.

## 7. What to compare, and the decision rule

Compare each RECORDED figure with the bold file-side figures above, to the centavo.

| Grab, 2026-10-12 (second check 2026-10-20) | Recorded equals | Meaning | Decision |
|---|---|---|---|
| gross | SUM `Amount`: 6,807.00 (10,036.00) | Staff type the order value before the merchant-funded discount | The discount was never taken out of the receivable, so **book `Discount (Merchant-Funded)` to 4900 as a signed leg in slice 6** |
| net | SUM `Net Sales`: 6,753.00 (9,928.00) | Staff type the order value after the discount | The receivable already excludes it: **book nothing for the discount** |
| neither | any other figure | Staff record something else (for example after commission, or a day with edits) | **Stop and report the difference** with both file figures; do not choose |

The two Grab days must give the same answer. If 12 Oct says gross and 20 Oct says net (or the reverse), stop and report.

| Foodpanda, 2026-10-12 | Recorded equals | Meaning | Decision |
|---|---|---|---|
| gross | SUM K: 16,042.00 | Staff type the gross food value | The restaurant-funded vouchers (477.25) are not in the receivable: they need the same signed contra-revenue leg as the Grab discount (the design's Foodpanda rows do not cover vouchers yet; BOSS to add them in the design before slice 6) |
| net | SUM R: 15,564.75 | Staff type the value after restaurant-funded vouchers | Book nothing for vouchers |
| neither | any other figure | | **Stop and report the difference** |

Caveats that could make a mismatch innocent, to check before reporting "neither":
- The day boundary: Grab orders on both days sit between 09:40 and 23:18 and Foodpanda dates have no time, so a midnight shift cannot explain a gap.
- Only 19 of 962 October Grab order rows (all three stores; 13 of Lipa's 537) carry a discount. On a day with no discounted order `Amount` equals `Net Sales`, so the test could not tell gross from net. The two days chosen each have at least one; if the script shows the recorded figure equals both (it cannot here), the day is useless and another discounted day (1, 3, 6, 21 or 23 Oct) must be picked.
- A recorded figure with `admin adjustments: yes` may have been restated after verification; use the "before the first admin adjustment" line.
- A recorded figure of 0.00 or "absent" with "staff confirmed no sales" means staff recorded nothing for that channel that day: report it, it is not a mismatch of definition.
