# T-528 — POS v2 Payment: itemized bill, per-line discounts, senior/PWD, split tenders, receipt print

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Depends on:**
> - T-527: the table panel and its Pay button.
> - T-526: the shell, the offline actor and the drain.
> - T-530a: `enqueue` and `reserveTerminalSeq`.
> - T-528a and T-528b: the receipt text.
> - T-525: `/api/pos/events`.
> - T-524: `completeSale`, the discount functions and `priceSession`.
> - T-539 S2: real rates in the snapshot.
>
> **Migration:** none. **Risk:** high, because money is shown and sent. The builder and the auditor are Sonnet, and the
> auditor checks money and auth.
> **Design:** §5.4, §7, `payment.png` and `payment-offline.png`. **Bible:** rows 276, 437, 438, 439, 440.
> Use `impeccable` for every screen.

## Goal

The cashier taps **Pay** on a table and sees the itemized bill. The cashier can then:
- add a discount to a line (a preset, a custom amount, or senior/PWD for a named diner), or apply one preset to every
  line;
- take one or more tenders, such as GCash with its reference plus cash;
- see the balance go down and the change, which comes from cash only;
- confirm.

The sale goes into the outbox, the receipt prints, and the table closes. Online and offline use the same path. The
server recomputes the bill and records any difference (T-524). The device total is what the customer saw, and the
server's total is the truth.

**v1's goal (§1.2d):** a correct bill with any tender mix, change from cash only, and paper every time.

**v2 beats it:**
- the device computes the bill with the **same pure function** the server uses (`priceSession`), so the two agree by
  construction;
- tenders are keyed by id, never by name;
- the reference is printed on the receipt;
- a senior's 20% applies only to their own share (row 437).

## Out of scope

| Out | Why |
|---|---|
| Refunds, wrong-tender corrections, the Receipts tab | Online-only requests (A4), done in a later slice |
| Card payments | There is no card tender in release 1 (T-524 ruling 5) |
| Native Bluetooth printing | The APK shell is T-530/A8. T-528 builds the print adapter with a browser fallback |
| A whole-bill discount | Row 440: "apply to all lines" covers it |

## R1 — `priceSession` on the device

- `packages/domain/src/pos/price.ts` is pure: it imports only `@shareat/core/money`. Add a package subpath
  `"./pos/price": "./src/pos/price.ts"` to `packages/domain/package.json`, then import it in client code as
  `@shareat/domain/pos/price`. `client-bundle-boundary` walks a leaf's imports to prove it is DB-free. If that guard
  needs an allowlist entry, add it with the reason "pure pricing leaf, T-528".
- **Add the VAT breakdown** to `PricedSession` for the receipt (T-528b), as one more field:
  `vat: { vatableSales, vatExemptSales, vatAmount, vatRemovedForScPwd }`, each a `Money`. The rules:
  - **VAT-registered:**
    - `vatExemptSales` = Σ the VAT-exclusive base of every senior/PWD-covered share. That is coveredGross − vatRemoved.
    - `vatRemovedForScPwd` = Σ vatRemoved.
    - `vatAmount` = VAT inside the rest of the bill after discounts: `halfUp(restNet × vatBp, 10000 + vatBp)`, where
      `restNet` = total − Σ the senior/PWD lines' covered net.
    - `vatableSales` = restNet − vatAmount.
  - **Not VAT-registered:** every figure is `0.00` except `vatExemptSales`, which is Σ the senior/PWD covered gross (v1
    labels it "SC/PWD SALES").
  - The figures must satisfy `vatableSales + vatAmount + vatExemptSales + Σ(senior/PWD discountAmount excluding vatRemoved) = total`
    on a VAT org, exactly to the centavo. If one centavo is left over from rounding, put it in `vatableSales`, and add a
    one-line comment saying so.
  - Unit tests:
    - the T-524 spec figures (48.11 / 80.18 and 26.79 / 44.64);
    - the receipt-mock bill;
    - the identity above, over 1,000 seeded random bills with no failures;
    - the non-VAT case.
  - The server does not store these figures. They only print. The server recomputes its own on receipts later if BIR ever
    needs them.
- The snapshot's `store` gains `vatRegistered: boolean` (from `organizations.tax_type`), in T-525 `snapshot.ts` (the
  closed list in bible §5.3 already says "store POS settings"). The ETag changes when it changes.

## R2 — The payment panel (`app/pos/_payment/*`, opened from T-527's Pay)

**Left, the bill:** the exact `payment.png` layout.
- Each line shows: qty × name, `@ unit price`, gross; under it, each discount by name with `(qty)` and its negative
  amount; then the line's Net.
- Then Subtotal, Discounts, **Total**. The VAT block sits under the total in small type.
- The figures come from `priceSession` with:
  - the snapshot's rules (`vatPercentBasisPoints`, `scPwdPercentBasisPoints`) and `store.vatRegistered`;
  - the T-527 projected lines (server lines plus pending ones), with `unitPrice` from the line (server) or the snapshot
    (pending);
  - `bundleHeads` from the line;
  - the active discounts (server plus pending, minus pending removals).

**Discounts on a line:** tap a line to open a sheet with these choices:
- **Preset:** the snapshot `discountPresets`.
- **Custom:** % or ₱ per unit, on a keypad.
- **Senior** or **PWD:** diner number 1..heads.

Then a qty stepper, from 1 to the units still free on that line. The sheet enforces:
- the cap (T-524);
- no other discount on a senior unit;
- one senior head per diner on package lines;
- seniors ≤ billed heads.

Each rule shows the server's sentence, so the cashier sees the refusal before sending. A discount that breaks a rule
cannot be added.

Events:
- Adding a discount enqueues `discount.added {discountId, lineId, kind, presetId?, valueType?, value?, qty, dinerNo?, appliedAtDevice}`.
- Removing one enqueues `discount.removed {discountId, removedAtDevice}`.
- **Apply to all** (a preset) enqueues `discount.applied_to_all {sessionId, presetId, applyId, appliedAtDevice}`.

Any cashier may do this, with no PIN, and every change is audited (row 440).

**Senior/PWD diners:** each diner number used by a senior/PWD discount needs a **name** and an **ID number** before Pay.
These are the only typed fields besides amounts and references (row 371). A missing one blocks Pay with "Add the name and
ID for Senior #2."

**Right, payments (row 438):**
- The tender buttons come from the snapshot `tenders`.
- Tapping one adds a payment row with the **remaining balance pre-filled**, editable on a keypad.
- A `wallet` tender needs a **reference** (typed). Offline it shows the tag "to check".
- "Split: add another payment" adds the next row.
- Limits:
  - at most 20 rows;
  - the balance and change update live;
  - **change only from cash**: if the paid total is more than the bill, the excess must not exceed the cash rows'
    amount, otherwise Pay is disabled with "Only cash can give change.";
  - Pay is enabled only when paid ≥ total and every rule holds.

## R3 — Pay (one tap, local-first)

1. `terminalSeq = await reserveTerminalSeq()` and `receiptId = crypto.randomUUID()`.
2. Enqueue `sale.completed` with this payload:
   ```
   {sessionId, receiptId, terminalNo: snapshot.store.terminalNo, terminalSeq, issuedAtDevice, offline: !online,
    device: {subtotal, discountTotal, total, lines: [{lineId, net}]},
    payments: [{tenderId, amount, referenceNo?, toCheck}],
    seniors: [{dinerNo, kind, idNumber, holderName}]}
   ```
   - `toCheck` is true for a wallet row when offline.
   - The payload matches T-524's `completeSale` input, minus `storeId` and `pairingId`.
3. **Print** (R4) the receipt built from the same `priceSession` result:
   - receipt number `T<terminalNo>-<terminalSeq padded to 6>`;
   - `offline` set when offline;
   - the VAT block from R1;
   - the store header and footer from the snapshot's store settings when T-525 carries them, else the store name only
     (add `header`/`footer` to the snapshot later, with no hard-coded text).
4. Close the panel. The table leaves the grid on the next state poll. Until then, the T-527 reducer shows it as "Paid,
   sending".
5. Request a drain.

If `enqueue` fails, nothing prints, the panel stays open, and it shows "This tablet could not save the sale. Nothing was
charged. Try again." The reserved number is spent, and the gap is harmless (DEF-587: continuous per terminal, never
reused).

## R4 — The print adapter (`apps/erp/src/lib/pos-print/adapter.ts`)

- `printLines(lines: string[], opts: {copies: number}): Promise<'printed' | 'fallback' | 'failed'>`.
- When `window.ShareatPrinter` exists (the APK plugin, T-530), call it. Otherwise open a print-only view: a monospace
  `<pre>` sized by the layout's columns, then call `window.print()`, and return `'fallback'`.
- A failure shows "Receipt did not print. Tap Reprint." The sale is already saved; printing never blocks the sale.
- **Reprint last receipt** is a button on the Orders screen after a sale. It keeps the last printed lines in memory and
  prints them again with `reprint: true`.

## R5 — Tests (the tester writes them first; every ✅ needs its ✗)

- **Unit, price:**
  - the VAT breakdown, with every case in R1;
  - the subpath import resolves, and `client-bundle-boundary` stays green.
- **Unit, the payment logic** (pure helpers in `_payment/logic.ts`):
  - balance and change;
  - change only from cash: refused when wallet overpay exceeds cash;
  - the 20-tender cap;
  - a wallet with no reference → blocked;
  - offline wallet → `toCheck`;
  - the senior name and ID required per diner;
  - the discount sheet's rules each fire with the server's sentence (cap, a senior unit with no other discount, one
    senior head per diner, seniors ≤ heads);
  - the exact `sale.completed` payload for the `payment.png` bill: GCash ₱500 with a reference plus Cash ₱1,600,
    total 2,092.42, change 7.58;
  - the payload never carries `storeId` or `pairingId`;
  - an `enqueue` failure prints nothing.
- **Unit, the adapter:**
  - no plugin → fallback;
  - plugin present → called with the lines;
  - a plugin throw → `'failed'`, with the sale untouched.
- **Integration, end to end** through the real `/api/pos/events`: the same `payment.png` bill paid, then the server's
  receipt, payments, statutory row (one per senior diner) and recompute **match the device figures with no mismatch
  audit row**. That proves the two prices agree. A second test changes one device figure and expects a mismatch audit
  row, with the sale not refused.
- **Render (standing rule):** `payment.png` and `payment-offline.png` recreated at 1280×800 with real components and the
  same data, attached to the hand-back.

## R6 — Gates

Typecheck, the unit project, the integration files above, plus t524, t525 and `client-bundle-boundary`. Use the lane's
own `_test` DB, and never print `.env.local` values.
