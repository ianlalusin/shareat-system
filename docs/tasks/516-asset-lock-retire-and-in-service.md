# T-516: retiring an asset (voided expense) and changing its in-service date take the asset row lock first

**Status:** SPEC 2026-11-04 (AUDIT). Number from the orchestrator (BOSS, 4 Nov; BOARD "T-516 = AUDIT follow-up"). Follow-up
to T-515 (PR #141, ab218d3), which found these two callers judging depreciation without the asset lock. No migration. No
DEF row, no bible row. Branch `audit/t516-asset-lock-retire-inservice`, worktree `wt-audit-t516`, base origin/main ab218d3.

## 1. The problem in plain words

The depreciation run (`postPeriodsFor`, depreciate.ts:136), a terms change (terms.ts:75), booking a missed month
(`lockAssetRow`) and, since T-515, disposal all take the asset's row lock `FOR UPDATE` as their first read, so they
serialise. Two more writers change an asset's depreciation without it:

1. `retireAssetFromVoidedExpense` (capitalize.ts:322-363): finds the asset with `findBySourceExpense` (unlocked), reads
   its posted depreciation entries, reverses each, then `markDisposed`. If a depreciation run has posted March but not
   committed, the retire reads only Jan/Feb, reverses those, and `markDisposed` (which only checks `status = 'active'`)
   passes once the run commits: a retired (disposed) asset keeps a LIVE March depreciation entry.
2. `setAssetInService` (in-service.ts:271-297): reads the asset with plain `getById`, plans which posted entries the new
   in-service date would reverse (`planInServiceReversal`), reverses them, writes the new date. A run committing March
   in between leaves March posted on the OLD schedule while the asset now has the new date; and the person's
   `confirmedPlan` token covered only the entries they saw.

## 2. Ruling (planner, AUDIT)

Same ruling as T-515: take the asset row lock FIRST, then judge on what the other writer committed.

1. `retireAssetFromVoidedExpense`: after `findBySourceExpense` (it only maps expense -> asset id), re-read the asset with
   `fixedAssetsRepo.getByIdForUpdate(tx, actor.orgId, found.id)` and use THAT row for the existing "no asset / not active:
   return `{ assetId, depreciationEntriesReversed: 0 }`" branch. Everything after (entries read, reversals, `markDisposed`)
   unchanged and in the same order. The no-asset branch keeps `assetId: asset?.id ?? null`.
2. `setAssetInService`: replace `fixedAssetsRepo.getById` with `getByIdForUpdate`. Authorize and the blank-reason check stay
   first, as today; every later step is unchanged. Result under a race: the plan is computed after the run commits, so a
   stale `confirmedPlan` gets the existing "What this would reverse has changed since you confirmed" refusal with the new
   token (the designed behaviour), and an unconfirmed call gets the normal confirm-to-proceed refusal.

Lock order: the asset row first, before any journal write, on both callers (`void.ts` calls retire after its own expense
reads; the asset lock is the only lock retire adds). No cycle with depreciate / terms / dispose / book-missed-month.

3. `setStoreOpeningDate`'s cascade (stores/service.ts:344-359; folded in by BOSS 4 Nov, same root cause): it lists
   store-opening followers with `listAssets` (unlocked), plans and reverses their depreciation. After the list, lock each
   follower in ASCENDING ID ORDER (`getByIdForUpdate`, so two cascades on one store cannot deadlock; different stores own
   different assets), re-read, and keep only rows still `status = 'active'` and `inServiceSource = 'store_opening'`; the
   plans use those locked rows. The `affected` / `requireConfirmedPlan` / `executeReversals` / `updateStore` steps are
   unchanged, in the same order. A stale `confirmedPlan` after a concurrent run gets the existing "has changed since you
   confirmed" refusal.

Out of scope, reported only: `reverseEntry` itself takes no asset lock (its callers now do). Not changed.

## 3. Changes

1. `packages/domain/src/fixed-assets/capitalize.ts` `retireAssetFromVoidedExpense`: locked re-read as in 2.1, one-line
   comment (`T-516: asset lock first, shares it with depreciate/terms/dispose`).
2. `packages/domain/src/fixed-assets/in-service.ts` `setAssetInService`: `getById` -> `getByIdForUpdate`, same comment.
3. `packages/domain/src/stores/service.ts` `setStoreOpeningDate`: lock-and-re-read followers as in 2.3, one-line comment.
4. New test file (below). Nothing else.

## 4. Tests (write FIRST, show red on unchanged code, then fix)

Integration, real PostgreSQL on `shareat_test_audit516` (never shareat_test or shareat_dev; never print `.env.local`).
File `packages/domain/tests/integration/t516-asset-lock-retire-and-in-service.test.ts`. Copy the fixture and two-transaction
`race()` helper of `packages/domain/tests/integration/t515-dispose-asset-lock.test.ts` (A holds open after its work; B
starts after A signals; B must still be pending after ~700 ms; release A; await both). For the retire tests the asset
must be linked to an expense: see how `t440-s6-money-refusals.test.ts` / `t346-in-service-date.test.ts` create a
capitalised asset or one with `source_expense_id`; reuse that, do not invent a new fixture path.

- (a) RED-FIRST, retire. Asset (linked to expense E) active, Jan and Feb depreciation committed. A: March run, posted, held.
  B: `retireAssetFromVoidedExpense` for E. Release A. Assert FINAL STATE: B waited; asset `disposed`; EVERY depreciation
  entry for the asset is reversed (Jan, Feb AND March: count of live depreciation entries = 0, 1590 net zero for the
  asset); `depreciationEntriesReversed` = 3. On unchanged code March stays live and this fails.
- (b) RED-FIRST, in-service. Same asset (in-service date changeable, e.g. source acquired -> a date that changes every
  month's amount). B: first `setAssetInService` without a token to get the plan token for Jan+Feb (read the refusal's
  `planToken`), in a separate committed transaction BEFORE the race. Then A: March run, held. B: `setAssetInService` with
  that stale token. Release A. Assert: B waited, B refused with `/What this would reverse has changed since you confirmed/`,
  in-service date unchanged, no entry reversed, Jan/Feb/Mar all still live. On unchanged code B commits having reversed
  only Jan+Feb and this fails.
- (c) Opposite order, retire: B (retire) holds open after reversing and `markDisposed`; A's March run starts and waits;
  release B; A posts nothing (asset disposed). Asset `disposed`, no live depreciation entry. Regression guard (may pass
  before and after).
- (e) RED-FIRST, cascade. A store with a `store_opening` follower asset, Jan/Feb depreciation committed. Plan token for
  Jan+Feb obtained beforehand from the unconfirmed refusal of `setStoreOpeningDate` (committed, separate transaction).
  A: March run on the follower, held. B: `setStoreOpeningDate` to the new date with that stale token. Release A. Assert: B
  waited; B refused with `/has changed since you confirmed/`; store opening date unchanged; nothing reversed; Jan/Feb/Mar
  all live. Unchanged code: B commits having reversed only Jan+Feb, March stale; red.
- (d) Existing behaviour: `t346-in-service-date.test.ts`, the store opening-date tests (grep `setStoreOpeningDate` under tests), `t368-*`, `t440-s6-money-refusals.test.ts`, the expense void
  tests and `fixed-assets.test.ts` stay green unchanged.

Exact counts, balances and message patterns; no bare `rejects.toThrow()`.

## 5. Checks
- Root `npm run typecheck` clean.
- New file red on unchanged code, green after (3 repeat runs), plus every integration file under
  `packages/domain/tests/integration` whose name matches fixed-asset|t346|t368|t392|t398-s2-dep|t440-s6|void on the
  dedicated DB.
- Unit guards/census (`tests/unit/*guard*`, `*census*`, app-boundaries, t371 numeric-write guard). If the full unit suite
  times out on this disk, re-run the failed files with `--maxWorkers=2 --testTimeout=120000`.
- LF endings, no CR bytes. `git diff --stat`: the two sources, the new test, this spec only.

## 6. Acceptance
Retire-from-voided-expense, in-service change and the store opening-date cascade serialise with the depreciation run on the asset row; whichever commits
second judges on the other's committed result; no committed state has a disposed asset with a live depreciation entry or
depreciation posted on a schedule the asset no longer has. `reverseEntry` stays as is (callers lock).

## 7. Built notes (4 Nov)
- (b) and (e) on UNCHANGED code: the DB guard `fixed_assets_in_service_b_guard` already catches the stale write ("already has
  depreciation posted for 2026-03; reverse it before moving its in-service date") and rolls B back, so no bad state was ever
  committed on those two paths. The lock still matters: B now judges after the run commits and gives the designed "has changed
  since you confirmed" refusal (with the new token) instead of a late database error. The tests assert that message, so they
  are red on old code for the right reason. (a) retire has NO database backstop: on old code a disposed asset kept March live.
- Reported, not fixed (builder, read-only): `bookMissedMonth` (missed-months/index.ts:114-143) reads the asset with plain
  `getById` and judges status/charge BEFORE `lockAssetRow` (line 143) and never re-reads after it, so a dispose/retire/in-service
  change committing in that gap lets it book a charge on a disposed asset or the old schedule. `valuateShell`
  (cutover/opening-assets.ts:81) takes no lock but only updates `pending_valuation` rows (low risk). `reverseEntry` takes no
  asset lock itself; its depreciation callers now all do.
- Sonnet audit: SHIP. LOW, accepted: two writers that each lock SEVERAL assets (the store cascade, ascending asset id, and
  voidInvoice with 2+ capitalised expenses, which reaches assets in expense order) could cross and deadlock; Postgres aborts
  one request, nothing corrupts. Not worth fixing now. An asset that becomes a follower after the list is taken is still caught
  by the DB guard trigger.
