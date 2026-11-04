# T-515: disposing an asset takes the asset's row lock before it judges anything (audit 49th pass)

**Status:** SPEC 2026-11-04 (AUDIT). Number from the orchestrator (BOSS, 4 Nov; BOARD line 136). Source: audit report
`shareat-audits/OPEN/audit-2026-11-04-forty-ninth-pass.md` (stable ID
`disposal-depreciation-check-without-shared-asset-lock`, P2). No migration. No DEF row, no bible row (BOSS, 4 Nov). Branch
`audit/t515-dispose-asset-lock`, worktree `wt-audit-t515`, base origin/main afb1f61. Follows T-513 (CR-3, PR #136).

## 1. The problem in plain words

`runDispose` (packages/domain/src/fixed-assets/dispose.ts:74) reads the asset with plain `getById`, then judges status,
the T-513 "not before the latest live depreciation" date, cost, and the accumulated amount, all from ordinary reads. The
depreciation run (`postPeriodsFor`, depreciate.ts:136) and the terms change (terms.ts:75) read the same asset row
`FOR UPDATE` first, so they serialise with each other. Disposal does not take part. Interleaving: a March depreciation run
posts March and pauses before commit; a disposal dated in February starts, sees only Jan and Feb, passes the T-513 check and
builds its entry from Jan+Feb; its final `markDisposed` UPDATE (repo fixed-assets.ts:367-381) then waits for the run's lock,
the run commits, and the UPDATE still matches (`status = 'active'`), so both commit. Result: a disposed asset that keeps
March depreciation dated after its disposal, and a disposal entry that did not clear it. A balanced journal does not stop
this.

## 2. Ruling (planner, AUDIT)

Take the lock first. In `runDispose` replace the first read, `fixedAssetsRepo.getById`, with
`fixedAssetsRepo.getByIdForUpdate` (same lock as depreciate and terms; same org filter). Everything after it (authorize,
reason, status, cost/acquired, disposal-vs-acquisition, T-513 latest-depreciation refusal, `accumulatedFromLedger`, posting,
`markDisposed`) stays in the same order and unchanged. Under READ COMMITTED each later statement sees what the lock holder
committed, so the loser either refuses (March now posted, disposal dated before it) or computes its accumulated figure from
the full ledger. No new error text. Keep the "asset does not exist" throw and the existing capability check exactly as they
are (the authz tests pin them). Do not reorder authorize before the read.

Lock order: asset row only, taken first in the transaction on both sides, so no cycle between depreciation, terms and
disposal. `postEntry` is called after the lock on all three paths.

Out of scope, but the builder reads and REPORTS (no edit): does `reverseEntry` on a depreciation entry take the asset
lock? **Answer (built 4 Nov): no.** `packages/domain/src/ledger/reverse-entry.ts` reads the entry (line 100), posts the
reversal and marks the original reversed (lines 213-214, journal rows only); no asset lock anywhere. So a reversal of a
depreciation entry can still interleave with a disposal that is reading `latestDepreciationDate` / accumulated. Not fixed
here (it needs the planner: the reversal does not know the asset, only the journal entry's source). Logged for BOSS in the PR.

## 3. Changes

1. `packages/domain/src/fixed-assets/dispose.ts`: one call, `getById` -> `getByIdForUpdate`, plus a one-line comment
   (why: shares the asset lock with depreciate/terms; T-515). Confirm `getByIdForUpdate` (repo fixed-assets.ts:235)
   returns the same row type as `getById` so nothing else changes.
2. New test (below). Nothing else.

## 4. Tests (write FIRST, show red on unchanged code, then fix)

Integration, real PostgreSQL on `shareat_test_audit515` (never shareat_test or shareat_dev; never print `.env.local`).
File `packages/domain/tests/integration/t515-dispose-asset-lock.test.ts`. Reuse the fixture/setup pattern of
`t513-disposal-before-depreciation.test.ts` (org, chart of accounts, 12 open periods, store, admin, createAsset +
depreciateAsset). Use the domain functions inside two `transaction(...)` calls on two separate pooled connections; hold
the first open with a deferred promise, signal when it has posted, start the second, wait ~700 ms (the second must still
be pending: that is the proof it is blocked, as in `packages/db/tests/integration/t502-f38-service-race.test.ts`),
release the first, await both. Set a generous `testTimeout` and a lock timeout so a hang fails, not freezes.

- (a) RED-FIRST. Asset active, Jan and Feb depreciation committed. Tx A: `depreciateAsset` through 31 Mar, post March,
  pause before commit. Tx B: `disposeAsset` dated **2026-02-28** (built note 4 Nov: not 15 Feb - with Jan and Feb posted
  the T-513 check already refuses 15 Feb because the latest live entry is 28 Feb, so the race is only reachable from 28 Feb;
  (c) uses 28 Feb for the same reason). Release A. Assert FINAL STATE: B was refused with the T-513
  message (`/before depreciation already posted up to 2026-03-31/`), the asset is still `active`, there is no disposal
  journal entry, and 1590 equals Jan+Feb+Mar exactly. On unchanged code B commits and this fails.
- (b) Same setup, B dated 2026-03-31 (same day as March): B waits, then commits; assert the disposal entry clears
  Jan+Feb+Mar exactly (exact decimal strings, same helper as the T-513 test), asset `disposed`, 1590 net zero for the
  asset. Positive control: waiting must not refuse.
- (c) Opposite order. Tx B (disposal dated 2026-02-28, only Jan/Feb posted) holds open after posting; Tx A starts the
  March `depreciateAsset` run and blocks; release B. Assert A posts nothing (asset is disposed, run returns no postings),
  asset `disposed`, no March depreciation entry, 1590 net zero.
- (d) Existing behaviour: the T-513 test file, `fixed-assets.test.ts` and `t392-s5-disposition-authz.test.ts` stay green
  unchanged.

Assert exact balances and messages, not a bare `rejects.toThrow()`. Check the loser's lock wait is real: assert the
second promise was still pending at the pause.

## 5. Checks
- Root `npm run typecheck` clean.
- New file (red on unchanged code, green after) plus the existing fixed-asset integration files (t513-*, t368-*,
  t392-s5-*, t398-s2-depreciation-principal, fixed-assets.test.ts) green on `shareat_test_audit515`.
- Unit guards/census (`tests/unit/*guard*`, `*census*`, app-boundaries) green. Numeric-write guard: add an EXEMPT line only
  if the new test trips it, and only the same kind as the T-513 test needed.
- LF endings, no CR bytes. `git diff --stat`: dispose.ts, the new test, this spec only.

## 6. Acceptance
Disposal and depreciation on the same asset serialise on the asset row; whichever commits second judges on the other's
committed result; no committed state has depreciation dated after the disposal date or an uncleared accumulated amount.
Closing the 49th-pass finding in `shareat-audits` happens after merge.

## 7. Built notes (4 Nov) - for the planner, NOT fixed here
Sonnet audit: SHIP. Same-fact judgements still made without the asset lock, outside this task's scope:
`retireAssetFromVoidedExpense` (capitalize.ts:342-348: finds the asset unlocked, reverses depreciation entries, then
`markDisposed`) and `setAssetInService` (in-service.ts:284: unlocked `getById`, then reverses and re-plans depreciation).
Both, plus `reverseEntry` (no asset lock), could interleave with a depreciation run. Proposed follow-up: take the asset lock
first in those two callers. An unauthorised caller now briefly holds the asset lock until its transaction ends (accepted;
the spec keeps authorize after the read, as before).
