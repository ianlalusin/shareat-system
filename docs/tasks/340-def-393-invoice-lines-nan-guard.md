# T-340: DEF-393 — `validateInvoiceLines` NaN-blind epsilon, and one reconciliation guard for trade and items

**Status:** DONE 2026-09-25 (independent Opus review → Amendment R1; audit CLEAN; S1 PASS both themes).
**Closes:** DEF-393. **Money path ⛔.** **Model:** Sonnet (tester, builder). **Migration:** none.
**Precondition met:** T-328 §4b on `main` (`0206c87`) — `assertTradeTotalReconciles` at
`packages/domain/src/trade/index.ts:123-134`; unit test `packages/domain/tests/unit/t328-trade-reconciliation-guard.test.ts`.

One slice. TESTER = test files only; BUILDER = source only; disjoint. Tester writes first, records raw red; the
red must be the one named. Gates: RULES §2 incl. the **full** integration suite before push.

## Goal
A unit price or line total that is not a number (`NaN`, `Infinity`, `abc`) is refused inside
`validateInvoiceLines` with a sentence naming the line and the field. Today it slips past both epsilon guards and
only the database stops it. The epsilon comparison lives in **one** pure, testable function, and both callers
(trade, invoice lines) delegate to it.

## Verified open (HEAD `6350032`)
- `packages/domain/src/items/index.ts:178-180`: `price`/`total` are plain `Number(...)`; no finiteness guard.
  `:183-184` guard `qty`/`factor` with `!(x > 0)` (catches NaN). `:185` `Math.abs(qty * price - total) > LINE_EPSILON`
  is `false` for a NaN operand. `:198` makes `sum` NaN, blinding `:211`. `:206-207` pass the raw strings through.
- No parser in that file (`grep -n "parseMoneyInput\|money(" packages/domain/src/items/index.ts` → nothing).
- Callers: `packages/domain/src/ap/index.ts:359` (`recordInvoice`), `:417` (`setInvoiceLines`). App path
  `apps/erp/src/app/ap/actions.ts:176-198` passes `unitPrice` raw (`:184`, `:192`) and computes `lineTotal` as
  `(Number(quantity) * Number(unitPrice)).toFixed(2)` (`:195`) — a typed `abc` arrives with `lineTotal === "NaN"`.
  `recordInvoice` is also called by `packages/domain/src/recurring-expenses/job.ts:163`.
- Column trace: `itemsRepo.insertInvoiceLines` (`ap/index.ts:360`, `:419`) → `supplier_invoice_lines.unit_price
  numeric(14,4)`, `.line_total numeric(14,2)` (`packages/db/migrations/0047_t145_item_master_and_invoice_lines.sql:65-66`).
- ⚠️ The register calls this a corruption path; that overstates it. Two DB layers refuse a NaN row:
  `supplier_invoice_lines_arithmetic_check` (`0047:76-78`) and T-327's `…_{unit_price,line_total}_finite_check`
  (`0155:372-377`). So today it is a **single-layer defect** (bible §15.11) **plus a message defect** (a constraint /
  type error instead of a sentence). The red capture measures it.

## Decision: one shared helper
Same shape in both places — two computed figures plus a tolerance, finiteness first, then magnitude; only the
tolerance (trade `0.005`, items `0.01`) and the label differ.

`packages/domain/src/shared/reconcile.ts`
```ts
export function assertFiguresReconcile(label: string, stated: number, computed: number, tolerance: number): void
```
- If `stated`, `computed` or `tolerance` is not `Number.isFinite` → throw
  `${label}: both figures must be finite — got stated=${stated}, computed=${computed}.`
  (a NaN tolerance makes `x > NaN` false, silently reopening the hole).
- Else if `Math.abs(stated - computed) > tolerance` → throw
  `${label}: ${stated} does not reconcile with ${computed} (beyond ${tolerance}).`
- Parses nothing, returns nothing, no Money type — **not a validator** (T-328 §4b; DEF-383).
- **Not** exported from the barrel (`packages/domain/src/index.ts` untouched); tests import by relative path.

Callers after this task (complete list):
1. `trade/index.ts` `assertTradeTotalReconciles(stated, computed)` → body becomes
   `assertFiguresReconcile('assertTradeTotalReconciles', stated, computed, EPSILON)`; name, export, signature and
   both messages byte-identical; catch/re-throw at `:329-337` unchanged.
2. `items/index.ts` line check (`:185`): `assertFiguresReconcile(label, total, qty * price, LINE_EPSILON)`.
3. `items/index.ts` header check (`:211`): `assertFiguresReconcile(label, Number(invoiceTotal), sum, LINE_EPSILON)`.

## Fix (BUILDER)
In `validateInvoiceLines`, per line, in order:
1. `qty` (`:183`) and `factor` (`:184`) guards unchanged and first.
2. New: `!Number.isFinite(price)` → throw
   `validateInvoiceLines: line ${i + 1} (${item.name}) — the unit price "${l.unitPrice}" is not a number.`
3. New: `!Number.isFinite(total)` → throw
   `validateInvoiceLines: line ${i + 1} (${item.name}) — the line total "${l.lineTotal}" is not a number.`
   (price first, so the app path quotes the typed `abc`, not the computed `NaN` — T-328 §4c.)
4. Line check delegates to `assertFiguresReconcile` in trade's pattern: re-throw unchanged if any operand is
   non-finite; otherwise throw the existing "does not add up" sentence (`:187-188`) byte-identical.
5. Header check likewise; otherwise the existing `:213-215` sentence byte-identical.
6. Delete the two inline `Math.abs(...) > LINE_EPSILON`; keep the `LINE_EPSILON` constant and comment.

⛔ `Number.isFinite`, not a comparison to 0 (a `!(price >= 0)` adds an out-of-scope negativity rule and matches the
money-positivity census shape, `packages/domain/src/shared/money-positivity-guard.test.ts`).
⛔ Do not route `unitPrice` through `parseMoneyInput` — it is `numeric(14,4)`; that parser refuses legitimate 4dp prices.
`trade/index.ts`: the delegate change above, and the doc comment `:114-122` says the check lives in `shared/reconcile.ts`.

**BUILDER paths:** `packages/domain/src/shared/reconcile.ts` (new), `packages/domain/src/items/index.ts`,
`packages/domain/src/trade/index.ts`.
**TESTER paths:** `packages/domain/tests/unit/t340-reconcile.test.ts` (new),
`packages/domain/tests/integration/items.test.ts` (new `describe`; reuse `fixture`, `porkBelly`, `evidence`,
`invoiceWithLines` at `:60-137`).

## Tests (TESTER first; raw red)
⛔ Every refusal asserted with a matcher from this spec's sentences — a bare `.toThrow()` proves nothing (0047/0155
refuse for free; T-328 Tests §1).

**Unit `t340-reconcile.test.ts`** (import from `../../src/shared/reconcile`)
- Red: module missing (accepted TDD red, as T-328 2(b)).
- U1 `('L', NaN, 100, 0.01)`, U2 `('L', 100, NaN, 0.01)`, U3 `('L', Infinity, 100, 0.01)` and `('L', 100, -Infinity, 0.01)` → `/finite/i`.
- U4 `('L', 5, 5, NaN)` → `/finite/i` (the silent case).
- U5 `('L', 100, 200, 0.01)` → `/does not reconcile/i` and NOT `/finite/i`.
- U6 `('assertX', 1, 2, 0.01)` message starts `assertX:`.
- Negative halves: `('L', 100, 100.004, 0.005)`, `('L', 0, 0, 0.01)`, `('L', 2900, 2900, 0.01)` do not throw.
  ⛔ No case exactly at the tolerance (float-fragile).

**Integration `items.test.ts`, `describe('T-340 — a non-number never reaches the line arithmetic')`**
- I1 (app path's exact shape): `recordInvoice` with no lines, total `'2900.00'`, then `setInvoiceLines` with
  `{ quantity:'10', purchaseUnit:'kg', conversionFactor:'1', unitPrice:'abc', lineTotal:(Number('10')*Number('abc')).toFixed(2) }`
  → `/line 1 \(Pork belly .*\) — the unit price "abc" is not a number/` and NOT `/line total/`.
  Expected red: `invalid input syntax for type numeric: "abc"` (22P02).
- I2: `unitPrice:'NaN', lineTotal:'NaN'` on `'2900.00'` → `/the unit price "NaN" is not a number/`.
  Expected red: `violates check constraint "supplier_invoice_lines_arithmetic_check"`.
- I3: `'Infinity'`/`'Infinity'` → `/the unit price "Infinity" is not a number/`. Expected red: overflow or constraint; record verbatim.
- I4: unit price `'290'`, line total `'NaN'` → `/the line total "NaN" is not a number/`. Expected red: arithmetic_check.
- Negative halves (green before and after):
  - N1 quantity `'abc'` + unit price `'abc'` → still `/needs a quantity above zero/`.
  - N2 zero is legitimate (bible §12 landmine 8): `[10 kg × 290 = 2900.00, 1 kg × 0 = 0.00]` on `'2900.00'` accepted; 2nd row `unit_price = '0.0000'`.
  - N3 4dp price: `{ quantity:'2', unitPrice:'12.3456', lineTotal:'24.69' }` on `'24.69'` accepted; stores `'12.3456'`/`'24.69'`.
  - N4 no partial state: a valid `setInvoiceLines` then I1's bad call fails; `count(*), max(unit_price)` = `1, '290.0000'`.
  - Existing `items.test.ts:254` and `:264` green unedited.
- Trade regression: `t328-trade-reconciliation-guard.test.ts`, `packages/domain/tests/integration/trade.test.ts` green unedited.
- Census: `money-positivity-guard.test.ts` green with NO `CLASSIFIED` edits; if red, STOP and report.
- **S1 (tester, http://localhost:9008):** pending invoice `/ap/invoices/<id>`, line 1 qty `10`, unit price `abc`, save →
  banner names line 1 and quotes `abc`, no line saved; repeat with `290` → saves. Both themes.

## Invariants
1. No money in floats (RULES §1 rule 6; bible §2.5/§6): no NEW float arithmetic on money; the helper compares figures
   the caller already computed; `validateInvoiceLines` returns the caller's original strings byte-identical. The float
   epsilon itself is existing debt, recorded not fixed (an exact reconciliation needs a 4dp parser — DEF-383 bars it).
2. No new money validator (T-328 Invariant 2; DEF-383). `Number.isFinite` is a finiteness guard like `!(qty > 0)`.
3. One source of truth: afterwards
   `grep -nE "Math\.abs\(.*\) > (LINE_)?EPSILON" packages/domain/src/items/index.ts packages/domain/src/trade/index.ts` → nothing.
4. Tolerances unchanged (trade 0.005, items 0.01 mirroring the DB `<= 0.01`).
5. Existing sentences unchanged; T-328's `/finite/` and `/does not reconcile/` preserved.
6. A finiteness refusal is never flattened into a mismatch sentence (trade's `:329-337` pattern).
7. Bible §15.11: DB constraints stay; the service guard is a second layer (RULES §6.3). No migration.
8. `0` is a legitimate price and total (bible §12 landmine 8).

## Out of scope — same NaN-blind shape elsewhere (candidates; "fail-open" = NaN makes the guard ALLOW)
- `packages/domain/src/channel-settlements/index.ts:159, :177, :184, :370, :388, :407, :417` — `computeSettlement`
  (`:132-149`) `Number(v ?? 0)` on typed figures; preview path `apps/erp/src/app/channel-settlements/actions.ts:72-73`
  passes raw. Fail-open; only 0155 refuses the post. **Highest-priority candidate.**
- `packages/domain/src/ap/index.ts:780-795` — `creditApplied` unparsed; fail-open to 0155.
- `packages/domain/src/ap/index.ts:305-306` — `recordInvoice`'s `Number(input.totalAmount) <= 0` NaN-blind;
  `apps/erp/src/app/ap/actions.ts:148` passes raw. ⚠️ Absent from T-328's enumeration → new DEF (with the float goods
  total at `ap/index.ts:356-358`, `:414-416`).
- `packages/domain/src/ar/index.ts:78` (credit limit; unreachable today, fail-open) · `cutover/opening.ts:206, :214` (unreachable, fail-open).
- DB-sourced, unreachable today: `ap/index.ts:221, :755, :763`; `customers/index.ts:114`; `liabilities/index.ts:211, :260, :279`; `cash-requests/index.ts:412`.
- `items/index.ts:191` — safe (factor proven finite at `:184`).
- Float/exactness debt: `ap/actions.ts:195` float `lineTotal`; `items/index.ts:185` refuses an exactly-₱0.01-off line the DB accepts;
  `1e3` passes `Number.isFinite`; no app-side negative-price guard. All need a 4dp parser after DEF-383.
- Register edits, DEF-383 unification, bible amendments (RULES §1 rule 14).

## Done when
U1–U6, I1–I4 red→green with raw red recorded (confirm or correct the expected reds). N1–N4 and every named regression
file green unedited. Typecheck + unit clean. **Full** integration 0 failed. Build green with 9008 stopped. S1 with
screenshots. One commit with the why, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The orchestrator
stamps DEF-393 FIXED, corrects its "corruption" wording and column trace, and logs the `recordInvoice.totalAmount` DEF.

## Amendment R1 — independent review (2026-09-25), binding
1. **Labels pinned.** Line check label: `validateInvoiceLines: line ${i + 1} (${item.name})`. Header check label:
   `validateInvoiceLines: the invoice total`. A re-thrown finiteness refusal therefore names the line.
2. **I5 (flattening, items):** quantity `'1e300'`, unit price `'1e10'`, line total `'1'` → `/finite/` and NOT
   `/does not add up/` (today: "does not add up … ₱Infinity" at `items/index.ts:185` — a genuine red). A bare catch
   that always throws "does not add up" must fail this. Optional I6: two lines of `1e308` each (sum → Infinity at `:211`)
   → `/finite/` and NOT `/the lines total/`.
3. **I1 must not use `invoiceWithLines`** (it verifies the invoice, `items.test.ts:124-126`, and `setInvoiceLines` refuses
   a non-pending invoice, `ap/index.ts:406`). Call `recordInvoice` directly with `evidence(f)`; do not verify.
4. Out of scope, recorded: `Number('')`/`Number(' ')` are `0` and pass `Number.isFinite`; the app skips an empty price
   (`ap/actions.ts:185`) but `recurring-expenses/job.ts:163` does not — reaches the DB as 22P02.
