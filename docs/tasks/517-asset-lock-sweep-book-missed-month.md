# T-517: booking a missed depreciation month takes the asset row lock first (sweep of every fixed-asset writer)

**Status:** BUILT 2026-11-04 (AUDIT). Number from the orchestrator (BOSS, 4 Nov; BOARD "T-517 = AUDIT asset row-lock sweep incl.
bookMissedMonth"). Follow-up to T-515 (PR #141) and T-516 (PR #142). No migration, no DEF row, no bible row. Branch
`audit/t517-asset-lock-sweep`, worktree `wt-audit-t517`, base origin/main 4220710.

## 1. The problem in plain words
Every writer that changes a fixed asset's depreciation takes the asset's row lock (`FOR UPDATE`) first, so two of them cannot
interleave. `bookMissedMonth` (packages/domain/src/missed-months/index.ts) read the asset with plain `getById`, judged
"is it active" and worked out the month's charge from that read, and only THEN took the lock (`lockAssetRow`, step 4b),
without reading again. A disposal, retire or terms change that committed in that gap was never seen: a charge could be booked
on a disposed asset, or on the old schedule. No database trigger backstops the disposed case.

## 2. Sweep result (Haiku read-only sweep, then checked by hand)
LOCKED first: postPeriodsFor (depreciate.ts:136), dispose (T-515), terms, setAssetInService / retireAssetFromVoidedExpense / store
cascade followers (T-516). SAFE: valueOpeningAsset / valuateShell (status compare-and-set in the WHERE), depreciateAsset pre-check
(re-read locked at :136), disposeAssetAction loadDestructiveTarget (reads storeId only). The ONE gap: bookMissedMonth.
Reported, not changed: the prepaid half of bookMissedMonth has the same shape (`prepaidRepo.getById` then `lockItemRow`); prepaid
items are not fixed assets and have no concurrent disposer today. `setInServiceSource` / `markReviewed` repo writers have no
status guard in their WHERE (hardening candidates, no caller race found).

## 3. Change
1. missed-months/index.ts step 3, depreciation branch: `getById` -> `getByIdForUpdate` (the later `lockAssetRow` stays; it
   still serves the prepaid branch's twin and is harmless here).
2. `packages/domain/tests/integration/t517-missed-month-asset-lock.test.ts`: (a) RED-FIRST: A disposes (holds the lock), B books
   January; B must wait, then be refused "is disposed; only an active asset or item can be caught up", asset disposed, 0 live
   depreciation entries (old code: B waited, then committed a live depreciation entry on the disposed asset). (b) guard: no race,
   January booked once, 5000.00.
3. `tests/unit/t517-asset-lock-guard.test.ts`: source scan - the only unlocked `fixedAssetsRepo.getById(` in packages/domain/src is
   depreciate.ts (allowlisted with its reason); bookMissedMonth / dispose / in-service / retire all contain `getByIdForUpdate(`.

## 4. Acceptance
Booking a missed month serialises with dispose, retire, terms and the run on the asset row; whichever commits second judges on the
other's committed result. A new unlocked asset read in the domain fails the guard until it is locked or allowlisted with a reason.
