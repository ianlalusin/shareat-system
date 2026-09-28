# T-351: follow-ups from the post-commit `/code-review 0944455` (DEF-480..483)

**Status:** RESERVED 2026-09-28 (orchestrator) — findings verified by an independent Opus read; spec to be written in plan mode before build. **Model:** Sonnet, tester then builder. **Migration:** none expected.
**Runs after** T-350 and T-349 S2c (no path overlap with either, but one slice at a time per lane).

## Findings (all verified at HEAD `141de73`)
1. **DEF-480 (Med)** AP invoice line unit price: no server non-negative/precision guard after the box became text. `packages/domain/src/items/index.ts:199`, `apps/erp/src/app/ap/actions.ts:196`, optional `apps/erp/src/lib/constraint-messages.ts` entry for `supplier_invoice_lines_unit_price_not_negative_check`. Use `parseFourDecimalCost` (`commissary/catalogue.ts:53`).
2. **DEF-481 (Med)** `apps/erp/src/app/loans/actions.ts:35,50`, `apps/erp/src/app/prepaid/actions.ts:35,55,107`: parse after `authorize()`; check the value, not the digit run; state the ceiling.
3. **DEF-482 (Low-Med)** `apps/erp/src/app/channel-settlements/SettlementForm.tsx:476`: no green "reconciles exactly" while figure blockers exist.
4. **DEF-483 (Low)** `packages/domain/src/shared/quantity-input.ts:27` `String(raw).trim()`; `packages/domain/src/commissary/catalogue.ts:40` comment corrected (the change widens).

## Red legs (to be finalised in the spec)
- AP: `-5` refused in human words, nothing written; `12.34565` refused or rounded consistently so stored price × qty = stored line total.
- Loans/prepaid: unauthorized actor gets the auth refusal even with a bad field; `000012` / `0012` accepted when in range.
- Settlement preview render: blockers present → no good-tone reconcile row.
