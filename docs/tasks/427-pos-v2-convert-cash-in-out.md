# T-427: POS v2 — Convert (GCash cash-in / cash-out) as its own screen, through the POS v2 server (P0)

**Status:** (checked 31 Oct against main) building is well under way and on main: red tests `e9830c6`, Convert routes `1aa73d6`, wiring `ac19dc1`, handover retry `d17d0ef`; slices S2/S3 completion, audit and any open disputes: verify. Original: spec written 2026-10-17 (Opus planner, POS v2 lane); revised after the Opus review (✎R); ready to build. (Written outside plan mode
at Ian's request to cut approval pop-ups; the spec is Opus-written and Opus-reviewed, which is what plan mode secured.)
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor (money lane).
**Migration:** none.
**Authority:** bible row 359 (Ian 17 Oct: Convert kept as its own feature; ADR-015 A4.2 corrected; T-422 regression) ·
orchestrator approval 17 Oct (server route like T-424, net-zero byMethod move as v1, no cashier PIN as in v1; tests must
cover two tabs converting at once and shift-close reconciliation; ✎R the "two tabs" case must truly overlap the two
transactions with the fake's `consumeBeforeTx` hook) · row 351 (money moves through the POS v2 server) ·
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
   walletMethod, amountCentavos, note?}`: ✎R `createdBy` comes from the signed-in caller (never a body name, as
   `tender-corrections.ts:130`); identity as T-424 (token + staff doc); roles admin/manager/cashier;
   no PIN (v1 parity, orchestrator 17 Oct); `walletMethod` must be an active non-cash method and the store must have an
   active cash method; `amountCentavos` > 0 and ≤ 5,000,000 (₱50,000, a fat-finger guard; above it: "That amount is too
   large for one conversion. Split it or check the number."); **an ERP till shift must be open** (`openTillShift`,
   row 319: Convert changes physical cash), ✎R refused otherwise with its OWN sentence: "Open the till shift in ERP
   before recording a cash-in or cash-out." (the orchestrator confirms Lipa opens an ERP till shift every day from
   11 Jan; if not, this gate is dropped for P0); `requestId` is the doc id and the body hash makes a retry return the same
   doc, a different body 409; ✎R the replay check also requires `source === 'pos2-convert'` and returns the same
   warning as the first call. Writes in ONE transaction: the `paymentConversions` doc in v1's shape (`fromMethod`,
   `toMethod` from the direction, `amount` pesos, ✎R `dayId`/`dayStartMs` from the SAME day function POS v2 sales use
   (`getDayIdFromTimestamp(now)`, so a conversion and the sales it relates to sit on one day; when row 348's closing-time
   day is implemented for sales it applies here too), `createdAtClientMs` = server now, `status: 'active'`,
   `createdBy`) plus `source: 'pos2-convert'`, `direction`, `amountCentavos`, `requestHash`, `tillShiftOpenedAtMs`; and
   the byMethod move via `writeByMethodDelta`: ✎R v1's BLIND increments, no read of the day doc in the transaction (no
   contention with sales' increments). ✎R The cash method is chosen deterministically: the store's active
   `storeModesOfPayment` of type cash with the lowest `sortOrder`, by the same name sales write into `byMethod`.
3. ✎R **Negative-day rule (orchestrator 17 Oct: record and flag, never refuse; blocking a real cash-in is worse and v1
   allowed it).** After the commit, a plain read of the day doc: if the `from` method is now below zero, the response
   carries a warning the sheet shows: "Recorded. Today's GCash total is below zero for now; the office will check this
   day if it stays that way." The doc stores `warnedNegativeAtWrite: true` as ADVISORY only. The authoritative check is
   `pos2-audit.mjs`, which reads each day's FINAL `byMethod` (what `v1-methods.ts:72` refuses on) and lists every
   negative day per store, with the conversions and corrections on it; the handover screen shows the same check for
   the current day. The ERP-side fix (import conversions as cash<->wallet transfers) is named for the orchestrator.
4. **Void route** `POST /api/pos2/conversions/void` `{storeId, deviceId, conversionId, requestId}`: same roles; only a
   doc with `source: 'pos2-convert'` (never a `pos2-correction`, never a v1 doc), still `active`, made in the CURRENTLY
   open till shift (`tillShiftOpenedAtMs` equals the open shift's) ✎R (no separate same-day rule; the reversal always
   goes to the doc's own day); ✎R writes `voidedVia: 'pos2'` so v1-dashboard voids can be told apart; idempotent; reverses with sign
   −1 on the doc's own day; sets `status: 'voided'`, `voidedAt`, `voidedBy`.
5. ✎R **Drawer reconciliation (closes v1's gap fully):** v2's cash handover expectation (`lib/cash/handover.ts`
   `computeCashSales`, `CashHandoverClient.tsx`) adds the net cash effect of EVERY active `paymentConversions` doc in
   the handover window `[prior.periodEndMs, now]` by `createdAtClientMs` whose from or to method is cash (`isCashKey`):
   v1 conversions, `pos2-convert` and `pos2-correction` alike (a GCash-to-Cash correction really put cash in the
   drawer while the receipt stays unchanged). Shown as its own line "Convert and tender fixes: +₱900.00", saved on the
   `cashHandovers` doc as the additive field `convertNet` (pesos) so the saved Expected still equals Starting + Cash
   sales + convertNet − Deductions in history and export. When the day is currently negative for any method, the
   screen also shows "A payment method is below zero today; the office must check this day." No X-slip line (✎R: the
   X-slip is built offline from the ledger; conversions need the internet).
6. **Offline:** Convert needs the internet (server route); the button shows "Needs the internet" offline (T-425
   connectivity). Volume and the ADR A3 offline list do not justify an offline path.
7. **pos2-audit.mjs** counts `pos2-convert` as POS v2's own, lists negative days from final totals (Ruling 3), and
   ✎R flags `pos2-convert` docs voided without `voidedVia: 'pos2'` (voided from v1's dashboard).
8. ✎R The list under the Convert sheet hides `pos2-correction` docs; v1 docs may show, never with a Void button.

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
5. ✎R A cash-in larger than the day's GCash sales -> recorded, warning returned, `warnedNegativeAtWrite: true`;
   pos2-audit lists the day while its final GCash total is negative and drops it once later sales lift it above zero.
   Kills: silently creating a day the ERP refuses; false alarms.
6. Void: a `pos2-correction` doc, a v1 doc, a doc from a previous shift -> refused; ✎R an 11:50 PM conversion voided at
   12:10 AM in the same shift -> allowed, reversed on its own day; a valid void
   reverses exactly; a second void is a no-op. Kills: voiding the wrong record; double reversal.
7. ✎R Shift-close reconciliation: start ₱2,000, cash sales ₱5,000, cash-in ₱1,200, cash-out ₱300, a GCash-to-Cash
   tender correction ₱150, a v1 conversion cash-in ₱100, deductions ₱0 -> expected cash ₱8,150, the line shows +₱1,150,
   and the saved `cashHandovers` doc has `convertNet: 1150`. Kills: v1's handover gap, half-fixes.
8. Offline -> button disabled with "Needs the internet". 
9. `npm test -w @shareat/pos`, pos tsc, all pos-v2 guards, `build` + `build:cap` green; no test requires a lane DB name.

## Must NOT change
Firestore field meanings (additive only) · `packages/**` · `apps/erp/**` · v1 · live `shareat-hub-v2`.

## Live data (read-only count, 17 Oct, ~1,000 reads)
120 days, 4 real stores: **0 days with a negative payment method**; 588 conversions (Lipa 546, Malvar 42), of which 3
(0.5%) between 00:00 and 05:00. The negative-day risk is real but rare, so the ERP-side fix is a follow-up, not a
go-live blocker.

### S1 audit checkpoint, 20 October
Routes and scoped tests are implemented locally; S2/S3 are still unfinished and this branch must not merge. DEF-695 and DEF-703 were reproduced with advisory read failure, failed metadata commit, and committed-then-lost acknowledgments of create/void before correcting them. A conversion writes additive advisoryPending=true in its atomic money transaction; after the advisory read a metadata-only transaction records either clear or negative outcome. Retries return the persisted outcome; pending checks give a truthful Recorded/office-check warning. A lost metadata acknowledgment is recovered by reading the conversion. An unexpected primary commit error is confirmed by the same id/status when possible, otherwise answered as an unconfirmed 503; recovery never repeats the money move. Concurrent-create tests now distinguish the two money transactions from the two metadata-only transactions rather than treating every transaction as a money event. Forty-four route checks pass. POS typecheck is blocked only by the existing missing S2/S3 convert-sheet-logic and convert-net modules (five errors); full POS/build/cap gates remain unmet.
S3 audit finding DEF-704: the existing cash-name substring fallback and tester callback both mistake GCash for cash. Supporting S3 scope must include the cash-method classifier and its explicit Cash/GCash regression; configured cash identities remain authoritative. No live Firestore operation has run.

### Ian ruling and S3 interval correction, 20 October
Ian chose **computed cash sales plus a separate adjustment**, preserving the old manual correction capability explicitly. On save, read fresh receipts/conversions through one captured closing time before writing. Expected = starting cash + computed cash sales + signed manual cash adjustment + net conversions - deductions. A nonzero manual adjustment requires a reason; save both additive fields and show them in history/export. Numeric calculations use the POS centavo helpers. Supporting scope includes CashHandover types and the shared POS request client/tests (DEF-705), plus the cash-method classifier (DEF-704).
DEF-706 records why the preview snapshot cannot close a later window. DEF-707 corrects the spec's overlapping [priorEnd,now] interval: a following handover reads (priorEnd,now], implemented as priorEnd+1 for millisecond timestamps with the existing inclusive reader. The first handover includes its shift-start instant. Persist periodStartExclusive to describe the boundary; never count the preceding inclusive end twice. This is an explicit spec correction, not a silent weakening of the inclusive pure-function tests. Chat ruling is recorded here for planner/Open Questions sync; ArtifactData is unavailable in this session.

### Caller census review for the unfinished POS lane
The post-S1 run passed 93 guard checks but failed both caller-baseline drift checks. Twelve additions were reviewed individually: calculateBillTotalsCentavosT423 is the frozen prior-math test oracle; fakeLocks, installFakeClock, saleOps, seedServerSession and voidOps are offline test fixtures; fixedPromo, loadMod, oldWholeBillSeniorDiscount, oracleStat and workedCase are statutory test fixtures. They must never gain production calls. getEvent is the ledger's read-only single-record inspection API used by tests; runtime processing reads listEvents/listByStatus, so it represents no missing posting path. clearQueue left the orphan set because runtime replay now consumes it. Regenerate docs/production-caller-baseline.txt with the unchanged controlled generator, inspect the exact delta, and retain the guard's controls and zero-new-name check. This explicitly adds the generated baseline to supporting scope; no caller is fabricated and no scanner exclusion or ceiling is widened.

### S2/S3 local implementation checkpoint, 20 October
Sheet, cashier launcher, retry-envelope logic, handover range/cash classifier/calculations, additive handover types/history/export and read-only audit classifications are now wired. Ninety-two affected tests pass; POS typecheck passes. New source-wiring controls are supplementary and do not prove running-app behavior. Signed adjustments use the existing exact typed parser and a nonzero reason; save refreshes receipts/conversions through one captured end and refuses failed fresh reads rather than inventing zeros. A pending Convert envelope is persisted before posting, survives tab reload and can only be discarded after a fresh server list is available and staff explicitly confirm they checked it. It is never automatically posted offline.
The old raw no-change browser transport fallback is corrected under DEF-705; new audit calendar controls under DEF-709 were red first. Command source guards distinguish the existing local Map accumulator from direct/chained database mutations, with positive controls. No live Firestore audit or write has run. Normal build/final guards, full POS CI, safe cap build and visual/runtime sign-off are still required. T-426 remains separate unfinished work on this branch.

## For the orchestrator

### DEF-710 supporting release scope, 20 October
Preserve one handover id and its complete closing payload before posting; retry that exact
window and values after an unknown outcome or reload. Supporting files are
`src/lib/cash/handover-submit.ts`, its test, CashHandoverClient and its wiring test.
An atomic read-before-set treats an identical saved record as success, refuses conflicting
payloads, and confirms an uncertain commit by server read. Persist per store/staff in browser
storage; failed persistence stops posting. Never re-read a later sales window on a retry.
No background/offline posting. Existing Firestore authorization rules remain the gate.
New tests were red for the absent recovery module before implementation; no live writes.
Implemented locally: 107 affected checks, POS typecheck and normal/cap builds pass. The
eight recovery tests include same-id concurrency and a committed write with both its ack
and recovery read lost. Browser storage is durable across reload/reopen, scoped to store
and staff. A pending attempt freezes the form; only explicit Retry posts it. The first
submission refreshes totals through its captured close, while every retry reuses that
unchanged payload. Prior-close seeding now requires a server read. DEF-712 separately
records distinct-id window overlap; this checkpoint does not claim a shared closing lock.
DEF-706 supporting check: if loading the prior close fails, Recompute retries that lookup;
it cannot enable saving a default shift-start window without a confirmed previous-close read.

The ERP day feed refuses a day with a negative method total; Convert legitimately produces one (cash-in before GCash
sales). Today every v1 store carries this risk. Suggested ERP task: import `paymentConversions` as cash<->wallet transfers
(or net them out before the negative check). Until then, `makesDayNegative` marks the affected v2 days.
