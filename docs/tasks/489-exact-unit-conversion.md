# T-489 — Purchase-to-base unit conversion uses the full 6-decimal factor, exactly; a line that converts to zero is refused

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: audit finding F20 (Claude posting-paths
pass, `C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-claude-posting-paths-pass.md`), re-verified on origin/main
26605d1. Branch `audit/t489-exact-unit-conversion`. Defect DEF-780. Numbers from the orchestrator (BOARD.md).
⚠️ `packages/domain/src/deliveries/**` is being changed by T-398 S5 (lane/t398-s5). This task touches ONE function body
there (`toBaseUnits`) plus a zero-guard of a few lines; it merges AFTER S5 and is rebased onto it then.

## Finding — DEF-780 (P2, stock quantities silently wrong)
`packages/domain/src/deliveries/receive.ts:219-223` `toBaseUnits` does
`BigInt(Math.round(Number(conversionFactor) * 1000))` then `(qtyThousandths * factorThousandths) / 1000n`:
the `numeric(14,6)` factor (`schema/deliveries.ts:186`; the item form accepts six decimals, `items/index.ts:618-621`)
is applied at three decimals through a float, and the product is truncated. `0.0625` becomes `0.063` (+0.8%: 1,000 cases
of sixteen receive 63,000 thousandths instead of 62,500); a factor below `0.0005` becomes 0, and `receive.ts:135-140`
then skips the line as "nothing arrived" — the delivery is received and nothing is on the shelf, with no error.
Callers: `receive.ts:135` (`receiveDelivery`) and `documents.ts:240` (duplicate-risk check).

## Rulings
1. New exported helper in `packages/core/src/money.ts` (next to `multiplyToMoney`, reusing its private `scaledOf` and
   `divideRoundHalfUp`): `multiplyQuantityByFactor(quantity: Quantity-like decimal 14,3, factor: decimal 14,6)` →
   quantity at 3 decimals, exact scaled-bigint arithmetic, rounded HALF-UP away from zero once at the end (the project's
   rule in code: `money.ts:163-167,194-197`, `receive.ts:228`). No `Number()`.
2. `toBaseUnits`'s body becomes a call to that helper (signature unchanged), and its doc comment no longer claims an
   exactness it lacked.
3. Zero guard: in `receiveDelivery`, a line whose RECEIVED purchase quantity is above zero but whose base quantity
   rounds to zero is REFUSED (nothing written), never skipped: "The unit conversion for <item> is so small that
   <qty> <purchase unit> rounds to zero <base unit>. Fix the item's conversion factor first." A line received as zero
   stays the legitimate "nothing arrived" skip.
4. Bible note owed (planner, at merge): quantities round half-up at three decimals, once, at the end. Not written here
   (T-398 S5 is editing the bible lane); listed in the PR.

## Tests (red first)
- Unit, no DB: `packages/core` test for `multiplyQuantityByFactor`: `5.000 × 0.0625 = 0.313` (half-up of 0.3125),
  `1000.000 × 0.0625 = 62.500`, `3.000 × 2.204622 = 6.614` (6.613866), `1.000 × 0.0004 = 0.000`, `12.000 × 12 = 144.000`,
  negative/zero edge per the helper's contract.
- Integration (real Postgres, dedicated fresh *_test DB), in `receive-delivery.test.ts` or a new
  `t489-unit-conversion.test.ts`: a line of 1,000 at factor `0.0625` receives exactly 62,500 thousandths into stock and
  its layer; a line of 1 at factor `0.0004` is refused with the Ruling 3 sentence and the delivery stays draft.

## Files
`packages/core/src/money.ts` (+ its test), `packages/domain/src/deliveries/receive.ts` (`toBaseUnits` body and the
zero guard ONLY), one test file, `docs/DEFECTS-REGISTER.md` (section E, DEF-780). Nothing else in `deliveries/**`.

## Acceptance
New tests red on 26605d1 for the stated reasons, then green; `receive-delivery.test.ts`, `deliveries.test.ts` and core
money tests green; root typecheck clean; guard/census unit files green.
