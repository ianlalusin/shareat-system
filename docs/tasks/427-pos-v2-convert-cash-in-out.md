# T-427: POS v2 — Convert (GCash cash-in / cash-out) as its own screen, through the POS v2 server (P0)

**Status:** spec written 2026-10-17 (Opus planner, POS v2 lane); awaiting Opus spec review. (Written outside plan mode
at Ian's request to cut approval pop-ups; the spec is Opus-written and Opus-reviewed, which is what plan mode secured.)
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor (money lane).
**Migration:** none.
**Authority:** bible row 359 (Ian 17 Oct: Convert kept as its own feature; ADR-015 A4.2 corrected; T-422 regression) ·
orchestrator approval 17 Oct (server route like T-424, net-zero byMethod move as v1, no cashier PIN as in v1; tests must
cover two tabs converting at once and shift-close reconciliation) · row 351 (money moves through the POS v2 server) ·
row 319 (the till is an ERP record) · PC-0: 333 conversions in 91 days, ~3.7/day, almost all Lipa.
**Depends on:** T-424 (server skeleton, `payment-conversion.ts` writer, identity, `openTillShift`).

## Goal, in plain words
The store is also a GCash cash-in / cash-out point. When a customer hands over cash and receives GCash (or the reverse),
the cashier records it on the tablet in two taps. The day's cash and GCash figures move by the same amount in opposite
directions, sales do not change, and the drawer count at shift close still balances.

## Facts verified (v1 at e26d0c1; v2 at the T-424 merge)
- v1: `PaymentConvertModal.tsx` (From = deducted, To = added; amount > 0; methods differ; note optional; today only;
  void today only with a confirm), `POST /api/analytics/payment-conversion` (roles admin/manager/cashier),
  `applyPaymentConversionServer` (one transaction of blind `increment`s on `payments.byMethod.{safeKey}` of the day,
  month, year and preset docs; `totalGross`/`txCount` untouched; doc in `stores/{s}/paymentConversions` with `dayId` =
  now), `voidPaymentConversionServer` (sign −1 on the doc's own day; idempotent). No fee, no limit.
- Direction (shop's view): **cash-in** (customer gives cash, gets GCash) = cash UP, GCash wallet DOWN = `from: GCash,
  to: Cash`; **cash-out** = `from: Cash, to: GCash`. v1's dialog copy says this; its animation comment contradicts it.
- v1's cash handover (`lib/cash/handover.ts` `computeCashSales`) IGNORES conversions, so expected cash and the drawer
  differ by the net converted cash (a v1 gap).
- ERP feed: a net-zero move leaves Σ byMethod and the refund inference unchanged but shifts cash vs wallet tenders;
  `v1-methods.ts:72-76` REFUSES a day whose method total is negative — a cash-in before any GCash sales that day makes
  GCash negative (v1 stores carry this risk today).
- v2 T-424: `server/pos2/payment-conversion.ts` `writeByMethodDelta` (port of v1, reusable), `tender-corrections.ts`
  pattern (identity, `requireRole`, requestId + body hash idempotency, centavo wire, `openTillShift`).

## Rulings (planner)
1. **Screen:** a "Convert" button on the cashier screen opens a sheet with two big choices, "Cash-in (customer gives
   cash, gets GCash)" and "Cash-out (customer gets cash)", then the e-wallet (active `storeModesOfPayment` of type
   online, default GCash), the amount (typed, `parsePesoInput`), an optional note, and Save. The sheet shows the plain
   effect: "Drawer cash +₱500.00 · GCash −₱500.00". Below, today's conversions (newest first, net by method, voided
   ones struck through) with Void on each of today's active ones (confirm step in the page). The money-morph animation
   is not carried (a toast "Recorded" is enough).
2. **Server route** `POST /api/pos2/conversions` `{storeId, deviceId, requestId, direction: 'cash_in'|'cash_out',
   walletMethod, amountCentavos, note?, actorName}`: identity as T-424 (token + staff doc); roles admin/manager/cashier;
   no PIN (v1 parity, orchestrator 17 Oct); `walletMethod` must be an active non-cash method and the store must have an
   active cash method; `amountCentavos` > 0 and ≤ 5,000,000 (₱50,000, a fat-finger guard; above it: "That amount is too
   large for one conversion. Split it or check the number."); **an ERP till shift must be open** (`openTillShift`,
   row 319: Convert changes physical cash); `requestId` is the doc id and the body hash makes a retry return the same
   doc, a different body 409. Writes in ONE transaction: the `paymentConversions` doc in v1's shape (`fromMethod`,
   `toMethod` from the direction, `amount` pesos, `dayId`/`dayStartMs` = now, `status: 'active'`, `createdBy`) plus
   `source: 'pos2-convert'`, `direction`, `amountCentavos`, `requestHash`, `tillShiftOpenedAtMs`; and the byMethod
   move via `writeByMethodDelta` (net zero; `totalGross`/`txCount` untouched).
3. **Negative-day guard (ERP refusal risk):** inside the transaction the route reads `analytics/{dayId}.payments.byMethod`
   and, if the move would make the `from` method negative for the day, it STILL records the conversion (refusing would
   stop a real cash-in service) but sets `makesDayNegative: true` on the doc and returns a warning the sheet shows:
   "Recorded. Today's GCash total is now below zero; the office will need to check this day." The ERP-side fix
   (import conversions as cash<->wallet transfers instead of letting a negative method refuse the day) is named for the
   orchestrator; it affects every v1 store too.
4. **Void route** `POST /api/pos2/conversions/void` `{storeId, deviceId, conversionId, requestId}`: same roles; only a
   doc with `source: 'pos2-convert'` (never a `pos2-correction`, never a v1 doc), still `active`, made in the CURRENTLY
   open till shift (`tillShiftOpenedAtMs` equals the open shift's) and on today's `dayId`; idempotent; reverses with sign
   −1 on the doc's own day; sets `status: 'voided'`, `voidedAt`, `voidedBy`.
5. **Drawer reconciliation (closes v1's gap):** v2's cash handover expectation (`lib/cash/handover.ts`
   `computeCashSales` and `CashHandoverClient.tsx`) adds the net cash effect of active `pos2-convert` conversions in the
   period (cash-in +, cash-out −), shown as its own line "Convert (cash-in/out): +₱1,200.00". The X-slip (T-425) adds
   the same line when present. ERP till reconciliation follows the day feed (unchanged here). When any conversion in
   the period has `makesDayNegative: true`, the handover screen also shows "A conversion took today's GCash below zero;
   the office must check this day." (orchestrator 17 Oct: record and flag, never refuse).
6. **Offline:** Convert needs the internet (server route); the button shows "Needs the internet" offline (T-425
   connectivity). Volume and the ADR A3 offline list do not justify an offline path.
7. **pos2-audit.mjs** counts `pos2-convert` as POS v2's own and lists `makesDayNegative` days.

## Slices
**T** tester: route tests (identity, roles, method rules, cap, open-shift gate, idempotency, two tabs converting at once
with different requestIds both applied exactly once and the same requestId applied once, negative-day flag), void route
(source/shift/day/status rules, double void), byMethod deltas identical to the vendored v1 writer, handover expected cash
with conversions (shift-close reconciliation: drawer = start + cash sales + net convert − deductions), X-slip line,
offline button state, UI direction labels. **S1** routes. **S2** sheet + list + void UI. **S3** handover + X-slip line +
audit script.

## Acceptance (each names the mutant it kills)
1. Cash-in ₱500 GCash -> doc `from: GCash, to: Cash`, day byMethod GCash −500 / Cash +500, `totalGross`, `txCount`
   unchanged. Kills: reversed direction (v1's comment bug).
2. Two tabs, two requestIds, same instant -> both recorded, byMethod moved by the sum; same requestId twice -> one doc,
   one move; same requestId different body -> 409. Kills: lost or doubled moves.
3. No open till shift -> refused before any write. Kills: cash moved outside a shift.
4. Above ₱50,000 refused with the sentence; 0 or negative refused; a cash method as wallet refused.
5. A cash-in larger than the day's GCash sales -> recorded with `makesDayNegative: true` and the warning returned.
   Kills: silently creating a day the ERP refuses.
6. Void: a `pos2-correction` doc, a v1 doc, yesterday's doc, a doc from a previous shift -> refused; a valid void
   reverses exactly; a second void is a no-op. Kills: voiding the wrong record; double reversal.
7. Shift-close reconciliation: start ₱2,000, cash sales ₱5,000, cash-in ₱1,200, cash-out ₱300, deductions ₱0 ->
   expected cash ₱7,900 and the "Convert" line shows +₱900. Kills: v1's handover gap.
8. Offline -> button disabled with "Needs the internet". 
9. `npm test -w @shareat/pos`, pos tsc, all pos-v2 guards, `build` + `build:cap` green; no test requires a lane DB name.

## Must NOT change
Firestore field meanings (additive only) · `packages/**` · `apps/erp/**` · v1 · live `shareat-hub-v2`.

## For the orchestrator
The ERP day feed refuses a day with a negative method total; Convert legitimately produces one (cash-in before GCash
sales). Today every v1 store carries this risk. Suggested ERP task: import `paymentConversions` as cash<->wallet transfers
(or net them out before the negative check). Until then, `makesDayNegative` marks the affected v2 days.
