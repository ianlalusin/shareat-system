# T-344: DEF-422 — the fiscal-period seed finds every missing month, not only those after the latest end

**Status:** APPROVED 2026-09-25 (orchestrator, after independent Opus spec review; its eight CHANGES folded in as Amendment R1). **Builds only after T-341 lands** (shares `position-defaults.ts`; one migration per cycle). **Migration slot: `0160`.**
**Migration slot: `0160`** — for the audit columns and the order-guard trigger (§3.5). Its journal `when` = 0159's + 86 400 000.
⛔ This task cannot share a cycle with T-341's `0159` (one migration per cycle, DEF-091).
**Closes:** DEF-422 (`docs/DEFECTS-REGISTER.md:629`) and the four queued T-276 follow-ups (`docs/tasks/276-def-305-fiscal-period-coverage.md:444-450`).
**Model:** Sonnet, both roles. TESTER writes first and records red; BUILDER second; paths disjoint (§5).

> ### Decisions (Ian, 2026-09-25)
> - **Q1 — report only.** The scheduled job never creates a period inside closed or locked books. Such a month is reported
>   on every run and never filled by the job.
> - **Q2 — build an admin action.** An administrator can create a missing month and close it in one step. The job's
>   failure line for that month names the action.
> - **Q3 — refuse, and name what blocks.** If the missing month should have had activity, the action refuses and lists that
>   activity. The activity is booked in the current open month as a prior-period adjustment; closed books stay untouched.
> - **Q4 — the action fills part-months.** It may create the missing part of a month as its own `closed`/`locked` period,
>   with the same refusals as for a whole month.
> - **Q5 — missed depreciation in a gap.** An adjustment booked in the current month that NAMES the missed month counts as
>   booked for it. **Its own task, T-345**; T-344 ships with the refusal pinned by its tests.

---

## 1. Goal (bible §1.2d)
1. **v1 at source.** v1 has no fiscal periods. Locking is per-day, per-feature (`LockableFeature`, `lockedDay.guard.server.ts`;
   `docs/discovery/06-accounting-gaps.md:85`), and no period close exists at all (`:174`). A grep of ERP-rebuild `src/` for
   `fiscalPeriod|fiscal_period` returns nothing, so v1 could not have a "hole".
2. **Goal:** every date from an org's first period through the end of M+11 is either covered by a period, or its absence is
   reported on every run with the remedy named. No date is refused in silence.
3. **v2 today.** The T-276 job reads only `F = latestPeriodEnd` (`packages/domain/src/scheduler/index.ts:1062`) and cuts it to its
   month (`:1067`). Holes before F are invisible; a mid-month F leaves the rest of that month uncovered; the run reports `ok`.
4. **v2 bar.** Find every hole. Fill the ones option (c) already covers. Report the rest. Give an administrator an audited
   way to close a whole month that is missing inside closed books.

## 2. Evidence (static read, HEAD `753b78a`)
- **Holes before F are not seen:** `gapMonths` is computed from `latestPeriodEnd` alone (`scheduler/index.ts:1062-1068`;
  `latestPeriodEnd` is `max(ends_on)`, `packages/db/src/repo/fiscal-periods.ts:111-119`). `backfill-fiscal-periods` seeds forward
  from the current month (`scripts/backfill-fiscal-periods.ts:97-98`), which is exactly how the register's June–August hole arises.
- **Mid-month F:** `before.slice(0, 7)` (`:1067`). The EXCLUDE constraint (`0000_slow_justice.sql:117`) would refuse any whole
  month that overlaps the partial period.
- **Refusal:** `postEntry` throws `no fiscal period covers entry date …` (`packages/domain/src/ledger/post-entry.ts:~142-147`).
- **Why the job must not fill holes inside closed books** (now ruled Q1):
  - Seeding can only create `open` rows (`fiscal-periods.ts:88`).
  - The close gates check for an earlier OPEN period, never a MISSING one (`hasEarlierOpenPeriod` `:168-176`; `closePeriod`
    `fiscal-periods/index.ts:79`; `closeYear` `close-year.ts:58`), so holes inside closed or locked stretches are reachable.
  - An `open` row there would reopen closed books (bible row 193). It would also block every later close.
- **Part months cannot close:** `closePeriod` matches exact calendar-month bounds (`fiscal-periods.ts:123-157`). So the
  action (Q4) cannot reuse the domain `closePeriod`. It inserts the row already closed, after running the same checks
  over the exact date range.
- **What "activity" means to the close today:** unposted drafts (`unpostedDraftsInPeriod`, `fiscal-periods.ts:232-260`),
  plus hard findings for the month (`closeReadiness`, `packages/domain/src/findings/index.ts:318-328`). ⚠️ The periodic
  detector is keyed on `scheduler_runs.period` (`packages/db/src/repo/findings.ts:179-195`). A prior-period adjustment booked
  in another month therefore does not clear it (see the open question).
- **No usable audit table:** `audit_log` has no org column and is `system_only` with zero policies
  (`packages/db/src/rls/registry.ts:285-291`), and nothing in `packages/domain` writes to it. `period_overrides` is scoped to
  one journal entry (`packages/db/schema/period-overrides.ts:50-70`). `fiscal_periods` has `closed_by`/`closed_at` but no
  creator and no reason (`packages/db/schema/fiscal-periods.ts:13-36`).
- **Capabilities:** `close_period` is ✅ for admin and super_admin, and **conditional** for manager
  (`CAPABILITY-MATRIX.md:129`; `packages/auth/src/capabilities.ts:855`). `override_period_lock` is admin/super_admin only
  (`:130`; `:863`), and its row says widening it "reopens a ruled question".
- **Screen:** the period close lives on `/findings` (`apps/erp/src/app/findings/page.tsx:119-134`, `closePeriodAction`
  `actions.ts:49-54`). Its period selector covers only the last 12 completed months (`findings/lib.ts:41-49`), so an older
  hole cannot be reached through it.
- **Outcome is derived:** `failed === 0 ? ok : posted > 0 ? partial : failed` (`packages/db/src/repo/scheduler.ts:60-61`).
- **Queued fixes, verified:**
  1. `scripts/fiscal-period-seed.ts:45-48` does NOT print `o.failures` on the error branch, as the queued note said. It is the
     reverse: it `continue`s past them. On the close-row-failed path (`scheduler/index.ts:~179-181`) that drops real failures,
     and after an outright throw it prints `inserted 0`.
  2. The comment at `:1057-1060` is wrong: the transaction does not close the TOCTOU under READ COMMITTED; the guards do.
  3. `JobOutcome['job']` (`:59-72`) should be `SchedulerJob` (`packages/db/schema/scheduler.ts:105`).
  4. Stale RED headers: `t276-fiscal-period-seed-job.test.ts:9-12`, `:289`; `tests/unit/t276-scheduler-job-check-mirror.test.ts:10-15`.

## 3. Design
### 3.1 Repo `packages/db/src/repo/fiscal-periods.ts`
- **`coverageHoles(tx, orgId, throughDate)`** — one SQL read. It uses `lag(ends_on) over (order by starts_on)` for interior
  holes, plus the tail `max(ends_on)+1 .. throughDate`. It also returns the close frontier: `max(starts_on)` over
  `closed`/`locked` rows, with that row's status. `[]` for an org with no periods.
- **`insertFilledPeriod(tx, orgId, { startsOn, endsOn, status: 'closed'|'locked', actorId, reason })`** — one INSERT with
  `closed_at = now()` and `closed_by = created_by = actorId`. It uses `ON CONFLICT DO NOTHING RETURNING id`, so `null` means
  another writer won.
- **`unpostedDraftsInRange(tx, orgId, startsOn, endsOn)`** — the body of `unpostedDraftsInPeriod`, taking a date range.
  `unpostedDraftsInPeriod` becomes a one-line call to it, with behaviour unchanged.

### 3.2 Domain `packages/domain/src/fiscal-periods/holes.ts` (new, exported)
**`classifyHoles(tx, orgId, through)`** is the ONE classifier, used by the job, the screen and the action. It splits each hole
into whole calendar months and part-month pieces:

| Class | Rule | Job action | Failure line (every run unless marked) |
|---|---|---|---|
| **A: fill** | whole month, no closed/locked period starts after it, AND its calendar year is not closed (R1.1) | `seedCalendarMonths`, `open` | Only for ended months (< M) THIS run inserted. Tail: T-276's string unchanged. Interior: `coverage gap: no period covered {s}..{e}; backfilled {n} elapsed month(s) {a}..{b} as open — created after their own month ended, so no close ever ran on them` |
| **B: missing in closed books** | whole month; a closed/locked period starts after it, OR its calendar year is closed (R1.1) | none (Q1) | `month {YYYY-MM} is missing inside closed books, so posts dated in it are refused; an administrator can create it as {closed\|locked} with "Create the missing month" on /findings` |
| **C: part month in closed books** | a part-month piece; a closed/locked period starts after it, OR its year is closed | none (Q1) | `{s}..{e} (part of {YYYY-MM}) is missing inside closed books, so posts dated in it are refused; an administrator can create it as {closed\|locked} with "Create the missing month" on /findings` |
| **D: part month in open books** | a part-month piece that is neither of the above | none | `coverage hole NOT filled: no period covers {s}..{e} (part of {YYYY-MM}); the job creates whole months only, and the action refuses while earlier months are open; posts dated there stay refused` |

- **"Its calendar year is closed" (R1.1)** means either:
  - some period in year Y is `locked`, or
  - a posted `journal_entries` row exists with `source_type = 'year_close'` and `entry_date = (Y+1)-01-01`
    (`close-year.ts:118-121`).

  This is one repo read, `closedYears(tx, orgId)`. The second condition is needed because `closeYear` checks only for
  earlier OPEN periods (`close-year.ts:58`), so it can lock a year that has missing months, or no periods at all.
- **`targetStatus` for a B or C piece** is `locked` if its calendar year is closed (above; ADR-006 §7.5). Otherwise it is
  `closed`.
- **Job:** the zero-period branch is unchanged (`:1084-1095`). The tail-only `gapMonths` path is deleted. Each A run gets
  its own `seedCalendarMonths` call, and only inserted months are reported (race guard). `detail` gains
  `· missing in closed books {b+c} · part-month holes in open books {d}`. A B/C/D-only run is `failed` (posted 0), and
  it repeats every month until the hole is dealt with.

### 3.3 Admin action: `createMissingClosedPeriod(tx, actor, { startsOn, endsOn, reason })` in `holes.ts`
Everything runs in one transaction; any refusal writes nothing. The input is one piece from `classifyHoles` class B or C:
a whole month, or the missing part of one (Q4). Steps, in order:
1. `authorize(tx, actor, 'create_missing_period', {})`.
2. Refuse a blank reason after trimming: `reason is required`.
3. Refuse a range that crosses a month boundary: `{s}..{e} spans more than one month; create one month at a time`.
4. Refuse if any period overlaps the range: `{s}..{e} is not missing — the period {ps} to {pe} covers it`.
5. The range must be the WHOLE missing piece inside its month. Otherwise refuse:
   `creating {s}..{e} would leave {x}..{y} of {YYYY-MM} still missing; create the whole missing part`.
6. Refuse class A or D (§3.2):
   `{s}..{e} is not inside closed books — the monthly fiscal-period job creates whole months as open`.
7-8. **One shared check (R1.5): `closeBlockers(tx, orgId, { startsOn, endsOn })`**, new in `fiscal-periods/index.ts`.
   It is extracted from `closePeriod`'s checks 2-4 (`:58-84`). It returns:
   - `drafts`: from `unpostedDraftsInRange`;
   - `blocking`: `closeReadiness(containing month).blocking`;
   - `earlierOpen`: from the date-keyed `hasEarlierOpenPeriodBefore(tx, orgId, startsOn)`.

   Two callers use it:
   - **`closePeriod`** keeps its three existing messages byte-for-byte, in the same order.
   - **The action** refuses on `earlierOpen` with closePeriod's message. It refuses on drafts/blocking with ONE message
     listing every item in human terms (DEF-417): `draft expense dated 2026-04-10 — {supplier name}`, or a finding's
     title. It ends: `Book this activity in the current open month as a prior-period adjustment, then try again. Closed
     books are not reopened.`
   - For a part month, readiness is checked on the containing month. This is conservative: it may over-refuse, but never
     lets activity through.
9. `insertFilledPeriod` with `targetStatus`. If it returns `null`, refuse: another writer won the race.
10. Return `{ periodId, startsOn, endsOn, status }`.

The action never calls the domain `closePeriod`, which works only on calendar months. It shares `closeBlockers` with it,
so the gates cannot drift apart (RULES §6 item 3).

**Supplier name for drafts (R1.7).** `UnpostedDraft` (`repo/fiscal-periods.ts:208-212`) gains `counterpartyName: string | null`:
- expenses: `JOIN suppliers ON suppliers.id = expenses.supplier_id` (NOT NULL FK, `schema/expenses.ts:135-137`) → `suppliers.name`;
- deliveries: `LEFT JOIN suppliers ON suppliers.id = deliveries.supplier_id` → the name, or null, which is shown as
  `{kind} delivery, no supplier` (a purchase or commissary delivery).

### 3.4 Capability (proposed row, `CAPABILITY-MATRIX.md` "Books and reporting", after `:130`)
| Capability | Scope | super_admin | admin | manager | staff | Note |
|---|---|---|---|---|---|---|
| `create_missing_period` | **org** | ✅ | ✅ | ✗ | ✗ | Ian 2026-09-25 (T-344 Q2). Creates a whole month, or the missing part of one (Q4), inside closed books. It is created already closed (locked in a locked year), with a typed reason. It refuses if the gap has activity (Q3). It is admin-only like `override_period_lock` because it changes closed books. It is a separate capability rather than a widening of that ruled row. It is not offerable to a position. Admin-yes/manager-no enrols it in the adminless-manager fallback automatically (row 196). |

In `packages/auth/src/capabilities.ts`, add it to: the union (`:196`), the list (`:334`), `CAPABILITY_SCOPE` `'org'` (`:495`),
area `'books'` (`:680`), the matrix (`:863`), and the label `create a month missing from closed books` (`:1089`).

**Not offerable (R1.3).** `OFFERABLE_TO_POSITIONS` (`packages/domain/src/people/position-defaults.ts:51-56`) excludes only
super-admin-only, platform and `close_period`. Add `c !== 'create_missing_period'`, and update the count comment at `:45-49`
(97 capabilities, still 91 offerable). ⛔ **This edit builds after T-341 lands**, because T-341 is editing that file now.

**Adminless-manager fallback (R1.4): no backfill in 0160; the gap is stated.** `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`
(`capabilities.ts:948-960`) is applied when a manager is created. So a manager already elevated in an org with no admin
will NOT hold `create_missing_period` until re-elevated (`elevateManager`, row 116).
Bible row 211 justification: *nobody loses access and nobody silently gains a new power. The one production org has an admin
(DEF-417), so the gap is expected to be empty. The orchestrator confirms that with a read-only count at cutover.*

### 3.5 Migration `0160_t344_fiscal_period_fill_audit.sql`, hand-authored (ADR-012 §5)
**Header (R1.8):** the header follows ADR-012 §5 item 2. It names T-344/DEF-422, why the columns and trigger exist, and the
`0159` dependency, and it says `Hand-authored per ADR-012 §5`.

**Where the audit lives.** The audit record is stored on the period row itself, because `audit_log` cannot hold org data
(§2). ⚠️ **It is immutable, not permanent (R1.6).**
- DELETE is not blocked, and must not be: the cutover purges periods that start before 2027
  (`cutover/classification.ts:134-141`, `keepFrom: '2027-01-01'`).
- Journal FKs are `ON DELETE RESTRICT`, so a period with postings survives.
- ⛔ No DELETE trigger.

The migration's statements:
1. `ALTER TABLE fiscal_periods ADD COLUMN created_by uuid REFERENCES persons(id) ON DELETE RESTRICT, ADD COLUMN fill_reason text;`
2. `CHECK fiscal_periods_fill_shape_check`: `fill_reason IS NULL OR (btrim(fill_reason) <> '' AND created_by IS NOT NULL AND
   closed_by IS NOT NULL AND closed_at IS NOT NULL AND status <> 'open')`. The builder checks that it is NULL-safe
   (0158's trap).
3. `BEFORE UPDATE` trigger `fiscal_periods_fill_immutable` (R1.6). If `NEW.fill_reason IS DISTINCT FROM OLD.fill_reason`
   OR `NEW.created_by IS DISTINCT FROM OLD.created_by`, it raises `fiscal_periods: a filled period's creator and reason are
   set only when it is created`. This covers both NULL→value and value→anything, so both columns are write-once, at INSERT.
4. **Order guard (R1.2): `BEFORE INSERT OR UPDATE OF status, starts_on, ends_on` trigger `fiscal_periods_order_guard`.**
   - First it runs `pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || NEW.org_id::text, 0))`.
   - Then, if `NEW.status = 'open'` and a `closed`/`locked` row of the same org has `starts_on > NEW.starts_on`, it raises
     `fiscal_periods: an open period cannot start on {starts_on} — a closed period starts after it`.
   - The lock serialises the job's insert against a concurrent `closePeriod` UPDATE. Under READ COMMITTED, the EXISTS read
     after the lock sees the committed close.
   - ⚠️ Fixtures that insert a closed row and THEN an earlier open one will now fail. Every fixture must insert in date
     order; the full suite decides which fixtures need reordering (TESTER, §5).

No data change. Mirror the columns and the CHECK in `packages/db/schema/fiscal-periods.ts`, and name the trigger in a comment.
The builder confirms that `classification.ts`/`registry.ts` need no edit: this is an existing table, and RLS is unchanged
(`0011:99-101`).

### 3.6 Screen: `/findings`
- Add a new section, **"Months missing inside closed books"**. It is rendered from `classifyHoles` classes B and C, **not**
  from the 12-month selector, so older holes appear too.
- Each row shows the month, or `{s} to {e} (part of {YYYY-MM})` for a part month, `will be created as closed|locked`, a required reason field, and a **"Create the missing month"**
  button, which calls `createMissingClosedPeriodAction` in `actions.ts` under `withOrgPrincipal`.
- The button renders only if `heldCapabilities` includes `create_missing_period`. Anyone else sees
  `Only an administrator can create a missing month.`
- Success and refusal messages use the existing `back({ ok | error })`, with months and names only, never an id (DEF-417).
- A Q3 refusal shows its full activity list on screen.
- The section is hidden when there are no B/C pieces.

### 3.7 Queued fixes (BUILDER)
- Script error branch: print the error, then `detail` only if it is defined, then every failure.
- Rewrite the comment at `:1057-1060`.
- Change `JobOutcome['job']` to `SchedulerJob`.

## 4. Tests (TESTER, current `main`, real Postgres, raw red)
**File 1, `packages/domain/tests/integration/t344-fiscal-period-holes.test.ts`.** Fixtures come from
`t276-fiscal-period-seed-job.test.ts`. `NOW = Date.parse('2026-08-31T20:00:00Z')`, so M = `2026-09`, through `2027-08-31`.
Each case calls `runFiscalPeriodSeed({ orgId, nowMs: NOW })`.

| # | Given | Positive | ⛔ Negative | Expected red |
|---|---|---|---|---|
| H1 | 2026-01..05 open, 2026-09..2027-08 open | posted 3, `partial`, interior line names `2026-06..2026-08`; `findPeriodForDate(2026-07-15)` finds July | nothing before 2026-01-01; existing rows' (status, updated_at) unchanged | `expected 0 to be 3` |
| H2 | H1 rerun | posted 0, `ok` | not `partial` again | guard |
| H3 | 2026-01..03 closed, **04 missing**, 05 closed, 06..2027-08 open | `failed`, posted 0; line = the B string with `2026-04`, `closed`, `"Create the missing month" on /findings` | no April row | `expected 'ok' to be 'failed'` |
| H4 | H3 rerun | same line again | not silenced | as H3 |
| H5 | 2025 all `locked` except **2025-06 missing**; 2026-01..2027-08 open | B line says `as locked`; `postEntry` on 2025-06-15 rejects `/no fiscal period covers/` | no 2025-06 row | as H3 |
| H6 | 2026-09..2027-07 open + `2027-08-01..15` open | D line names `2027-08-16..2027-08-31` | no row starts 2027-08-16 | as H3 |
| H7 | 2026-04 closed, `2026-05-01..05-20` closed, 06 closed, 07..2027-08 open | C line names `2026-05-21..2026-05-31` and `"Create the missing month"` | no row for it | as H3 |
| H8 | B 2026-02 (03 closed) + A 2026-06..08 | posted 3, `partial`, 2 lines | no 2026-02 row | one line |
| H9 | 2026-09..10, 2027-01..08 open | posted 2, `ok` | no line | guard |
| H10 | 2026-01..08 closed, 09..2027-08 open | the forward seed still runs: window `2026-09..2027-08`, posted 0, skipped 12, `ok`; detail has `window 2026-09..2027-08` | failed 0 | guard |
| H11 | R1.1: 2025-01..05 closed, **2025-06..12 missing**, 2026-01..2027-08 open; `closeYear(2025)` run through the domain (locks Jan–May, posts `year_close`) | `failed`, posted 0; seven B lines `as locked` | ⛔ no 2025-06..12 row created open | `expected 7 to be 0` (today: posted 7, `partial`) |
| H11b | 2024-12 closed; **no 2025 periods**; a posted `year_close` entry dated 2026-01-01 (source_id `{org}:2025`, set up by superuser SQL); 2026-01..2027-08 open | twelve B lines for 2025, `as locked` | ⛔ no 2025 row created | as H11 |
| H12 | R1.2 trigger, APP role, raw SQL: 2026-07 closed exists | — | ⛔ inserting 2026-06 `open` raises `/an open period cannot start on 2026-06-01/`; ⛔ updating a closed 2026-07 row back to `open` while 2026-08 is closed raises the same | `expected to throw` |
| H13 | R1.2 race, two connections: A `BEGIN`, closes 2026-07 (UPDATE), holds; B starts `runFiscalPeriodSeed` with 2026-06 missing and 07 read as open; A commits | B's June insert is refused by the order guard; the run row has `error` naming it | ⛔ no 2026-06 open row | green only if the lock + trigger exist |

**File 2, `packages/domain/tests/integration/t344-create-missing-period.test.ts`.** Use the H3 shape unless stated. Every
decision goes through real `authorize()`. Every ⛔ also asserts the `fiscal_periods` count is unchanged.

| # | Case | Positive | ⛔ Negative | Expected red |
|---|---|---|---|---|
| F1 | admin, April `2026-04-01..04-30`, reason `'  late setup  '` | April is `closed`, `closed_by` = `created_by` = admin, `fill_reason = 'late setup'`; `postEntry` on 2026-04-15 now fails with the closed-period message, not `/no fiscal period covers/`; a job rerun has no April line and is `ok` | no other row changed | `createMissingClosedPeriod is not a function` |
| F2 | H5 shape, admin | 2025-06 is `locked` | not `closed`; the admin override on 2025-06-15 is still refused (locked) | as F1 |
| F3 | super_admin | resolves | — | as F1 |
| F4 | manager with org-wide scope who holds `close_period` | — | rejects `AuthorizationError /may not 'create_missing_period'/` | as F1 |
| F5 | staff | — | rejects `/may not 'create_missing_period'/` | as F1 |
| F6 | range already has a period (`2026-03-01..03-31`) | — | `/is not missing — the period 2026-03-01 to 2026-03-31 covers it/` | as F1 |
| F7 | Q4, H7 shape: `2026-05-21..05-31` | row with exactly those bounds, `closed`; job rerun has no C line | ⛔ `2026-05-21..05-25` → `/would leave 2026-05-26\.\.2026-05-31 of 2026-05 still missing/`; ⛔ `2026-05-21..06-02` → `/spans more than one month/` | as F1 |
| F7b | Q4 in a locked year: `2025-06-01..06-15` locked, `06-16..06-30` missing | the part is created `locked` | not `closed` | as F1 |
| F8 | class A month (H1's July) and class D part (H6's) | — | `/not inside closed books/`; still missing | as F1 |
| F9 | reason `'   '` | — | `/reason is required/` | as F1 |
| F10 | Q3: draft expense dated 2026-04-10 | after the draft is re-dated into 2026-09 (the prior-period adjustment), the action succeeds | ⛔ first call refused; the message contains `draft expense dated 2026-04-10`, the supplier's name, and `prior-period adjustment`; no April row; no id in the message | as F1 |
| F10b | Q3, part month (F7 shape) with a draft dated 2026-05-25 | — | refused, lists it; no row | as F1 |
| F11 | 2026-02 open, 03 closed, 04 missing, 05 closed | — | `/earlier period .* still open/`; no row | as F1 |
| F13 | Q3, hard finding: a depreciable asset in service, and no depreciation run for 2026-04 | — | refused; the message lists the depreciation finding's title; no row (success afterwards is NOT asserted — see the open question) | as F1 |
| F12 | DB, APP role with org set (raw SQL) | a filled row's `status` can move closed→locked; a plain row's DELETE still succeeds (R1.6: no DELETE trigger) | ⛔ `fill_reason='  '` → 23514; ⛔ `fill_reason` NULL on insert with `created_by` set, then UPDATE `fill_reason='x'` → the write-once error (R1.6); ⛔ UPDATE `created_by` NULL→person on a plain closed row → same error; ⛔ `fill_reason` on an `open` row → 23514; ⛔ change `fill_reason`/`created_by` on a filled row → same error | `column "fill_reason" does not exist` |
| F14 | R1.5 regression: `closePeriod` refusals | its three messages (drafts, not ready, earlier open) match today's text exactly | ⛔ no message change | none (guard) |
| F15 | R1.7: a draft delivery of kind `purchase` (no supplier) dated in the hole | the refusal names `purchase delivery, no supplier` | ⛔ no id in the message | as F1 |

**File 3, `tests/unit/t344-create-missing-period-capability.test.ts`.**
- `CAPABILITY_MATRIX.create_missing_period` is `{ super_admin: true, admin: true, manager: false, staff: false }`.
- Its scope is `'org'`; `create_missing_period` is not offerable to a position.
- ⛔ `override_period_lock`'s row is unchanged.
- Red: TS2353 / `undefined`.

**Existing unit pins (R1.4), owned by the TESTER.** Update each deliberately and record it red first:
- `tests/unit/capability-matrix.test.ts:221` and `:293-295` (96 → 97);
- `tests/unit/t337-capability-areas.test.ts:56` and `:124` (96 → 97);
- the adminless-manager set at `capability-matrix.test.ts:339+`, which gains `create_missing_period`;
- `tests/unit/position-defaults-offerable.test.ts`, if it pins the count: offerable stays 91, and `create_missing_period` is
  asserted absent (R1.3).

`capability-matrix.test.ts` must parse the new doc row green. T-276 T1-T5 stay green; only their headers are edited.

## 5. Paths (disjoint)
**TESTER:**
- the three new test files;
- the unit pins listed under R1.4 in §4;
- any existing integration fixture the R1.2 order guard breaks. Reorder its inserts into date order only, and list each one
  in the report;
- header text only in `packages/domain/tests/integration/t276-fiscal-period-seed-job.test.ts` (`:9-12`, `:289`) and
  `tests/unit/t276-scheduler-job-check-mirror.test.ts` (`:10-15`).

**BUILDER:**
- `packages/db/migrations/0160_t344_fiscal_period_fill_audit.sql` and `meta/_journal.json`;
- `packages/db/schema/fiscal-periods.ts`;
- `packages/db/src/repo/fiscal-periods.ts`:
  - the additions: `coverageHoles`, `insertFilledPeriod`, `unpostedDraftsInRange`, `closedYears`, and
    `hasEarlierOpenPeriodBefore`;
  - `unpostedDraftsInPeriod` and `hasEarlierOpenPeriod` delegating to the range/date forms;
  - `UnpostedDraft.counterpartyName` (R1.7);
- `packages/domain/src/fiscal-periods/holes.ts` (new), and `fiscal-periods/index.ts`: its export, the new `closeBlockers`,
  and `closePeriod` rewritten to call it with messages unchanged (R1.5);
- `packages/domain/src/people/position-defaults.ts:45-56` (the R1.3 exclusion only). ⛔ **Only after T-341 has landed.**
- `packages/domain/src/scheduler/index.ts` (the T-276 block and `JobOutcome`);
- `scripts/fiscal-period-seed.ts`;
- `packages/auth/src/capabilities.ts`;
- `docs/decisions/CAPABILITY-MATRIX.md` (the one row in §3.4 only);
- `apps/erp/src/app/findings/page.tsx` and `actions.ts`.

⛔ **Do not touch:** applied migrations, `SCHEDULER_JOBS`, `seedCalendarMonths`, `closeYear`, `override_period_lock`, `findings.ts`, `backfill-fiscal-periods.ts`, `docs/ops/*`, the bible, or the
register (the orchestrator stamps DEF-422).

## 6. Invariants
1. The job never creates a period at or before a closed/locked one, nor in a closed year (Q1; bible row 193; R1.1). The
   database enforces this against races (R1.2). H3, H5, H8, H11-H13.
2. The job creates only whole calendar months (`fiscal-periods.ts:123-157`). The action creates only exactly one missing
   piece within one month, and never an `open` row. H6, H7, F7.
3. The action applies the close gates (drafts, hard findings, earlier-open; ADR-006 §7.4) to the exact range. It is
   all-or-nothing. Activity is never booked into closed books: it goes to the current open month (Q3). F10, F10b, F11, F13.
4. The action is admin/super_admin only. Every ✅ has a ✗ (matrix rule; F1/F3 vs F4/F5).
5. Audit is write-once: the creator and a non-blank reason are set at INSERT only, and the DB enforces it (RULES §6.3).
   Deleting the row is not blocked (the cutover purge). F12.
6. No silent outcome: every unfilled month gets a line on every run, and a B line names its remedy (option (c); DEF-044). H3-H7.
7. `partial ⇒ posted > 0` is derived (`repo/scheduler.ts:60-61`); every run is recorded (bible row 181).
8. `asSystem` / `withOrgPrincipal`, never a bare transaction (DEF-287, DEF-421); business month in Manila time (DEF-283).

## 7. Out of scope
- **Making `closePeriod`/`closeYear` refuse over a MISSING earlier month.** This is the root of B holes; it is a candidate
  DEF for the orchestrator to register.
- Class D (part month in open books). It arises only from hand-made partial `open` periods, and such a period can never be
  closed either, since `closePeriod` works by calendar month. That is a candidate DEF for the orchestrator.
- A `/findings` detector for holes; DEF-423; `backfill-fiscal-periods.ts`; the production hole count (read-only,
  orchestrator, at cutover).

## 8. Done when
- H1-H13, F1-F15, File 3 and the R1.4 pins are each seen red for the stated reason (or recorded green as guards), then passing.
- T-276 tests are still green. Typecheck + unit clean, including `capability-matrix`, `migration-journal`, `t337-capability-areas`
  and `route-capability-coverage`.
- **FULL** integration green (orchestrator runs it).
- Scratch-DB proof per ADR-012 §5.8 (migrate, apply 0160, then `dropdb`).
- Build green with 9008 stopped.
- **§9.4 on 9008** (seed a B hole, and a C part month with one draft expense in it, on `shareat_dev` by raw SQL; remove
  them after). The part month's refusal must show the draft by name, then succeed once the draft is re-dated.
  The whole-month steps:
  1. As admin, `/findings` lists the month with `will be created as closed`. A blank reason is refused on screen. With a
     reason, the section disappears and the success message names the month.
  2. As a manager, the same row shows no button, only the admin-only sentence.
  3. Screenshots of all three states.
- Smoke test: `npm run fiscal-period-seed -- --manual` twice on dev; the B line appears before the fill and not after.

**Open for Ian (new):**
1. **A scheduled posting that was missed in the gap** — depreciation or amortisation. The close check asks whether that
   month's scheduled run posted (`findings.ts:179-195`). Booking it in the current month as a prior-period adjustment (Q3)
   does not satisfy that check, so the action keeps refusing and the gap can never be filled. Should an adjustment that
   names the missed month count as booked for that month? That changes the findings and journal code, so it would be its
   own task. Until Ian decides, F13 pins the refusal only.

**Planner uncertainties:**
- Whether `closeReadiness` for a very old month raises blockers unrelated to the hole. F1 and the §9.4 check will show it.
- The exact refusal line in `post-entry.ts`; the TESTER matches it by regex.

## Amendment R1 — spec review (2026-09-25), binding
The independent Opus review returned CHANGES. Every item below is folded into §3-§6 above. This list is the record.
1. **CRITICAL: closed-year gap.** A gap in a year with a `locked` period or a posted `year_close` entry is B/C, never A.
   §3.2, H11, H11b.
2. **HIGH: race.** 0160 adds `fiscal_periods_order_guard`: a per-org advisory lock, and it refuses an open row with a
   closed/locked row after it. §3.5 item 4, H12, H13.
3. **HIGH: offerable.** `create_missing_period` is excluded in `position-defaults.ts:51-56`. It builds after T-341. §3.4.
4. **HIGH: unit pins.** The 96-count pins and the adminless set go to the TESTER. The fallback is not backfilled; the gap is
   stated under row 211. §3.4, §4.
5. **MEDIUM: shared gates.** `closeBlockers` is shared by `closePeriod` and the action, with messages unchanged. A date-keyed
   `hasEarlierOpenPeriodBefore` is added. Both are taken off do-not-touch. §3.3, F14.
6. **MEDIUM: write-once audit.** `fill_reason`/`created_by` are refused on any UPDATE, including NULL→value. The
   "permanent" wording is corrected: DELETE stays allowed (cutover purge), with no DELETE trigger. §3.5, F12.
7. **MEDIUM: supplier name.** `counterpartyName` comes from joins on `suppliers`. §3.3, F10, F15.
8. **LOW:** H10's window is defined; the 0160 header follows ADR-012 §5 item 2.
