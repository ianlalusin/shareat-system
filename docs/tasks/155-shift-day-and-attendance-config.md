# T-155 — The shift day, and attendance config that cannot retroactively move somebody's pay

> **Status:** Spec written 2026-08-29 by the Opus planner (session `ianla-f9`, lane B).
> **Depends on:** T-101 (`stores`), T-121 (capabilities) — shipped.
> **Blocks:** T-156 (a punch needs a shift day to land on), T-157 (adjudication reads the config),
> T-160 (config is hot-set item 3, priority refresh).
> **Two deliverables in one task on purpose:** the shift day and the config are both *inputs* to the
> adjudication and neither is independently testable in a useful way — a config with no calendar to
> apply it against has nothing to assert. Splitting them would produce two half-tasks that only mean
> something together.

## Part A — the shift day

### A.1 The rule, from v1, verbatim

`ERP-rebuild/src/lib/attendance/shift-day.ts:3-6`:

> *"A shift day runs 05:00 → 05:00 PHT, not midnight → midnight: a closing staffer who taps out at
> 01:30 belongs to the day they started, not the calendar day the clock rolled into. Every attendance
> session is anchored to this, which is why `AttendanceSessionPlain.sessionDate` is called sessionDate
> and not dayKey — **the financial dayKey is a different, midnight-based thing.**"*

⭐ **v1 named its two calendars differently on purpose, and said so in a comment.** That is the
single most useful line in the module and it is the reason this task exists rather than being three
lines inside T-157.

### A.2 ⛔ Where it goes, and why not `packages/core`

`packages/core/src/datetime.ts:31-36` answers this itself:

> *"Note this is a plain midnight-to-midnight boundary in Manila. If a module needs a different
> cut-off (a sales day that closes at 4am, say), **that belongs in that module as an explicit, named
> rule** — not as a quiet change to this function."*

So: **`packages/domain/src/attendance/shift-day.ts`**, importing `BUSINESS_TIMEZONE` and the
`BusinessDate` primitives from core rather than re-deriving them. That satisfies the instruction
*and* bible §12 landmine 26 (*"v1 had FOUR coexisting date idioms… There is exactly one here. Do not
add a second"*) — there is still one timezone definition, one parser, one formatter. What is added is
one **named, local rule** about where a day is cut.

⚠️ **Do not add a 05:00 variant beside `toBusinessDate` in core.** Two similarly-named functions in
one module, differing by five hours, is how a payroll query silently uses the wrong one — and the
symptom is a rounding-sized pay difference on overnight shifts only, which is the hardest kind of
bug to notice.

### A.3 Contract

```ts
/** A shift day in the business timezone, `YYYY-MM-DD`. NOT interchangeable with BusinessDate. */
export type ShiftDay = string & { readonly __brand: 'ShiftDay' };

export const SHIFT_DAY_START_HOUR = 5;

/** The shift day an instant belongs to. A 01:30 punch belongs to the PREVIOUS calendar date. */
export function toShiftDay(instant: Date): ShiftDay;

/** [start, end) in UTC covering one shift day — 05:00 Manila to 05:00 Manila. Half-open. */
export function shiftDayRange(day: ShiftDay): { start: Date; end: Date };

/** Where a wall-clock hour sits within the shift day, in ms from its 05:00 start.
 *  05:00 -> 0, 18:00 -> 13h, 01:00 -> 20h. This ordering is what lets a store whose shifts
 *  start at 18:00 compare an 01:00 punch correctly: 01:00 comes AFTER 18:00 within one shift
 *  day, even though 1 < 18 as a number. (v1 shift-day.ts:44-50, ported with its reasoning.) */
export function shiftDayOffsetMsForHour(hour: number): number;

export function parseShiftDay(value: string): ShiftDay;
export function addShiftDays(day: ShiftDay, n: number): ShiftDay;
```

⭐ **`ShiftDay` and `BusinessDate` are separate branded types**, so passing one where the other is
expected does not compile. The branding is not decoration — it is the only mechanism that makes the
two-calendar problem a build error instead of a payroll defect.

⚠️ **`shiftDayOffsetMsForHour` is the subtle one and it must be ported with its reasoning**, not
just its arithmetic. A store whose shifts begin at 18:00 and end at 02:00 depends on 01:00 sorting
*after* 18:00. Naive hour comparison gets this backwards and the failure looks like "the anchor
picked the wrong shift", not like a sorting bug.

### A.4 Tests (unit — no database)

| # | Case | Expected |
|---|---|---|
| 1 | 2026-03-10 **01:30** Manila | shift day `2026-03-09`; **and** `toBusinessDate` of the same instant is `2026-03-10` — asserted **in the same test**, because the divergence IS the rule |
| 2 | 2026-03-10 **04:59:59** Manila | `2026-03-09` |
| 3 | 2026-03-10 **05:00:00** Manila | `2026-03-10` — the boundary is inclusive at the start |
| 4 | 2026-03-10 **23:59** Manila | `2026-03-10` |
| 5 | `shiftDayRange('2026-03-10')` | starts `2026-03-09T21:00:00Z`, ends `2026-03-10T21:00:00Z` (Manila is UTC+8, no DST) |
| 6 | `shiftDayOffsetMsForHour` for 5, 18, 1 | `0`, `13h`, `20h` |
| 7 | Every hour 0–23 | maps into `[0, 24h)` exactly once — no gaps, no collisions |
| 8 | A punch at 20:00 and one at 02:00 the next morning | **the same** shift day, and the second sorts after the first by offset |

## Part B — attendance config

### B.1 The requirement it must satisfy, and it is not "store some settings"

Discovery 15 "Intent worth preserving" #6, quoting `payroll.actions.ts:15-18`:

> *"A payslip must never disagree with what was actually recorded, even if today's config has since
> changed… `computePayslip` reads the STORED `payrollComputedHours ?? computedHours` rather than
> recomputing against live config, specifically so a payslip always reflects what was paid, not what
> today's rules would produce for the same historical day. **This is a historical-integrity
> requirement, not an implementation shortcut** — it must survive the SQL rewrite."*

Two ways to keep that promise:

| | How | Verdict |
|---|---|---|
| **Snapshot** | Copy the ~20 values onto every `attendance_days` row | v1's approach, adapted. Twenty columns wide on a table with one row per person per day, and the values are duplicated a hundred thousand times to answer a question asked rarely |
| ⭐ **Effective-date** | Config rows are immutable; a change inserts a new row; the day names the row it was computed under | **Chosen.** One FK. Recomputing a March day in June is deterministic and gives March's answer. The repo already supersedes rather than updates for `person_roles` and `person_grants`, and effective-dated pay rates are what discovery 15 §5 says v1 already does correctly for money |

⭐ **This also makes v2 *better* than v1, not merely equal.** v1 keeps the promise by refusing to
recompute. v2 keeps it while still being able to recompute — which is what makes a genuine repair
(a corrected punch, a fixed bug) possible without either lying about history or manually patching
stored hours.

### B.2 `store_attendance_config` — immutable rows, one live at a time

| Column | Type | v1 default | Source |
|---|---|---|---|
| `id` | `uuid` pk | | |
| `orgId` / `storeId` | `uuid not null` | | |
| `effectiveFrom` | `date not null` | | The shift day this row starts governing |
| `supersededAt` | `timestamptz null` | | Set when the next row is inserted |
| `requiredHoursPerShift` | `numeric(4,2) not null` | **9** | `attendance-config.ts:174` |
| `halfDayHours` | `numeric(4,2) not null` | **5** | `:183` |
| `shortShiftHalfDayOt` | `boolean not null` | **false** | `:182` — opt-in |
| `allowedShiftStartHours` | `integer[] not null` | `{9,10,11,14,15,16,17,18}` | `:` — see B.3 |
| `timeMode` | `text not null` CHECK `('open','fixed')` | `open` | |
| `halfDayOnMissingTap` | `boolean not null` | false | |
| `nightDiffEnabled` | `boolean not null` | true | |
| `nightDiffStartHour` / `nightDiffEndHour` | `integer not null` | **22 / 6** | `:178-179` |
| `nightDiffMultiplier` | `numeric(4,2) not null` | 1.10 | |
| `overtimeMultiplier` | `numeric(4,2) not null` | 1.25 | |
| `lateGraceMinutes` | `integer not null` | **0** | `:82` |
| `earlyOutGraceMinutes` | `integer not null` | **0** | `:95` |
| `undertimeGraceMinutes` | `integer not null` | **0** | `:113` |
| `latePolicy` | `text not null` CHECK `('record_only','charge_per_minute','infraction')` | `record_only` | `:73-78` |
| `lateChargePerMinute` | `numeric(14,2) not null` | 0 | `:80` |
| `lateInfractionPoints` | `integer not null` | 1 | `:115` |
| `breakEnabled` | `boolean not null` | true | |
| `defaultWorkHours` / `defaultBreakHours` | `numeric(4,2) not null` | 8 / 1 | |
| `credentialPasscode` / `credentialNfc` / `credentialFingerprint` / `credentialFace` | `boolean not null` | all true | `EnabledCredentials`, and hot-set item 3 |
| `createdAt` / `createdBy` | | | |

⚠️ **Every column is `NOT NULL` with a default, so "unset" cannot exist.** This is the exact
reasoning `stores.remittanceCadence` already carries (T-152): *"An unset cadence is the same defect
class as an unmapped expense category — it fails quietly, in the direction that looks fine."* v1's
`enabledCredentials` and `breakEnabled` are both **optional** and merged with defaults at read time,
which is the same shape one layer up.

Constraints:
- `unique (store_id) where superseded_at is null` — exactly one live config per store.
- `unique (store_id, effective_from)`.
- ⛔ **A trigger refusing `UPDATE` of any policy column on a row that is superseded**, and refusing
  `DELETE` always. An edited historical config is a silently rewritten payslip.
- `check (night_diff_start_hour between 0 and 23 and night_diff_end_hour between 0 and 23)`.
- `check (late_policy <> 'charge_per_minute' or late_charge_per_minute > 0)` — ⭐ a store that
  switched to charging and left the rate at zero has a policy that costs nothing and looks enforced.
  The Dolibarr `outstanding_limit` failure mode (Phase 2 plan §7), applied to pay.

### B.3 `allowedShiftStartHours` as `integer[]` — the one place a scalar column is not used

Every other config value is a scalar column. This one is a **set of hours**, and the three options
are a child table, a comma-joined string, or a native array.

⭐ **`integer[]` with a CHECK.** Bible §12 landmine 2 forbids **maps-as-records** — a map standing in
for a row with fields. A set of small integers is not a record; it has no fields, no identity, and no
independent lifecycle. A child table would give every hour a uuid, a `created_at` and a foreign key
in order to store the number `14`. Postgres arrays are first-class, indexable and CHECK-able:

```sql
check (array_length(allowed_shift_start_hours, 1) between 1 and 24)
check (allowed_shift_start_hours <@ array[0,1,2,...,23])
check (allowed_shift_start_hours = (select array_agg(distinct h order by h)
                                    from unnest(allowed_shift_start_hours) h))
```

The third one normalises the array to sorted-and-distinct at the database boundary, so no reader ever
has to defend against `[14, 9, 9]`.

> **Fixed-mode shift templates (`shifts[]`) are NOT built here** — see Out of scope. They are a
> record with fields, so if they are ever built they get a real table.

### B.4 Service layer

```ts
getLiveConfig(tx, { storeId }): Promise<AttendanceConfig>
getConfigForShiftDay(tx, { storeId, day: ShiftDay }): Promise<AttendanceConfig>   // ⭐ what T-157 calls
supersedeConfig(tx, actor, { storeId, effectiveFrom, changes }): Promise<AttendanceConfig>
```

- `supersedeConfig` copies the live row, applies `changes`, inserts, and stamps the old row's
  `superseded_at` — **in one transaction**. It never updates a policy column in place.
- `getConfigForShiftDay` picks the row with the greatest `effective_from <= day`. This is the
  function that makes the historical-integrity promise real, and it is the one every test should be
  suspicious of.
- ⛔ **`effectiveFrom` in the past is refused** unless the actor holds `manage_store_settings` *and*
  no `attendance_days` row already references a config for a day at or after it. Backdating a config
  change over already-adjudicated days is exactly the retroactive pay move this table exists to
  prevent — and refusing it is cheaper than detecting it later.

### B.5 Seeding

A store with no config row must not be a store where attendance silently does nothing. **Seed one
row per existing store** at `effective_from = '2026-01-01'` with every v1 default above. Idempotent.

## Part C — the glossary

Three entries in `docs/GLOSSARY.md`, because `CLAUDE.md` says read it *"first, always"* before naming
anything, and because this domain is about to introduce a third meaning of a word that already has two:

- **`shift day` ✅** — 05:00→05:00 Manila. The attendance calendar. **Not** the financial business
  day, which is midnight-based. A 01:30 punch belongs to the previous shift day and the current
  business day.
- **`punch` ✅** — one raw credential presentation at a terminal. A fact, never an outcome. It carries
  no hours and no lateness.
- **`attendance day` ✅** — the adjudicated result for one person on one shift day. ⛔ **Never called a
  "session"**: `session` already means *a group of diners at a table* (this glossary), and
  `packages/db/schema/sessions.ts` already took the second meaning for auth. v1's `attendanceSessions`
  would be the third.

## Invariants

1. A 01:30 punch resolves to the previous shift day and the current business day — asserted together.
2. `ShiftDay` and `BusinessDate` do not interchange; passing one for the other fails `typecheck`.
3. Every hour 0–23 maps into `[0, 24h)` exactly once.
4. A superseded config row cannot be updated or deleted, by any path including raw SQL.
5. Exactly one live config per store.
6. `getConfigForShiftDay` for a day before a change returns the **old** values, after it the new.
7. Every config column is NOT NULL; no store can have a partially-configured attendance policy.
8. `charge_per_minute` with a zero rate is refused.
9. `allowed_shift_start_hours` is always sorted and distinct as read from the database.
10. Backdating an `effective_from` across already-adjudicated days is refused.

## Tests

Part A is **unit** (`packages/domain/src/attendance/shift-day.test.ts`) — pure arithmetic, no database.
⚠️ **Pin `TZ` in the test**, per project memory and bible §12 landmine 7: a server-side date test that
passes only because the developer's machine is in Manila is a test that will fail in CI and pass
locally, or worse, the reverse.

Part B is **integration** against real Postgres on **`shareat_test_b`** — never `shareat_test`.
Fixtures: a seeded store · a supersede, then reading the same day before and after · an attempted
UPDATE of a superseded row (**refused**) · a DELETE (**refused**) · a second live config (**refused**)
· `charge_per_minute` at rate 0 (**refused**) · an unsorted array in, sorted array out · a backdated
`effective_from` over an adjudicated day (**refused**) · re-running the seed (changes nothing).

## Out of scope — each with its reason

**Fixed-mode shift templates (`shifts[]`, `FixedShift`)** — discovery 15 §3 records that fixed mode's
`shifts[]` grid and open mode's `allowedShiftStartHours` *"are a genuinely different grid and can
disagree; documented as dormant (**no store runs fixed mode**) but not removed."* ⭐ **Building a
second, conflicting schedule grid that no store uses, in the same task that establishes the first
one, is how the disagreement gets ported.** `timeMode` keeps the column so the option is not
foreclosed; the templates get their own task if a store ever wants one · **`PayrollConfig`
(period type, cutoffs, statutory toggles)** — Phase 5, and it changes on a different cadence ·
**Holiday calendar** — T-157 needs it, and it is a per-org dated *list*, not per-store policy; it
lands there · **Any settings UI** — schema and service only · **The mirror publisher's priority
refresh of this table** — T-160, and it is why config is hot-set item 3.

## Done when

- [ ] All ten invariants pass — Part A unit with `TZ` pinned, Part B integration on `shareat_test_b`.
- [ ] Migration hand-written, numbered in **0070–0089**, `meta/_journal.json` row hand-added as
      `previous.when + 86400000`.
- [ ] `store_attendance_config` classified in `cutover/classification.ts` **and** registered in
      `rls/registry.ts` — ⭐ **own first commit**.
- [ ] The three glossary entries are in `docs/GLOSSARY.md`.
- [ ] Every v1 default in B.2 verified against `ERP-rebuild/src/types/attendance-config.ts` by
      reading it, not by trusting this table. ⚠️ **If any differs, the spec is wrong — report it,
      do not quietly follow the source** (§3.4a).
- [ ] `npm run typecheck` · `npm test` · `npm run test:integration` green, real output reported.
