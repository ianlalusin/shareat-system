# Evaluation: the file figure as the truth for Grab and Foodpanda sales (T-511)

Read-only study of origin/main 9238217, 4 Nov 2026. Owner direction (4 Nov) ruled by BOSS: B now (staff keep a provisional daily figure; the file replaces it through a correcting entry), C later (staff stop encoding).

## Verdict
1. **B is feasible and low risk, but v2 has no path for it.** `postPosCorrection` is POS-only, needs a verified feed day and refuses a closed month. A verified day can only be voided. B is a new function and pattern, built on that function's shape.
2. **Never overwrite the staff figure.** `sales_day_channels.amount` stays "staff encoded". A new append-only table plus one delta journal entry (Dr 1220 / Cr 4150, party channel; the reverse if the file is lower) carries the file figure. Overwriting is blocked by the database on feed days and would make `postPosCorrection` post a phantom delta.
3. **Staff accuracy needs no new column.** Staging already keeps `recorded_figure`, `order_value` and `difference` per line version (Lipa 20 Oct: 9,474.00 against 9,928.00, the 23:18 order). The new table is for the books only.
4. **C is the expensive one.** Revenue and the receivable are missing for 7 to 31 days, and the month-end cut-off cannot be solved because periods are never reopened. Do not build C unless the owner accepts that.
5. **Recommendation:** B as ruled. Approving a file day posts the correction first, then the settlement, in one transaction.

## BOSS's points
- **1. Entry date.** Sales day if its period is open, else `firstOpenDateOnOrAfter` (`repo/fiscal-periods.ts:588-615`, used at `recurring-expenses/job.ts:184`; null if after today), shown on screen. Never reopen. Consequence: the revenue delta lands in the next open month, the receivable is right at once.
- **2. Staff figure kept** (verdict 2 and 3).
- **3. Variance leg.** Under B the staged net equals the file gross less explained fees, so the settlement difference is about zero. The 6420/7100 acknowledgement stays only as a rare safety valve (balance-versus-gross gap, fee relocation, a residual over tolerance). 0229's `difference_reason` keeps a small job; slice 6 shrinks to loan legs plus the correction. Also found: today, staff 11,000 and file 10,000 leaves 1,000 sitting on 1220 with no 6420 sweep (code read, not run); B closes that gap.
- **4. Existing correction path.** None for a platform amount. Void exists (`verify.ts:313-330`); `postPosCorrection` (`correction.ts`) is POS-only; DEF-779/T-487 only gates close; T-490, T-493, T-499 do not touch it. v1 had a post-verify sales adjustment; v2 does not. The new correction record cannot reuse `sales_day_pos_corrections` (NOT NULL feed ids).
- **5. Blast radius: about 29 files** (5 repo SQL, 10 domain, 14 ERP). Only these need B's attention: `repo/reports.ts` (3 places: it keeps a copy of the staff amount and recognises POS corrections by table), `repo/dual-run.ts:342`, the correction loop in `voidSalesDay` (`verify.ts:321`), `repo/channel-settlements.ts:328` (the settle queue reads the staff amount). Follow a correction by themselves (ledger-based): the 1220 receivable by party (`outstandingFor`, T-507 AR section) and the income statement. Not affected: remittance, till and cashier custody (they read accounts 11xx, not 1220), POS (no Grab or Foodpanda code in the POS domain).
- **6. C's cost.** The dashboard, the sales report by channel, the AR platform section, the settle queue and the income statement show no platform sales until a file is approved; the daily receivable is missing for 7 days (Foodpanda) to about 31 days (Grab uploads); the month-close guard has nothing to catch because nothing was booked. The owner loses the same-day sales and receivable figure. v1 and v2 would disagree on 1220 and 4150 every platform day.
- **7. v1 cutover.** B applies only to v2-posted days; v1 books the staff figure until cutover. The dual-run class catalogue is closed, so a rule-assigned class "platform file correction" is needed or those weeks will not tie before the 15 Nov go/no-go, and `dual-run.ts` must re-date the new corrections. Pre-cutover v2 data is purged on 1 Jan 2027, so B's lasting value starts at cutover.

## Slice re-plan
Slice 4: no change. Slice 5: staff-accuracy view, the day's orders, and a "will correct to X on date D" preview. Slice 6: correction table (its own migration number from BOSS), `correctPlatformSales`, void and report and dual-run changes, full integration suite. Slice 7: correct first, then settle. Slice 3 is unaffected.

## Open decisions for BOSS and the owner (ALL RULED by BOSS 4 Nov: 1 credit the channel's own revenue account (4150 today), never hard-coded; 2 block until the sales day is verified; 3 keep the 6420/7100 valve; 4 yes, rule-assigned dual-run class before any correction posts; 5 kept; 6 own migration 0231; plus DEF-810 for the gap and a platform_sales_correction pattern with a test; see design decision 17)
1. Typed days that put the sale in 4100: use 4150 always, or the day's own split? (Recommend 4150, state the convention.)
2. A file day whose sales day is not yet verified when the file arrives: block until verified (design default) or verify from the file?
3. Does the staff-accuracy report need a threshold, or is it an owner view only?
4. Add the dual-run class "platform file correction", assigned by rule?
5. Keep the 6420/7100 safety valve, or remove it?
6. Correction table: fold into 0229 or its own migration number?
Not checked: Z readings, exports other than the sales rollup, budget screens in full, any v1 code; no code or test was run.
