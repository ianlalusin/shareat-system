# T-471: POS v2 — close the day with a Z-reading; an X-reading any time (P0, PC-8)

**Status:** spec written 2026-10-23 (Opus planner, POS v2 session). **Rulings 1-3 decided by Ian 23 Oct (all as recommended; bible row 390).** Ready to build.
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor. Money: never Haiku.
**Migration:** none. No `packages/**` change (reuses `approve_pos_correction` and `requireManagerApproval`).
**Authority:** bible rows 272, 319, 348 (business day ends at the store's closing time; after-midnight sales
belong to the day that opened), 351, 356, 378 · plan §0 (PC-8 by 21 Nov) · knowledge base:
`knowledge/staff/cashier-dine-in-sop.md` (the POS prints a bill, never an invoice; official receipts are written
by hand in the OR booklet) and `knowledge/store-operations/opening-and-closing.md` (closing checklist open until
2 a.m.; some stores close at midnight).

## Goal, in plain words
At closing the manager presses **Close the day**. The POS prints a **Z-reading**: what the store sold that
business day, by payment method, with refunds, voids, discounts (senior/PWD shown apart), Convert, and the
expected cash. The day is then closed; the next sale starts the next business day. Any time during the day anyone
can print an **X-reading** (same figures so far, closes nothing). Both say "cash control, not a BIR document",
because the POS is not BIR-accredited and official receipts are handwritten.

## Facts verified at `69dca6c` (survey, 23 Oct)
- No closing time exists anywhere usable: the POS store type has optional `openingTime`/`closingTime`
  (`apps/pos/src/lib/types.ts:1160`) read only by online-hours and the weather logger; nothing in `packages/*`
  or `apps/erp` holds it.
- Day ids today: v1 analytics = Manila calendar midnight (`lib/analytics/daily.ts:86`); handover = 04:00 Manila
  (`lib/cash/handover.ts:15`); ERP `businessDayRange` = midnight (`packages/core/src/datetime.ts:12`).
- Reusable: `computeCashSales` / `computeHandoverCash` (`lib/cash/handover.ts:54,97`), `computeExpectedCash` and
  `negativeMethods` (`lib/cash/convert-net.ts:39,61`), X-slip text and print path (`lib/printing/xSlipFormatter.ts`,
  `lib/outbox/xSlipRun.ts:38`, header `XSLIP_HEADER`), manager PIN approval (`server/pos2/approval.ts:9`).
- The ERP reads v1's HTTP day feed (`packages/db/src/pos-v1/wire.ts:16`), midnight-based. Nothing here changes it.

## Rulings
1. **(Ian, 23 Oct) The business day ends when the manager closes it.** A day runs from the
   previous Z-reading to this one ("Z to Z"). The first Z at a store starts at 04:00 Manila of its first day
   (today's handover rule). This meets row 348 without needing a closing-time setting nobody keeps, and a store
   that closes at 1 a.m. simply closes the day at 1 a.m. If a Z is forgotten, the next Z covers both days and
   prints that it spans two dates. *Alternative:* add a closing time per store and cut the day there.
2. **(Ian, 23 Oct) A Z does not lock the till.** Selling continues after the Z; those sales are
   the next business day. *Alternative:* block sales until a "start the day".
3. **(Ian, 23 Oct) Who closes:** cashier or manager presses it; a manager approves with their ERP
   PIN (`approve_pos_correction`, the same as refunds). An X-reading needs no PIN.
4. **The Z is the server's record.** POS v2 server route `POST /api/pos2/z-readings` (manager PIN, store from the
   verified token, never the client) computes the totals from Firestore receipts in the window and writes ONE new
   document `stores/{storeId}/zReadings/{zNo}` (additive: v1 ignores it; T-423 wire constraint holds). `zNo` per
   store, never resets, `Z-0001` style. Idempotent by `requestId` + body hash, like Convert. `GET
   /api/pos2/x-reading?storeId=` returns the same totals for `[last Z, now)` and writes nothing.
5. **What a receipt belongs to.** By its sale moment `createdAtClientMs` (as the handover does). The Z is refused
   on a tablet whose `Unsent sales` is not 0 ("Send the unsent sales first."). A receipt that reaches the server
   after a Z but was rung before it is counted on the NEXT Z and listed there as "late from an earlier day" with
   its number. Nothing is ever recomputed into a printed Z.
6. **Figures (centavos, integer only).** Receipt count; gross sales; discounts with senior/PWD separate (count of
   qualifying diners and total, from T-426 fields); charges; refunds (count, total); voided sales (count, total);
   by payment method (tender id + name, sale, refund, net); Convert net cash; expected cash (`computeExpectedCash`
   with the day's handovers); the last handover's counted cash and variance if one exists; negative-method flags.
   Every total equals the sum of its lines (property test).
7. **The slip.** New `lib/printing/zSlipFormatter.ts` beside the X-slip formatter, same widths (58/80 mm) and print
   path. Header `Z-READING — cash control, not a BIR document`; store, Z number, window from-to (both dates when it
   spans two), printed by, approved by. Footer: "The ERP's sales day still follows midnight until the shared
   database (P2)." The online X-reading uses the same formatter with `X-READING`.
8. **Where on the tablet.** Settings → a "Day" section with **Print X-reading** and **Close the day (Z)**; the
   last Z number and time shown. No new route.
9. **Out of scope:** BIR anything; changing the ERP sales day; locking sales; closing-time settings (unless Ian
   picks the alternative in Ruling 1).

## Slices
- **T:** pure window + totals tests (`lib/cash/z-reading.test.ts`: Z-to-Z windows, first-Z 04:00 start, two-date
  span, late arrivals, every total = sum of lines, refunds/voids/senior-PWD/Convert cases); server route tests
  beside `server/pos2/z-readings.ts` (PIN required, store from token, idempotent replay, refused while unsent on
  that device, X writes nothing); formatter golden text at 58 and 80 mm; wiring test for the Settings buttons.
- **S1:** `lib/cash/z-reading.ts` (pure). **S2:** `server/pos2/z-readings.ts`, `app/api/pos2/z-readings/route.ts`,
  `app/api/pos2/x-reading/route.ts`. **S3:** formatter + Settings section.
- **A:** auditor against this spec, mutant per ruling.

## Acceptance
POS suite green, POS typecheck clean, guards (`pos-v2-*`, `app-boundaries`) green; `V1-COPY.md` lists the hand edits;
runbook §8 gains one line: the detector also lists Z gaps (a `zNo` missing in the sequence).

## Corrections 23 Oct
1. **Senior/PWD was counted twice (money).** `analytics.discountsTotal` already includes the statutory discount (`statutory/totals.ts` `totalDiscounts`). `computeZReading` now reports ordinary discounts = `discountsTotal` - `statutoryDiscountTotal` per receipt (integer centavos), senior/PWD separately; `discounts.totalCentavos` equals the sum of the receipts' `discountsTotal`. Tests: a receipt with both kinds; one fully statutory; the random-day property now also checks the total against `discountsTotal`.
2. **Cash refunds come off expected cash, on the Z/X reading AND the cashier handover (bible row 391).** Expected = start + cash sales + Convert net + manual adjustments - deductions - cash refunds. A refund counts when its `refundTender.methodName` is a cash method, it is not voided, and its `createdAtClientMs` is in the window (same rule as sales); amount `refundTotalCentavos`, else |total|. `computeExpectedCash`/`buildHandoverRecord` take `cashRefunds`; `computeHandoverCash` returns it; the handover stores `cashRefunds` and the screen shows it. The Z slip line is now "Less cash refunds" (above "Expected cash"), same amount as before. Reading `cash.refundsPaidCentavos` is no longer information only.
   Existing tests changed only because of row 391: `handover-cash-method.test.ts` (the handover reader now also returns `cashRefunds: 0`), `zSlipFormatter.test.ts` golden (line renamed and moved above Expected cash), `z-reading.test.ts` (fixture discounts now include the statutory part, per correction 1; contract comment).
3. **FIX A (money): a receipt can no longer be on two Z-readings.** The Z took its clock before its transaction, so a receipt committed in between was counted by that Z (sold inside the window) and again by the next as "late". Each `zReadings` document now stores `receiptIds` (Firestore doc ids of every receipt it counted, late ones included); a receipt is late only if sold before the window, arrived within `LATE_LOOKBACK_MS`, and its id is in no Z of that store reaching into the lookback. Tests in `server/__tests__/z-readings.test.ts` and `lib/cash/z-reading.test.ts`.
4. **FIX B: the slip reconciles.** Cash kept on voided sales was inside "Cash sales" and on no line of its own. `ZReading.cash.voidCashKeptCentavos` is new; the slip prints "Cash sales" without it and "Cash kept on voided sales" above Expected cash, so the printed cash lines add up to expected cash. Golden changed for that (and the fixture now reconciles). DEF-750 and DEF-751 logged.

## Correction 24 Oct (T-474): Correction 3's lookback withdrawn; Z may not go backward; manual adjustments printed
- **Correction 3 ("arrived within `LATE_LOOKBACK_MS`") is withdrawn (DEF-758).** A receipt held unsent for more than 7 days uploaded after the cutoff and was on no Z. Now a Z reads in-window receipts by sale time AND every receipt that arrived (`createdAt`) since the last Z's clock, with no time limit, merged by document id; "counted once" uses the `receiptIds` of every Z committed at or after the last Z's clock. `LATE_LOOKBACK_MS` is gone.
- **A Z's window may not run backward (DEF-757):** inside the transaction, if the latest Z ends at or after this request's clock, the Z is refused 409 and nothing is written.
- **Manual cash adjustments are on the slip (DEF-759):** `reading.cash.manualAdjustmentCentavos` (signed) and a "Manual adjustments" line after "Convert net"; a Z stored before this fix prints no such line.
