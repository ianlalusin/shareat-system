# T-379: small ERP follow-ups — DEF-575, DEF-592 (+DEF-564 trade half), DEF-568, DEF-569, DEF-570

**Status:** SPEC 2026-10-07 (Opus planner). Written at HEAD `93222bc`. Not yet reviewed.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** none. If one turns out to be needed, STOP and report: it is a spec defect. Do not number one.
**Money:** S3 changes a cost basis (DEF-569, see R6), so S3 gets an **independent Opus review** before it is
built. S1 and S2 post nothing new and change no amount.
✎S3-AMEND 2026-10-07: the review (✎REV) found DEF-601/602 in the landed-cost SQL. S3 is split. **S3a** fixes
them in `packages/db/src/repo/items.ts`, ships first, and gets a second Opus review of its diff (R9). **S3b** is
the screen (DEF-568/569) and ships after S3a.
**Fenced off:** `packages/domain/src/pos/`, `scripts/`, `packages/db/migrations/` (T-375 S0 and T-380 are live there).

## Goal
- A refusal on the transit-shortfall screen (closed month, or anything thrown) is a sentence on the page, never a
  digest (DEF-575).
- Recording a customer return says what happened; a refusal is a banner, never a digest (DEF-592, and the trade
  half of DEF-564, which is the same lines).
- The remittance page stops running the whole findings feed to keep three cash kinds (DEF-570).
- Invoice refusal sentences print pesos the way the page does: ₱1,000.00 (DEF-568).
- The bills screen can record the supplier's delivery fee and other fees, which T-151 already folds into landed
  cost, and the bill page says what the lines must add up to (DEF-569).

## research-evaluate-propose (row 283), in brief
- **Verdict:** build all five, small. Drop DEF-571 (already fixed) and DEF-572 (does not reproduce; census).
- **v1 owns the goal.** DEF-575/592: v1's goal is "the manager reads why"; v2 already has the method (the
  `?error=`/`?ok=` banner of T-369 S4 / T-376 S2), so this is wiring, not design. DEF-569: v1 has **no** fee
  field on a supplier bill (`ERP-rebuild` greps `deliveryFee`/`otherFees` only on branch orders:
  `src/types/index.ts:1798-1799`, `commissary/order-helpers.ts`). The goal is Ian's T-151 rule (*"delivery fee
  from supplier to Lipa is added to price"*, `docs/tasks/151-landed-cost-and-branch-price.md:14`). The domain
  and the landed-cost query were built for it. Only the screen was never built, so v2 cannot reach its own rule.
- **Open source:** nothing to adopt. These are wiring and formatting fixes inside existing patterns.
- **Effort against use:** each slice is one or two files plus tests. Not reachable from here: how many live
  supplier bills carry freight (v1 has no field, so none are counted); how often today's month is closed when a
  shortfall is resolved (rare: the form posts today's date). Both are flagged, not invented.

## Census, verified at source (corrections to the register marked ✎)

### DEF-575 — still open
- `resolveDiscrepancyAction` (`apps/erp/src/app/commissary/discrepancies/actions.ts:30-62`) has no try/catch
  around `withOrgPrincipal` (`:36-54`). `deferDiscrepancyAction` next to it has one (`:69-85`).
- `resolveDiscrepancy` (`packages/domain/src/commissary/discrepancy.ts:97`) reaches `postEntry` for loss/charge
  at `:176` with `entryDate: input.resolvedOn`, and `postEntry` throws a plain `Error` carrying the period id for a
  closed or locked period (`packages/domain/src/ledger/post-entry.ts:182-201`).
- ✎ extra_dispatch: `resolveAsExtraDispatch` writes first. `consume()` at `:291-296` and the branch movement after
  it come before its `postEntry` (`:334`). In a closed month the stock trigger (0145) throws at `consume`, and the
  transaction rolls back. Same digest, different raw text.
- audit, late_receipt and return post nothing (`:149-165`). They are not affected.
- The form posts `resolvedOn` = today as a hidden field (`page.tsx:63`, `:170`, `:280`). So the case is "today's
  month is closed", or a stale or forged form.
- ✎ Second leak, same action: `back(storeId, result.reason)` (`:59`) puts raw reasons into the URL, and several
  carry a uuid (`discrepancy.ts:102`, `:124`, `:173`).
- Precedent for the fix: `approveExpense` reads the period and says it in words, before `postEntry`
  (`packages/domain/src/expenses/approve.ts:248-264`). `stock/period-guard.ts:1-12` states why this is a sentence
  and not a second enforcement: the trigger and `postEntry` still refuse.

### DEF-592 — still open; ✎ it is also DEF-564's trade half
- `recordReturnAction` (`apps/erp/src/app/trade/returns/actions.ts:27-51`) returns normally on success, so there
  is no banner. It does `throw new Error(result.reason)` on refusal (`:48`), which is a digest in production.
- `applyCreditAction` (`:75-92`) has the same two faults (`:89`). ✎ No form calls it (grep: only
  `apps/erp/tests/t374-s2-posted-dates.test.ts:56`). It is fixed anyway: same file, same lines, DEF-564.
- `voidReturnAction` (`:53-73`) already has the target shape. The page already renders `sp.error`/`sp.ok`
  (`page.tsx:130-138`).
- ✎ The record form has no hidden `store` input (`page.tsx:201-228`). A redirect would drop the chosen store.
- ✎ DEF-564's inventory half is already fixed by T-376 S2 `13d61fb` (`inventory/returns/actions.ts`, both actions
  now redirect). The register row still says open. The orchestrator corrects it at wrap-up.
- `recordCustomerReturn` returns `settlement` ∈ `cash_refund | reduce_ar | store_credit | mixed |
  reverse_transfer` (`packages/domain/src/trade/returns.ts:321`, `:346`, `:387`, `:504`).

### DEF-570 — still open
- `cashCustodyFindings` (`apps/erp/src/app/remittance/lib.ts:155-163`) calls the whole `listFindings`
  (`packages/domain/src/findings/index.ts:144-274`): ~45 detectors. Then it keeps 3 kinds (`lib.ts:142-146`).
- ✎ The register names one of these costs, `postedDepreciationPeriodsByAsset` (`packages/db/src/repo/fixed-assets.ts:506-529`,
  no period filter, reached through `periodicPostingsStillMissing` → `subjectsOwingWithoutEntry`,
  `missed-months/index.ts:272`). That is one of ~45 reads that this page pays for and throws away.
- The three detectors are plain repo calls (`findingsRepo.unremittedCeilingBreached`, `remittanceOverdue`,
  `serviceChargeFloatAgeing`; `index.ts:164-166`). Acknowledgement decoration is `:251-273`.

### DEF-568 — still open
- `pesos()` (`packages/domain/src/items/index.ts:217-220`) prints `1000.00`, with no grouping.
- The two refusals print four figures: `pesos(computed)`, raw `l.unitPrice`, raw `l.lineTotal` (`:402-405`);
  `pesos(sum)`, raw `invoiceTotal` (`:429-432`). The page prints `peso()` = `₱1,000.00`
  (`apps/erp/src/lib/format.ts:22`).
- `pesos` takes bigint centavos on purpose: a mismatch may sit outside `numeric(14,2)` (`:215-216`), so
  `formatMoney`/`Number` is not a drop-in.
- Pinned by: `packages/domain/tests/integration/items.test.ts:256` (`₱2900.00`, `₱5000.00`).
  `t367-s3-invoice-total-due-date.test.ts:144`, `:156`, `:177`, `:197`, `:293` use figures under 1,000, so they are
  unchanged.

### DEF-569 — still open
- `recordInvoice` accepts and validates `deliveryFee`/`otherFees` (`packages/domain/src/ap/index.ts:387-388`,
  `:441-457`). The lines are checked against goods = total − fees (`:455`, `:608-612`).
- `recordInvoiceAction` sends neither (`apps/erp/src/app/ap/actions.ts:176-185`). The form has no input for them
  (`apps/erp/src/app/ap/page.tsx:138-180`).
- The bill page tells the person *"Lines must add up to {total}"* (`apps/erp/src/app/ap/invoices/[id]/page.tsx:192-195`).
  That is wrong as soon as a fee exists.
- The fee feeds `landed_base_price` (`packages/db/src/repo/items.ts:250-262`) and `lastTwoLandedMax` (`:989-1005`).
  That is the branch-price basis T-151 defaults internal trade-order rates from. **This is why S3 is money (R6).**
- No ledger posting reads the fee: the bill's payable is `total_amount` either way.
- There is no header edit path for a pending bill (`ap/index.ts` exports no update of total/fees). A wrong fee is
  corrected the way a wrong total is today: void and re-log while pending. This task does not change that.

### Dropped
- **DEF-571 — already fixed** (register row: T-369 S8 commit, `recurring-expenses/job.ts` passes `dueDate`).
- **DEF-572 — does not reproduce.** The trial-balance picker is `reportScope` (`apps/erp/src/app/reports/lib.ts:73-135`).
  It lists the active stores the person holds `person_store_scope` at, or all active stores when they hold every
  one (`:112-124`). `authorize` gates `transfer_funds` (store-scoped, `packages/auth/src/capabilities.ts:409`) on
  that same table (`packages/auth/src/authorize.ts:198`). So "may pay from SMK2" and "SMK2 not offered" cannot both
  hold for one principal. On the smoke DB `shareat_test_setup`, SmokeAdmin (`01a0bfb2-04d6…`) holds scope at SMK
  (manual, 2026-09-20) and SMK2 (fan_out, 2026-09-25). SMOKE_ORG has exactly those two active stores. So by code
  and fixture, the picker offers both and "All stores". The likely cause is a session minted for another of the
  org's admins (e.g. `01a0e7f9…`, scope at SMK only). That person could not pay from SMK2 either. **The orchestrator
  closes it as not reproduced.** No slice.

## Rulings (planner)
- **R1 (DEF-575). Say it in the domain, before the first write. Also catch in the action.**
  - In `resolveDiscrepancy`, for the three dispositions that write to the ledger or stock (`loss`, `charge`,
    `extra_dispatch`), read `journalRepo.findPeriodForDate(tx, orgId, resolvedOn)`. Do it after every existing
    gate (terminality, direction, charge-person) and before the `value` check / `resolveAsExtraDispatch` call. If
    the period is `closed` or `locked`, return `{ ok: false, reason, userReason }` with:
    *"{Month} is {closed|locked}, so this can't be booked on {humanDate}. Nothing was saved."*
  - If no period covers the date, change nothing: `postEntry`'s own error stands, and the action's catch turns
    it into a sanitised sentence.
  - This is a sentence, not the enforcement (the `period-guard.ts` I3 rule). `postEntry` and the 0145 trigger still
    refuse if this check is deleted. No override: the screen offers none, and stock never takes one.
  - `audit`/`late_receipt`/`return` are not checked. They write no entry and no movement, so a closed month does
    not concern them.
  - `monthLabel`: copy the three-line helper locally, as `approve.ts:46`, `reimbursement.ts:29` and
    `period-guard.ts:18` each do. Consolidating the four copies is N1, out of scope (it would touch three
    unrelated files).
  - The action: wrap `withOrgPrincipal` in try/catch → `back(storeId, errorMessage(err))`. The refusal arm uses
    `back(storeId, outcomeMessage(result))` (`apps/erp/src/lib/constraint-messages.ts:367`), so a reason with a
    uuid is redacted. `redirect` stays outside the try, as in `deferDiscrepancyAction`.
- **R2 (DEF-592 + DEF-564 trade half). Copy `voidReturnAction`'s shape exactly.** Both `recordReturnAction` and
  `applyCreditAction`: thrown → `?error=errorMessage(err)`; `{ok:false}` → `?error=errorMessage(new Error(reason))`;
  success → `revalidatePath('/trade/returns')` then `?ok=…`. Keep `store` when the form sent one.
  - The success sentence is fixed text chosen by `settlement`, and never carries an amount or a typed reason
    (DEF-476 / T-380 territory):
    - `cash_refund`: *"Return recorded. The refund was paid out."*
    - `reduce_ar`: *"Return recorded. It comes off what the customer owes."*
    - `store_credit`: *"Return recorded. The customer has it as store credit."*
    - `mixed`: *"Return recorded. Part comes off what the customer owes; the rest is store credit."*
    - `reverse_transfer`: *"Return recorded. The transfer to the branch is reversed."*
    - `applyCreditAction`: *"Credit applied to the order."*
  - The record form gains `<input type="hidden" name="store" value={storeId} />`.
- **R3 (DEF-570). A cash-only entry point in the domain, sharing the decoration.**
  - In `findings/index.ts`, extract `:251-273` (acks + decoration + counts) into a private
    `decorate(tx, orgId, detected)`. `listFindings` calls it, with output byte-identical.
  - Add `export async function listCashCustodyFindings(tx, orgId): Promise<FindingsFeed>`. It runs only the three
    cash detectors, in the same order as `listFindings`, then `decorate`.
  - `cashCustodyFindings` calls it, keeps the store filter (`f.storeId === null || f.storeId === storeId`), and
    drops `period` and `CASH_CUSTODY_KINDS`. The set stays defined once, in the domain.
  - ✎ The register's other suggestion (a period filter on `postedDepreciationPeriodsByAsset`) is NOT taken. The
    `/findings` page and the close check are full feeds by design. `missedMonths` needs the whole history. A
    `LIKE` on the idempotency key still scans the org's depreciation rows. Revisit only if `/findings` itself is
    measured slow (N2).
- **R4 (DEF-568). Group thousands in `pesos`, and print every figure through it.**
  - `pesos(centavos: bigint)` inserts `,` every three integer digits (bigint-safe, sign kept): `1000.00` →
    `1,000.00`.
  - In both sentences (raw and user), print `₱${pesos(toCentavos(lineTotal))}` (the parsed Money, not the box
    text) and `₱${pesos(invoiceCentavos)}`. The unit price keeps its typed decimals (up to four,
    `t367-s3:177` pins `₱33.3333`, `:197` pins `₱0.0050`). Group only its integer part: a local
    `groupInt(text)`, used by `pesos` too, so there is one grouping rule.
  - Not `formatMoney`: it goes through `Number` and caps at 2 decimals.
- **R5 (DEF-569). Two optional inputs on the log-a-bill form; show the split on the bill page.**
  - `/ap` form, after "Total": **Delivery fee** and **Other fees**, optional, `inputMode="decimal"`,
    placeholder `0.00`. Help line: *"Part of the total above. The supplier's delivery fee is added to the items'
    cost; it is not a line."*
  - `recordInvoiceAction`: `deliveryFee: str(fd,'deliveryFee') || null`, `otherFees: str(fd,'otherFees') || null`.
    Every check is the domain's (`feeOf`, `feesTooBig`); the action re-implements none.
  - `/ap/invoices/[id]`: when either fee is non-zero, the itemise note reads *"Lines must add up to
    {peso(goods)} — the {peso(total)} total less a {peso(deliveryFee)} delivery fee and {peso(otherFees)} other
    fees."* (drop a zero fee's clause). With no fee, today's sentence stays. Goods is computed with
    `subtract` from `@shareat/core/money`, as `ap/index.ts:608-612` does, never `Number`.
  - No fee edit on the bill page (no domain path exists). Out of scope, N3.
- **R6. S3 is money.** A fee raises `landed_base_price` and so the branch-price basis that defaults internal
  trade-order rates (T-151 invariants 1 and 3). Those rates post. No posting code changes, but the same invoice
  now yields a different cost. So S3 is reviewed by an independent Opus pass before the builder starts. The
  review checks R5 against T-151 §1 and §5 (inbound fee into cost, allocated by value) and confirms that no
  expense/AP posting reads the fee.

## Parallel plan
| Slice | DEF | Files (BUILDER) | Shared state | Parallel-safe with |
|---|---|---|---|---|
| S1 | 575, 570 | `packages/domain/src/commissary/discrepancy.ts` (`resolveDiscrepancy` only), `apps/erp/src/app/commissary/discrepancies/actions.ts` (`resolveDiscrepancyAction` only), `packages/domain/src/findings/index.ts` (`listFindings` refactor + `listCashCustodyFindings`), `apps/erp/src/app/remittance/lib.ts` (`cashCustodyFindings` only) | lane DB | S2, S3 |
| S2 | 592 (+564 trade) | `apps/erp/src/app/trade/returns/actions.ts` (`recordReturnAction`, `applyCreditAction`), `apps/erp/src/app/trade/returns/page.tsx` (the hidden `store` input only) | none (unit) | S1, S3 |
| ✎S3-AMEND S3a | 601, 602 | `packages/db/src/repo/items.ts` (`priceHistory`, `lastTwoLandedMax` only) | lane DB | S1, S2, S3b (build); ships before S3b |
| ✎S3-AMEND S3b | 568, 569 | `packages/domain/src/items/index.ts` (`pesos`, the two `validateInvoiceLines` sentences only), `apps/erp/src/app/ap/actions.ts` (`recordInvoiceAction` only), `apps/erp/src/app/ap/page.tsx` (the log-a-bill form only), `apps/erp/src/app/ap/invoices/[id]/page.tsx` (the header fee rows and the itemise note only) | lane DB | S1, S2, S3a (build); ships after S3a |

No two slices share a file, a test file or a lane DB. None touches a migration, `classification.ts`, the RLS
registry, `POSTING-PATTERNS.md`, `pos/`, or `scripts/`.
⚠️ **T-380 (DEF-476) is being specced on the banner transport itself.** If it moves `?ok=`/`?error=` off the URL
across the app, it will touch `discrepancies/actions.ts` and `trade/returns/actions.ts`. Land S1 and S2 first, or
have T-380 list them. This spec adds no amount and no typed text to a URL (R2).

## Invariants
- I1. No new capability, no new table, no migration. `authorize` order is unchanged in every touched function.
- I2. No posted amount changes in S1/S2. S1 refuses earlier with the same outcome (nothing written). S2 changes only
  what the person is told.
- I3. `listFindings`' output is byte-identical (S1). `findingsRepo` is not edited.
- I4. No uuid reaches a URL from a touched action. No success banner carries an amount or a typed reason.
- I5. S3: `recordInvoice`, `feeOf`, and the line-sum rule are not edited. The domain already owns them.
- I6 ✎S3-AMEND. S3a edits two SQL expressions and one status literal, nothing else. `costBasisFor`, the
  `PriceObservation` shape and every caller are unchanged. There is no migration and no backfill; the basis is
  derived per read.

---

## S1: DEF-575 and DEF-570
**BUILDER:** R1 in `discrepancy.ts` and `discrepancies/actions.ts`; R3 in `findings/index.ts` and `remittance/lib.ts`.

**TESTER:**
- `packages/domain/tests/integration/t379-s1-discrepancy-closed-month.test.ts` (new). Fixture from
  `t374-s6-branch-recount-action.test.ts` / `t372-receipt-discrepancy.test.ts`: a commissary, a branch, an order
  dispatched and received short (and one over). Close the month of `resolvedOn` (set `fiscal_periods.status` as
  `fiscal-period-close.test.ts` does).
- `apps/erp/tests/integration/t379-s1-discrepancy-action-web.test.ts` (new). Harness from
  `t376-s1-action-forward-web.test.ts` (RedirectSignal, mocked session, real domain).
- `packages/domain/tests/integration/t379-s1-cash-custody-findings.test.ts` (new). Fixture from
  `findings.test.ts:1030-1075` (an unremitted-ceiling breach).
- `apps/erp/tests/t379-s1-remittance-lib.test.ts` (new, unit). `@shareat/domain` is mocked so that `listFindings`
  throws `'full feed called'` and `listCashCustodyFindings` returns a fixture with three findings: store A, store B,
  and org-wide (`storeId: null`).

**Tests:**
- **D1** (red on HEAD: it throws). Short row, `loss`, `resolvedOn` in a closed January → `{ok:false}`. `userReason`
  = *"January 2026 is closed, so this can't be booked on {humanDate}. Nothing was saved."* No uuid. The row is
  still `open`, and there is no journal entry for `trade_discrepancy:<id>:loss`.
- **D2** (red on HEAD). The same with `charge` and a named person → the same sentence, nothing written.
- **D3** (red on HEAD). Over row, `extra_dispatch`, with stock on hand at the source room, closed month → the same
  sentence. Zero `stock_movements` with `source_id` = the row. The row is still `open`.
- **D4** (red on HEAD). Locked period → *"… is locked, so …"*.
- **D5** (control, green on HEAD). Over row, `return` with a note, closed month → `ok`. Short row, `audit`, closed
  month → `ok`. Open month, `loss` → `ok`, and the entry is posted.
- Mutants:
  - delete the check → D1–D4 red;
  - check only `closed` → D4 red;
  - check `loss`/`charge` only → D3 red;
  - check every disposition → D5 red;
  - place the check above the direction gate → **D6**: over row, `loss`, closed month must still get
    `OVER_REFUSES_SHORT_DISPOSITIONS`, not the month sentence.
- **A1** (red on HEAD: an uncaught throw, no redirect). `resolveDiscrepancyAction` with the D1 setup → redirect to
  `/commissary/discrepancies?store=<id>&error=<the D1 sentence>`.
- **A2** (red on HEAD). `resolveDiscrepancy` returns a reason carrying the row's uuid (resolve twice) → the
  redirect's `error` has no uuid. Mutant: `back(storeId, result.reason)` → A2 red.
- **A3** (red on HEAD). A thrown refusal (a `staff` actor, so `authorize` throws) → a redirect with the
  authorization sentence, not a throw. Mutant: drop the try/catch → A1, A3 red.
- **F1** (parity, red on HEAD: no such export). On the breach fixture, `listCashCustodyFindings(tx, org)` equals
  `listFindings(tx, org, {period})` filtered to the three kinds: same keys, order, `status`, `acknowledgedAt`,
  counts. Do it twice, once before and once after `acknowledgeFinding`.
- **F2.** `listCashCustodyFindings` returns no non-cash kind on a fixture that also raises `itemsMissingThreshold`.
- **L1** (unit, red on HEAD: `listFindings` is called). `cashCustodyFindings(org, 'A')` returns the A and org-wide
  findings, not B.
- Mutants:
  - the lib still calls `listFindings` → L1 red;
  - the store filter is dropped → L1 red;
  - `decorate` is skipped in the cash path → F1 (the acknowledged leg) red;
  - a fourth detector is added to the cash path → F2 red.

**Smoke (9008):**
1. Close the current month on a dev DB. Resolve a shortfall as loss → the banner shows the sentence, with no digest
   page. Reopen the month.
2. `/remittance` renders with its findings card unchanged.

Take screenshots of 1 and 2.

---

## S2: DEF-592 (and DEF-564, trade half)
**BUILDER:** R2 in `trade/returns/actions.ts`; the hidden `store` input in `trade/returns/page.tsx`.

**TESTER:**
- `apps/erp/tests/t379-s2-customer-return-banners.test.ts` (new, unit). It copies the harness of
  `apps/erp/tests/t376-s2-return-banners.test.ts` (RedirectSignal, the real `constraint-messages`, `@shareat/domain`
  with `recordCustomerReturn`/`applyCredit` replaced).
- Edit `apps/erp/tests/t374-s2-posted-dates.test.ts:53-56`: wrap the two `customer.*` calls in `untilRedirect`, as
  the supplier calls already are. That is the only change.
- W3 lives in the same new unit file as a source assertion on `trade/returns/page.tsx`: the `recordReturnAction`
  form contains `name="store"`. No integration render is needed.

**Tests:**
- **B1** (red on HEAD: no redirect). For each of the five settlements, success → `revalidate:/trade/returns`
  BEFORE `redirect:/trade/returns?store=S&ok=<R2 sentence>`.
- **B2** (red on HEAD: it throws). `{ok:false, reason:'trade order <uuid> does not exist.'}` → `?store=S&error=` with
  no uuid.
- **B3** (red on HEAD). The domain throws a real `refuse(raw, sentence)` → `error` = the sentence.
- **B4** (red on HEAD). `applyCreditAction`: success → `ok=Credit applied to the order.`; `{ok:false}` →
  `error`; a thrown refusal → `error`.
- **B5.** No `store` in the form → there is no `store` param (the `voidReturnAction` rule).
- **B6.** No `ok` value contains `₱` or a digit.
- **W3** (red on HEAD). The record form carries `name="store"`.
- Mutants:
  - revalidate after the redirect → B1 red;
  - a single generic `ok` for every settlement → B1 red (the four non-default legs);
  - `error: result.reason` raw → B2 red;
  - drop the try/catch → B3, B4 red.

**Smoke (9008):** On `/trade/returns`, record one return of a sellable line → the banner shows the store-credit (or
reduce-AR) sentence, and the store picker keeps its store. Over-return past the cap → the refusal banner, with no
digest. Take a screenshot of each.

---

## S3: DEF-568 and DEF-569 — ⚠️ money, Opus review first (R6). ✎S3-AMEND: REV-1/REV-2 are ruled below. S3 is now S3a + S3b, and the original S3 BUILDER/TESTER/tests are replaced by them.

### ✎REV — independent Opus review, 2026-10-07: **NOT READY until REV-1/REV-2 are ruled.**
Verified true: domain fee path (`ap/index.ts:441-459`, blank → `undefined` → column default; `-x` refused; fees > total
refused), `setInvoiceLines` re-derives goods with `subtract` (`:609-612`) and refuses non-pending (`:601`), no
posting reads a supplier fee (only `items.ts:259`, `:996` do), `recordInvoiceAction` passes neither fee (`actions.ts:176-185`),
`authorize` order untouched by R5. Wiring R5 as written is safe. What it switches ON is not:
- **✎REV-1 (blocker, pre-existing, now reachable).** The landed-cost allocation is wrong for any bill with more than one
  item. `sum(l.line_total) over (partition by l.supplier_invoice_id)` runs AFTER `where l.item_id = ${itemId}`
  (`packages/db/src/repo/items.ts:260`+`:266`, `:997`+`:1002`), so the denominator is only THIS item's lines: on a bill of X
  ₱1,000 + Y ₱9,000 + ₱500 fee, X and Y each absorb the whole ₱500 (₱1,000 of landed fee for a ₱500 fee). T-151 §4
  says "over the invoice". Every T-151 test buys one item per bill (`trade.test.ts:919-956`), so it has never been
  caught; W6 below is single-line and would pass with it. Branch prices default from this (`costBasisFor`, `:1022-1040`)
  and those rates post. Fix = compute the per-invoice sum before filtering (a CTE/subquery over all lines of the
  invoices that carry the item) in BOTH queries. Outside S3's BUILDER paths → planner rules: widen S3 to
  `items.ts` (`priceHistory`, `lastTwoLandedMax` only) or block S3 behind a new DEF. Do not ship the form first.
- **✎REV-2 (high, pre-existing, now reachable).** `lastTwoLandedMax` filters `si.status <> 'void'` (`items.ts:1002`);
  the status is `'voided'` (`packages/db/schema/suppliers.ts:49`; `priceHistory` uses `'voided'`, `:266`). So voided
  bills still set the branch-price basis — and N3's only fee correction is "void and re-log", which leaves the wrong
  fee in the max-of-last-two. One-word fix, same file as REV-1.
- **✎REV-3 (medium).** W4's `Number` mutant cannot go red: `peso()` rounds to 2 dp (`format.ts:15-27`), so
  `0.30 − 0.10` prints `₱0.20` either way. Replace with a source assertion on `invoices/[id]/page.tsx` (imports
  `subtract` from `@shareat/core/money`; no `Number(` on a fee).
- **✎REV-4 (medium).** P3's fixture is refused before the sum: a unit price of 99,999,999,999.99 has 11 integer digits
  and `parseFourDecimalCost` refuses >10 (`commissary/catalogue.ts:72-78`). Use two lines of `10 × 9999999999.999`.
- **✎REV-5 (medium, wording).** On a fee bill the domain refusal says "but the invoice says ₱10,000.00"
  (`items/index.ts:429-432`; `setInvoiceLines` passes goods as `invoiceTotal`, `ap/index.ts:613`) while the header and
  the new note say ₱10,500.00 total. Smoke 1 will show exactly this. R4 already edits that sentence: say "the goods on
  this bill come to ₱X" (one sentence for both cases is fine — goods = total when no fee). No rule change (I5 holds).
- **✎REV-6 (low).** R5's help line says only the delivery fee is added to cost; the SQL adds BOTH fees
  (`items.ts:259`, T-151 §4). Text: *"Part of the total above. Both are added to the items' cost; neither is a line."*
- **✎REV-7 (low).** The split shows only in the pending-only itemise section (`[id]/page.tsx:189`). A verified bill's
  lines then sum to less than its total with no explanation. Show the two fees in the header when non-zero.
- **✎REV-8 (tests to add).** W7: one bill, items X ₱1,000 + Y ₱9,000, delivery fee ₱500 → X landed +₱50, Y +₱450
  (red on HEAD, REV-1). W8: void the W6 bill, re-log without fee → `costBasisFor(X)` drops to the raw price (red on
  HEAD, REV-2). DEF-568 changes text only: no stored value changes (`pesos` is display-only; the stored `lineTotal`
  is the parsed Money, `items/index.ts:419`) — confirmed.
### ✎S3-AMEND (planner, 2026-10-07): S3 is split into S3a and S3b, and REV-1..REV-8 are all adopted
- **REV-1 → DEF-602, REV-2 → DEF-601** (logged in `9047488`). Both are fixed in **S3a**, in `packages/db/src/repo/items.ts`.
  S3a is shippable on its own and ships **before** S3b. The fee fields must not reach a screen while the
  allocation is wrong (REV-1's "do not ship the form first").
- REV-3 → W4 is a source assertion (S3b). REV-4 → P3's fixture changes (S3b). REV-5 → R4's sentence changes (S3b).
  REV-6 → the help line names both fees (S3b). REV-7 → the fee split shows on a bill of any status (S3b). REV-8 →
  W7/W8 become L1/L4 (S3a).
- **R7 (DEF-602). The fee share's denominator is the WHOLE bill's lines, computed before filtering to the item.**
  - In both `priceHistory` (`items.ts:256-260`) and `lastTwoLandedMax` (`:993-997`), replace
    `sum(l.line_total) over (partition by l.supplier_invoice_id)` with a per-bill goods sum. It must be joined
    before `l.item_id = ${itemId}` can narrow it. For example:
    `join (select supplier_invoice_id, sum(line_total) as goods from supplier_invoice_lines where supplier_invoice_id
    in (select supplier_invoice_id from supplier_invoice_lines where item_id = ${itemId}) group by 1) g on
    g.supplier_invoice_id = l.supplier_invoice_id`, then `l.line_total / nullif(g.goods, 0)`. The builder may use a
    CTE instead; the denominator rule is what matters.
  - Not `si.total_amount − fees`. That equals the line sum only when the bill is itemised under today's rule, and
    T-151 §4 says "allocated across its lines". Keep the denominator as the lines, so the fee is conserved: the
    landed line totals of one bill sum to goods + fees.
  - The landed expression stays one shape in both queries. A bill with no lines yields no row (unchanged).
- **R8 (DEF-601). `lastTwoLandedMax` excludes `si.status <> 'voided'`**, the schema's value
  (`packages/db/schema/suppliers.ts:49`), as `priceHistory` already does (`:266`).
- **R9. S3a is money and gets a second review.** It changes the branch-price basis for every multi-item bill
  with a fee, and for every item whose last two bills include a voided one. Branch prices default internal
  trade-order rates, and those rates post. **An independent Opus review reads the S3a diff and L1–L6 before it
  ships** (the auditor pass, not a re-spec). No data migration: the basis is derived per read (T-151 §3). The first
  read after deploy is correct. Rates already captured on posted trade orders are not touched, and should not be.
- ~~N5~~ → **R10** (✎S3-AMEND, orchestrator's ruling: folded into S3a, because L-tests must not pin a basis that
  is not deterministic).
- **R10. In `lastTwoLandedMax`, a "receive" is ONE BILL.**
  - All of the item's lines on one bill combine into one landed price per base unit: Σ landed line totals ÷ Σ base
    quantities (`l.quantity * l.conversion_factor`), computed with R7's whole-bill denominator. This is a weighted
    price, not the max or the mean of the lines.
  - Bills are ordered `si.invoice_date desc, si.created_at desc, si.id desc`, then `limit 2`, then `max`.
    `created_at` is the transaction's `now()`, so two bills in one transaction tie there and `id` (uuidv7, rising)
    decides.
  - `priceHistory` stays per line: it is a list of observations, not a basis.
  - **What T-151 intended, checked:**
    - `151-landed-cost-and-branch-price.md:37` says *"max of the last two receives"*; `:106` (invariant 3) says
      *"`max` of the **last two landed receives**, derived per read"*; `:119` (test 3) says *"a cheap lot after an
      expensive one keeps the expensive basis"*.
    - The unit is a receive, which is a lot, and v2 derives it from bills (`:58-60`). So one bill is one receive.
    - HEAD counts lines. A bill with two X lines fills both slots, and the bill before it (the "expensive lot still
      in inventory") drops out. That breaks the goal invariant 3 states.
    - v1's live hook is one `newCost` per receive against the stored prior (`ERP-rebuild/src/lib/financial/commissary/pricing.ts:102-103`).
      v1's refresh button walks lines (`commissary-item-config.actions.ts:~470-500`, "identical lines collapse"),
      so v1 is internally inconsistent here.
    - R10 follows T-151's stated goal, not v1's refresh method. It matches T-151, so planning does not stop.
- No other N5 remains.

## S3a: DEF-601 and DEF-602 — ⚠️ money, second review before ship (R9) ✎S3-AMEND
**BUILDER:** `packages/db/src/repo/items.ts`: `priceHistory` (R7) and `lastTwoLandedMax` (R7, R8, R10) only.
Nothing else in the file. Update `costBasisFor`'s doc comment only if it names lines.

**TESTER:** `packages/domain/tests/integration/t379-s3a-landed-cost.test.ts` (new). Fixture from
`trade.test.ts:919-956` (T-151's landed-cost tests): an org, a store, a supplier, items X, Y and Z (kg). Bills are
written through `recordInvoice` with `lines` and `deliveryFee`/`otherFees`, and voided through `voidInvoice`, never
by raw insert. `trade.test.ts:919-956` stays unedited as the single-item control (L5).

**Tests:**
- **L1** (red on HEAD; REV-8's W7). One bill: X 10 kg ₱1,000 + Y 10 kg ₱9,000, delivery fee ₱500 (total ₱10,500).
  `priceHistory(X)` landed = `105.0000`, `priceHistory(Y)` landed = `945.0000`. HEAD gives 150 and 950: each item
  takes the whole fee.
- **L2** (red on HEAD). On the L1 fixture: `costBasisFor(X).basis` = 105, and Y = 945. That is the
  `lastTwoLandedMax` path.
- **L3** (red on HEAD; conservation). One bill: two X lines of 10 kg at ₱1,000 each, + Y 10 kg ₱8,000, other fees
  ₱1,000 (total ₱11,000). Expect:
  - each X line landed 110/kg;
  - Y landed 880/kg;
  - Σ (landed × base qty) over the three lines = ₱11,000.00 exactly (goods + fees).
- **L4** (red on HEAD; REV-8's W8). Bill B1: X 10 kg ₱1,000, delivery fee ₱500 → `costBasisFor(X)` = 150. Void B1.
  Log B2 the same date: X 10 kg ₱1,000, no fee → `costBasisFor(X)` = 100. HEAD keeps 150 (the voided bill still
  counts). Control: `priceHistory(X)` has only B2's row (already true on HEAD).
- **L5** (control, green on HEAD). The T-151 single-item tests (`trade.test.ts:919-956`) pass unchanged. A bill
  with no fee gives landed = raw base price.
- **L6.** Add an unrelated bill (Z, ₱50,000, fee ₱2,000) to the L1 fixture. L1's and L2's figures do not move.
- Mutants:
  - fix only `priceHistory` → L2 red;
  - fix only `lastTwoLandedMax` → L1 red;
  - denominator = `si.total_amount` (includes the fees) → L1, L3 red;
  - denominator over the item's lines only (HEAD) → L1, L2, L3 red;
  - denominator summed over all bills (no per-bill grouping) → L6 red;
  - `'void'` restored → L4 red.
- **L7** (red on HEAD; R10, one bill is one receive).
  - Setup: B0 (2026-01-05) X 10 kg ₱3,000, no fee: landed 300/kg. B1 (2026-01-10) has two X lines, 10 kg ₱1,000
    and 30 kg ₱6,000, delivery fee ₱700 (goods ₱7,000).
  - Landed: line 1 = (1,000 + 100) / 10 = 110/kg; line 2 = (6,000 + 600) / 30 = 220/kg.
  - B1 combined = 7,700 / 40 = 192.50/kg.
  - Expect `costBasisFor(X)` = 300.00: the last two receives are B1 (192.50) and B0 (300).
  - HEAD gives 220 (B1's two lines fill both slots, so B0 drops out).
  - Mutants:
    - per line (HEAD) → red (220);
    - the bill as the max of its lines, with B0 removed → a second leg without B0 expects 192.50, red (220);
    - the bill as the plain mean of its line prices → the same leg red (165).
- **L8** (red on HEAD; R10, a deterministic tie-break).
  - Setup: three single-line bills of X, all dated 2026-01-10, each recorded in its own transaction, in this order:
    B1 300/kg, B2 100/kg, B3 50/kg.
  - Expect `costBasisFor(X)` = 100: the last two are B3 and B2. Run it 5 times; all 5 agree.
  - Second leg: three bills recorded in ONE transaction, in the same order and at the same prices (equal
    `created_at`). Expect 100, so `id desc` decides.
  - HEAD has no tie-break, so the result depends on the plan.
  - Mutants:
    - `created_at asc` / `id asc` → red (300);
    - drop the `id` tie-break → the second leg is not guaranteed; it is pinned by asserting the generated SQL
      ordering in the repo source (`invoice_date desc, … created_at desc, … id desc`), as a source assertion in the
      same file.

**Smoke:** none on screen (no UI change). L1–L6 against the lane DB are the evidence. The second review (R9)
stands in for the smoke.

## S3b: DEF-568 and DEF-569, the screen — ⚠️ money (R6); ships after S3a ✎S3-AMEND
**BUILDER:** R4 (as amended below) in `packages/domain/src/items/index.ts`. R5 (as amended below) in
`apps/erp/src/app/ap/actions.ts` (`recordInvoiceAction` only), `apps/erp/src/app/ap/page.tsx` (the log-a-bill form
only), and `apps/erp/src/app/ap/invoices/[id]/page.tsx` (the header figures and the itemise note only).

**R4/R5 amendments (✎S3-AMEND):**
- REV-5: the sum refusal (raw and user) reads *"The lines total ₱X, but the goods on this bill come to ₱Y. Either
  the lines are incomplete or the total is wrong — both are worth fixing before this becomes a price everyone
  trusts."* `Y` is the figure `validateInvoiceLines` receives, which is goods (= total when there is no fee). The
  line refusal (`:402-405`) is unchanged apart from R4's grouping.
- REV-6: the help line is *"Part of the total above. Both are added to the items' cost; neither is a line."*
- REV-7: the bill page's header shows **Delivery fee** and **Other fees** rows whenever either is non-zero, on a
  bill of ANY status (not only in the pending itemise section). The itemise note (R5) is unchanged.
- REV-3: no `Number(` on a fee anywhere in `[id]/page.tsx`. Goods come from `subtract`/`money`
  (`@shareat/core/money`).

**TESTER:**
- Edit `packages/domain/tests/integration/items.test.ts:256` → `/lines total ₱2,900\.00, but the goods on this
  bill come to ₱5,000\.00/`.
- Edit `packages/domain/tests/integration/t367-s3-invoice-total-due-date.test.ts` `:144`, `:156`, `:293`: "but the
  invoice says" → "but the goods on this bill come to" (the figures do not change). `:177` and `:197` are unchanged.
- `packages/domain/tests/integration/t379-s3b-peso-sentences.test.ts` (new). Fixture from `t367-s3`.
- `apps/erp/tests/integration/t379-s3b-ap-fees-web.test.ts` (new). Harness from `t362-supplier-terms-web.test.ts` /
  `t358-ap-invoice-expense-form.test.ts`.

**Tests (domain):**
- **P1** (red on HEAD). Lines summing to ₱1,234,567.89 against a total of ₱1,234,567.90 → *"The lines total
  ₱1,234,567.89, but the goods on this bill come to ₱1,234,567.90. …"*.
- **P1b** (red on HEAD; REV-5). A bill with total ₱10,500 and a fee of ₱500. `setInvoiceLines` with lines of
  ₱10,500 → *"… ₱10,500.00, but the goods on this bill come to ₱10,000.00. …"*.
- **P2** (red on HEAD). One line `10 × 1234.5` stated `12345.01` → *"… 10 × ₱1,234.5 is ₱12,345.00, not
  ₱12,345.01."*.
- **P3** (red on HEAD; REV-4's fixture). Two lines of `10 × 9999999999.999`, total `199999999999.99` → the sentence
  prints `₱199,999,999,999.98` and `₱199,999,999,999.99`. Nothing throws.
- **P5** (control). `t367-s3` `:177` and `:197` stay green with their text unchanged (`₱33.3333`, `₱0.0050`).
- Mutants:
  - group only `pesos` and not the box-text figures → P1 (the goods leg), P2 (the "not" leg) red;
  - `formatMoney`/`Number` for the unit price → P5 (`₱0.0050` becomes `₱0.01`) red;
  - group the unit price's decimals → P2 red;
  - keep "but the invoice says" → P1, P1b red.

**Tests (web):**
- **W1** (red on HEAD: fees are ignored). `recordInvoiceAction` with total `10500.00`, deliveryFee `500.00`, otherFees
  blank → `delivery_fee` = `500.00`, `other_fees` = `0.00`. `setInvoiceLinesAction` with lines summing to
  `10000.00` → accepted. Lines summing to `10500.00` → refused. Variant: otherFees `200.00` → `other_fees` =
  `200.00`. Mutant: the action drops `otherFees` → the variant red.
- **W2** (control). A blank fee → `delivery_fee` = `0.00`, and the lines must sum to the total.
- **W3.** deliveryFee `-5` → `?error=` "The delivery fee can't be less than zero."; fees above the total → the
  `feesTooBig` sentence.
- **W4** (red on HEAD; REV-3, a render leg plus a source leg).
  - Render: the W1 bill's page says "Lines must add up to ₱10,000.00" and names the ₱500.00 delivery fee; the W2
    bill keeps today's sentence.
  - Source: `[id]/page.tsx` imports `subtract` from `@shareat/core/money` and contains no `Number(` applied to
    `deliveryFee`/`otherFees`.
  - Mutant: the note uses `totalAmount` → the render leg red. Mutant: goods via `Number` → the source leg red.
- **W4b** (red on HEAD; REV-7). The W1 bill, once verified, still shows the Delivery fee ₱500.00 row. A no-fee bill
  shows no fee rows. Mutant: the rows stay inside the pending-only section → W4b red.
- **W5** (red on HEAD). The `/ap` form HTML has inputs `deliveryFee` and `otherFees`, neither `required`, and the
  REV-6 help text. Mutant: the old one-fee text → W5 red.
- **W6** (money, end to end). After W1, itemise one line (X, 10 kg, ₱10,000) and read X's price history → landed
  1,050.0000 per kg against a raw 1,000.0000.
- Multi-item allocation and void-and-relog are proven in S3a (L1–L4) and are not repeated here.

**Smoke (9008, with S3a on the tree):**
1. Log a bill of ₱10,500 with a ₱500 delivery fee. Itemise ₱10,000 → saved. Itemise ₱10,500 → the grouped sentence
   "… the goods on this bill come to ₱10,000.00".
2. Verify it → the header still shows the fee.
3. Two-item version (X ₱1,000 + Y ₱9,000, fee ₱500): price history shows X and Y each at +5%.

Take screenshots of 1–3.

---

## Out of scope
- N1. Four local `monthLabel` copies (`approve.ts`, `reimbursement.ts`, `period-guard.ts`, and S1's). One shared
  helper is a cleanup across unrelated files.
- N2. A period filter on `postedDepreciationPeriodsByAsset` / `postedPeriodsByItem` for the full `/findings` feed.
  Only if measured.
- N3. Editing the fees (or the total) of a pending bill. No domain path exists. Today it is void and re-log.
- N4. `reportScope` silently swaps a `?store=` the person may not see for their default. A one-line notice would
  say so. A UX nit, separate from DEF-572.
- The register, the bible and the ROADMAP. The orchestrator handles these at wrap-up.

## Done when
- S1–S3 are green. Each red is shown red on HEAD or against its named mutant before the build.
- S3's Opus review is recorded in this file (✎REV) before the S3 builder starts. ✎S3-AMEND: done; and S3a's diff
  gets its own independent Opus review (R9) before it ships. S3b does not ship before S3a.
- Typecheck is clean. The unit suite passes. The FULL integration suite passes on a fresh gate DB before any push.
  `npm run build` passes with the dev server stopped. Touched files are LF.
- Each slice's smoke is done on 9008 with screenshots.
- Each builder touched only its BUILDER paths, and each tester only its TESTER paths.
- The orchestrator, at wrap-up:
  - marks DEF-575, 592, 568, 569, 570 fixed with the hashes; ✎S3-AMEND: and DEF-601, 602 with S3a's hash;
  - marks DEF-564 fixed: the inventory half by `13d61fb`, the trade half by S2;
  - closes DEF-572 as not reproduced (census evidence);
  - files N1–N4 (✎S3-AMEND: N5 became R10, built in S3a).

## Questions only Ian can answer
None.
- DEF-569 implements Ian's own T-151 rule. It adds no new rule.
- R2's sentences carry no amount.
- DEF-572's closure rests on code and the fixture. If Ian saw it himself, he says so and it reopens.

## Ruling log
- 2026-10-07, planner: R1–R6. No migration. DEF-571 dropped (fixed), DEF-572 dropped (not reproduced). S3 flagged
  money (cost basis) for an independent Opus review.
- 2026-10-07, planner ✎S3-AMEND (orchestrator's ruling after ✎REV): S3 is split into S3a (DEF-601/602,
  `repo/items.ts`, ships first, second review R9) and S3b (DEF-568/569 screen). R7–R9 added. REV-3..REV-8 adopted.
  N5 noted.
- 2026-10-07, planner ✎S3-AMEND: N5 folded into S3a as R10 (one bill = one receive, weighted; a stable tie-break).
  Checked against T-151 `:37`, `:106`, `:119`: it matches. v1's refresh walks lines; that is the method, not the
  goal. L7 and L8 added.
