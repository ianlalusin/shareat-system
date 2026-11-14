# Shared Domain Helpers
## Overview
Cross-module building blocks used by many domain modules: the refusal producer API (server and client-safe halves), raw-input parsers for money, decimals, quantities and whole numbers, oldest-first payment allocation, straight-line spreading, the money-lines form rules, and the standard staff-shortage ledger charge. Most files are pure so a client form and the server action can run the same rule.
## Interface
- `refusal.ts` (server-only, imports `@shareat/db`): `RefusalError`, `refuse`, `gone`; re-exports `InternalFaultError`, `internalFault`, `humanDate`.
- `refusal-leaf.ts` (client-safe): `InternalFaultError`, `internalFault`, `humanDate`.
- `money-input.ts`: `exceedsMaxMagnitude`, `parseDecimalInput` (overloaded), `parseMoneyInput`.
- `quantity-input.ts`: `parseQuantityInput`. `whole-number-input.ts`: `parseWholeNumberInput`. `manual-cost-pattern.ts`: `MANUAL_COST_PATTERN`.
- `exact-decimal.ts`: `pow10`, `divideRoundHalfUp`, `textOf` (scaled-bigint arithmetic).
- `allocate-oldest-first.ts`: `allocateOldestFirst`, types `AllocationItem`/`TypedAmount`/`AllocationLine`/`AllocationPlan`.
- `straight-line.ts`: `buildStraightLine`, `periodsThroughOf`, types `StraightLineInput`/`SchedulePeriod`.
- `money-lines.ts`: `MONEY_OUT_METHODS`, `MONEY_IN_METHODS`, `METHOD_LABELS`, `COVERAGE_BAND_LABELS`, `methodsForDirection`, `floatAsSource`, `accountAsSource`, `availableOf`, `labelOf`, `sourceKey`, `keyOfSource`, `drawnPerSource`, `tryMoney`, `totalOfLines`, `bandFor`, `groupSourcesByCoverage`, `cashOnDeliverySentence`, `validateMoneyLines`, plus types (`MoneyDirection`, `MoneyLineMethod`, `MoneyLine`, `MoneyAccountOption`, `FloatOption`, `SourceOption`, `CoverageBand`, `GroupedSources`, `MoneyLineIssue`, `ValidateMoneyLinesInput`); re-exports `judgeDraw`, `DrawVerdict`, `DrawableAccount`.
- `staff-shortage-charge.ts`: `STAFF_SHORTAGE_RECEIVABLE_ACCOUNT` ('1230'), `postStaffShortageCharge`, type `StaffShortageChargeInput`.
- `field-rules-assert.ts`: `assertFieldRules`. `audit-text.ts`: `AUDIT_FREE_TEXT_MAX`, `AUDIT_TRUNCATED_MARK`, `capAuditText`.
- `constraint-refusals.ts`: `recordConstraintRefusal`. `reconcile.ts`: `assertFiguresReconcile` (not in the package barrel).
- `money-positivity-census.ts` (dev tooling): `stripComments`, `extractComparison`, `normaliseComparison`, `censusKey`, `scanMoneyPositivitySites`, type `CensusSite`.
## Invariants
- Money is integer centavos / branded `Money`; no floats. `parseMoneyInput` is the single entry for a raw money string; `exact-decimal` rounds once, half-up on the absolute value.
- Production code calls `refuse`/`gone`/`internalFault`, never `new RefusalError(...)`. Client files import `refusal-leaf`, never `refusal.ts`.
- `allocateOldestFirst` sorts internally by `dueDate || documentDate` (`||`, not `??`, so a blank string counts as absent).
- `buildStraightLine`: the rounding remainder lands on the LAST period, so the schedule sums exactly to the amount.
- `postStaffShortageCharge` is the one posting for a charged shortage: Dr 1230 (employee party) / Cr the short account; the credit-line party and idempotency key come from the caller.
- `money-lines.ts` must stay free of React/DB imports; the overdraft rule is owned by `judgeDraw`, not re-derived here.
- `assertFieldRules` error diagnostics never contain the typed value; call it only where every caller is an ERP action.
- `money-positivity-census.ts` imports `node:fs`: never re-export it from `packages/domain/src/index.ts`, and keep its own code free of unclassified positivity comparisons.
- `recordConstraintRefusal` takes no `tx` by design (independent transaction via `withOrgPrincipal`), and failures are logged and swallowed.
- `assertFiguresReconcile` checks finiteness of both figures and the tolerance before comparing; it parses nothing.
## Side Effects
- `postStaffShortageCharge` posts a ledger entry via `postEntry` on the caller's `Tx`.
- `recordConstraintRefusal` writes a prerequisite-refusal row on its own independent transaction and logs errors.
- `money-positivity-census.ts` reads the filesystem (`readdirSync`, `readFileSync`, `statSync`).
- Everything else: None (pure functions); `refusal-leaf.humanDate` formats via `@shareat/core/datetime`.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
