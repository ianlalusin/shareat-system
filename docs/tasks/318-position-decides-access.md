# T-318 — a position decides what a person may do

> ### **Status: SPEC — written 2026-09-14 by `system32-85` (Opus planner). NOT BUILT. Reserves T-318 and migration `0152`.**
>
> **Ian, 2026-09-14**, shown the two options in plain language and asked which: *"yes A"* — shrink
> the staff baseline, so the 21 everyday capabilities stop being automatic and are granted to a
> position explicitly. The screen design was approved in the same message: *"the artifact seems
> good to me"*.
>
> **What he was actually reporting**, and it is the acceptance test for this task:
> *"still cant turn off record sale submit sales day on dishwasher role and server and panda role
> they do not have this."*

## Why this exists

`/admin/access-defaults` renders `record_sale` and `submit_sales_day` as a flat **`inherited`**
badge with no control beside it, for every position. That is not a screen fault. **Position defaults
can only ADD capability on top of what the role already grants; they can never take any away** —
and `packages/domain/src/people/position-defaults.ts` refuses the write in terms, saying a default
*"would be a row that changes nothing"*.

Underneath, the system has **four roles** — `super_admin`, `admin`, `manager`, `staff`. Cashier,
Cook, Server, Dishwasher, Slicer, Inventory Staff and any store-invented position such as Panda are
**positions**, and every one of them resolves to the single role `staff`. `CAPABILITY_MATRIX` grants
`record_sale` to `staff`, so it reaches all seven at once. **There is no dishwasher-shaped hole in a
role-keyed table.**

⭐ **`authorize()` already has the mechanism this needs and it needs no new one.** Axis 3a is
`CAPABILITY_MATRIX[capability][role] || granted.has(capability)` — a role cell **or** an explicit
`person_grants` row. `setPositionDefault` already materialises those grant rows onto every open
employment holding the position. **So the capability can move from the left side of that `||` to the
right side without touching `authorize` at all.**

## Ian's ruling, and the option that was declined

| | What it means | Why |
|---|---|---|
| **(a) CHOSEN — shrink the baseline** | The 21 stop being automatic. A position holds one because somebody granted it. | One careful setup per store, once. Afterwards **what the screen shows is what the person can do** — one rule, one place to read it. |
| (b) declined — let a position subtract | Keep the baseline, add a per-position override that removes. | Cheaper to ship and then permanently ambiguous: two rules answer one question and disagree. ⛔ **A subtraction layer is also invisible at the `authorize` call site** — the matrix says yes, something else says no, and nothing in the code names the second thing. |

## ⛔⛔ THE BLAST RADIUS — READ THIS BEFORE WRITING ANY CODE

**Flipping the matrix without a backfill removes 21 capabilities from every staff member at every
store, simultaneously, on deploy.** This is migration `0148`'s shape — the one that revoked every PIN
on 2026-09-14 and cost Ian an afternoon — and it is **worse in the way that matters**:

| | `0148` (PINs) | This, unbackfilled |
|---|---|---|
| Where it fails | at the door, before work starts | **mid-shift, per action** |
| What the person sees | *"No sign-in PIN issued yet"*, with the fix on screen | `role 'staff' may not 'submit_sales_day'` |
| Second way in | admin email sign-in, unaffected | ⛔ **none — the capability is simply gone** |
| To recover | re-issue PINs from a screen | configure every position at every store first |

⛔ **THEREFORE THE BACKFILL IS NOT A PRECAUTION, IT IS THE TASK.** The order is not negotiable:

1. **Migration `0152` writes the defaults first** — one `position_capability_defaults` row per
   (active position × store × each of the 21) plus the materialised `person_grants` for every open
   employment holding that position. **This reproduces today's behaviour exactly and changes nothing
   observable.**
2. **Only then does the matrix flip** to `staff: false`. Both ship in one release; `deploy.yml` runs
   migrations before the new build serves traffic, so the grants exist before any code needs them.
3. **Ian subtracts afterwards**, at his own pace, from a known-good state — which is the whole point
   of (a) and the only moment in this task where anybody's access actually changes.

⚠️ **The additive-then-flip order is also safe under the old code**: extra grant rows give staff
capabilities the matrix already gave them, so a half-deployed state is a no-op rather than a window.

## ⛔ The orphan case — measure it before writing the migration

An open employment with **no** row in `employment_positions` receives nothing from a
position-keyed backfill and loses all 21 silently. **The count is unknown and the orchestrator
cannot query production** (`DATABASE_URL` points at `shareat_dev`; SSH is blocked for agents —
today's handoff). **This is a NEEDS FROM IAN before slice B may be written**, and the honest options
are:

- **Refuse to run** until every open employment has at least one position. Safest, and it surfaces
  a data-quality problem rather than papering over it — but it can block the release on data entry.
- **Grant the 21 at employment level** for positionless employments, and report them. Nobody breaks;
  the exception is recorded and visible rather than silent.

⭐ **Recommended: refuse, with the list printed.** A positionless open employment is already a gap in
the roster, and this task is the first thing that would ever notice. ⛔ **Do not invent a third
option that guesses a position from the person's history.**

## Scope — the only paths this task may create or modify

**Slice A — measurement (read-only, no writes at all)**
- `scripts/position-access-census.mjs` — new. Counts, per store: active positions, open employments,
  open employments with no position, and holders per position. **Prints; writes nothing.**

**Slice B — the backfill**
- `packages/db/migrations/0152_*.sql` — hand-authored per ADR-012 §5. ⛔ **`when` must exceed
  `1798860707084` and be re-derived from `packages/db/migrations/README.md` at build time, never
  copied from this document** (DEF-039).
- `packages/db/migrations/meta/_journal.json`

**Slice C-pre — the test fixtures, and it is NOT optional**
- `packages/domain/tests/integration/**` — a shared fixture helper, plus the mechanical pass over
  the files that use it.

⛔⛔ **THIS SLICE EXISTS BECAUSE THE SPEC'S OWN PREMISE 1 WAS FALSE, AND THE FALSEHOOD WAS SMUGGLED
RATHER THAN STATED.** The spec asserted *"`authorize()` needs no change"* — **true of the function**,
verified independently by two lanes — and then did duty for a second claim it never wrote down:
*"and therefore nothing else needs to change either."* **That one is false.** Bible §13 row 207 at
the level of a spec rather than a comment.

**Measured 2026-09-14, two ways.** A lane reading files found the shape and reported a range it could
not close (*"at least 2, at most 48"*); the orchestrator then intersected *every domain function that
authorizes on one of the 21* with *every integration test that builds a staff-role actor*:

| | |
|---|---|
| Integration test files scanned | **115** |
| Staff actor, but calls none of the gated functions | **31** — not at risk |
| ⛔ **Staff actor AND calls a gated function** | **19** |

⚠️ **19 is an UPPER bound and is stated as one:** the intersection cannot tell whether a file calls
the gated function with its *staff* actor or with an admin one. **Both independently confirmed
instances — `count-workflow` and `expenses` — are inside the set**, which is the check that the
method works.

⛔ **THE MIGRATION CANNOT SAVE THESE, AND THAT IS THE POINT.** `0152` backfills data that exists
**when it runs**. These fixtures create a fresh person with `role='staff'` **during their own test
run**, long after migrations applied — no position, no default, no grant, because today the matrix
grants it and nothing needs one. The moment slice C flips the cells, every one of those positive-path
assertions starts throwing.

⭐ **RULING: one shared fixture helper, not 19 explicit grant blocks.**
1. These tests are not testing authorization — the staff actor is scenery for a count or an expense
   flow. **19 copies of "grant the everyday capabilities" is 19 copies of one idea**, which is the
   drift T-317 invariant 6 exists to stop.
2. ⭐ **After T-318 the fixture is WRONG, not merely under-provisioned.** By Ian's own ruling a
   positionless open employment is a **data error** that `0152` refuses to run against. **A fixture
   creating one models a state production is not permitted to be in** — so the helper does not paper
   over the flip, it makes the fixture realistic for the first time.
3. A test asserting a **refusal** must be able to opt out: the helper takes the positions to grant,
   and a refusal test asks for none.

⛔⛔ **CORRECTED: C-pre AND C ARE ONE LANE, NOT TWO — BECAUSE C-pre IS UNVERIFIABLE ALONE.** The first
draft of this section said *"sequenced BEFORE slice C"*, which is true of the order and wrong about
the packaging. **Adding a position and grants to a fixture changes nothing while the matrix still
grants the capability automatically: the suite is green before the change and green after it.** A
slice whose every test passes identically with and without its own work has proved nothing — RULES
§3.2, *a test that only ever passed proves nothing*, applied to a whole slice rather than one test.

⭐ **The flip is the only thing that can prove the fixtures.** So they ship together: the fixtures go
in first **within the same lane**, the matrix flips second, and **the gate is the full integration
suite green AFTER the flip.** ⛔ Green before the flip is not evidence and must not be reported as
progress.

**Slice C — the flip**
- `docs/decisions/CAPABILITY-MATRIX.md` — ⛔ **the decision document, and it changes FIRST.**
- `packages/auth/src/capabilities.ts` — the 21 `staff` cells to `false`.
- `packages/domain/src/people/position-defaults.ts` — delete the staff-matrix refusal (check 4b).
- `packages/auth/tests/integration/authorize.test.ts`
- `packages/domain/tests/integration/position-defaults.test.ts`
- `tests/unit/capability-matrix.test.ts` if its parse needs it — **not its assertions**.
- `packages/domain/src/files/index.ts` — ⚠️ **one comment only.** It asserts *"No access changes —
  both are granted to staff"* about `record_supplier_invoice` and `record_wastage`, and that becomes
  **false** the moment this slice ships. The code stays correctly gated either way (it authorizes
  through `PURPOSE_CAPABILITY`), so nothing breaks — ⛔ **but a reader will believe the comment over
  the code.** Bible row 204's shape, and row 206's ruling that a comment giving a plausible wrong
  reason is worse than none. Found by the T-318 review lane; fix it in the pass that is already
  touching capability semantics, not as a separate task.

**Slice D — the screen**
- `apps/erp/src/app/admin/access-defaults/page.tsx` · `lib.ts` · `actions.ts`
- Approved design: https://claude.ai/code/artifact/f5d644bb-50d5-4f98-9b35-a3027325f739

⛔ **Out of scope and orchestrator-owned:** `PROJECT_BIBLE.md` (this task needs a §13 row and an
implementer **reports** it, RULES §1 rule 14) · `docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md` ·
every other `docs/tasks/*.md` · `packages/auth/src/authorize.ts` — ⭐ **if you find yourself editing
`authorize`, stop and report: the design claim of this task is that it needs no change.**

## Contract

1. `CAPABILITY_MATRIX[c].staff === false` for all 21, and `true` for `manager`, `admin`,
   `super_admin` — **managers and admins keep every one of them through the role**, so supervision
   is unaffected and there is no scenario in which a store has nobody who can act.
2. `setPositionDefault` accepts all 21. The refusal sentence and its test both go.
3. `OFFERABLE_TO_POSITIONS` is **unchanged** — it already includes the 21 (T-289 §C10 deliberately
   excluded only super-admin-only, platform-scoped and `close_period`).
4. After the migration, **every person's effective capability set is byte-identical to before.**
   That is the slice-B acceptance test, and it is an assertion, not a hope.
5. The screen renders the 21 as **live toggles**, not `inherited` badges. `GridCapability.inherited`
   becomes false for them by the matrix change alone — ⚠️ **confirm it is not separately hardcoded.**

## Invariants, with citations

1. **No client-side-only authorization** — RULES §1 rule 7. The screen is a view onto grants; the
   refusal stays in `authorize`.
2. **Every schema change is a migration, hand-authored** — RULES §1 rule 9, ADR-012 §5. `npm run
   db:generate` is retired and fails closed.
3. **An applied migration is never edited** — RULES §1 rule 9. If `0152` is wrong, `0153` corrects it.
4. **The database enforces the rules** — RULES §6 item 3. ⚠️ **But tenancy is layered on purpose**
   (bible §15.11): the repository filters and RLS backstops, and **no layer may be the only one for a
   given risk**. This task moves a check from the matrix to grant rows; it must not become the only
   layer for anything it is currently the second layer of.
5. **Tests before implementation, failing for the right reason** — RULES §3.2. ⭐ For slice B the
   red control is the one that matters: **a fixture person must lose access when the matrix flips
   WITHOUT the backfill, and keep it WITH the backfill.** A test that only ever passed would prove
   nothing here, and this is the exact invariant `0148` had no test for.
6. **`capability-matrix.test.ts` parses `CAPABILITY-MATRIX.md` cell by cell** — so the decision
   document and the code cannot drift. ⭐ **This is a feature of this task, not an obstacle:** edit
   the markdown first and the compiler plus that test will find every code site you missed.

## Findings already made — do not re-derive these

⭐ Measured 2026-09-14 by the orchestrator, at source. Each is a premise this spec rests on, stated
so it can be checked rather than inherited (bible §13 row 207).

1. ⛔ **`record_sale` has ZERO enforcement callers.** Repo-wide, outside `capabilities.ts`, its only
   mentions are tests and one comment. **Nothing calls `authorize(..., 'record_sale')`.** It is a
   declared capability that no code gates on — because the app that would gate on it does not exist.
2. ✅ **`submit_sales_day` IS enforced**, twice: `packages/domain/src/sales-days/create.ts:112` and
   `verify.ts` inside `runSubmit`. ⭐ **So of Ian's two named capabilities, only this one bites
   today** — a Dishwasher really can close the day, and really cannot record a sale, for two
   completely different reasons.
3. ✅ **Segregation of duties is intact** — `runVerify` gates on `verify_sales_day` (manager+) and
   `runSubmit` on `submit_sales_day` (staff). Checked because the two calls sit in one file and the
   file's own header says they must differ. **They do. This is not a defect; it was verified, not
   assumed.**
4. ⭐⭐ **`apps/pos` is a single `README.md` and `apps/customer` contains no TypeScript.** Only
   `apps/erp` is a real application. **This is the cheapest moment this change will ever have** — the
   POS that will one day ask the same question has not been written, so there is exactly one
   enforcement surface to get right instead of two. ⛔ **The orchestrator told Ian this change
   "affects POS"; that was wrong in the present tense and is corrected here.**
5. ⚠️ **`authorize.test.ts`'s comment says *"Eleven capabilities are held by ALL FOUR roles"*. The
   real number is 21** — measured from the matrix, all 21 staff-true rows are true for the other
   three roles as well. A count that grew without the sentence being edited: **bible §13 row 204's
   class, and it is inside the file slice C must edit anyway.** Fix it there; do not file it
   separately.

## Tests

- **Slice A:** none — it is a read-only census. Say so rather than inventing one.
- **Slice B:** the effective-capability-set equality assertion (contract 4), plus invariant 5's
  paired red control. Integration, real Postgres, the lane's own DB.
- **Slice C:** `authorize` refuses `submit_sales_day` for a staff person whose position lacks the
  grant, and allows it for one whose position has it. ⭐ **Two people, one store, one capability,
  different positions — that is the whole task expressed as one test**, and it is the test that
  would have answered Ian's question without anybody opening a screen.
- **Slice D:** smoketest on 9008 — RULES §9.4. A green build has already shipped an app that could
  not start.
- ⛔ **Every gate-leg test names two DIFFERENT positions.** T-302's two gate-leg tests passed for
  the wrong reason by issuing and signing in at the same store; the identical trap here is a test
  whose two people share a position.

## Out of scope

- Any change to `authorize()` (see Scope).
- The 56 manager-tier and 19 admin-tier capabilities. **This task touches 21 cells and no others.**
- A POS enforcement path — there is no POS (finding 4).
- Retiring the four-role model. Roles stay; this moves one role's baseline, nothing more.
- The AP-ceremony question, the till floor, and anything else in T-316.

## Done when

- The 21 are position-granted, managers and admins unaffected.
- **A person's effective capabilities are unchanged by the release itself**, proven by test, not by
  inspection.
- Ian can switch `submit_sales_day` off for Dishwasher at one store and a dishwasher there is
  refused, while a cashier at the same store still closes the day.
- Typecheck · unit · integration on the lane DB · **build with the dev server stopped** · smoketested
  on 9008 · the bible row reported to the planner.
- ⚠️ **Not in done-when:** that every store is configured correctly. **That is Ian's, it is
  deliberate, and the backfill exists precisely so it is not urgent.**

## Needs from Ian

1. ✅ **THE ORPHAN RULING — ANSWERED 2026-09-14. An open employment with no position is a DATA
   ERROR.** Ian chose *refuse and list them*, the recommended option, told in plain language that it
   can hold up the release until the records are fixed. **So slice B's migration refuses to run
   while any open employment lacks a position, and prints exactly who.** ⭐ **That makes slice A's
   census a gate rather than a report** — it is now the thing that says whether slice B can run at
   all, and it must be run before the migration is written, not after.
   ⛔ **Do NOT soften this into a warning.** The whole reason it is safe to shrink the baseline is
   that nobody loses access by accident; a positionless employment is the one shape where they
   would, and refusing is what keeps that promise. ⚠️ **If the count turns out to be large, that is
   a finding to bring back — not a reason to switch to granting a fallback.** The ruling was made
   knowing it could block; changing it is Ian's, not the lane's.
2. ✅ **Answered by the same ruling** — a positionless open employment is not a normal onboarding
   state, so the recommendation does not invert.

⚠️ **Still open, and not blocking any slice yet:** nothing. Both questions are closed.

## Slice A's census — measured 2026-09-14, and what it settles

⛔ **RUN AGAINST `shareat_dev`, NOT PRODUCTION.** `scripts/position-access-census.mjs` names its own
source in its output, deliberately: a census that does not say which database it read is how a dev
number gets quoted later as a production one. **Every figure below is a dev-database fact.** Ian runs
it against production when he chooses; nothing here licenses a production claim.

| Measure | `shareat_dev` |
|---|---|
| Active stores censused | 3 (2 deactivated smoketest stores excluded) |
| ⛔ **Open employments with NO position — the gate** | **0.** The gate would not trip today. |
| ⚠️ **Open employments holding MORE THAN ONE position** | **1** — a cashier who is also a cook |
| Backfill size | **651** default rows (31 position×store pairs × 21) + **84** person grants = **735** |

⛔ **THE SIZING FIGURE WAS WRONG IN THIS DOCUMENT UNTIL SLICE B CORRECTED IT, AND THE REASON IS THE
FINDING.** The census first reported **483** (19 pairs), sizing scoped to **active stores**. Slice B
then established that the backfill must cover **every** store, active or not — nothing about
deactivating a store ends anyone's employment, so scoping to active stores would silently break
Contract 4 for anyone employed at a deactivated one. **The true figure is 735 across 31 pairs, of
which 12 pairs are at inactive stores.** ⭐ The census now prints both, rather than replacing one
number with another: **a figure that changed deserves to show what it changed from.**

⭐ **The census found and fixed its own defect before reporting:** the first draft counted two
deactivated stores into the backfill sizing (735 rows instead of 483). Sizing and position counts are
now scoped to active stores; **the orphan gate and the multi-position count deliberately are NOT** —
an open employment does not stop being open because its store was deactivated — and the script says
how many of each fall at an inactive store rather than silently folding them in.

## ⭐ THE MULTI-POSITION RULING — a person holding two positions gets the UNION

**The briefing guessed this question might be hypothetical. It is not: there is a real instance.** So
it is ruled here rather than discovered during the migration.

**A person holding two positions holds the union of both positions' grants.** That is not a new
mechanism — it is what `setPositionDefault` already does, reconciling every open-employment holder of
a position, so a person holding two is simply reconciled by both. **No code decides between them.**

⛔ **`is_primary` IS NOT AN ACCESS CONCEPT AND MUST NOT BECOME ONE.** It exists on
`employment_positions` (a boolean on the join row, with a partial unique index allowing one primary
per employment — **not** a `primaryPositionId` column, which is what the briefing wrongly called it),
and **nothing in the codebase reads it for an access decision today.** Using it to pick a winner would
invent a precedence rule the business has never expressed, and would silently demote a real
capability somebody holds for a real reason.

⚠️⚠️ **THE OPERATIONAL CONSEQUENCE, AND IT IS THE ONE THAT WILL SURPRISE SOMEBODY: TURNING A
CAPABILITY OFF FOR ONE POSITION DOES NOT TAKE IT AWAY FROM A PERSON WHO ALSO HOLDS IT THROUGH
ANOTHER.** Switch `submit_sales_day` off for Dishwasher, and a person who is Dishwasher *and* Server
keeps it if Server has it. **That is correct — they really are a server — but it will look like the
switch did not work.** ⭐ **Therefore slice D owes the screen an answer:** when a capability is
switched off for a position, the screen must say how many of that position's holders **still hold it
through another position**. Without that line the screen lies by omission, and the person reading it
is the one deciding who may take money.

## ⚠️ A newly-visible surface slice C and D must expect

`grantableCapabilitiesFor(role)` (`apps/erp/src/app/admin/users/lib.ts`) offers, for a given role,
whatever the matrix does **not** already grant it — so after the flip **all 21 newly appear as
hand-grantable to an individual staff member on `/admin/users`**, bypassing position defaults
entirely. ⭐ **This is correct and intended** — the per-person grant override is bible rows 115–116 and
predates this task — **but nobody had named it, and it is the kind of surface that gets discovered in
review and mistaken for a bug.** It is named now. ⚠️ Not verified: how those 21 render on that screen.
