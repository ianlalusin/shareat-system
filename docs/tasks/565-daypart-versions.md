# T-565: a queued order is judged by the daypart window in force when the tablet took it (audit MC-002)

**Status:** SPEC 2026-11-11 (AUDIT). Number and migration from the orchestrator: **T-565, migration 0251**, with `when` =
0250's `when` + 86400000. 0250 is T-564 (settlement renumber) and 0249 is T-557; both must reach main first. Build now, and
set the final journal entry at merge time. Ian's ruling "b" (11 Nov). The design was approved by BOSS: server-side dated
versions, plus the version saved on each line. Ian also ruled that dayparts stay fully admin-configured (add, edit or retire
ANY window, for example Breakfast), so nothing here may assume lunch and dinner only. Source:
`shareat-audits/OPEN/2026-11-09-menu-cache.md` MC-002. Branch `audit/t565-daypart-versions`, worktree `wt-audit-t565`.
Follow `docs/decisions/ADR-012-hand-authored-migrations.md` §5. Classify the new table in
`packages/db/src/cutover/classification.ts` AND `packages/db/src/rls/registry.ts`.

## 1. Problem

`menu_dayparts` (`packages/db/schema/menu.ts:451-495`, migration 0233) is edited in place (`repo/dayparts.ts:69`, domain
`menu/dayparts.ts:118`). Every reader uses the CURRENT window:
- `menu/daypart.ts:166/239/290`
- `live-offers.ts:134-148`
- `load-store-menu.ts:12-30`
- POS `order.ts` `MenuAt` :59-74, with `.at(device time)` at :162 and :452

So an order taken offline under the old window is refused ("pos: outside hours", `order.ts:88`), or priced differently,
when it syncs after a manager edits the window. Offers are already versioned by `effective_from`; windows are not.

## 2. Design

1. **New table `menu_daypart_versions`.** Columns: `id` (uuidv7), `org_id`, `store_id`, `daypart_id`, `name`, `days`,
   `start_time`, `end_time`, `status`, `valid_from timestamptz`, `valid_to timestamptz NULL`. It copies the window columns
   and checks from `menu_dayparts`, with a same-org composite FK to `menu_dayparts (store_id, id)`, and these rules:
   - append-only: no UPDATE except setting `valid_to` once from NULL, and no DELETE;
   - at most one open version per daypart (a unique partial index where `valid_to IS NULL`);
   - RLS like `menu_dayparts`.
2. **Backfill in 0251.** One open version per existing daypart, `valid_from` = the daypart's `created_at`. A retired daypart
   gets a version with status 'retired', or a closed one; choose whichever keeps "as of" lookups right before and after
   retirement, and test both.
3. **Writers** (domain `createDaypart`, `updateDaypart`, `retireDaypart`, in the same transaction, SQL in the repo):
   - create opens version 1;
   - update closes the open version (`valid_to = now`) and opens a new one;
   - retire does the same with status retired.
   `menu_dayparts` stays as the current row, so existing FKs, offers and screens are unchanged.
4. **Readers take an as-of time.**
   - Add a repo read `listDaypartWindowsAsOf(tx, orgId, storeId, at)`: the version in force at `at`, meaning
     `valid_from <= at < coalesce(valid_to, infinity)`.
   - `loadStoreMenu(..., at)`, and therefore `MenuAt.at(device time)` in POS orders and refills, must judge by those
     windows.
   - When `at` is now, the result must equal today's current windows, so the tablet snapshot and the price screens are
     unchanged.
   - Grep every reader of `days`/`startTime`/`endTime` and `daypartsRepo` (including `menu/pricing.ts`). List each one and
     say whether it uses as-of or current, and why.
5. **Save the version on the line.**
   - Add a nullable `daypart_version_id` to `table_session_lines` (same-org FK, or a declared no-FK exemption with a
     reason).
   - When `writeLines` or `requestRefill` judge a dayparted offer, store the version they used. It stays NULL for all-day
     offers.
   - Receipt lines are left alone; they reach the session line through `session_line_id`.
6. **Any number of dayparts.** Nothing keys on names or counts. The tests use three windows: Breakfast, Lunch, Dinner.

## 3. Tests (first, red on the old code; real PostgreSQL on the worktree's `_test` DB)

- An order taken at 11:30 under a Lunch window 11:00-14:00; the manager then moves Lunch to 12:00-15:00; replay with device
  time 11:30. Accepted at the OLD price. The line's `daypart_version_id` = the old version.
- The same, but the order is taken after the edit at 11:30: refused, outside hours.
- Retire Breakfast after a queued breakfast order: the queued order is still judged by the version in force then.
- A new daypart added after the order does not affect it.
- At "now", the windows and the snapshot equal the current rows, for 3 dayparts.
- Append-only: a direct UPDATE of a version's window or a DELETE is refused. Two open versions for one daypart are refused.
- Backfill: every existing daypart has exactly one correct version.
- Isolation: org A cannot read or write org B's versions.

## 4. Checks

Because this has a migration, the FULL suite is the gate: CI, plus locally a fresh DB built from zero with 0249/0250 present
(merge or stack their branches locally for the test only). Run root typecheck; the guard and census files, re-measured with
their tools; the migration-journal test; the ADR-012 checklist; and the classification/registry guards. No CR or control
bytes.

## 5. Acceptance

Editing, adding or retiring any daypart never changes how an order already taken is judged. Each POS line records the
window version it was judged by. Current menus and prices are unchanged. MC-002 closes after merge.
