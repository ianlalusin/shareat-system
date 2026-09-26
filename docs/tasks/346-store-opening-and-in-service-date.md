# T-346: a store's opening date, and an asset depreciates from the day it is in service (DEF-428, DEF-427)

**Status:** DONE 2026-09-26 (S1 1ac1bca, S2 78350ce, S3 this commit; each screen-tested with real sign-in). APPROVED 2026-09-25 (orchestrator, after independent Opus spec review; its 11 CHANGES folded in as Amendment R1, which wins where the body differs). Ian: build both before launch. **Builds after T-345 lands** (it changes the schedule
T-345 derives from; one migration per cycle, DEF-091). **Migrations:** S1 `0162`, S2 `0163` (**orchestrator claims 0163**); S3 none. Journal `when` = previous + 86 400 000.
**Closes:** DEF-428 (`docs/DEFECTS-REGISTER.md:635`) with S1+S3, DEF-427 (`:634`) with S2. Discharges T-345 §7's DEF-427 residual.
**Model:** Sonnet, both roles, per slice. TESTER writes first and records red; BUILDER second; paths disjoint (§5).

> **Naming:** `stores.opening_date`, not the register's `opened_on`. A future value is a *planned* opening, which `opened_on`
> would misstate, and `finding_occurrences.opened_on` (`schema/findings.ts:111`) already means "first observed". v1's word too.

---

## 1. Goal (bible §1.2d)
1. **v1 at source.** A store has `openingDate` and a four-value `status` including `under_construction`
   (ERP-rebuild `src/types/index.ts:95`, `:165`). A new store is born `under_construction` with `openingDate: null`
   (`src/lib/client/store.client.ts:29`, `:35`). The date is display-only (`store-editor.tsx:78`,
   `store-details-client.tsx:252`); nothing reads it. v1 depreciation charges every `status == 'active'` asset in the month
   run (`src/lib/actions/depreciation.actions.ts:85`), with no look at the store's status or the asset's in-use date.
2. **Goal:** know when each store opens; charge an asset's depreciation only from when it is available for use (PAS 16);
   never let a pre-opening store look like a dormant one.
3. **Live data.** v1 Firestore is not countable from here. The orchestrator runs a read-only count of v1 stores by `status`
   and non-null `openingDate` at cutover. On `shareat_dev` (read-only query, 2026-09-25) there are 5 stores, **0 fixed assets and
   0 depreciation entries**. LIP's first ledger line (2026-08-03) is before its `created_at` (2026-08-31), so `created_at` is
   **not** an opening proxy. `fixed_assets` is `keep_shell` with `acquired_on` cleared (`cutover/classification.ts:565-567`), so
   **no asset carries a depreciation posting on 1 January**. The "already depreciating" case (§3.4) is post-launch correction only.
   ⛔ v1's `openingDate` is unread and defaults null, so it is evidence of the NEED only. It is not a source to port.
4. **v2 bar.** One opening date per store (null = not yet open, future = planned), set by an admin. An asset at a store that
   has not opened is *held*: on the books at cost in 1510, depreciating nothing, and visibly waiting. Its schedule starts the
   month the store opens. Posted history is never rewritten; a correction reverses, in an open month.

## 2. Evidence (static read, HEAD `1e7862c` + T-344/T-345 specs)
- Schedule starts at `acquiredOn` (`fixed-assets/schedule.ts:41-42`, `:81-86`). `scheduleInputFor` feeds it from `acquired_on`
  (`depreciate.ts:71-80`). Period label = the LAST month of the period (`shared/straight-line.ts:77-82`), so a start shift
  moves the labels of quarterly, semiannual and annual assets.
- Key `asset:{id}:depreciation:{P}`, unique per org (`depreciate.ts:142`; `schema/journal.ts:110-112`). A reversed entry
  keeps its key, so its month cannot be re-booked (**DEF-435**). Accumulated depreciation = the 1590 net, reversal-safe
  (`repo/fixed-assets.ts:383-409`). `reverseEntry` flips posted→reversed (`ledger/reverse-entry.ts:36`, `:121`).
- **CIP account:** none. `chart-of-accounts.ts:159-167` seeds 1510 and 1590 only, and 1520/1530 are "deliberately NOT seeded ...
  a reserved NUMBER GAP" (bible §4.4, §16.9). POSTING-PATTERNS has `asset_purchase.cash/credit` → DR 1510 (`:1046-1065`) and
  no CIP or reclass pattern.
- **Stores:** `schema/stores.ts:48-146` has no date; `createStore` is the only production insert (`stores/service.ts:97-170`);
  `storeReadiness` is derived (`:475+`). Stores are plain `keep` (`classification.ts:69-72`, bible row 182). The ETL converts
  ledger legs and resolves `storeCode` → `stores.id` (`packages/etl/src/convert.ts:116-119`). **No ETL path writes `stores`.**
- **Absence-sensitive readers** (`repo/findings.ts`): `tillFloatOffTarget` (`:506`) fires on a float target versus a zero
  balance, which is wrong for a pre-opening store. `periodicPostingsMissed` (`:185-188`) counts every `active` asset as
  "still depreciating". Activity-driven, so unchanged: `salesDayUnposted` `:1594`, `posUsagePullNotRun` `:1551`,
  `usageRecordMissing` `:1844`, `remittanceOverdue` `:449`, `attendanceConfigMissing` `:1993` (config is needed BEFORE
  opening), and the attendance sweep (`scheduler/index.ts:342`).
- **Capabilities:** `manage_stores` (org; admin ✅, manager ✗; "Opening or closing a BRANCH", `CAPABILITY-MATRIX.md:140`),
  `manage_fixed_assets` (org; admin ✅, manager ✗, `:156`). No new capability is needed.
- **Seen in passing (candidate DEF, orchestrator):** `updateTermsAction` (`apps/erp/src/app/fixed-assets/actions.ts:82-106`,
  `repo/fixed-assets.ts:306-322`) changes life, interval and salvage on an asset that already has postings. That changes the
  amounts of posted months and orphans posted quarterly keys, with no guard: the same class as §3.4. It is not fixed here.

## 3. Design
### 3.1 S1: migration `0162_t346_store_opening_date.sql` (hand-authored, ADR-012 §5)
`ALTER TABLE stores ADD COLUMN opening_date date;`. Backfill every existing store to
`store_first_trading_date(id)`: R1.3's definition (the earliest non-voided sales day or posted `source_type='sale'` entry with a line at the store; a reversed sale does not count), or NULL if it has neither (R3.4). The backfill runs under `SET LOCAL row_security = off`, so a migrating role that cannot bypass RLS fails loudly instead of matching zero rows; production migrates as `doadmin`, which bypasses RLS (`docs/ops/README.md:61`). The header states this (R3.2).
An existing trading store is therefore open from its first recorded activity. Header: the only data it writes, and why.
Mirror the column in `schema/stores.ts`, with the comment "null = not yet open; future = planned".
**Pre-opening predicate (one definition; S1 ships the TS twin used by `storeReadiness`, the `repo/stores.ts` `isPreOpening` SQL fragment lands with S3 where its readers are — R2.3):**
`opening_date IS NULL OR opening_date > (now() at time zone 'Asia/Manila')::date` (DEF-283).

### 3.2 S1: domain `stores/service.ts`
- `CreateStoreInput.openingDate?: string | null` (absent = NULL).
- **`setStoreOpeningDate(tx, actor, storeId, { openingDate: string | null, confirmReversal?: boolean })`**: (1)
  `authorize('manage_stores', {})`; (2) once the store has traded (R1.3: a non-voided sales day or a posted `source_type='sale'` entry; a construction-period expense is not trading), refuse NULL or any date after its first trading date (R3.6; this covers R2.1's future dates): `{store} has traded
  since {date}; its opening date must be on or before that`. The value must be a real `YYYY-MM-DD` date, checked before any comparison (R3.1); (3) from S2 on, apply §3.4 to each follower asset, all or nothing.
- `storeReadiness` gains `openingDate` (manual, **non-blocking**). Its detail is `Opens {date}`, `Opened {date}`, or
  `Not yet open — no opening date set` (R2.2; S2 adds the depreciation effect).

### 3.3 S2: migration `0163_t346_asset_in_service.sql`: CIP as a STATE, not an account
**Decision (planner, not Ian's):** no 1520 "Construction in progress" account, no reclass entry at in-service. PAS 16 CIP
is PPE at cost, undepreciated: exactly 1510 with zero 1590. A new account breaches the COA no-fabrication rule
(`chart-of-accounts.ts:159-164`) and adds N reclass postings; its disclosure is derived instead (register subtotal, §3.6).

Migration steps, in order:
1. `ADD COLUMN in_service_on date`, `ADD COLUMN in_service_source text CHECK in ('acquired','store_opening','set')`.
2. Backfill: shells stay NULL/NULL; others `'acquired'`, `in_service_on = acquired_on`. **Zero existing schedules change.**
3. `CHECK fixed_assets_in_service_shape_check`: `pending_valuation` ⇒ both NULL; else source NOT NULL; `'acquired'` ⇒
   `in_service_on = acquired_on`; `'set'` ⇒ NOT NULL; always `in_service_on IS NULL OR in_service_on >= acquired_on`.
4. **Fill trigger** `fixed_assets_in_service_a_fill` (R1.1), `BEFORE INSERT OR UPDATE OF acquired_on, store_id, in_service_source, status`,
   non-shell rows. In the DB (RULES §6.3), so every writer gets it (`createAsset`, `capitalizeFromExpense`, `valuateShell`,
   raw fixtures). Source NULL with `in_service_on` supplied ⇒ `'set'`, value kept (R1.8); source NULL and no value ⇒
   `'store_opening'` if the store's `opening_date IS NULL OR > acquired_on`, else `'acquired'`;
   `'acquired'` ⇒ `in_service_on := NEW.acquired_on` (re-derived on every INSERT and on an UPDATE that corrects `acquired_on`), EXCEPT when the statement itself supplies a different date — on INSERT a non-NULL value ≠ `acquired_on`, on UPDATE `NEW.in_service_on IS DISTINCT FROM OLD.in_service_on AND NEW.in_service_on <> NEW.acquired_on` — which raises (R4.2)
   `fixed_assets: an in-service date on the acquisition date must equal it`, never overwritten silently (R1.8);
   `'store_opening'` ⇒ `greatest(stores.opening_date, acquired_on)` (NULL
   while the store has no date); `'set'` ⇒ the supplied value, untouched.
5. **History guard** `fixed_assets_in_service_b_guard` (R1.1), `BEFORE UPDATE` with **no column list** and
   `WHEN (OLD.in_service_on IS DISTINCT FROM NEW.in_service_on)`, so it also catches a move made by the fill (a
   `store_id`/`in_service_source`/`status` update) or by step 6's propagation. Postgres fires same-timing triggers by name,
   so `_a_fill` runs before `_b_guard` (or merge both into one function). It raises
   `fixed_assets: {name} already has depreciation posted for {P}; reverse it before moving its in-service date`
   when a `status='posted'` `source_type='depreciation'` entry for the asset has a posted month that is illegal. The month
   comes from the KEY (`asset:{id}:depreciation:{YYYY-MM}`), never `entry_date`: T-345 catch-ups are dated on the booking
   day and quarterly entries at period end (`shared/straight-line.ts:77-82`) (R1.2). A key month is illegal when
   `NEW.in_service_on` is NULL; when it is before the month of `in_service_on` (monthly), or its period began before that
   month (interval > 1: `key month − (step−1) months`) (R1.2); or when it is after the new final period,
   `in-service month + ceil(life/step)·step − 1` (R1.5). The amount check stays in the domain (§3.4).
6. **Propagation trigger** `stores_opening_date_propagate`, `AFTER UPDATE OF opening_date ON stores`. It re-runs step 4's fill
   for the store's `'store_opening'` rows. Step 5 therefore refuses the whole store update if any follower would move past
   a posted month.
7. **Cutover:** add `in_service_on` and `in_service_source` to `fixed_assets.clearColumns` (`classification.ts:567`), or the
   shell violates step 3.

Mirror the columns and the CHECK in `schema/fixed-assets.ts`, and name the three triggers in comments. `ScheduleInput.acquiredOn` is
renamed **`startsOn`**. `scheduleInputFor` returns null when `in_service_on` is NULL (a held asset owes nothing), else starts
from `in_service_on`. `periodDue` and `depreciationDrift` follow automatically. T-345 does NOT: `missed-months/index.ts:55`
has its own private `assetScheduleInput()` built from `acquired_on` (a copy of `depreciate.ts:71`), so `bookMissedMonth`,
`missedMonths` and its §3.3 close filter would keep the old start and I10 could not pass. The S2 BUILDER exports
`scheduleInputFor` from `fixed-assets/depreciate.ts` and replaces `assetScheduleInput` with it: one schedule input, one
definition (R4.1).

### 3.4 S2: an asset already depreciating: reverse, never rewrite; refuse what cannot be re-booked
**Recommendation (not an Ian question):** closed books are never touched (bible row 193), and the correction convention already
exists: reverse in an open month with a `[prior period]` memo (T-106; `POSTING-PATTERNS.md:1220-1241`). The planner therefore
chose "reverse and keep" over refusing outright. It never re-posts: a still-owed month whose amount differs (the last period
takes the remainder, `straight-line.ts:71`) is refused by step 3, not re-booked (R1.5).

**`setAssetInService(tx, actor, assetId, { mode: 'acquired'|'store_opening'|'set', inServiceOn?, reason, confirmReversal? })`**
(new file `fixed-assets/in-service.ts`). It runs in one transaction; any refusal writes nothing.
1. `authorize('manage_fixed_assets', {})`; refuse a blank reason; the asset must be `active`.
2. E = every `posted` depreciation entry for the asset, by key month. Keep each E owed by the new schedule at an equal
   amount; every other E goes into **R** (to reverse).
3. If any month the new schedule owes has its key in R, or already held by a reversed entry, refuse (**DEF-435**):
   `{name}: {P} would need re-booking at {amount}, which this cannot do yet (DEF-435)`.
4. If R is non-empty and `!confirmReversal`, refuse and list the months with the total. The screen then shows a confirm
   button: `Setting {date} reverses {n} depreciation entries ({P1}–{Pn}, ₱X) in {current month}`.
5. `reverseEntry` each R, passing `reversalDate` = Manila today ONLY when the original's period is not open (otherwise
   `reverseEntry` dates it on the original's own date). The reason carries NO prefix: `in-service date corrected to {date} —
   {reason}`; `reverseEntry` adds `[prior period] ` itself for a closed period (`ledger/reverse-entry.ts:140-158`) (R1.4).
   This includes T-345 catch-up entries: their `missed_month_adjustments` link stays (immutable), pointing at a reversed
   entry, and T-345 already answers that honestly (`/reversed; this task cannot re-book it/`).
6. Write the columns. The §3.3 guard is the backstop.

Moving EARLIER can reverse too (R1.5): the schedule ends earlier and the last period takes the remainder
(`straight-line.ts:71`), so posted months past the new end are no longer owed (step 2 puts them in R), and the new last
month's amount can differ (step 3 refuses, DEF-435). The §3.3 step 5 guard also refuses a posted key month after the new
final period. The newly owed months post on the next run if their period is open; if closed, T-345's
"Scheduled charges missed in closed months" lists them. `setStoreOpeningDate` (§3.2 step 3) applies steps 2-6 to every
follower, with one confirm listing every asset.

### 3.5 S3: honouring the opening date (every reader named)
| Reader | Change |
|---|---|
| `repo/findings.ts` `tillFloatOffTarget` (`:506`) | suppressed only when the store is pre-opening AND the balance is exactly 0; any non-zero drift still fires (R1.6) |
| `repo/findings.ts` `periodicPostingsMissed` (`:185-188`) | count assets with `in_service_on <= last day of P`; none ⇒ no finding |
| new soft detector `openingDateContradicted` (`repo/findings.ts` + `findings/index.ts` + `apps/erp/src/app/findings/lib.ts` title) | a store with a sales day while `opening_date` is NULL or later than it: `{store} recorded sales on {d} but {opens on {o} \| has no opening date}; set its opening date — its assets depreciate from it`. **Soft**, so not a close gate (ADR-006 §7 is a closed list) |
| `reports/store-comparison.ts` + its page | each column carries `openingDate`; the header shows `Opened {d}` / `Pre-opening`; the figures are unchanged (pre-opening costs are expensed, PAS 16 ¶19) |
| new soft detector `assetHeldPastOpening` (`repo/findings.ts` + `findings/index.ts` + `apps/erp/src/app/findings/lib.ts` title) (R1.7) | an active asset with `in_service_source = 'store_opening'`, `in_service_on IS NULL`, `acquired_on` more than 30 Manila days ago, whose store has `opening_date` NULL or a past `opening_date` with no non-voided sales day on or after it: `{asset} at {store} has been waiting {n} days to go into service; {store} {has no opening date \| was due to open on {d} and has recorded no sales}`. **Soft**, never blocks the close |
| unchanged, on purpose | §2's activity-driven detectors, the attendance sweep, and the balance sheet (held cost is PPE) |

### 3.6 Screens (familiar-but-upgraded, bible §1.2c; names never ids, DEF-417)
- **`/admin/stores` create + `/admin/stores/[id]`:** `Opening date` ("Leave blank if it has not opened. The first day this store trades." — R2.2; S2 adds the depreciation sentence); its own `setStoreOpeningDateAction` (S2 adds the §3.4 confirm; S1 has none, R3.5). The list badge has three states from `isPreOpening`: `Not yet open` / `Opens {d}` / `Opened {d}` (R3.3).
- **`/fixed-assets/new`:** an "In service" choice: `When {store} opens ({date} | not set yet)` (the default when the store
  is pre-opening), `On the acquisition date`, `On a date: [ ]`.
- **`/fixed-assets/[id]`:** `In service from {date}`, or `Not yet in service — waits for {store} to open`. A change form takes
  a mode, a date and a reason, and leads to the confirm. Its `buildSchedule` call (`[id]/page.tsx:52`) starts from
  `in_service_on`; a held asset shows no schedule, only "Not yet in service" (R1.10).
- **`/fixed-assets` register:** a "Not yet in service" group with a cost subtotal (the CIP disclosure).

## 4. Tests (TESTER, real Postgres, raw red; real `authorize()`; every ⛔ asserts nothing was written)
Fixture: an asset with cost 24,000, 24 months, monthly, salvage 0 (so 1,000 a month), acquired 2026-03-15. Periods are open
2026-01 → current + 1.

| # | Slice | Case | Positive / ⛔ Negative | Expected red |
|---|---|---|---|---|
| O1 | S1 | `createStore` with and without `openingDate` | the date is stored / NULL | `column "opening_date" does not exist` |
| O2 | S1 | `setStoreOpeningDate` admin; super_admin | resolves. ⛔ a manager holding `manage_store_settings` at the store, and staff → `/may not 'manage_stores'/` | `not a function` |
| O3 | S1 | clear to NULL after a sales day | ⛔ `/has traded since/` | as O2 |
| O4 | S1 | readiness | the `openingDate` row is non-blocking, with each of the three details | missing key |
| M1 | S1 | migration (scratch DB, the `position-access-backfill` technique) | first sale 08-03 + first line 08-01 → 08-01; ⛔ a store with no activity → NULL | locate `t346` fails |
| I1 | S2 | asset at a store with no date | `store_opening`, NULL; the run through 2026-09 posts nothing. ⛔ no 6700 line | column missing |
| I2 | S2 | then `setStoreOpeningDate(2026-10-01)` | follower `in_service_on` 10-01; the run through 10 posts only 2026-10 = 1,000. ⛔ no 03..09 | as I1 |
| I3 | S2 | store open since 2025-01-01 (guard) | `acquired`; posts from 2026-03 | none |
| I4 | S2 | acquired 2026-11-02, store opens 10-01 | `acquired` | as I1 |
| I5 | S2 | `set` 2026-12-01 | first period 2026-12. ⛔ `set` 2026-03-01 (before acquired) → 23514 | as I1 |
| I6 | S2 | open store, 03..10 posted, then 2026-03..05 closed (06+ open); `setAssetInService(set 10-01)` | ⛔ without confirm → lists 7 months, ₱7,000. With confirm: 7 reversals; 03..05 dated today with `[prior period]` in the memo, 06..09 each dated in its own month with no prefix (R1.4); 2026-10 kept; accumulated 1,000; `depreciationDrift` empty | `not a function` |
| I7 | S2 | earlier: store 10-01 → 08-01 after Oct posted | the run posts 08, 09. ⛔ no second 10 | as I1 |
| I8 | S2 | DEF-435: 1,000.00 over 3 months, `set` Feb, Feb..Apr posted; move to Jan | ⛔ `/DEF-435/` (Mar's owed 333.34 ≠ posted 333.33); nothing reversed | as I6 |
| I9 | S2 | DB, APP role, raw SQL | an insert with no in-service columns is filled both ways; (R4.2) correcting `acquired_on` on an `'acquired'` asset re-derives `in_service_on`; ⛔ the same UPDATE also supplying a conflicting `in_service_on` raises; source NULL with `in_service_on` supplied → `'set'`, value kept (R1.8). ⛔ `acquired` with a value ≠ `acquired_on` → `/must equal it/` (R1.8); a shell with a source → 23514; UPDATE later past a posted month → the named guard error; `store_id` changed to a store that opens later → guard error (R1.1); a store `opening_date` update propagating a follower past a posted month → guard error naming the asset (R1.1); a T-345 catch-up keyed 2026-04 and dated 2026-09, then in-service moved to 2026-06 → refused (R1.2); a quarterly asset with key 2026-06 (period Apr–Jun) moved to 2026-05 → refused (R1.2) | column missing |
| I10 | S2 | T-345: a held asset | `bookMissedMonth(2026-04)` → `/owes nothing for 2026-04/`; `missedMonths` omits it. A T-345 adjustment for 04, then a correction to 10-01 → its entry is reversed; the link count is still 1 | as I1 |
| I11 | S2 | `setAssetInService` by a manager, staff; super_admin | ⛔ `/may not 'manage_fixed_assets'/`; resolves | as I6 |
| I12 | S2 | dispose a held asset | loss = full cost. ⛔ no 1590 | as I1 |
| I13 | S2 | R1.5: 3-month asset, cost 3,000, `set` 2026-02, Feb–Apr posted; move to 2026-01 | with confirm, Apr is reversed and the next run posts Jan; ⛔ Feb/Mar untouched. Same asset at cost 1,000 (Mar owed 333.34, posted 333.33) → ⛔ `/DEF-435/`, nothing reversed. ⛔ the raw UPDATE → guard error (Apr past the new end) | as I6 |
| R1 | S3 | `tillFloatOffTarget` on a pre-opening store with a target and a zero balance | ⛔ no finding; after the date passes → a finding. A pre-opening store with a balance of 500 → finding present (R1.6) | finding present |
| R2 | S3 | 2 active assets, 1 held | detail `1 asset(s)`; only held assets → no finding | `2 asset(s)` |
| R3 | S3 | a sale on 09-20 at a store opening 10-01; a NULL date with a sale | the soft finding names the store and dates. ⛔ a sale after opening → none; not in `closeReadiness.blocking` | kind unknown |
| R4 | S3 | store comparison | `openingDate` per store. ⛔ totals byte-identical to before | property missing |
| R5 | S3 | `assetHeldPastOpening` (R1.7) | fires at 31 days. ⛔ not at 29; ⛔ not once the asset is in service | kind unknown |

C1 (cutover purge) is removed (R1.9): it fails for DEF-437, which owns its proof in its own task. §3.3 step 7's
`clearColumns` edit stays.

Files: `packages/domain/tests/integration/t346-store-opening-date.test.ts` (O, S1),
`packages/db/tests/integration/t346-migrations.test.ts` (M1 in S1; I9 appended in S2 — R1.9),
`packages/domain/tests/integration/t346-in-service-date.test.ts` (I), `packages/domain/tests/integration/t346-opening-readers.test.ts` (R).

## 5. Paths (disjoint per slice; S2 after S1 lands, S3 after S2)
**S1 TESTER:** O and M1 files. **S1 BUILDER:** `migrations/0162_*` + `meta/_journal.json`; `schema/stores.ts`; `repo/stores.ts`;
`domain/stores/service.ts`; `apps/erp/src/app/admin/stores/{page.tsx,actions.ts,lib.ts,[id]/page.tsx}`.
**S2 TESTER:** I (incl. I13), I9 (C1 removed, R1.9); `tests/unit/depreciation-intervals-parity.test.ts` and
`packages/domain/tests/depreciation-schedule.test.ts` (the `acquiredOn` → `startsOn` rename, R1.10); fixture helpers only where the red is "held" (give the fixture store an `opening_date`):
`fixed-assets.test.ts`, `findings.test.ts`, `scheduler.test.ts`, `remittance.test.ts`, `money-accounts.test.ts`,
`t344-create-missing-period.test.ts`, `t345-missed-month.test.ts`. List each one in the report.
**S2 BUILDER:** `migrations/0163_*` + journal; `schema/fixed-assets.ts`; `repo/fixed-assets.ts`;
`domain/fixed-assets/{schedule.ts,depreciate.ts,capitalize.ts,in-service.ts(new),index.ts}`; `domain/stores/service.ts`
(§3.2 step 3); `domain/missed-months/index.ts` (**carve-out, R4.1:** replace `assetScheduleInput` with the exported
`scheduleInputFor`, that one function only); `db/src/cutover/classification.ts` (clearColumns only); `apps/erp/src/app/fixed-assets/{page.tsx,lib.ts,actions.ts,new/page.tsx,[id]/page.tsx}`.
**S3 TESTER:** the R file. **S3 BUILDER:** `repo/findings.ts` (four functions, incl. `assetHeldPastOpening`, R1.7); `domain/findings/index.ts`; `apps/erp/src/app/findings/lib.ts`;
`domain/reports/store-comparison.ts`; `apps/erp/src/app/reports/store-comparison/page.tsx`.
⛔ **Do not touch:** applied migrations, `post-entry.ts`, `reverse-entry.ts`, `shared/straight-line.ts`, T-345's `missed-months/*` (except the R4.1 carve-out),
`updateTerms` (candidate DEF), `CAPABILITY_MATRIX`, `CAPABILITY-MATRIX.md`, `chart-of-accounts.ts`, the bible, the register, the glossary.

## 6. Invariants
1. Posted history is never rewritten. A correction reverses in an open month (bible row 193; T-106). The DB guard is §3.3
   step 5. I6, I8, I9.
2. Depreciation starts at `in_service_on`; a held asset owes nothing (PAS 16; `schedule.ts`). I1-I5, I12.
3. The DB derives the default and enforces the shape (RULES §6.3): fill trigger, CHECK, propagation. I9.
4. The migrations change zero existing schedules (backfill `'acquired'`), so no T-345 adjustment becomes an over-charge by
   migration. M1, I3.
5. Key idempotency and DEF-435 are respected: never a raw 23505, never a silent skip. I7, I8.
6. Every ✅ has a ✗: `manage_stores` O2; `manage_fixed_assets` I11 (matrix rule).
7. `withOrgPrincipal`, never a bare transaction (DEF-287); Manila dates (DEF-283); names, never ids (DEF-417).
8. Tenancy unchanged: both tables are existing org-scoped RLS tables; `registry.ts` needs no edit (the BUILDER confirms).

## 7. Out of scope
- `updateTerms` changing a posted schedule (candidate DEF, §2). Merging progress billings into one asset. Leasehold lives.
- Refusing sales before opening (flagged soft, R3). "Open but no sales" detector. The Website/POS "coming soon" (CROSS-APP-MAP).
- A store `closed` state (v1 `closed` ≈ `is_active=false`). A T-134 valuation writer (the trigger already fills it).
- **Orchestrator:** v1 count (§1.3); production listing of backfilled `opening_date` for Ian to check; GLOSSARY
  (`opening_date`, `in_service_on`, "held"); POSTING-PATTERNS note "CIP is a state"; bible §13 row.

## 8. Done when (per slice)
Cases seen red for the stated reason (guards green), then passing · typecheck + unit clean (`capability-matrix`,
`migration-journal`, `route-capability-coverage`, classification/RLS guards, `depreciation-intervals-parity`) · **FULL**
integration green (at risk: every fixed-asset/findings/scheduler/T-344/T-345 file) · scratch-DB proof (ADR-012 §5.8) · build
green with 9008 stopped · **§9.4 on 9008** (`docs/SMOKETEST.md`), screenshots: **S1** a store with no date shows "Not yet
open" in readiness, a manager sees no field; **S2** the scenario: store created 2026-01 with no date, asset bought 03-15
"waits for {store} to open", a manual run posts nothing, set 10-01, the asset shows "In service from 2026-10-01", the held
subtotal drops; **S3** the pre-opening store is absent from till-float findings and labelled on store comparison.

**Planner uncertainties:** fixtures turned "held" (S2 TESTER lists); S1 backfill over every `sales_days` status; the propagation trigger under forced RLS (I9 as APP role).

## Amendment R1 — spec review (2026-09-25), binding; still DRAFT
Independent Opus review: CHANGES. Items 6 and 7 are orchestrator rulings. Where the body above disagrees, this wins.
1. **HIGH, guard bypass.** A column-list trigger does not fire when another trigger rewrites the column. So UPDATE of
   `store_id`/`in_service_source`/`status` (fill) and the §3.3 step 6 propagation could move `in_service_on` past a posted
   month unguarded. The guard is now `BEFORE UPDATE` with **no column list** and
   `WHEN (OLD.in_service_on IS DISTINCT FROM NEW.in_service_on)`, and it runs AFTER the fill. Postgres fires same-timing
   triggers by name, so name them `fixed_assets_in_service_a_fill` and `fixed_assets_in_service_b_guard`, or merge the
   two into one function. I9 gains: ⛔ `store_id` changed to a store that opens later → guard error; ⛔ a store
   `opening_date` update propagating past a posted month → guard error naming the asset.
2. **HIGH, which month.** The guard reads the month from the KEY (`asset:{id}:depreciation:{YYYY-MM}`), never
   `entry_date`: T-345 catch-ups are dated on the booking day, and quarterly entries are dated at period end
   (`shared/straight-line.ts:77-82`). A posted key month is illegal when it is before the month of `in_service_on`
   (monthly), or when the period it ends began before that month (interval > 1: `key month − (step−1) months`).
   I9 gains: ⛔ a T-345 catch-up keyed 2026-04 and dated 2026-09, then in-service moved to 2026-06 → refused;
   ⛔ a quarterly asset with key 2026-06 (period Apr–Jun), moved to 2026-05 → refused.
3. **HIGH, S1 backfill.** `opening_date` = `least(min(business_date) of sales_days where status <> 'voided', min(entry_date)
   of journal_entries with source_type = 'sale' and status = 'posted' with a line at the store)`, else NULL. Rent or an
   asset bought during construction no longer marks a store open. M1 gains: ⛔ a store whose only activity is an expense
   → NULL; ⛔ a store whose only sales day is voided → NULL. §3.2 step 2's "has traded" uses the same definition.
4. **MEDIUM, reversal dating.** `reverseEntry` already dates an open-period reversal on the original's own date and adds
   `[prior period] ` only for a closed period (`ledger/reverse-entry.ts:140-158`). §3.4 step 5: pass `reversalDate` =
   Manila today ONLY when the original's period is not open; the reason carries no prefix
   (`in-service date corrected to {date} — {reason}`). I6 now expects each reversal to be dated in its own month when that
   month is open, and dated today with `[prior period]` in the memo when it is closed. Fixture: close 2026-03..05, keep 06+ open.
5. **MEDIUM, moving earlier.** Strike "Moving EARLIER never reverses" (§3.4). The schedule ends earlier and the last
   period takes the remainder (`straight-line.ts:71`), so posted months past the new end are no longer owed, and the new
   last month's amount can differ. §3.4 step 2 already routes both into R/refusal. The DB guard also refuses a posted key
   month after the new final period (`in-service month + ceil(life/step)·step − 1`); the amount check stays in the domain.
   New I13: a 3-month asset, `set` 2026-02, cost 3,000, Feb–Apr posted, is moved to 2026-01. With confirm, Apr is reversed
   and the next run posts Jan; ⛔ Feb/Mar are untouched. The same asset at cost 1,000 (Mar owed 333.34, posted 333.33)
   → ⛔ `/DEF-435/`, nothing reversed. ⛔ The raw UPDATE → guard error (Apr past the new end).
6. **MEDIUM, till float (ruling).** `tillFloatOffTarget` is suppressed only when the store is pre-opening AND the balance
   is exactly 0. Any non-zero drift still fires. R1 gains: ⛔ a pre-opening store with a balance of 500 → finding present.
7. **MEDIUM, held assets (ruling).** A new soft detector, `assetHeldPastOpening`: an active asset with
   `in_service_source = 'store_opening'` and `in_service_on IS NULL`, `acquired_on` more than 30 Manila days ago, whose
   store has `opening_date` NULL, or has an `opening_date` in the past with no non-voided sales day on or after it. Detail:
   `{asset} at {store} has been waiting {n} days to go into service; {store} {has no opening date | was due to open on
   {d} and has recorded no sales}`. Soft, so it never blocks the close. S3, with its title in `apps/erp/src/app/findings/lib.ts`.
   New R5: fires at 31 days; ⛔ not at 29; ⛔ not once the asset is in service.
8. **MEDIUM, fill rule.** Source NULL with `in_service_on` supplied → `'set'`, value kept. `'acquired'` with a supplied
   value ≠ `acquired_on` → raise `fixed_assets: an in-service date on the acquisition date must equal it`. It is never
   overwritten silently. I9 gains both cases.
9. **MEDIUM, C1.** C1 is removed: it fails for DEF-437, which is registered with its own task. The `clearColumns` edit
   (§3.3 step 7) stays, and its proof moves to DEF-437's task.
10. **LOW.** The S2 TESTER also owns `tests/unit/depreciation-intervals-parity.test.ts:54` and
    `packages/domain/tests/depreciation-schedule.test.ts` (the `acquiredOn` → `startsOn` rename). The S2 BUILDER switches
    `apps/erp/src/app/fixed-assets/[id]/page.tsx:52`'s `buildSchedule` call to start from `in_service_on`: no schedule is
    shown for a held asset, only "Not yet in service".
11. **LOW, badge.** The `/admin/stores` `Opens {d}` / `Not yet open` badge is **S1 only**, and S1 already owns the path.
    Delete its row from the §3.5 table; S3 does not touch `apps/erp/src/app/admin/stores/**`.

## Amendment R2 — auditor, before S1 build (2026-09-26), binding
1. **§3.2 step 2 keys off the predicate, not the literal NULL.** For a store that has traded (R1.3's first trading date exists), refuse ANY new value that makes it pre-opening under §3.1 (`NULL` or a date after today), naming the first trading date. Otherwise an admin blocked from clearing the date reaches the same state by typing a future one. S1 TESTER adds the negative (future date on a traded store → refused, nothing written).
2. **S1's screen text states the date's meaning, not its effect.** Until S2 lands, nothing is held and depreciation runs. S1 strings: readiness `Not yet open — no opening date set` / `Opens {date}` / `Opened {date}`; field helper `The first day this store trades.` S2 changes both to name the depreciation effect, in S2's paths.
3. **The `isPreOpening` SQL fragment lands with S3**, where its readers are (§3.5). S1 ships only the TypeScript twin, used by `storeReadiness`. A zero-caller SQL export at S1 would fail callers.mjs.

## Amendment R3 — S1 code review (2026-09-26), binding (folded in above)
1. MEDIUM: the opening date is validated as a real `YYYY-MM-DD` date server-side before any comparison (`01/01/2099` and `2026-3-1` were mis-compared as strings); the check calls `isPreOpening`/one helper, not an inline copy.
2. MEDIUM: the backfill runs under `SET LOCAL row_security = off` (fail loudly, never match zero rows silently); header states the role property; M1 asserts the backfill's EFFECT (rows set), not only the column.
3. MEDIUM: `/admin/stores` badge has three states via `isPreOpening`: `Not yet open` / `Opens {d}` / `Opened {d}` (R1.11 predates R2.2).
4. LOW: §3.1's backfill text now matches R1.3 (a reversed sale is not trading). Decided: keep R1.3.
5. LOW: §3.6 no longer claims S1 shows the §3.4 confirm.
6. LOW: a traded store's opening date must be on or before its first trading date; NULL and later dates are refused. Message: `{store} has traded since {date}; its opening date must be on or before that`.

## Amendment R4 — S2 fold (2026-09-26)
R1's S2/S3 items were never folded into the body; they now are, each tagged in place. R1 above stays as the record.
- R1.1: §3.3 steps 4-5 — triggers renamed `_a_fill` / `_b_guard`; guard is `BEFORE UPDATE`, no column list, `WHEN (OLD.in_service_on IS DISTINCT FROM NEW.in_service_on)`; I9 gains the `store_id` and propagation negatives.
- R1.2: §3.3 step 5 — posted month read from the key, not `entry_date`, with the interval > 1 period-start rule; I9 gains the catch-up and quarterly negatives.
- R1.4: §3.4 step 5 — `reversalDate` only for a non-open period, no prefix in the reason; I6 expects per-month dating with 03..05 closed.
- R1.5: §3.4 intro and the "Moving EARLIER never reverses" paragraph replaced; §3.3 step 5 refuses a key month after the new final period; new I13.
- R1.6: §3.5 `tillFloatOffTarget` row (pre-opening AND zero balance only); R1 test gains the 500-balance negative.
- R1.7: §3.5 new `assetHeldPastOpening` row; new R5; §5 S3 BUILDER now four functions.
- R1.8: §3.3 step 4 fill rule (NULL + value ⇒ `'set'`; `'acquired'` ≠ `acquired_on` raises); I9 both cases.
- R1.9: C1 removed from §4 and §5; the step 7 `clearColumns` edit stays.
- R1.10: §5 S2 TESTER owns the two rename-broken test files; §3.6 `/fixed-assets/[id]` starts `buildSchedule` from `in_service_on`.
- R1.11: §3.5 `/admin/stores` badge row deleted (S1 shipped the three-state badge, R3.3).
- R4.1 (new, orchestrator): T-345's `missed-months/index.ts:55` `assetScheduleInput()` duplicates `depreciate.ts:71`'s private `scheduleInputFor` from `acquired_on`, so §3.3's "every consumer follows automatically" was false and I10 could not pass. S2 BUILDER exports `scheduleInputFor` and replaces `assetScheduleInput` with it (that function only); §3.3 sentence fixed; §5 S2 BUILDER carve-out and do-not-touch exception added.
- R4.2 (new, auditor): §3.3 step 4's `'acquired'` rules defined for UPDATE: correcting `acquired_on` re-derives `in_service_on`; only a statement that itself supplies a different in-service date raises. Otherwise every acquisition-date correction on an `'acquired'` asset would be refused forever (step 3's CHECK forbids leaving it behind). I9 gains both cases.
- R4.3 (orchestrator, tester's questions at S2 red): (a) `setAssetInService` without confirm refuses with `{asset} — moving the in-service date reverses {n} depreciation entries ({first}–{last}), ₱{total}; confirm to proceed`. (b) `createAsset` takes `inServiceSource`/`inServiceOn` (the `/fixed-assets/new` "In service" choice, §3.6); every writer gets the fill (§3.3). (c) The guard's message names the asset: `fixed_assets: {asset name} already has depreciation posted for {YYYY-MM}` (R1.1).
- R4.4 (orchestrator, S2 static audit): a store's opening-date change touches only ACTIVE `'store_opening'` followers — the §3.2 step 3 cascade filters `status = 'active'` AND the `stores_opening_date_propagate` WHERE clause carries the same condition, so the two sets cannot differ. A disposed asset's schedule is closed by its disposal (`dispose.ts:104-131`); moving the store's date never reverses its depreciation or re-derives its `in_service_on`. Matches §3.4 step 1 (single-asset path refuses a non-active asset). New test I14: a disposed `'store_opening'` follower with posted months; move the store's date later → the active followers are handled, the disposed one is untouched (no reversal, `in_service_on` unchanged), no guard error. Also: every `!` on `acquiredOn`/`cost` in the cascade and `in-service.ts` becomes a guard or carries a comment naming why it is safe (RULES, bible row 206).
- R4.5 (orchestrator, S2 code review): **the confirm is built, on both screens.** `/admin/stores/[id]` opening-date form and `/fixed-assets/[id]` in-service form: when the domain refuses with the reversal list, the page re-renders that list with the months and total and a `Reverse and save` button that resubmits the same values with `confirmReversal`. An in-page second step, never a browser `confirm()` dialog.
- R4.6 (orchestrator, S2 code review): **`/fixed-assets/new`'s default sends NO source**, so the database infers it (`'store_opening'` when the store has not opened, else `'acquired'`, §3.3 step 4). The default choice reads `When the store opens (or on the acquisition date if it already has)`; `On the acquisition date` and `On a date` remain as explicit overrides. The helper text states that. Otherwise the form re-opens DEF-427 for every asset created with the default. New test I15: `createAsset` with no source at a store with no opening date → held; the screen test creates one with the default choice and sees `Not yet in service`.
- R4.7: the held-subtotal row spans all 9 columns; `in-service.ts:55`'s `acquiredOn!` gets its safety comment; I14's header says it pins BOTH the cascade filter and the propagation filter.

## Amendment R5 — S3, before build (auditor, 2026-09-26), binding
1. **One answer to "was P booked?".** §3.5's `in_service_on <= last day of P` in `periodicPostingsMissed` is a cheap SUPERSET used only to decide whether anything needs checking. The finding's DETAIL ("N asset(s)") is built in `domain/findings/index.ts` from the assets T-345's `periodFullyCovered` finds owing P without an entry — never from the repo count. A quarterly asset in a non-quarter-end month, or a fully depreciated one, is never counted in the detail. R2 gains a case: one monthly asset and one quarterly asset in service by P (P not a quarter end), neither booked → detail reads 1 asset.
2. **R3's fixture order.** `setStoreOpeningDate` refuses a date after the first trading day (R3.6), so R3 sets the opening date 10-01 FIRST, then records the 09-20 sales day (raw insert). The detector's case is a backdated sales day entered after the date was set.
3. **`openingDateContradicted` stays, both arms reachable.** The NULL arm fires when a store records its first sales day before anyone sets a date; the "later than a sale" arm fires only through a backdated sales day entered after the date was set (R3.6 blocks the forward route). The row says so, so nobody deletes the detector as unreachable.
4. **Carve-out for R5.1 (option a).** S3 BUILDER may edit `packages/domain/src/missed-months/index.ts` for one change only: an exported function returning the SET of active subjects owing P without an effective entry, with `periodFullyCovered` rewritten as `set.length === 0` over it — one computation, two callers. `findings/index.ts` builds the detail from that set, and its comment at `:150-153` ("never a second computation") is updated to say the domain now supplies both the drop and the count from that one function. Re-deriving the count from `missedMonths` is NOT allowed: it applies the R3.1 floor, the open-period filter and `through`, and would be a third answer.
5. **The control for R5.4:** `t345-missed-month.test.ts` A3, A4, A5 and A17 must stay green UNEDITED. If any of them needs a change, the refactor changed meaning — stop and report, don't adjust. S3 TESTER runs them with the R file.
6. **`assetHeldPastOpening` fires on `in_service_source = 'store_opening' AND in_service_on IS NULL AND status = 'active'`, held past the §4 R5 threshold — nothing more.** Under 0163's fill and propagation such an asset can only exist while its store's `opening_date` IS NULL, so the row's "or a past opening date with no sales" half is unreachable and is dropped. A store whose stated opening has passed with no trading is a store question, not a held-asset one; it is not built here. The detail names the store as having no opening date.

## Amendment R6 — S3 code review (2026-09-26), binding
1. **Dormant is "has not traded", not "pre-opening".** `tillFloatOffTarget`'s suppression (R1.6) keys on `store_first_trading_date(store) IS NULL` (and a zero balance), never on `isPreOpening`, whose NULL arm also covers a trading store nobody gave a date. A trading store with no opening date and a swept pot still gets its cash-control finding. New R1 case for exactly that.
2. `openingDateContradicted` pre-filters to stores that could contradict (`opening_date IS NULL`, or a sales day earlier than it) before calling `store_first_trading_date`.
3. The store-comparison header uses S1's three states: `Not yet open — no opening date set` / `Opens {d}` / `Opened {d}`.
4. `openingDatesByStore` filters by `orgId` as well as the ids (bible §15.11).
5. The amortisation detail no longer claims to measure open balances; it says N item(s) owe P with no entry.
6. The repo's `depreciationNotBooked`/`amortisationNotBooked` detail strings carry a comment that the domain overwrites them (R5.1).
7. **R6.1 corrected at build:** suppression requires BOTH `isPreOpening(opening_date)` AND `store_first_trading_date IS NULL`. "Has not traded" alone would also silence a store with an explicit past opening date and no recorded sale, which R1's existing "already open" case forbids.
