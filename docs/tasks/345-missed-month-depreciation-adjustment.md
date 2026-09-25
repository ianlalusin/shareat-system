# T-345: an adjustment naming a missed month counts as that month's depreciation or amortisation

**Status:** APPROVED 2026-09-25 (orchestrator, after independent Opus spec review; its nine CHANGES folded in as Amendment R1). **Builds only after T-344 lands** (it extends T-344's `/findings` section and its
`closeBlockers`; one migration per cycle, DEF-091). **Migration slot: `0161`**, journal `when` = 0160's + 86 400 000.

> **Decision (Ian, 2026-09-25):** the catch-up books to THIS month's depreciation or amortisation expense (6700/6750), labelled `[prior period]`. It does not go to opening retained earnings.

**Closes:** T-344 Q5 residual (Ian, 2026-09-25): *"an adjustment booked in the current month that NAMES the missed month
counts as booked for it"*. Today T-344's action refuses forever on such a month (T-344 F13).
**Model:** Sonnet, both roles. TESTER writes first and records red; BUILDER second; paths disjoint (§5).

---

## 1. Goal (bible §1.2d)
1. **v1 at source.** v1 had no idempotent schedule; its two missed months were caught up by hand (DEF-044, register
   `:571`, `:576`). No fiscal periods, so no "missed month inside closed books" could arise (T-344 §1).
2. **Goal:** a scheduled charge that could not post in its own month is booked once, in an open month, with the
   amount the schedule says, and every check that asks "was month X booked?" answers yes.
3. **v2 today.** A month P with no period (or a closed/locked one) makes `postEntry` refuse P's entry
   (`post-entry.ts:142-146`). The per-asset loop posts oldest-first inside one transaction per asset
   (`depreciate.ts:133-161`, `:274-288`), so **the asset's P failure rolls back every later month too**. The asset stops
   depreciating for good and shows as a failure every run. Amortisation behaves the same way (`prepaid/index.ts:238-268`).
4. **v2 bar.** One audited admin action books P in an open month. It reuses P's own idempotency key, so the monthly
   job never double-posts P, and the asset's later months post again. The month-close finding for P clears only when
   every asset or item that owes P has an entry for P.

## 2. Evidence (static read, HEAD `1e7862c` + T-344 spec)
- **The key IS the record of what ran.** Depreciation key `asset:{id}:depreciation:{P}` (`depreciate.ts:142`). Amortisation
  key `prepaid:{id}:amortisation:{P}[#N]` (`repo/prepaid.ts:344-351`), read back by `postedPeriods`, which skips
  reversed entries (`:276-305`). Unique on `(org_id, idempotency_key)` (`schema/journal.ts:110-112`).
- **Idempotency before period:** `postEntry` returns `created:false` on an existing key BEFORE resolving the period
  (`post-entry.ts:128-138`; `depreciate.ts:18-21`). So an entry dated in September with P's key makes every later run no-op for P.
- **Amount is derivable:** `periodDue(input, P)` (`fixed-assets/schedule.ts:89-91`) via `scheduleInputFor`
  (`depreciate.ts:71-80`); `prepaidSchedule` + `periodsThroughOf` (`prepaid/index.ts:64`, `:232`).
- **Accumulated depreciation is derived** from `source_type='depreciation'`, `source_id` = the asset, account 1590
  (`repo/fixed-assets.ts:408-428`). An adjustment with the same source is counted with no other change.
- **The close check asks for a RUN row, not entries.** `periodicPostingsMissed` counts `scheduler_runs` for
  `period = P` (`repo/findings.ts:179-229`, `:195`). It uses current `active` assets, not "owes P". The runner records
  `period` = the month run through (`scheduler/index.ts:225-251`), so a catch-up run in a later month never satisfies P.
  ⚠️ Also, `count(*)` ignores `outcome`: a FAILED run for P clears the finding. This is a candidate DEF for the
  orchestrator, not fixed here.
- **Close readiness is a filter over the feed** (`findings/index.ts:153-165`, `:318-328`). T-344's `closeBlockers` reuses
  it (T-344 §3.3 steps 7-8), so narrowing the feed narrows both.
- **Pattern (looked up, not decided):** `depreciation.monthly` DR 6700 / CR 1590 and `amortization.monthly` DR 6750 /
  CR 1400 (`POSTING-PATTERNS.md:361-373`, `:873-883`). Prior-period convention: dated in an open period, memo prefixed
  `[prior period]` (`:1236`; `reverse-entry.ts:158`). Bible row 103 (`PROJECT_BIBLE.md:1426`): the prior-period
  record "must carry the TARGET period". There is no such field today (grep of `schema/` finds none).
- **Capabilities:** `run_depreciation`/`run_amortisation` are admin-only, "scheduled, not clicked"
  (`CAPABILITY-MATRIX.md:157`, `:159`). `create_missing_period` is admin-only (`:131`, T-344).
- **Cutover lineage:** `period_overrides` CASCADEs off `journal_entries`, class `purge` (`cutover/classification.ts:153-160`).

## 3. Design
### 3.1 Migration `0161_t345_missed_month_adjustments.sql` (hand-authored, ADR-012 §5; header names T-345, T-344 Q5)
Table `missed_month_adjustments`. It is the target-period record bible row 103 asks for, scoped to scheduled charges.
- `id uuid pk default uuidv7()`, `org_id` FK RESTRICT; `schedule text NOT NULL CHECK in ('depreciation','amortisation')` (= the `source_type` values)
- `fixed_asset_id`/`prepaid_item_id uuid NULL` FK RESTRICT; CHECK `(schedule='depreciation') = (fixed_asset_id IS NOT NULL) AND (schedule='amortisation') = (prepaid_item_id IS NOT NULL)`
- `belongs_to_period text NOT NULL CHECK ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`; `journal_entry_id uuid NOT NULL UNIQUE` FK **ON DELETE CASCADE** (`period_overrides` lineage)
- `reason text NOT NULL CHECK (btrim(reason) <> '')`; `booked_by uuid NOT NULL` FK persons RESTRICT; `created_at timestamptz default now()`
- **One per subject per month:** `UNIQUE (org_id, fixed_asset_id, belongs_to_period)` and
  `UNIQUE (org_id, prepaid_item_id, belongs_to_period)`. NULLs are distinct, so each index covers only its own kind.
- **`BEFORE INSERT` trigger `missed_month_adjustments_guard`.** It raises unless all of these hold:
  1. The linked entry has the same `org_id` and `status='posted'`, `source_type = schedule`, and `source_id` = the subject.
  2. Its `idempotency_key` is the schedule key for (subject, `belongs_to_period`): exactly `asset:{id}:depreciation:{P}`,
     or `prepaid:{id}:amortisation:{P}` optionally followed by `#N`. So the name and the key cannot disagree.
  3. `to_char(entry_date,'YYYY-MM') > belongs_to_period`: it is booked in a later month.
  4. No `open` `fiscal_periods` row of the org overlaps P's calendar month. An open month is posted by the run, not adjusted.
  5. (R1.9) The entry has exactly two lines: DR 6700 / CR 1590 for depreciation, DR 6750 / CR 1400 for amortisation.
- **`BEFORE UPDATE` trigger** raises `missed_month_adjustments: rows are immutable`.
- **`BEFORE DELETE` trigger (R1.7)** raises the same error unless `pg_trigger_depth() > 1`. So a direct DELETE is refused,
  and the cascade from deleting the journal entry (the cutover purge) still works.
  RLS `org_column` (as `fiscal_periods`, `rls/registry.ts:219`); classification `purge`, reasoned as `period_overrides`.
- ⛔ **Amount is NOT DB-enforced.** The schedule is TypeScript-only (`schedule.ts` is pure by design). The domain derives
  the amount, and the tests pin it (A1, A6). This is stated here as the one gap in "the DB enforces the rules".

### 3.2 Domain `packages/domain/src/missed-months/index.ts` (new)
**`bookMissedMonth(tx, actor, { schedule, subjectId, belongsToPeriod, reason, bookOn? })`** runs in one transaction;
any refusal writes nothing. Messages name things, never ids (DEF-417).
1. `authorize(tx, actor, 'book_missed_month', {})`.
2. Blank reason after trimming → `reason is required`.
3. Load the subject in the org. It must be `active`, otherwise `{name} is {status}; only an active asset or item can be caught up`.
4. Derive the charge: `periodDue(scheduleInputFor(asset), P)` or the prepaid schedule's row for P. If there is none →
   `{name} owes nothing for {P}`. ⛔ There is no amount parameter.
5. **A link row already exists for (subject, P)** (R1.2)? If its entry is `posted` → `{name} is already booked for {P}`.
   If it is `reversed` → `{name} was booked for {P} on {date} and reversed; this task cannot re-book it` (DEF-435).
   Otherwise, an effective entry for P already exists (for depreciation, the key exists; for amortisation, `postedPeriods`
   contains P) → `{name} is already booked for {P}`. This order means neither reversal case reaches a raw 23505.
6. P's month overlaps an `open` period → `{P} is open — the monthly run books it in its own month`.
6b. (R1.5) Require `P < month(bookOn)` and `bookOn ≤ today (Manila)`. Otherwise refuse
   `the booking date must be after {P} and not after today`.
7. `postEntry` with `entryDate = bookOn ?? today (Manila business date)`, the same `sourceType`/`sourceId` as the run,
   and `idempotencyKey` = the schedule key (for amortisation, `nextRevisionKey`). The lines are exactly the pattern's
   (6700/1590 or 6750/1400, the subject's `storeId`). Memo: `[prior period] Depreciation {P} — {name}` or
   `[prior period] Amortisation — {name} ({P})`. The DB period trigger refuses a closed or locked `bookOn`.
   (R1.6) If `postEntry` returns `created:false`, or a concurrent booker wins (23505 on the journal key or the link
   UNIQUE), refuse `{name} is already booked for {P}`. Never surface a raw 23505.
8. Insert the link row. The trigger (§3.1) is the backstop for steps 5-7.
9. For amortisation, re-run the `fully_amortised` check (`prepaid/index.ts:270-276` logic, shared rather than copied).

**`missedMonths(tx, orgId, through)`** (the screen's list): per active subject, each owed P ≤ `through` with no effective
entry and no `open` period over its month, with the derived amount, from the same schedule functions.

### 3.3 The close check: `findings/index.ts` `listFindings` (domain; `repo/findings.ts` untouched)
After `periodicPostingsMissed`, drop `depreciationNotBooked:P` (and `amortisationNotBooked:P`) when **every** active asset
(item) whose schedule owes P has an effective entry keyed for P. That entry may be P's own run posting or an adjustment
naming P. It is a filter over the one feed, so `closeReadiness`, T-344's `closeBlockers` and `/findings` stay in step.
If no subject owes P (the assets were bought later), the finding is dropped too. That is what unblocks T-344 on old holes
(T-344's planner uncertainty). ⛔ One asset caught up out of three does NOT clear P.
**(R1.4) Only subjects active TODAY are counted, as `periodicPostingsMissed` already does.** A disposed asset's remaining
book value is written off to the loss account at disposal (`dispose.ts:104-131`), so a month it missed is already absorbed
there. `bookMissedMonth` refuses disposed assets (step 3), so counting them would block P forever with no remedy.

### 3.3b The asset page's booked months (R1.1)
`postedDepreciationPeriods` (`repo/fixed-assets.ts:436-455`) takes the month from `entry_date`. The asset page
(`apps/erp/src/app/fixed-assets/lib.ts:79`) would therefore show the catch-up month twice and still show P as unposted.
Read the month from the key instead, as `repo/prepaid.ts:296-300` does (`/:depreciation:(\d{4}-\d{2})$/`, with a guard
and no `!`). The `status = 'posted'` filter is unchanged.

### 3.4 Capability (proposed row, `CAPABILITY-MATRIX.md` "Books and reporting", after `create_missing_period`)
| Capability | Scope | super_admin | admin | manager | staff | Note |
|---|---|---|---|---|---|---|
| `book_missed_month` | **org** | ✅ | ✅ | ✗ | ✗ | Ian 2026-09-25 (T-344 Q5). Books a scheduled depreciation or amortisation charge missed in a month that is missing, closed or locked, into an open month with a typed reason. The amount comes from the schedule, never typed. It is admin-only like `create_missing_period` and `run_depreciation`. It is not offerable to a position, and it joins the adminless-manager fallback (row 196) |

`capabilities.ts`: the union, the list, scope `'org'`, area `'books'`, the matrix, and the label
`book a missed month's depreciation or amortisation`. Exclude it in `OFFERABLE_TO_POSITIONS` (`position-defaults.ts`).
The count goes 97 → 98, and offerable stays 91. There is no fallback backfill; it is the same gap as T-344 R1.4, row 211.

### 3.5 Screen `/findings`: a section beside T-344's "Months missing inside closed books"
**"Scheduled charges missed in closed months"** comes from `missedMonths(through = last completed month)`.
- Each row: name, month, derived amount, `will be booked in {current month}`, a required reason, and **"Book it"**
  (`bookMissedMonthAction`, `withOrgPrincipal`). Non-holders see `Only an administrator can book a missed month.`
- T-344's Q3 refusal text gains, for a depreciation or amortisation finding: `book it under "Scheduled charges missed in closed months"`.

## 4. Tests (TESTER, real Postgres, raw red)
**Fixture.** An asset acquired 2026-01-15, monthly, 24 months, cost 24,000, salvage 0, so 1,000 a month. Jan-Mar and May
are posted, then 2026-01..03 and 05 are closed and **04 is missing**. Open periods run from 2026-06 through the real
current month + 1. The same shape is used for a prepaid item. **File 1:** `packages/domain/tests/integration/t345-missed-month.test.ts`.

| # | Case | Positive | ⛔ Negative | Expected red |
|---|---|---|---|---|
| A1 | admin books asset for 2026-04 | one entry, DR 6700 / CR 1590 = 1,000.00 (= `periodDue`), dated today, key `asset:{id}:depreciation:2026-04`, memo starts `[prior period]`; link row with `belongs_to_period='2026-04'` | no row in any closed period | `bookMissedMonth is not a function` |
| A2 | then `runDepreciationAsSystem(through: last month)` | Jun..last month post; the asset is not in `failed`; P no-ops | ⛔ no second 2026-04 entry; accumulated = the schedule (`depreciationDrift` empty) | as A1 |
| A2b | before A1, same run | — | the asset fails on 2026-04 and posts NO later month (pins §1.3) | guard |
| A3 | `closeReadiness(2026-04)` after A1 | no `depreciationNotBooked:2026-04` | ⛔ before A1 it is present | `expected [...] to be empty` |
| A4 | two assets owe April, only one adjusted | — | ⛔ the finding stays | as A3 |
| A5 | no active asset owes 2026-04 (acquired 2026-07) | finding dropped | — | as A3 |
| A6 | prepaid item, 2026-04, **its own org** (R1.9) | DR 6750 / CR 1400 = the schedule's April slice; `postedPeriods` contains 2026-04; the amortisation run then no-ops April | ⛔ no second April entry | as A1 |
| A7 | second call, same asset + month | — | `/already booked for 2026-04/`; 1 entry, 1 link | as A1 |
| A8 | P is open (2026-06) | — | `/2026-06 is open/` | as A1 |
| A9 | owes nothing (2025-12, before acquisition) | — | `/owes nothing for 2025-12/` | as A1 |
| A10 | blank reason; disposed asset | — | `/reason is required/`; `/is disposed/` | as A1 |
| A11 | `bookOn` inside closed 2026-05 | — | refused by the period trigger; no link row | as A1 |
| A12 | T-344 end to end, **its own org** (R1.9) | after A1, `createMissingClosedPeriod(2026-04)` succeeds, which is the success F13 left unasserted | ⛔ before A1 it refuses, naming the depreciation finding | as A1 |
| A13 | manager with org-wide `close_period`; staff | — | `AuthorizationError /may not 'book_missed_month'/`; nothing written | as A1 |
| A14 | super_admin | resolves | — | as A1 |
| A15 | (R1.8) adminless org: a manager elevated by the fallback (`elevateManager`) | resolves | ⛔ the same manager in an org WITH an admin is refused | as A1 |
| A16 | (R1.2) book April, `reverseEntry` it, book again; for an asset and a prepaid item | — | `/booked for 2026-04 on .* and reversed; this task cannot re-book it/`; no raw 23505; the link count is still 1 | as A1 |
| A17 | (R1.4) a second asset that missed April is disposed in June | the finding for 2026-04 is dropped once the active asset is booked | ⛔ `bookMissedMonth` on the disposed one → `/is disposed/` | as A3 |
| A18 | (R1.5) `bookOn` = tomorrow (Manila) | — | `/must be after 2026-04 and not after today/`; nothing written | as A1 |
| A19 | (R1.6) two connections book the same asset and April at once | exactly one entry and one link | ⛔ the loser gets `/already booked for 2026-04/`, not 23505 | as A1 |
| A20 | (R1.1) `postedDepreciationPeriods` after A1 | `['2026-01','2026-02','2026-03','2026-04','2026-05']` | ⛔ no duplicate of the current month; 2026-04 present | today: 2026-04 missing, current month twice |
| D1 | DB, APP role, raw SQL | a valid link inserts | ⛔ key names 2026-03 but row says 2026-04; ⛔ entry dated BEFORE P (R1.3): while March is still open, post an entry dated 2026-03-31 with key `asset:{id}:depreciation:2026-04`, then close March, then insert the link naming 2026-04 → refused by check 3; ⛔ an entry with a third line, or 6700/1400 (check 5); ⛔ P overlaps an open period; ⛔ wrong `source_id`; ⛔ both subject columns or neither → 23514; ⛔ duplicate (asset, P) → 23505; ⛔ any UPDATE → the immutable error; ⛔ a direct DELETE → the same error, while deleting its journal entry the way the cutover purge does removes it (R1.7); ⛔ `reason='  '` → 23514 | `relation "missed_month_adjustments" does not exist` |

**File 2:** `tests/unit/t345-book-missed-month-capability.test.ts`: row `{super_admin:true, admin:true, manager:false, staff:false}`,
scope `'org'`, not offerable; red TS2353. **TESTER-owned pins:** 97 → 98 in `capability-matrix.test.ts`/`t337-capability-areas.test.ts`,
the adminless set, `position-defaults-offerable.test.ts`. Real `authorize()` throughout.

## 5. Paths (disjoint)
**TESTER:** the two new test files; the unit pins above.
**BUILDER:** `packages/db/migrations/0161_t345_missed_month_adjustments.sql` + `meta/_journal.json`; `packages/db/schema/missed-month-adjustments.ts`
+ schema index export; `packages/db/src/cutover/classification.ts`; `packages/db/src/rls/registry.ts`; `packages/db/src/repo/missed-months.ts`
(new, the only SQL); `packages/domain/src/missed-months/index.ts` (new); `findings/index.ts` (§3.3 filter only); `fiscal-periods/holes.ts`
(Q3 pointer only); `packages/db/src/repo/fixed-assets.ts` (`postedDepreciationPeriods` only, R1.1); `prepaid/index.ts` (extract the `fully_amortised` check, behaviour unchanged); `packages/auth/src/capabilities.ts`;
`position-defaults.ts` (exclusion); `CAPABILITY-MATRIX.md` (one row); `apps/erp/src/app/findings/page.tsx`, `actions.ts`.
⛔ **Do not touch:** `repo/findings.ts`, `depreciate.ts`, `schedule.ts`, `post-entry.ts`, `SCHEDULER_JOBS`, applied migrations,
the bible, the register.

## 6. Invariants
1. P is booked at most once per subject. This is enforced by the journal key's unique index (`journal.ts:110-112`) and
   the link's UNIQUE. A1, A2, A7, D1.
2. The amount is derived from the schedule, never typed (Q5; `schedule.ts:89`). A1, A6.
3. The name and the key cannot disagree. The DB trigger enforces it (RULES §6 item 3). D1.
4. Closed books are untouched: the entry is dated in an open month (T-344 Q3; bible row 193). A11.
5. P counts as booked only when every subject that owes P has an entry for P. This is one filter over one feed
   (`findings/index.ts:318-328`). A3-A5.
6. Every ✅ has a ✗ (matrix rule). A13, A14.
7. `withOrgPrincipal`, never a bare transaction (DEF-287); business dates are Manila time (DEF-283).

## 7. Out of scope
- **DEF-427 (in-service date, not built).** When it lands, `scheduleInputFor` must start from `in_service_on`, and
  `bookMissedMonth` then follows automatically. ⚠️ An adjustment booked BEFORE DEF-427 for a month the asset later turns
  out not to owe becomes an over-charge. DEF-427's own task must list such links and reverse them.
- Re-booking after an adjustment is reversed. That is DEF-435 (registered). This task refuses it honestly (R1.2, A16).
- A failed run clearing `depreciationNotBooked` (§2 ⚠️, candidate DEF); disposed assets; "as booked vs as belonging" reports (row 103(a)); the job's failure line naming this remedy.

## 8. Done when
- A1-A20, D1, File 2 and the pins seen red for the stated reason (A2b green as a guard), then passing; T-344 F13 still green.
- Typecheck and unit are clean (`capability-matrix`, `t337-capability-areas`, `migration-journal`, `route-capability-coverage`,
  classification and RLS registry guards). **FULL** integration is green. Scratch-DB proof per ADR-012 §5.8. Build is green with 9008 stopped.
- **§9.4 on 9008.** Seed the fixture on `shareat_dev` by raw SQL, then remove it. As admin, the row shows the
  asset, `2026-04` and `₱1,000.00`; a blank reason is refused; after booking, the row disappears and T-344's "Create the
  missing month" for April succeeds. As a manager, there is no button. Take screenshots of all three states.

- **Orchestrator items, not this task's:** the `POSTING-PATTERNS.md` variant for the `[prior period]` catch-up, and the
  bible §13 row recording Ian's Decision.

## Amendment R1 — spec review (2026-09-25), binding
The independent Opus review returned CHANGES. Each item is folded in above; this list is the record.
1. **HIGH:** `postedDepreciationPeriods` reads the month from the key, not `entry_date`. §3.3b, A20, BUILDER path.
2. **MEDIUM:** after a reversal, an existing link row gets an honest refusal, never a raw 23505 (DEF-435). §3.2 step 5, A16.
3. **MEDIUM:** D1's "dated in P itself" could not be set up. It is replaced by "dated before P", built by fixture order. D1.
4. **LOW:** §3.3 counts only subjects active today, with the reason (`dispose.ts:104-131`). A17.
5. **LOW:** `P < bookOn ≤ today (Manila)`. §3.2 step 6b, A18.
6. **LOW:** `created:false` and concurrent bookers → "already booked". §3.2 step 7, A19.
7. **LOW:** a `BEFORE DELETE` trigger refuses unless `pg_trigger_depth() > 1`. §3.1, D1.
8. **LOW:** adminless-manager-allowed test. A15.
9. **LOW:** A6 and A12 each use their own org; the trigger checks the line accounts (check 5). §3.1, D1.
