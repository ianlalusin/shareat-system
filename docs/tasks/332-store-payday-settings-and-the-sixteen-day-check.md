# T-332 — the payday settings Ian asked for already exist; what is missing is the row and the check

**Status:** ⭐ **SPECCED 2026-09-20 by the orchestrator (`system32-df`), NOT BUILT.** Ordered by Ian
the same night: *"create a doc on store settings where admin define the date of paydays."*
**Migration slot:** ⛔ **decide at build time — §4.2 turns on whether a backfill is a migration.**
**Depends on:** nothing. ⚠️ **T-187 is its best data source but is NOT a prerequisite** — §5.

> ⛔ **READ THIS FIRST, BECAUSE IT CHANGES THE ORDER.** Ian asked for a screen where an admin
> defines paydays. **That screen exists.** `/settings/attendance` already edits a per-store,
> effective-dated pay cycle, shipped under T-189c/T-189d. Building it again would have been days
> spent re-creating something already in the repo. This task is what is actually missing, and it is
> smaller and more useful. ⭐ **Side with the project, and say plainly that you did** — RULES §4.

---

## 1. What already exists — measured, not assumed

A read-only census (`webapps-17`, 2026-09-20) found the payday model already built:

| Thing | Where |
|---|---|
| The per-store settings mechanism | **`store_attendance_config`** (`packages/db/schema/attendance-config.ts`) — effective-dated, one live row per store. ⛔ **NOT on `stores`**, which has no JSON or settings column |
| The payday policy itself | `payrollPeriodType` (monthly/semi_monthly/weekly) · `semiMonthlyCutoffDay` (CHECK 1..27, default 15) · `payoutMode` (lag/fixed_days) · `payoutLagDays` · `payoutDays` |
| The derivation | `packages/domain/src/payroll/periods.ts` — `derivePeriods`, `tilesTheMonth`, `periodForDate`, `payoutDateFor` |
| The admin screen | **`/settings/attendance`** → `updateAttendanceConfigAction`, capability `manage_store_settings`, store-scope, **admin and manager** |
| The clock | `packages/db/src/repo/sql-time.ts` — `MANILA_TODAY`, Postgres-side. Business dates are `YYYY-MM-DD` strings, never a round-tripped `Date` |

⭐ **So Ian's instruction is already satisfied on its face** — the same shape as row 222's *"turn on
the service charge"*, where the measurement was that there was nothing to turn on.

## 2. ⭐ The measurement that decides this task

Bible row 223 cautions that *"a month with a 31st can stretch a semi-monthly gap to 16-17 days."*
That was a hypothesis. `webapps-17` **ran the repo's own unmodified `derivePeriods` and
`payoutDateFor`** across 2026 (non-leap) and 2028 (leap), on the schema's real defaults
(semi_monthly, cutoff 15, lag, lag-days 0):

| Cadence | Max gap | Verdict against RA 11360's sixteen-day ceiling |
|---|---|---|
| **semi_monthly** (the default) | **exactly 16 days**, in **7 months of every year** — Jan, Mar, May, Jul, Aug, Oct, Dec, always the 15th to the 31st. Never 17. Leap years identical. | ✅ compliant — **with ZERO slack, seven times a year** |
| **monthly** | 28-31 days, every gap, all year | ⛔ **non-compliant every single month**, smallest gap 12 days over |
| **weekly** | 1-7 days | ✅ compliant, nine days of margin |

⭐⭐ **THE FINDING IS BETTER THAN THE HYPOTHESIS AND POINTS SOMEWHERE ELSE.** Row 223 feared an
overshoot. There is none — the model never reaches 17. **The real exposure is that it sits exactly
ON the ceiling seven months a year, so any slip of one day breaks the statute:** a payout landing
on a weekend or a holiday, an admin running payroll a day late, or `payoutLagDays` ever being
bumped off 0.

⛔ **Therefore "the config already guarantees compliance" is the wrong conclusion to draw from
these numbers, and it is the conclusion they superficially support.** Work out the DIRECTION of the
error before its severity: a gap measured too SHORT is the dangerous direction, and a model that
stops at 16 by construction measures nothing about the day it was actually paid.

⚠️ **`fixed_days` mode was NOT measured** — the census was scoped to the defaults and said so.
**Do not read these numbers as covering it.**

## 3. ⛔ DEF-249 — a brand-new store has NO payday policy at all, and the screen shows nothing

> ⛔ **CORRECTION, same night.** This section was first written against a NEW defect number,
> **DEF-405**. It was a **duplicate**: DEF-249 had already recorded the same defect and the same
> mechanism on 2026-09-09/10, with two discovery documents behind it. DEF-405 is retracted and its
> measured evidence merged here. ⭐ **The census lane caught it while verifying an unrelated
> sentence** — a 1.2MB register was never grepped before a number was issued, and **a duplicate
> passes every guard this repo has**, because they all check whether a row is well-formed and none
> asks whether it is new.
>
> ⭐⭐ **AND THE NEAR-MISS MATTERS MORE THAN THE DUPLICATE.** DEF-249 carries two consequences a
> fresh row would have missed entirely, **both live, both on this same table, and both to be read
> before building this task**:
> **DEF-251** — the attendance sweep INNER JOINs on the config, so an unconfigured store is not in
> the population at all and the job reports **clean success**. ⚠️ That is precisely the quiet-failure
> shape §4.3's detector exists to avoid, already shipped, one table away.
> **DEF-256** — T-197's short-shift overtime decision has **never reached a single store** through
> this same hole. A payroll consequence, not merely a wiring one.

Measured tonight against a freshly bootstrapped throwaway database:

```
bootstrap-org --code=SMOKE_ORG ... --store-code=SMK --confirm   -> store created
select count(*) from store_attendance_config                    -> 0
/settings/attendance rendered signed-in                         -> a store picker and NOTHING ELSE
```

`bootstrap-org.ts` creates the organisation, the chart of accounts, 38 expense categories, 12
fiscal periods, the first admin, the store and its default room — **and no attendance config.**
⛔ **Column defaults do not save this: a default needs a ROW, and there is no row.** So the first
store of a new organisation has no pay cycle, `payoutDateFor` has nothing to derive from, and the
screen an admin would use to fix it renders empty because it edits a row that does not exist.
⚠️ **This is the state production is in if `bootstrap-org` is how production's org was made.**
⭐ **The evidence above is what this re-measurement ADDS to DEF-249**, which reasons from call sites: this was measured end to end on a running app. **Tracked as DEF-249**, with DEF-251 and DEF-256 as its live consequences.

## 4. Scope

1. ⭐ **Seed the config in `createStore`** — `packages/domain/src/stores/service.ts:100`, in the same
   transaction that inserts the store.
   ⭐⭐ **THE CENSUS SETTLED WHERE THIS GOES, AND THE ANSWER IS BETTER THAN THE ONE THIS SPEC FIRST
   GUESSED.** The first draft said "and so does whatever creates a store through `/admin/stores`",
   inferring two independent writers that must both be fixed. **They are not two writers.** There is
   exactly **one** INSERT into `stores` in the whole application — `storesRepo.insertStore`
   (`packages/db/src/repo/stores.ts:152`) — with exactly **one** production caller, `createStore`,
   which has **three doors into it**: `/admin/stores`'s `createStoreAction`, and
   `bootstrapOrganization` (`packages/domain/src/organizations/index.ts:66,389`), which is what BOTH
   `/setup` and `scripts/bootstrap-org.ts` call. ⛔ **So `bootstrap-org.ts` is the wrong place to fix
   it** — patching there leaves `/admin/stores` broken. **One function, one hole, one fix.**
   ⚠️ **No migration inserts a store and no trigger creates the config** — both checked, not assumed.
   ⚠️ **The ~30 integration fixtures that insert a store do NOT go through `createStore`** — each
   defines its own local raw-insert helper of the same name. Seeding inside `createStore` will not
   reach them, and ⭐ **that is fine and worth knowing rather than fixing**: the 10 attendance-specific
   test files already call `seedAttendanceConfig` explicitly as a visible second step, and the other
   fixtures run against the same unconfigured state production does. **The suite is not lying to
   itself here.**
2. **A backfill for stores that already exist without a config.** Whether that is a migration or a
   one-shot script is the builder's call, **stated in the spec before building** — an applied
   migration is never edited, so this is the decision that cannot be taken back.
3. ⭐ **The detector — the actual point of the task.** A finding, in the shape of those in
   `packages/db/src/repo/findings.ts`, per store, **soft** severity, firing when a store's
   configured cadence cannot satisfy RA 11360. ⛔ **`monthly` is the unambiguous case and §2 proves
   it by measurement** — any store on `payrollPeriodType = 'monthly'` is non-compliant every month.
   **Fire on that outright.** Follow `grniNotAtRest`'s per-store shape, which
   `serviceChargeFloatAgeing` is being regrouped onto under T-187.
4. **A store with NO live config is itself a finding** — the DEF-249 state made visible rather than
   silent, so the backfill can be verified from the app instead of from SQL.

## 5. Out of scope, and the second half that is deliberately not here

- ⛔ **Building a payday settings screen.** It exists. §1.
- ⛔ **Changing `semiMonthlyCutoffDay`'s CHECK, the enum values, or any default.** Ian ruled the
  business runs a 15-day cycle and the default already encodes it.
- ⛔ **Modelling weekends or holidays.** Real, and the thing that turns 16 into 17 — but it is a
  calendar capability this repo does not have, and inventing one inside a compliance detector is
  how a detector acquires a second source of truth about what a working day is.
- ⭐ **THE DETECTOR THIS TASK CANNOT BUILD, NAMED SO NOBODY THINKS IT DID.** §2 shows the exposure
  is the distance between the MODELLED payout date and the REAL one. Nothing in the repo records a
  real payout date today. **T-187 is the first thing that will** — it records the date a store's
  service-charge float was actually discharged. Once T-187 has shipped and produced data, the
  honest detector is *"did the real payout land more than sixteen days after the previous real
  payout"*, and **that is a later task, not this one.** ⛔ Do not stub it here. This task ships the
  config-level check, which is the half that can be true today.

## 6. Done when

Every §9 gate, including **§9.4 in a real browser — which is now possible**: a session can be minted
locally against a throwaway database and driven headless.

⛔ **Read `docs/SMOKETEST.md` §3 before using it, and cite THAT, not this sentence.** The forge
**bypasses sign-in on purpose**, so a smoketest through it proves things about **screens** and
**nothing whatever about authentication**. ⚠️ **Do not cite `docs/HANDOFF-TODAY.md` for this** — an
earlier draft of this section did, and that file still carries the pre-fix claim that nobody can
drive a browser at all.

⛔ **Plus two specific to this task:** a freshly bootstrapped store must come up with a live config
and a populated `/settings/attendance`, **shown on screen, not asserted**; and a store set to
`monthly` must produce the finding while a `semi_monthly` store produces none.

---

## Amendment 1 — 2026-09-21, from a read-only Opus spec audit run BEFORE any source existed

> ⭐ **Every one of §1–§4's load-bearing claims was independently re-measured and HELD.** `/settings/attendance`
> exists with a "Pay periods" group (`page.tsx:194-222`); there is exactly one `.insert(stores)`
> (`stores.ts:154`) with exactly one production caller and three doors; §2's arithmetic reproduces
> exactly; DEF-249/251/256 are where §3 says. ⛔ **What follows is what the audit found ANYWAY**, and
> two items change what gets built. Auditor: `webapps-cb` (Opus 5). Orchestrator: `system32-df`.

### A1.1 ⛔ §6's second half was a FALSE RULE, and it is now DEF-409

§6 required *"a `semi_monthly` store produces none"*. **There exist `semi_monthly` stores that are
flagrantly non-compliant, so as drafted the done-when MANDATED silence about a real breach.**
`payout_days` is constrained only by `cardinality > 0` (`0109:35`), the screen offers it as free
text hinted *"e.g. 10,25"*, and `payoutDateFor` picks `payoutDays[min(periodIndex, length-1)]`
(`periods.ts:158`) — so a **single-entry** array collapses both semi-monthly periods onto one day
and consecutive distinct paydays run **28 days** apart. Twelve days over the ceiling.

⛔ **Filed as DEF-409** (register section E, `reported`, INFERRED not executed). ⚠️ `10,25` is fine
(15/13/15/16); it is the one-element array that collapses, so this is not closeable as *"configure
it sensibly"*. ⚠️ §2's measured "max 16 days, seven months a year" holds **only for
`payout_mode = 'lag'`** — the census scoped itself to the defaults and said so.

**§4.3 IS AMENDED:** compute the finding from `derivePeriods` and `payoutDateFor`, **not from
`payrollPeriodType` alone**. `monthly` still fires outright; a collapsed `fixed_days` store fires
for the same measured reason.
**§6 IS AMENDED** to: *a `semi_monthly` store **on the schema defaults** produces none* — which is
true, where the original was not.

### A1.2 ⛔ Both halves of §6 must assert through `listFindings`, never the exported function

The registry is a hand-maintained array literal inside `feed()`
(`packages/domain/src/findings/index.ts:95-136`). **A detector exported from `findings.ts` and never
spread into that array runs nowhere, and nothing enumerates exports against the registry.** A test
that imports the detector and calls it directly passes BOTH halves of §6 with zero registration —
**DEF-406's exact shape**.

⭐ **It is one clause from sound, and better than DEF-406 was:** the `monthly` half is a real
positive control, because the same absence that silences the negative case also silences the
positive one. That only holds if both go through `listFindings`. House convention already does it:
`findings.test.ts:111` (`const feed = (f) => asOrg(..., listFindings(...))`), model pair
`grniNotAtRest` at `:576`/`:587`.

### A1.3 ⚠️ §4.2 was underspecified one level below where it said — `effectiveFrom` and `createdBy`

Migration-vs-script is the **reversible** half. The irreversible half is **`effectiveFrom`**, which
this spec never mentioned. `seedAttendanceConfig` requires it with no default
(`attendance/config.ts:114`) and `findForDay` resolves by `effective_from <= day`
(`attendance-config.ts:91`):

- **Backfill at today** → every day already worked still resolves to NO config, so **DEF-251's
  INNER JOIN exclusion and DEF-256's unreached decision survive across all history.** ⛔ *The
  backfill looks done and the consequences it was written for survive* — the quiet-failure shape
  this task exists to remove, reappearing inside the remedy.
- **Backfill at an early date** → a policy nobody chose retroactively governs days already worked,
  including DEF-256's `short_shift_half_day_ot = true`. **Fabricating a historical fact.**

⚠️ **`createdBy` has the same gap** — there is no actor in a backfill, and `null` must remain
distinguishable from a real user or the audit trail has a hole.
⛔ **And inside `createStore` the choice sets a FLOOR:** if the screen refuses an edit at or before
the live row's `effectiveFrom`, then seeding at today means **the admin who just created the store
cannot change its pay policy until tomorrow.** ⭐ **All three must be stated before building.**

### A1.4 ⭐ §4.1's options menu omitted the precedent this repo already set

§4.1's *"no trigger creates the config — checked, not assumed"* is **literally true and reads as
though this repo does not do that. It does.** `0029_t142_foundation_money_accounts.sql` defines an
idempotent `seed_foundation_money_accounts(p_org_id, p_store_id)`, an `AFTER INSERT ON stores`
trigger (`:62`), and an adopt-then-backfill **in the same migration** — §4.1 and §4.2 solved
together, one table over, commented *"Every new store gets them, whichever path created it."*

⚠️ **This is NOT a recommendation to use a trigger here** — it cannot call domain code, it would
fire inside the ~30 raw-insert fixtures §4.1 deliberately leaves unseeded, and it has no actor for
`createdBy`. It is named so the decision is made against the full record.
⭐ **It also recolours §4.1's own paragraph:** those ~30 fixtures DO get foundation money accounts
today, so *"the other fixtures run against the same unconfigured state production does"* is true of
**the config** and not of the store generally.

### A1.5 ✅ §4.3 and §4.4 are TWO detectors — the orchestrator's doubt was unfounded

They are mutually exclusive by construction: **a store with no live config has no cadence to
judge.** The registry already carries the pair — `posUsagePullNotRun` / `usageRecordMissing`
(`findings/index.ts:112-115`), commented *"The exact complement of `posUsagePullNotRun` above: a
store with no active POS mapping at all, so that detector's own gate never looks at it."* **Copy
that shape and that comment.**

### A1.6 ⛔ One constant for one statute — and cite the RIGHT statute

`SERVICE_CHARGE_MAX_DAYS = 16` already exists (`findings.ts:307`) carrying the sixteen-day citation.
§4.3 **cites it rather than declaring a second** — declaring a second is precisely what §5 warns
about two bullets earlier.
⚠️ **Statute split:** the sixteen-day interval for **WAGES** is **Labor Code Art. 103**; **RA 11360**
carries the same number for **SERVICE CHARGES**. §4.3's operator-facing sentence must cite Art. 103
— a person reading a payroll alert is entitled to a citation that survives being looked up.

### A1.7 ⚠️ §2's risk narrative names one cause that CANNOT happen

§2 lists *"`payoutLagDays` ever being bumped off 0"* as breaking the statute. **It cannot.** Payout
is period end plus the lag for every period, so the interval between consecutive paydays is
`(end2+lag) - (end1+lag) = end2 - end1` — a uniform lag shifts every payday equally and changes no
gap at all (`periods.ts:152-156`). ⛔ **That limb is struck.** The two real causes stand: a payday
landing on a weekend or holiday, and payroll run late. Corrected because a builder who tests the
inert limb may discount the rest of the section.

### A1.8 ⚠️ §6's stated REASON for not citing `HANDOFF-TODAY.md` is stale

§6 says that file *"still carries the pre-fix claim that nobody can drive a browser at all."* It no
longer does — it now leads with *"THE SCREEN GATE IS OPEN."* **The instruction stands** (cite
`SMOKETEST.md` §3, which says the forge bypasses sign-in on purpose); only the false reason is
struck, because a builder who checks the reason and finds it inverted may discount the instruction
with it.

### A1.9 Minor corrections

- §3's *"a store picker and NOTHING ELSE"* is wrong: the screen renders an explicit empty state,
  *"This store has no attendance config yet."* (`page.tsx:80-84`). Does not change DEF-249; it does
  soften §4.4's rationale — the state is **not invisible on that screen** — though the findings feed
  remains the right place for it.
- §4.1 never named **`seedAttendanceConfig`** (`packages/domain/src/attendance/config.ts:114-121`),
  which is **production code, already idempotent** (existing live row wins) and is the obvious
  callee. Naming it removes a choice from the builder.

### A1.10 Decisions taken at amendment time

- **§4.2 shape: (b) a one-shot script, NOT a migration. No migration slot allocated; `0157` stays
  free.** Reason, from the builder: `seedAttendanceConfig` is the one place that knows what a
  correct default row is, and a SQL migration cannot call it — it would restate the INSERT in raw
  SQL, **a second source of truth for defaults that drifts the next time a default changes.**
  Precedent: `scripts/backfill-fiscal-periods.ts` (`--confirm` gated, dry-run default, one
  transaction per row, reports inserted/skipped/coverage).
- ⛔ **`effectiveFrom`, `createdBy`, and the `createStore` floor are OPEN and go to Ian.** See A1.3.
- **Build order: SLICE A** (seed in `createStore` + the backfill script) **then SLICE B** (the two
  detectors). Slice B does not start until A1.1 and A1.2 are reflected in its tests.

### A1.11 ⭐ The three OPEN questions in A1.3 are CLOSED — and measurement dissolved all three

⛔ **A1.3 said `effectiveFrom`, `createdBy` and the `createStore` floor were open and going to Ian.
They went to the source instead, and none of them survived contact with it.** All three were
measured by the builder lane (`webapps-4d`), with the code quoted, not reasoned about. ⭐ **This is
the repo's own lesson landing for the third time in two days: a static read NOMINATES, running
SETTLES.** The audit's A1.3 was a correct concern from a correct premise — and reading the JOIN
settled it the other way.

**1. `effective_from` = Manila's business date (today). RULED.**
A1.3 feared that seeding at today leaves DEF-251 and DEF-256 alive across all history. **It does
not, and the reason is in the sweep's own SQL.** The population is
`stores s join store_attendance_config c on c.store_id = s.id and c.superseded_at is null`
(`scheduler/index.ts:346`) and `sweep.ts:117` — ⛔ **there is no `effective_from` filter anywhere in
it** — and it selects `d.status = 'open' and d.frozen_at is null` (`sweep.ts:138-140`). So the moment
ANY live row exists the store enters the population on the next run.

> ⛔ **CORRECTED SAME SESSION, and the correction matters because the wrong version reads like a
> fact about the sweep.** This paragraph first said those days "are by definition happening now".
> **They are not.** `sweep.ts:138-140` applies **no date bound at all** — an attendance day that
> opened three weeks ago and was never closed is still `open` and is still in that result set.
> ⭐ **"Open" means UNCLOSED, not RECENT.** The ruling is unaffected: it rests on the sweep never
> reading `effective_from`, which is measured and true, not on how old an open day can be.
**DEF-251 closes completely, whatever date the row carries.**

⭐ **And backdating would have been actively WORSE, which inverts A1.3's framing.** For DEF-256,
`getConfigForShiftDay` is effective-dated and deliberately THROWS on a day before config existed
(`config.ts:36-38` — *"never substitute the live config for a missing historical one"*), matching
`ingestor.ts:320-325` which quarantines rather than silently passing. That refusal is unchanged by
the backfill. But `seedAttendanceConfig` has **no `hasAdjudicatedDaysFrom` guard**, so a
creation-date-backdated config could make an old unfrozen day **silently adjudicate under a policy
invented after the fact** — turning today's loud refusal into a quiet wrong answer. ⛔ *Fabricating
history* was not merely dishonest; it was the dangerous direction.

**2. `createdBy` = `null` in the backfill script, a real actor everywhere else. RULED.**
`created_by` on this table is **deliberately nullable** (`schema/attendance-config.ts:282`, no
`.notNull()`) — unlike most of this codebase, where it is NOT NULL with the comment *"only a human
ever writes here"* (`0048_t147...sql:26`). ⭐ **That exception was written anticipating exactly this
non-human writer.** `createStore`'s seed and `supersedeConfig` both always pass `actor.personId`, so
`null` appears if and only if the script wrote the row. The audit trail keeps its distinction.

**3. The `createStore` floor is REAL, PRE-EXISTING, and a net IMPROVEMENT. No action.**
`config.ts:76` does refuse `input.effectiveFrom <= live.effectiveFrom`. ⛔ **But T-332 does not
introduce it.** The screen already defaults the field to tomorrow
(`page.tsx:47`, `defaultEffectiveFrom = addShiftDays(toShiftDay(), 1)`) and already explains itself
in the form: *"Must be after {cfg.effectiveFrom} (today's live policy)…"* (`page.tsx:100`). It is
the screen's general behaviour for any store whose live row is effective today, and it is
**identical under either candidate** — a store created today has `effectiveFrom = today` whichever
option had been chosen, so backdating would not have avoided it either.
⭐ **Before T-332 the screen rendered no form at all** (`!cfg`). An admin who must wait until
tomorrow to change a policy is strictly better off than one who cannot set a policy at all. **Not a
papercut this task introduces; not filed.**

> ⭐⭐ **THE METHOD NOTE, because it is worth more than the ruling.** Three questions were escalated
> toward Ian on a correct reading of correct code. All three dissolved when someone opened the
> consuming query instead of the writing one. **A1.3 asked what `effective_from` MEANS; the answer
> was that the code which was supposed to care about it does not read it.** ⛔ Before escalating a
> decision, read the CONSUMER, not only the producer.

### A1.12 ⭐ The old-open-day question, chased to its end — the ruling holds, and the backfill gains one operator sentence

A1.11's correction above (an open day can be weeks old) looked as though it might reopen the
`effective_from` ruling: if the sweep can pick up a three-week-old unclosed day, could it be
processed under a live policy that post-dates it? ⛔ **It cannot silently, and the audit traced it
to the end rather than stopping at the worry.**

- `sweep.ts:161` writes `markNeedsReview` and **no punch** — so **no pay is computed at the sweep.**
- The money step is `adjudicate.ts:126` → `getConfigForShiftDay` → `findForDay`
  (`effective_from <= day`), which **THROWS** when nothing governed that day (`config.ts:44-50`).

⭐ So with `effective_from` = today, an old day reaches a **loud, designed refusal** — *"this day
cannot be adjudicated without deciding, explicitly, which policy applied to it"* — and never a quiet
wrong number. **That is the direction A1.11 wanted, and it is the direction its ruling produces.**

⚠️ **ONE OPERATIONAL CONSEQUENCE, for the backfill's operator note — not a defect and not a register
row.** Backfilling puts previously-excluded stores INTO the sweep population. A store holding old
unclosed days can therefore acquire a `needs_review` queue that then **refuses to settle** until
someone decides which policy governed those days. ⛔ DEF-251's own row already records that there is
nothing at those stores to sweep today, so this is **latent, exactly as that row says** — but
whoever runs the backfill should not meet it as a surprise. **One sentence in the script's operator
output is the whole remedy.**

> ⭐⭐ **THE METHOD NOTE, sharpened by its own counter-example.** A1.11 said *read the CONSUMER, not
> only the producer*. That is right and it is what caught the auditor, who measured `findForDay` and
> stopped at the function that reads `effective_from` without asking which consumers call it — the
> sweep does not. ⚠️ **But it cuts both ways, and this is the half worth keeping:** the sweep's
> indifference to `effective_from` is simultaneously **what made the ruling safe** and **what made
> the false "open means now" sentence survivable for as long as it lasted.** A claim can be
> load-bearing-adjacent — sitting right next to the real reason, quoted as though it were the real
> reason, and wrong. ⛔ Check the limb you did not lean on, because someone later will lean on it.

### A1.13 ⭐ Slice B's contract — the two detector names, RULED, and why one of them is not what it looks like

Neither the spec nor Amendment 1 named these, and a mismatch between the test and the registration
produces a **plumbing red rather than an assertion red** — the distinction this task has already
spent effort on once. Ruled by the orchestrator, proposed by the tester lane:

| | kind | key | severity |
|---|---|---|---|
| **B1** cadence compliance | **`payoutIntervalTooLong`** | `` `payoutIntervalTooLong:${storeId}` `` | `soft` (§4.3 states it) |
| **B2** no live config | **`attendanceConfigMissing`** | `` `attendanceConfigMissing:${storeId}` `` | `soft` |

⭐ **B2 matches `usageRecordMissing` on the nose**, which is right: A1.5 makes it that detector's
structural twin, and the pair `posUsagePullNotRun` / `usageRecordMissing` is the shape being copied.

⛔ **B1 was PROPOSED as `payIntervalExceedsArt103` and that was REJECTED. The reason generalises
beyond this task.** A finding's `kind` is **persisted** — `recordFindingObservations` writes it and
acknowledgements are keyed off it — so **a kind is a permanent identifier**, and anything embedded
in it can never be changed without orphaning every stored observation that used the old name.
⚠️ **A statute citation is exactly the thing that changes:** it gets renumbered, superseded, or turns
out to be the wrong statute — **which very nearly happened here.** A1.6 records that this task was
one draft away from citing RA 11360 at someone reading a **wage** alert, when the wage rule is Labor
Code Art. 103.

⭐ **The house already separates these, and the precedent is the sibling detector:**
`serviceChargeFloatAgeing` carries no statute in its name. The law lives in
`SERVICE_CHARGE_MAX_DAYS`'s citation (`findings.ts:307`) and in the operator-facing message.
⛔ **The kind names the CONDITION. The constant and the message carry the LAW.** `grniNotAtRest`,
`usageRecordMissing` and `posUsagePullNotRun` are all condition-named; `payoutIntervalTooLong` is the
same noun-plus-state shape.

⚠️ **Per A1.6 the detector reuses `SERVICE_CHARGE_MAX_DAYS` rather than declaring a second constant
for the same number.** One statute, one constant.

> ⭐⭐ **THE TRANSFERABLE RULE, which is bigger than this detector: ask what a name is WRITTEN INTO
> before choosing it.** A kind string looks like a label and behaves like a primary key. ⛔ Anything
> that will be persisted must be named for what is true about the CONDITION forever, never for the
> current explanation of why the condition matters — explanations get revised, and a revised
> explanation inside a persisted identifier is a migration nobody budgeted for.

### A1.14 ⭐ §9.4 MET for slice A — and the screen showed a consequence nobody in this cycle had written down

**Driven 2026-09-21 by the tester lane (`webapps-d1`) against `next start` on 9008, database
`shareat_test_t332_smoke`, bootstrapped AFTER the fix. Screenshot read by the orchestrator, not
taken on trust.** 9/9 script assertions passed.

⛔ **THE LIMIT, STATED WHEREVER THIS IS CITED:** the session is **FORGED** (`SMOKETEST.md` §3). It
**bypasses sign-in on purpose**, so it proves things about **SCREENS** and **NOTHING WHATEVER about
authentication.** Real end-to-end sign-in still needs the Firebase terminal account only Ian can
create.

```
/                     landed=/                      SIGNED IN
/findings             landed=/findings              SIGNED IN
/liabilities          landed=/liabilities           SIGNED IN
/settings/attendance  landed=/settings/attendance   SIGNED IN
PASS  empty-state sentence GONE ("This store has no attendance config yet.")
PASS  semi-monthly · cutoff 15 · payout mode lag · lag days 0
```
⚠️ Console: exactly one `404`, the known static-asset noise (`SMOKETEST.md` §5). Not new.
⚠️ The effective-from field defaults to **09/22/2026** and explains itself in full: *"Must be after
2026-09-21 (today's live policy) and cannot fall on or before a day already adjudicated."* ⭐ The
second clause was not in anyone's prediction — the screen guards **already-adjudicated days** as
well as the live date, which is A1.12's refusal surfaced in the UI rather than only at
`adjudicate.ts`. The floor ruling in A1.11 stands and is now visible rather than inferred.

=== ⭐⭐ WHAT THE SCREENSHOT REVEALED THAT NO TEST ASSERTED ===

The rendered form is **fully populated across every group** — Shift & capture, Clock-in
credentials, Overtime & premiums, Holiday multipliers, Late policy, Pay periods, Sweep & terminal.
⛔ **And "Short-shift half-day OT" is CHECKED.** Confirmed in the database on the same store:
`short_shift_half_day_ot = true`.

⭐ **That is DEF-256, closing as a side effect of DEF-249's fix, and nobody in this cycle predicted
it.** DEF-256 records that *"T-197 / DEF-112's decided default has never reached a single store, so
a pay correction that was argued, costed and shipped landed NOWHERE"* — `short_shift_half_day_ot`
was set TRUE on a measured ~9.2%-of-basic-pay argument, justified in the schema and in its
migration, **and no store ever had a row for the default to apply to.** Seeding the row is what
delivers it. The spec listed DEF-256 as a *consequence* of DEF-249 (§3); it did not notice that
fixing DEF-249 therefore *delivers* it.

⛔ **BE PRECISE ABOUT WHAT IS AND IS NOT CLOSED — this is exactly the place to overclaim:**
- ✅ **NEW stores**, through all three doors, now carry the decided default from creation. Measured.
- ⚠️ **EXISTING stores** get it only when the backfill runs, and that script is still being
  corrected (finding 1 / DEF-410's shape). Until then, nothing has changed for them.
- ⛔ **HISTORY IS NOT CLOSED AND MUST NOT BE CLAIMED.** `effective_from` is today (A1.11), and
  `findForDay` resolves by `effective_from <= day`, so days already worked still resolve to no
  policy and still reach `getConfigForShiftDay`'s deliberate refusal. **The decision reaches those
  stores PROSPECTIVELY ONLY.** That is the correct outcome per A1.11 — backdating would have let an
  old day adjudicate under a policy invented afterwards — but it means DEF-256 is *delivered going
  forward*, not *retroactively repaired*.

> ⭐ **THE METHOD NOTE: the screenshot outperformed the assertions.** Five tests asserted five
> fields and all five passed. **The finding that mattered was in a group nobody was asked to look
> at**, visible only because a human-readable artefact was produced and then actually read. ⛔ A
> green assertion list would have shipped this slice without anyone noticing it had closed a
> second, separately-argued defect. *A static read nominates, running settles* — and a picture
> shows you what you did not think to assert.

### A1.15 ⛔ CORRECTION TO A1.14 — the verb was wrong, and the framing was more wrong than the verb

**A1.14 was given an adversarial read at the orchestrator's request. Its factual core was
independently CONFIRMED and two things about how it was WRITTEN were not.**

Confirmed by the auditor, executed: `0111_t197_short_shift_default_on.sql:24` sets
`short_shift_half_day_ot` default **true**, `schema/attendance-config.ts:120` agrees, and
`seedAttendanceConfig` passes only `orgId`/`storeId`/`effectiveFrom`/`createdBy` — so every other
column takes its database default and a seeded row carries `true`. The screenshot, the DB read and
the source all agree. A1.14's scope limits are all correct as written.

**⚠️ CORRECTION 1 — the verb.** A1.14 says *"DEF-256 being delivered"*, which reads as **the
~9.2%-of-basic-pay correction is now in effect. It is not, anywhere.** What is now true is that
**the flag reaches a store's config row.** It reaches **pay** only when attendance is actually
adjudicated at that store — and no store has been adjudicating anything, which is DEF-249 and
DEF-251's whole point and the reason DEF-256 existed at all. ⛔ **The screenshot evidences a
CHECKBOX, not a peso.**
**Restated correctly: DEF-256's MECHANISM is closed for new stores. Its CONSEQUENCE remains pending
on attendance actually running.**

**⛔ CORRECTION 2 — the framing, which matters more than the verb.** A1.14 presents this as a bonus.
⭐ **It is also this: every store created from now on silently acquires a MONEY-AFFECTING DEFAULT,
argued and costed under T-197 at roughly 9.2% of basic pay, and it becomes live at store creation
WITHOUT ANYONE RE-RATIFYING IT — as a side effect of a wiring task.**

That is **correct behaviour** — it is the decided default, T-197 decided it, and seeding it is the
fix. ⚠️ **And the error direction is the reassuring one: it pays staff MORE, so the exposure is cost,
not underpayment.** But *"our fix quietly turned on a pay rule"* is a sentence Ian is entitled to
hear rather than discover, and A1.14 did not say it. **Escalated to Ian as a notification, not as a
request for permission** — nothing is being held up for an answer.

> ⭐⭐ **THE METHOD NOTE, and it is about this document rather than the code.** A1.14 was written by
> the orchestrator, from a screenshot the orchestrator read, about a defect closing earlier than
> anyone expected. ⛔ **That is exactly the kind of finding that gets written up in its most
> flattering form, by the person least able to see it.** It took an adversarial read by a session
> that had not written it. **The rule generalises: a finding that makes our own work look better
> than we thought deserves the same hostile read as a finding against it — and it will not get one
> from its author.**
