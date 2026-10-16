# T-423: POS v2 — money in centavos and one receipt series per tablet (P0, PC-4 part 1)

**Status:** spec written 2026-10-16 (Opus planner, POS v2 lane, plan mode); revised the same day after the Opus spec
review (M7-M10 and minors folded in, marked ✎R)
**Model:** Sonnet tester (T) -> Sonnet builder (S1-S3) -> Sonnet auditor. Money lane: Sonnet always, never Haiku.
**Migration:** none. No `packages/**` change. No server code (that is T-424).
**Authority:** ADR-015 §5 + Amendment A3/A4 · bible rows 67 (centavos), 272 (closed receipt immutable), 276
(`(store, terminal_no, seq)`, never resets, IndexedDB not localStorage) · DEF-001, 002, 003, 587 · plan
`docs/plans/pos-customer-v2-phase-plan.md` §6 PC-4 · PC-4 plan approved by Ian 16 Oct (`T-424` carries the server half).
**Depends on:** T-422 (merged into this branch at `648f1b5`).

## Goal, in plain words
Make the till count money in whole centavos, never in decimals that drift, and give every receipt from a tablet a
number from one series that never restarts, online or offline. Nothing the ERP or the old POS reads may change shape.

## Hard constraint: the Firestore wire format does not change
v2 writes to the same `shareat-hub-v2` documents that v1's server analytics and the ERP day feed (T-375) read.
`packages/domain/src/pos/v1-methods.ts` refuses a day whose `byMethod` holds a non-centavo or negative value;
`v1-derive.ts` derives refunds as `X = Σ byMethod − totalSales`. Therefore:
- ✎R Row 67 (money as strings on the wire) governs v2's OWN wire; this is v1's Firestore wire, shared with live v1
  stores, so its types cannot move until P2.
- Amounts stay **peso numbers** on the wire. Every written amount is `centavos / 100` of an integer (× 100 is an
  integer). Field names, nesting and meanings are unchanged.
- New information is **additive** (`terminalNo`, `terminalSeq`, `deviceId`). No field changes meaning, except
  `receiptSeq`, which the glossary already says is not a monotonic key and nothing reads as one (research 16 Oct:
  only display, search, and `startsWith('RF-') || isRefund` in `receipt-view.tsx:58`).
- `analyticsApplied` / `analyticsReversed` keep v1's meanings (v1's reconcile cron depends on them).

## Facts verified (apps/pos at `648f1b5`)
- `lib/money.ts:16-21` `roundMoney` (float pesos) used once (`components/cashier/firestore.ts:691`); `lib/tax.ts:25-27`
  a private duplicate `round()`; `calculateBillTotals` (`tax.ts:37-`) returns floats, rounding only per stage; callers
  `firestore.ts:433`, `offlinePayment.ts:55`, `session-detail-view.tsx:30`, `bill-totals.tsx:7`.
- Cents already used locally at `firestore.ts:441,512-513,623-650`, `offlinePaymentSummary.ts:26-80`,
  `payment-modal.tsx:28-60,201-240`, `lib/cash/handover.ts:66-86` — each with its own conversion.
- Online number: store-wide `counters/receipts.seq` in `completePaymentFromUnits` (`firestore.ts:611-620`),
  `formatReceiptNumber` (`:110-117`), defaults `SELIP-######` vs `OR-######` (`receipt-settings.ts:49`) disagree.
  Offline number: `lib/offline/offlineReceiptNumber.ts`, localStorage `pos_offline_seq`, resets daily (`:88`).
  Device id: `lib/offline/device.ts:10-24` (localStorage `pos_device_id`, random UUID); `deviceReceiptTag` = 4 chars.
- `voidSession` (`firestore.ts:877-1001`): tickets read OUTSIDE the transaction (`:891`), table freed without reading it
  (`:960-976`), loyalty reversal returned to the caller after commit (can be lost).

## Rulings (planner)
1. **One money module.** `apps/pos/src/lib/money/centavos.ts`: ✎R TWO entry points by source:
   `storedPesosToCentavos(x)` for values read from Firestore (catalog prices, modifiers, fixed discounts/charges,
   receipts) rounds half-up and reports a non-centavo input to a counter/log (row 67's legacy-float rule) and NEVER
   throws, so one bad catalog value cannot stop checkout; `parsePesoInput(string)` for amounts a person types is exact
   or refused with a message. The read-only count of live non-centavo values is recorded under "Data found" below. `roundHalfUp` for
   rates, `allocate(total, weights)` largest-remainder (sums exactly), `toWirePesos(c) = c / 100`. `lib/money.ts` keeps
   only re-exports for old imports; the private `round()` in `tax.ts` is deleted. **Exactly one rounding
   implementation** (DEF-003).
2. **Bill math in exact integers, rounded only where v1 rounds.** ✎R `calculateBillTotals` keeps its signature but
   computes intermediates as scaled integers (centavos x 10,000; ✎R2 near-exact: dividing by 1.12 is the one place
   that scale is not exact, which is why the BigInt oracle, not this function, is the exact reference) and rounds half-up
   to centavos ONLY at v1's named stages (`tax.ts:129-131` grossSubtotal, lineDiscountsTotal, lineChargesTotal; the
   VAT split; totalDiscounts; grandTotal); percent charges on "total" use the UNROUNDED tax as v1 does
   (`tax.ts:203-207`). Per-line amounts needed elsewhere are allocated from the rounded totals afterwards
   (`allocate`). Returns peso numbers only via `toWirePesos`; `calculateBillTotalsCentavos` returns integers.
3. **Golden comparison with v1.** ✎R The generator must hit half-centavo edges (amounts and rates chosen so a stage
   lands on x.xx5), and every bill is also computed by an exact-rational oracle (BigInt fractions, same stages) so each
   difference is classified as v1 float error or not; the test reports how many bills differ per field.
   **`grandTotal` (what the customer pays) must equal v1's except for documented float-error classes; any class that
   changes `grandTotal` is listed for Ian's sign-off before merge.** A fast-check property (≥ 2,000 generated bills: VAT inclusive / exclusive / non-VAT,
   line discounts fixed and percent, bill discount incl. `vatExempt`, charges on subtotal and total, loyalty stacking,
   free and voided qty) compares the new function with v1's original (`git show e26d0c1:src/lib/tax.ts`, vendored
   read-only as a test fixture `apps/pos/src/lib/__fixtures__/tax-v1.ts`). Every difference must be ≤ 1 centavo per
   field; each class of difference is explained in this doc's "Golden findings" (to be filled by the builder). A
   difference > 1 centavo stops the lane.
4. **Terminal series.** Receipt number `<STORECODE>-<TT>-<NNNNNN>`. ✎R STORECODE = the store doc's `code`
   (`types.ts:1118`, free text) normalised to `A-Z0-9`; a claim is refused when it is empty. TT = two digits.
   NNNNNN is FIXED width 6 (lexical order = numeric order for Ruling 6's doc-id range query); at 999999 payment is
   refused with a plain message (54 years at 50 a day). Additive receipt fields `terminalNo`
   (number), `terminalSeq` (number), `deviceId` (string); `receiptSeq = terminalSeq`; `receiptNoFormatUsed: 'TERMINAL'`.
   The same series is used online and offline, and by refunds when T-424 lands (DEF-001, 002, 587).
5. **Counter in IndexedDB** (`apps/pos/src/lib/terminal/counter.ts`, native IndexedDB, no new dependency): object
   store `terminal` holding `{storeId, terminalNo, deviceId, nextSeq}`. `reserveNext()` increments and COMMITS the
   IndexedDB transaction before returning the number, and ✎R is called BEFORE (outside) the Firestore transaction
   callback, so a Firestore retry reuses the reserved number instead of burning a new one, so a crash can skip a number but never reuse one. localStorage
   is never used for the counter (row 276). The old `offlineReceiptNumber.ts` is deleted.
6. **Terminal claim** (`apps/pos/src/lib/terminal/claim.ts`, a section on `/settings`): picking a terminal number runs
   a Firestore transaction on `stores/{s}/terminals/{TT}` = `{deviceId, claimedAt, claimedByUid}`; refused when held
   by another `deviceId` ("Terminal 01 is already used by another tablet. Ask a manager to release it." — release is a
   manager action on the same page that clears the doc). ✎R After claiming, `nextSeq` = 1 + the highest seq found by a
   **document-id range query on `stores/{s}/receiptNumbers`** between `CODE-TT-000000` and `CODE-TT-999999`, ordered
   by id desc, limit 1 (no composite index needed; the test fake REFUSES any query shape that would need an undeclared
   composite index), so a reinstall cannot reuse a number. Before the first claim of a prefix, a range query on
   `receipts.receiptNumber` (single-field, auto-indexed) must find no receipt with that prefix lacking `terminalNo`
   (proves v1's free-text `receiptNoFormat` does not already use it). **Release** writes `releasedAt` and bumps
   `releaseEpoch`; the next claim starts at max + 1,000, so receipts a released tablet still holds offline cannot
   collide with the new holder's numbers; a tablet that comes back online and finds the terminal doc held by another
   `deviceId` stops taking payment and lists its unsynced receipts for a manager (PC-5 owns their upload).
   Without a claim, or with a missing counter, payment is refused with "Connect to the internet and set up this
   tablet's terminal number in Settings." (v1 refuses offline payment on a corrupt counter the same way.)
7. **Uniqueness backstop (online).** Inside the payment transaction, `tx.create` on
   `stores/{s}/receiptNumbers/{receiptNumber}` = `{receiptId, terminalNo, terminalSeq, createdAt}`; a collision aborts
   the payment with a plain error and does not advance anything else. Offline, the offline batch writes the same doc
   with `set`, which can silently overwrite; ✎R the release gap (Ruling 6) is what prevents a collision. Making
   `receiptNumbers` create-only in the Firestore rules is stronger, but rules deploy from v1's repo: an optional Ian
   step below, not a dependency.
8. **v1's counters stay v1's.** v2 never reads or writes `counters/receipts`. v1 stores and v1's online-order completion
   keep using it; their numbers have a different prefix, so the two cannot collide.
9. **Unpaid-session void (client half).** In `voidSession`: re-read each active ticket doc and the table inside the
   transaction (ticket ids from the pre-read query; a ticket that changed status is left alone); free the table only if
   `currentSessionId === sessionId`; enqueue the loyalty reversal through the existing deferred-effects queue
   (`lib/offline/` queue used by `replayDeferredEffects.ts`) ✎R BEFORE the commit; the replay first checks that the
   session really is `voided` and drops the item otherwise, so a crash before or after commit neither loses nor
   misapplies it. `offlineVoid.ts` unchanged (PC-5). Server gating of this action is T-424 S8.
10. **No live writes.** Tests use fakes and fixtures. No agent signs in or writes to `shareat-hub-v2`.

## Slices (tester paths and builder paths disjoint)
**T — tester first, red for the right reason.** `apps/pos/src/lib/money/centavos.test.ts`,
`apps/pos/src/lib/tax.golden.test.ts` (+ the vendored fixture `apps/pos/src/lib/__fixtures__/tax-v1.ts`, byte-identical
to v1 except its imports, listed in `V1-COPY.md`), `apps/pos/src/lib/terminal/counter.test.ts` (fake-indexeddb if it is
already in the lockfile, else an in-memory IDB shim written in the test), `apps/pos/src/lib/terminal/claim.test.ts`
(Firestore calls behind an injected port), `apps/pos/src/components/cashier/receipt-number.test.ts`,
`apps/pos/src/components/cashier/void-session.test.ts`, and `tests/unit/pos-v2-money-guards.test.ts` (tree guards).
**S1 — money core + bill math** (Rulings 1-3), ✎R including the private converters in `payment-modal.tsx`,
`lib/offline/offlinePaymentSummary.ts` and `lib/cash/handover.ts`, which move onto the module. **S2 — terminal series** (Rulings 4-8; `firestore.ts`
`completePaymentFromUnits`, `offlinePayment.ts`, `/settings` section, delete `offlineReceiptNumber.ts`).
**S3 — unpaid void** (Ruling 9).

## Acceptance (each names the mutant it kills)
1. `centavos.test.ts`: `storedPesosToCentavos(0.1+0.2)` = 30; ✎R2 `storedPesosToCentavos(1.005)` rounds to 101 and is
   counted; `parsePesoInput("1.005")` is refused; `allocate(100,[1,1,1])` sums
   to 100. Kills: float pass-through; lossy allocation.
2. Golden property: ≥ 2,000 bills, every field within 1 centavo of v1; every wire amount × 100 is an integer. Kills: a
   changed discount/VAT stage; float drift reaching the wire.
3. Guard: ✎R across ALL of `apps/pos/src`, money rounding (`Math.round(` on an amount, `toFixed(2)` parsed back)
   lives only in `lib/money/`; no `round(` function in `tax.ts`; listed exceptions carry a reason. Kills: the duplicate rounder surviving (DEF-003).
4. Guard: payment writers (`firestore.ts`, `offlinePayment.ts`, `payment-modal.tsx`, `offlinePaymentSummary.ts`,
   `handover.ts`) build amounts only via `toWirePesos`/the centavo
   functions (test greps for `/ 100` or `* 100` outside `lib/money/`, allowing a listed few with a reason). Kills: an
   ad-hoc conversion bypassing the module.
5. Receipt number: two payments on one tablet get seq n and n+1; a counter wiped then re-claimed resumes at max+1 of
   the receipts fake; the number format matches `^[A-Z0-9]+-\d{2}-\d{6,}$`; online and offline paths call the same
   `reserveNext()`. Kills: daily reset (DEF-587); reuse after reinstall; two series (DEF-002).
6. Collision: a second `create` of the same `receiptNumbers` doc aborts the payment and leaves the session unpaid.
   Kills: silent duplicate numbers.
7. Claim: a terminal held by another device is refused; release clears it. Kills: two tablets on one series.
8. No localStorage for the counter: guard that `apps/pos/src/lib/terminal/**` does not reference `localStorage`, and
   `offlineReceiptNumber.ts` no longer exists. Kills: row 276 regression.
9. Wire shape: a payment's receipt fixture has every v1 field with the same type as before plus the three additive
   fields; `analyticsApplied === false`; `analytics.mop` keyed by method name. Kills: a renamed or retyped field that
   would break v1 analytics or the ERP feed.
10. Void: a ticket served between pre-read and transaction is not cancelled; a table re-seated to another session is not
    freed; a loyalty reversal is queued before the function returns. Kills: the three race defects in Facts.
11. ✎R Stored values: a catalog price of 99.999 does not throw at checkout; it is rounded and counted. Typed
    `"12.345"` is refused with a message. Kills: one bad stored value stopping the till.
12. ✎R Index: the claim's max-seq query runs against a fake that refuses undeclared composite-index shapes. Kills: a
    query that passes in tests and fails live.
13. ✎R Release: after a release the next claim starts at max + 1,000; a released tablet back online refuses payment.
    Kills: number reuse from a released tablet's offline receipts.
14. `npm test -w @shareat/pos`, `npx tsc -p apps/pos/tsconfig.json --noEmit`, T-422 guards, `build` + `build:cap` all
    pass; root unit project still runs 0 files under `apps/pos`.

## Must NOT change
Firestore field names/types/meanings (beyond the additive fields and `receiptSeq`) · `counters/receipts` ·
`packages/**` · `apps/erp/**` · CI workflows · v1 (read-only) · live Firestore.

## Out of scope
Refund, tender correction, manager PIN, server routes, server-gated void (T-424) · offline outbox and the ₱50,000 warning
(PC-5) · SC/PWD (PC-6; volume UNKNOWN per PC-0 — Ian is asking the stores) · DEF-589 (v1's analytics builder; P2).

## Data found (read-only count before S1)
Read-only count, 16 Oct 2026, shareat-hub-v2, 4 real stores, 5,813 reads: **0 non-centavo values** in inventory prices and
costs (558 each), package prices (44/19/19), option-group price deltas (13), fixed discounts and charges, non-integer
percents (0), and 90 days of receipts (5,171: total, totalPaid, change, grandTotal; 5,346 mop values; 8,200 unit
prices; 265 modifier totals; 660 custom adjustments). Ruling 1's tolerant path is therefore a safety net, not a
known need.

## Optional Ian step
Make `receiptNumbers` create-only in the Firestore rules (deployed from v1's repo; needs Ian's exception like the DEF-651
fix). Not required: the release gap covers it.

## Golden findings
Filled 16 Oct 2026 by the builder. Run: `tax.golden.test.ts`, 2,500 generated bills (seed 423423), 244 of them with a stage exactly on a
half centavo. The new `calculateBillTotalsCentavos` uses exact fractions (BigInt) between v1's rounding stages, so it equals the
exact-rational oracle on **every field of every bill (0 differences)**. Every difference from v1 is therefore a v1 float error.

**One class only: "v1 float error at a half-centavo stage".** v1 rounds with `Math.round((x + EPSILON) * 100) / 100` on a float that
is a hair below or above the true x.xx5, so it sometimes rounds the wrong way; the new code rounds the true value half-up.
Bills that differ from v1, per field: grandTotal 37, taxableAmount 20, vatableSales 20, totalDiscounts 20, chargesTotal 13,
lineDiscountsTotal 13, vatExemptSales 7, taxTotal 5, loyaltyDiscountTotal 4, billDiscountTotal 3. subtotal never differs. Largest
difference from v1 on any field: 1 centavo, except one bill (below).

**Change to `grandTotal` vs v1 (FOR IAN'S SIGN-OFF):** 37 of 2,500 stress bills (1.5%; the generator is biased to half-centavo
edges, real bills hit them far less often) charge 1 centavo different from v1, always toward the exact answer. Example (VAT inclusive
10%, one line 70.75 x 12 with 1 voided, 30% line discount on 7 units): v1 charges 629.68, exact and new 629.67. Examples of the other
fields on the same kind of bill: lineDiscountsTotal v1 148.57, new 148.58 (same bill); taxTotal v1 184.28, new 184.27 (VAT inclusive
10%, two lines, 50% bill discount, two loyalty rewards); billDiscountTotal v1 2196.92, new 2196.93 (VAT-exempt 50% on three discounted
lines); chargesTotal v1 135.07, new 135.08 (7.5% VAT inclusive, 7.5% charge on subtotal after a 1,875.12 fixed bill discount).

**Spec ambiguity hit (planner ruling 1):** one bill (VAT inclusive 7.5%, percent charges of 7.5% and 10% on "total") has v1 itself 2
centavos off the exact answer (grandTotal v1 5467.91, exact and new 5467.89). It is judged against the oracle and listed here for
sign-off. No other field on any bill is more than 1 centavo from v1.

**Wire check:** every peso value on the wire times 100 is an integer (property test, 500 random bills; centavo and peso functions agree).

