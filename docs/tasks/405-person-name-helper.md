# T-405 — `personName` helper: never a raw person id on screen

**Status:** SPEC 2026-10-14, Opus. Work list item 2 (`docs/plans/2026-10-14-ian-answers-worklist.md`),
review item 14 (`docs/feedback/2026-10-14-ian-feedback-review.md`). No migration. Size S.

## Goal
When a person lookup misses, three ERP pages print the person's UUID. Bible row 229: what a person
sees names things in words — "never an id, a code or a key". One shared pure function renders a
person's display name, `Unknown person` on a miss, `—` when there is no person at all.

## Correction to the review
Grep of `apps/erp/src` (2026-10-14) finds the person-id fallback on **3** pages, not 4.
`ap/invoices/[id]` and `ap/page.tsx` have no person fallback — theirs are `?? inv.supplierId`,
`?? e.categoryId`, `?? id.slice(0, 8)`. Those belong to the follow-up below, not here.

## Builder — files
1. **NEW** `apps/erp/src/lib/person-name.ts` — pure, no React, no DB:
   ```ts
   export const UNKNOWN_PERSON = 'Unknown person';
   export const NO_PERSON = '—';
   type Lookup = ReadonlyMap<string, string> | ReadonlyArray<{ id: string; displayName: string }>;
   export function personName(lookup: Lookup, personId: string | null | undefined): string
   ```
   `null`/`undefined`/`''` -> `NO_PERSON`; found -> its name (trimmed); found but blank name, or
   not found -> `UNKNOWN_PERSON`. Never returns `personId`.
2. `apps/erp/src/app/expenses/[id]/page.tsx:93-94` — delete local `personName`, call the helper with `persons`.
3. `apps/erp/src/app/sales-days/[id]/page.tsx:124-125` — same (`persons`); call sites at 224-229, 317 unchanged in shape.
4. `apps/erp/src/app/wastage/[id]/page.tsx:114` — `nameById.get(a.personId) ?? a.personId` ->
   `personName(nameById, a.personId)` (`nameById` is a `Map<id, name>`; keep it).

## Tester — files
- **NEW** `apps/erp/tests/person-name.test.ts` — found; not found -> `Unknown person`; null/undefined/'' -> `—`;
  blank/whitespace name -> `Unknown person`; works for both Map and array lookups; for a not-found
  UUID the output does not contain the UUID.
- **NEW** `apps/erp/tests/no-raw-person-id-fallback.test.ts` — walks `apps/erp/src/**/*.{ts,tsx}`
  (pattern: `tests/clock-route-is-client-only.test.ts`), fails on any line matching
  `/\?\?\s*\(?[\w.]*(personId|PersonId|\bpid)\b/`, printing `file:line`. Self-check: the regex
  matches each of the three removed original lines (inline strings in the test) and does not match
  `?? '—'` or `?? UNKNOWN_PERSON`.

## Invariants and named mutants (each must turn a test red)
- I1 a miss never echoes the id — **M1** `return personId` on miss.
- I2 no person -> `—`, not `Unknown person` — **M2** swap the two constants' use.
- I3 a blank stored name is a miss — **M3** drop the trim/blank check.
- I4 the pattern cannot come back — **M4** restore `?? a.personId` in `wastage/[id]/page.tsx`.

## Out of scope (separate follow-up, same row-229 class — not this task)
Raw non-person id fallbacks still rendered: `expenses/[id]` 91, 128 · `expenses/page.tsx` 116-117 ·
`ap/lib.ts` 93 · `ap/page.tsx` 52 · `ap/invoices/[id]` 124, 143, 339 · `findings/scorecard` 99 ·
`commissary/orders/lib.ts` 153 · `trade/orders/lib.ts` 152 · `trade/returns` 153, 241 ·
`inventory/returns` 152, 235 · `inventory/transfers` 156 · `inventory/production/lib.ts` 91 ·
`inventory/pos-usage/lib.ts` 99-100 · `inventory/pos-map` 201, 203 · `inventory/counts/lib.ts` 194 ·
`reports/{store-comparison,sales-rollup,ar-aging,ap-aging}` page + export routes ·
`staff/lib.ts` 64 · `staff/[employmentId]/credentials` 68 · `sales-days/page.tsx` 132 ·
`sales-days/[id]` 126 · `statutory-discounts` 59 · `remittance/actions.ts` 68.
Also out: the `/activity` audit page (T-402 S4), any repo/query change, `Unknown owner`/`Unknown holder` wording.

## Done when
- The two new tests pass; M1-M4 each verified red then reverted.
- `grep -rnE "\?\?\s*\(?[\w.]*(personId|PersonId|pid)\b" apps/erp/src` -> no output.
- `npm run typecheck` and the erp test project green.
