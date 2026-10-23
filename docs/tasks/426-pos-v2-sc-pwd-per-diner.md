# T-426: POS v2 — senior and PWD discount per qualifying diner, with name and ID (P0, PC-6)

**Status:** S1-S4 local implementation checkpoint, 2026-10-21: 893 POS tests pass (one existing skip), typecheck, web build and Capacitor export pass; 100 affected root guards passed before final presentation/export corrections. Full exact-head CI, separate test Firebase backend and runtime/visual checks remain release gates.
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor (money lane).
**Migration:** none (no Postgres change; the ERP register and day-feed changes are named below for the orchestrator).
**Authority:** plan §6 PC-6 · ADR-015 L42 (P0 captures SC/PWD name + ID, row 218) and L194 (one price per head) · bible
rows 75, 132, 164, 218, 330, 343 · `docs/discovery/24-cash-custody-and-statutory-discounts.md` §4 ·
`docs/tasks/137-statutory-discount-logbook.md` §2 · discovery 39 flaws I, J, R · CAPABILITY-GAPS L244 ·
CAPABILITY-MATRIX `record_statutory_discount` (staff-open) · PC-0: 0 statutory discounts recorded in 91 days, **volume
UNKNOWN** (Ian is asking the stores; orchestrator 16 Oct) — the design must be cheap to use, not sized to the zero.
**Depends on:** T-423 (centavo bill math), T-425 (offline: the same computation runs offline).

## Goal, in plain words
When a senior citizen or a person with disability eats at a table, the cashier records their name and ID, and the 20%
discount and VAT exemption apply to that person's share of the bill only, not to the whole table. The receipt prints
their name, ID and a signature line. Today the discount covers the whole bill and nobody's name is kept.

## Facts verified (apps/pos at the T-424 merge)
- SC/PWD is a bill `Discount` with `vatExempt` (`types.ts:836-838`); no name, no ID, no diner. Applied from the "Bill
  Discount" popover (`bill-adjustments.tsx:228-233`, manager/platform-admin only, UI gate).
- `calculateBillTotalsCentavos` exempt branch (`tax.ts:148-155`) applies to the WHOLE `grossAfterLine` (flaw I): VAT
  removed from everything, 20% of the net, loyalty skipped, `taxTotal = 0`.
- `bill-totals.tsx:187-200` hides the VAT block when `taxTotal = 0`, so an exempt bill shows no VAT-exempt row (bug).
  `receiptFormatter.ts:76-80` prints no VAT split and no SC/PWD name or ID (flaw R).
- Package lines: per head `unitPrice = pricePerHead, qtyOrdered = guests` (`firestore.ts:253-255`); bundles one line at
  `bundlePrice` plus an extra-head line (`:142-153, 270`). `allocate()` exists (`lib/money/centavos.ts`).
- ERP: `statutory_discount_records` (migrations 0101/0102) allows ONE live row per invoice; the day feed hardcodes
  `seniorDiscount/pwdDiscount = ZERO` (`packages/domain/src/pos/v1-derive.ts:216-218`). Nothing reads `vatExemptSales`.

## Rulings (planner; ✎R = revised after the Opus spec review of 17 Oct and a law check)
**Law notes used (to confirm with Ian's accountant; see Open questions):** RA 9994 §9: a senior gets the
establishment's promo discount OR the 20%, **whichever is higher**, never both (DTI says this binds only for a promo with
a DTI permit; we apply it always, the stricter reading for the store, and flag it). DOJ Legal Opinion No. 45 (2024): the
PWD 20% on restaurant food applies only to food **exclusively consumed** by the PWD; a group meal is not discounted
unless that is shown. We use the same exclusive-consumption rule for seniors, so one rule covers both.
1. **Qualifying diners live on the session** as the additive field `statutoryDiners: [{id, kind: 'senior'|'pwd', name,
   idNo, idNoNormalized, addedByUid, addedAtClientMs, dishLineIds: []}]`. "Senior / PWD" button on the bill screen:
   kind, full name, ID number (OSCA or PWD ID), all required; one entry per person; a person who is both claims ONE 20%.
   ✎R The same normalised ID twice is refused; the same name twice warns. Any signed-in store staff may add an entry
   (`record_statutory_discount` is staff-open) and may remove one before payment; every add and remove is written to the
   activity log with who, when, kind and the masked ID. ✎R If the session has no head count (à la carte with null
   counts), the cashier must enter the number of diners first. Diners ≤ heads is checked on add AND again inside the
   payment (online transaction `firestore.ts:427`, offline `offlinePayment.ts:52`), since an approved guest-count change
   can lower heads later.
2. ✎R **Share rule = what the diner alone consumed** (law notes): (a) for a per-head package, ONE head of the package
   line (`pricePerHead`, after that line's own adjustments allocated per head); for a bundle, `bundlePrice ÷ covered
   heads` (allocated, exact centavos), ✎R2 a diner beyond the covered heads takes one unit of the extra-head line
   instead; (b) plus the à la carte lines the cashier assigns to that diner (`dishLineIds`;
   a line assigned to one diner only; a shared dish is not discounted). This sits behind one function
   `statutoryShares(bill, diners, heads)`, so if Ian chooses an equal share of shared dishes instead, only that function
   changes. The Open Questions page carries the choice. ✎R2 A diner whose share is 0 (à la carte session, no dish
   assigned) blocks payment with "Mark at least one dish for each senior/PWD diner, or remove them." An assigned line
   that is later voided or moved leaves the diner's list automatically, and the block applies again if nothing is left.
3. ✎R **Math, with named rounding stages** (integer centavos, exact fractions as in T-423):
   - Per diner: `share` (exact). VAT-inclusive store: `shareNet = share / (1 + rate)`; VAT-exclusive or non-VAT:
     `shareNet = share`. `statutoryBenefit = shareNet × 20% + (share − shareNet)`.
   - **Whichever is higher (✎R):** if a bill promo discount applies, compute `promoOnShare` = the promo applied to the
     share's gross (pro-rata for a fixed-amount promo); if `promoOnShare > statutoryBenefit`, the diner takes the promo
     (the share joins the remainder FOR THE DISCOUNT ONLY: ✎R2 its VAT exemption is kept either way, the safer reading
     for the customer, and Open question 3 asks to confirm; so the comparison is promo vs the 20% alone) and the receipt
     notes "promo was higher"; otherwise the share is statutory. A fixed-amount promo is compared pro-rata to the share,
     and ✎R2 when the diner takes the promo, only that pro-rata part applies to their share and the rest to the
     remainder (never the full amount twice). Line-level
     promos already inside `grossAfterLine` stay (more generous than the law requires; allowed; noted here).
   - Qualifying totals are computed EXACTLY over all statutory shares and rounded ONCE, half-up: `statutoryDiscount =
     round(Σ shareNet × 20%)`, `vatExemptSales = round(Σ shareNet − Σ shareNet × 20%)`, and ✎R2 `statutoryVatRemoved =
     Σ share − statutoryDiscount − vatExemptSales` computed from the ROUNDED figures, so the receipt always adds up. The per-diner figures for display are `allocate()`d from those totals (they add up).
   - The REMAINDER (`grossAfterLine − Σ statutory shares`) follows T-423's path unchanged (bill promo, loyalty, VAT split,
     its own rounding). ✎R Loyalty applies to the remainder only; if the remainder is 0, a loyalty redemption on the
     session is refused before payment ("Points cannot be used when every diner gets the senior/PWD discount") and any
     reserved redemption is released.
   - Charges: v1's bases (`netSales`, `totalBeforeCharges`) where `netSales = remainder net + vatExemptSales`; whether a
     service charge may be levied on a senior/PWD share is an OPEN law question (Open questions); until answered the
     charge is computed as v1 does over the combined amount.
   - With no qualifying diners the function returns exactly T-423's result.
   - ✎R Result type gains `statutoryDiscountTotal`, `statutoryVatRemovedTotal`, `statutoryDiners: [{kind, share,
     discount, vatRemoved, vatExempt}]`; `billDiscountTotal` EXCLUDES the statutory discount; `totalDiscounts` includes
     it; `analytics.discountsTotal` includes the statutory discount (not the VAT removed).
   - ✎R All four callers pass the diners: `bill-totals.tsx:38`, `session-detail-view.tsx:263`, `firestore.ts:427`,
     `offlinePayment.ts:52` (screen total = charged total).
4. ✎R **Close the old whole-bill path:** the Bill Discount popover hides any preset that is `vatExempt` OR whose name
   matches `/senior|\bsc\b|pwd|osca/i` (Malvar's non-exempt "PWDDiscount" was used in the PC-0 window), and a custom
   discount with such a name is refused with "Use the Senior / PWD button so the name and ID are recorded." The
   `vatExempt` branch stays in `tax.ts` only for reprinting old v1 receipts.
5. **Wire (additive only, T-423 hard constraint):** the receipt gets `statutoryDiners: [{kind, name, idNo, share,
   discount, vatRemoved, vatExempt, promoWasHigher}]` (peso numbers, exact centavos); `billDiscount` keeps v1's meaning;
   `vatableSales`, `vatExemptSales`, `taxAmount` carry the mixed split. Refunds (T-424 `refundShare`) unchanged.
6. **Screens and print:** the bill lists each diner (kind, name, masked ID `****1187`, discount); the VAT block shows
   whenever `taxTotal > 0 OR vatExemptSales > 0` (fixes the hidden-row bug); the payment screen shows the same lines.
   The printed receipt adds a VAT block, ✎R a line "Less: VAT exemption (SC/PWD)" so the receipt adds up
   (gross − promo − SC/PWD discount − VAT exemption + charges = amount due), ✎R the label "SC/PWD sales" instead of
   "VAT-exempt" on a non-VAT store, and per diner: kind, name, full ID, discount and "Signature: ________".
7. **Offline:** unchanged pure computation (T-425 carries the fields).
8. **OCR** of the ID card is later (row 330).
9. **Not in this task (for the orchestrator):** (a) the ERP register allows one live row per invoice; a table with two
   seniors cannot be registered (ERP schema change); (b) `v1-derive.ts` hardcodes senior/PWD to 0 and its
   `total = P + D + refunds − C` will understate gross by the VAT exemption: the T-375 feed must read `statutoryDiners`
   and `statutoryVatRemoved`; (c) register rows from POS wait for P2; (d) CUSTOMER v1's running bill
   (`session-orders/route.ts:77`) ignores `statutoryDiners`, so the diner's phone may show a higher bill (note in
   CROSS-APP-MAP; the pilot store runs only v2 on its one tablet).
10. ✎R **Privacy (RA 10173; PWD status is sensitive personal information):** the full ID is stored only where the law's
    per-transaction record needs it (session while open, receipt); screens show it masked; the ledger copy (T-425)
    follows its 7-day pruning; ✎R2 at bill-out the closed session and its `closedSessions` copy keep only the masked
    ID (the receipt holds the full one); `pos2-audit.mjs --statutory-logbook` prints a header "Contains personal data. Management
    record, not a BIR document (row 75)." and lists each qualifying diner with name, ID, kind, share, discount, VAT
    exemption, date, receipt number, and ✎R a flag when the receipt was later refunded. Retention follows the receipts;
    a shorter period is Ian's question.

## Slices
### S1 implementation scope clarification, 20 October
Existing shares/capture/bill-math controls currently report 64 failures and 3 passes.
Keep line adjustment math in one place: extract the existing exact line stages from tax.ts
unchanged into `src/lib/money/line-amounts.ts`, consumed by both tax and statutory shares.
Supporting scope includes types.ts, statutory/shares.ts and capture.ts. No test oracle is
imported into production. Frozen T-423 parity remains the control for existing bill behavior;
receipt/caller/UI/export slices still have to land before this branch can pass full CI.
The ordinary promo/loyalty/VAT stages are also shared via `src/lib/money/ordinary-bill.ts`;
mixed statutory totals live in `src/lib/statutory/totals.ts`. No production test-helper imports.
DEF-713 reports two spec/test rounding gaps found after the existing 84 checks passed:
six one-cent qualifying shares can allocate both a discount and VAT cent to the same diner,
making their exempt amount negative; a one-cent fixed promo split over two one-cent shares
can invent negative VAT at a non-VAT store. New independent boundary tests failed first.
Explicit correction: cap each VAT allocation at that diner's share after discount and
redistribute the excess with the existing allocator. For promo winners, quantize their
aggregate promo discount before deriving the remaining payable VAT split; keep fixed promo
parts within its one centavo budget. Preserve ordinary remainder and all-statutory rounding.
A third red control uses two separate P449.95 dishes, each with its own 10% discount:
rounding each line's share independently exceeds the bill's 809.91 budget by a centavo and
refuses an otherwise valid all-qualifying bill. Allocate the one rounded bill line budget
over exact line-net weights before splitting package heads or assigning dishes. Supporting
scope adds allocateExact in money/centavos.ts; the existing numeric allocator delegates to
the same algorithm while preserving its six-decimal weight contract. No float weights.
DEF-714 extends payment blockers with invalid-diner and duplicate-id: stored session data
must revalidate kind/name/actual ID and dish-list shape before any payment writes. Do not
trust stored idNoNormalized to prove a different person. Five independent forged/incomplete
entry tests failed first; required entry fields cannot be enforced only by the add form.
Local checkpoint: the three original files moved from 64 failures/3 passes to green;
113 selected math/capture/money checks and POS typecheck pass. Eight independent audit
controls were red first (three rounding, five validation); another three small-value sweep
checks cover 4,860 bills. Capture UI, payment/receipt/caller/print/logbook wiring and runtime
remain unfinished. No baseline regeneration may disguise those missing production callers.
A further red regression control preserves normalization of stored numeric percentage
strings before Exact consumes the rate; it is not a claim that live rates are malformed.
Final checkpoint checks: 132 selected math/capture/money/refund tests, POS typecheck and
normal/cap builds pass. Cap restored all 34 moved files byte-for-byte, no stash remains.
S2 supporting files include statutory/session.ts, payment.ts and its tests, plus the capture
panel and preview artifact. Desktop: compact kind/name/ID row and diner table left, bill
effect preview right. Tablet: retain the diner table with 44px controls (Ian, 2026-10-20).
Tables become cards only below 768px; 768px and above retains tables, with local scrolling when needed. Phone: stacked form and
diner cards with sticky Add action. Loading, empty, error, focus/hover and locked states
must be explicit; no full ID in saved lists. Preview is synthetic, not a runtime smoke.
Online all-qualifying bills reverse existing points through the same authenticated DELETE
endpoint the current reward card uses, then refuse payment for review. Offline refuses
without a server call and requires reconnecting to release points before payment; no new
offline effect queue is invented. Unknown release responses never claim points were released.
S3 supporting scope explicitly includes `src/app/receipt/page.tsx` and
`src/app/receipts/page.tsx`: both real receipt-data factories must forward statutoryDiners
to preview and print. Formatter tests alone could pass on synthetic data while both real
pages drop the full identity records. Two new source-wiring controls were red first (DEF-715).
Capture supporting scope includes statutory/mutations.ts and tests, StatutoryDinersPanel,
types.ts activity tags and lib/logs/describe-log.ts labels. Session change and both existing
masked activity logs commit in one transaction; current bill status and assigned lines are
read again. Capture retains the existing online billing-edit requirement; already captured
qualifiers apply to offline payment. Pruning uses current line data. Two repair controls
were red before allowing excess/duplicate records to be removed one at a time; payment
validation remains strict. The 155dd37 post-commit run passed 132 affected checks and 91
guards; the one red census gate named eight then-unwired S2 helpers. Baseline unchanged.
S3 privacy correction, 21 October: Ruling 10 requires masked IDs on screens, but the S3 receipt
test's prose demanded a full ID in the on-screen preview. Keep full receipt identity data and
thermal/printed IDs, but render the preview ID through the existing mask helper and expose the
full value only under print media. The new rendered regression fails before this correction;
existing thermal receipt full-ID/signature assertions remain unchanged (DEF-719).
Final audit: the new panel's payable total must wrap rather than ellipsize (DEF-720). S4's
management CSV must encode formula-like text as literal spreadsheet text (DEF-721), preserving
raw receipt records and all numeric columns. These are presentation/export corrections within
the existing panel, wiring test, logbook helper and logbook test scope; both controls fail first.
CSV mitigation follows [OWASP's spreadsheet-viewing guidance](https://community.owasp.org/attacks/CSV_Injection):
quote and tab-prefix dangerous text, including full-width variants. This is a management viewing
export, not a lossless reimport format; raw receipt records and money columns are untouched.

**T** tester: `statutoryShares` and the bill math (golden: no diners = T-423 result exactly; with diners vs a
BigInt-fraction oracle; VAT incl / excl / non-VAT; 1 of 4, 2 of 4, all diners; bundle; à la carte; promo + loyalty on
the remainder only); capture rules (required fields, count ≤ heads, one entry per person); the hidden popover presets;
receipt wire fields; formatter VAT block and signature lines; BillTotals VAT row; offline path computes the same; the
logbook export. **S1** math. **S2** capture UI + session field. **S3** receipt wire + print + screens. **S4** logbook export.

## Acceptance (each names the mutant it kills)
1. ✎R Worked case, VAT-inclusive 12%, per-head package ₱449 × 4 heads plus shared à la carte ₱318 (subtotal ₱2,114.00),
   1 senior, no dishes assigned: share = one head = ₱449.00; shareNet = 400.892857…; statutory discount = round(80.178571…)
   = ₱80.18; VAT removed = round(48.107142…) = ₱48.11; VAT-exempt sales = round(320.714285…) = ₱320.71; remainder
   ₱1,665.00 -> VATable round(1,486.607142…) = ₱1,486.61, VAT round(178.392857…) = ₱178.39 (T-423 rounds each on its own);
   amount due = remainder 1,665.00 + exempt 320.714285… rounded once = ₱1,985.71. The tester recomputes these with the
   BigInt oracle and the spec's numbers must match it exactly. Kills: whole-bill exemption (flaw I); unnamed rounding.
2. No qualifying diners -> every field equals T-423's `calculateBillTotalsCentavos` on ≥ 2,000 generated bills.
3. ✎R Whichever is higher: a 10% bill promo -> the senior share takes the statutory benefit, the promo hits the remainder
   only; a 50% bill promo -> the senior share takes the promo, `promoWasHigher: true`, no statutory discount on that
   share. Kills: stacking, and denying a bigger promo.
4. ✎R All diners qualifying, every dish assigned -> remainder 0, VATable 0, and the statutory totals equal the old
   whole-bill branch's totals EXACTLY (one rounding over the exact sum). Kills: per-diner rounding drift.
5. ✎R2 A diner with a zero share blocks payment with the sentence; voiding their only assigned dish brings the block
   back. Capture: missing name or ID refused; diners > heads refused at add and at payment (after a guest-count drop); the same
   normalised ID twice refused; à la carte with no head count requires one first. Kills: padded or unrecorded discounts.
6. ✎R The popover lists no `vatExempt` preset and no preset named like senior/SC/PWD/OSCA; a custom "PWD" discount is
   refused with the sentence. Kills: the whole-bill path reachable in v2.
7. Receipt doc has `statutoryDiners` with exact-centavo peso amounts and v1 fields unchanged; printed text has the VAT
   block, "Less: VAT exemption (SC/PWD)", each diner's name, full ID, discount and a signature line, and adds up to the
   amount due ✎R2 on every generated bill (property test: share = discount + VAT removed + exempt sales, exactly).
   Kills: flaws J and R; a receipt that does not add up.
8. BillTotals shows the VAT-exempt row when `taxTotal = 0` and `vatExemptSales > 0`.
9. ✎R Screen total = charged total: for the same session, `bill-totals`, `session-detail-view`, the online payment and the
   offline payment all produce the same amount due with diners. Kills: a caller that forgets the diners.
10. ✎R Loyalty with every diner qualifying is refused before payment and the redemption released. Kills: lost points.
11. Logbook export: one row per qualifying diner with the listed fields, the personal-data header, and a refunded flag.
12. `npm test -w @shareat/pos`, pos tsc, all pos-v2 guards, `build` + `build:cap` green; no test requires a lane DB name.

## Must NOT change
Firestore field meanings (additive only) · `packages/**` · `apps/erp/**` · v1 · live `shareat-hub-v2`.

## Open questions for Ian (Open Questions page)
1. ✎R **Shared dishes:** the law note (DOJ Opinion 45, 2024) says the PWD discount covers only food the PWD alone ate.
   Recommended (built): the diner's own package head plus dishes the cashier marks as theirs; shared dishes are not
   discounted. Other way: an equal share of shared dishes (more generous; may not match the DOJ reading).
2. ✎R **Service charge on a senior/PWD share:** may the store charge it on that share? Until answered, charged as today.
3. ✎R **Promo vs 20%:** we always give the higher of the two (stricter than DTI's permit-only reading), ✎R2 and keep
   the VAT exemption on the diner's share even when the promo wins. Confirm both.
4. ✎R **How long to keep the ID numbers** (default: as long as the receipts).
