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

**Slice C — the flip**
- `docs/decisions/CAPABILITY-MATRIX.md` — ⛔ **the decision document, and it changes FIRST.**
- `packages/auth/src/capabilities.ts` — the 21 `staff` cells to `false`.
- `packages/domain/src/people/position-defaults.ts` — delete the staff-matrix refusal (check 4b).
- `packages/auth/tests/integration/authorize.test.ts`
- `packages/domain/tests/integration/position-defaults.test.ts`
- `tests/unit/capability-matrix.test.ts` if its parse needs it — **not its assertions**.

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

1. ⛔ **The orphan ruling** — refuse, or grant at employment level. Recommended: refuse with the list
   printed. Slice B cannot be written without it.
2. ⚠️ **Confirmation that a positionless open employment is a data error** rather than a normal state
   for, say, a new hire mid-onboarding. **If it is normal, the recommendation above inverts.**
