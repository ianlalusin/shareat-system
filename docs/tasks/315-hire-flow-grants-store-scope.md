# T-315 — the hire flow grants a `person_store_scope` row, and somebody decides about everyone already hired

> **STATUS: NUMBER RESERVED 2026-09-14 by the orchestrator (`system32-85`), SPEC NOT YET WRITTEN.**
> Reserved so the number cannot be taken twice — that happened on 2026-08-31, when two sessions
> took task 196 and DEF-117 within 2m40s. **Do not implement from this file.**
>
> ⛔ **BLOCKED ON A DECISION, NOT ON ANALYSIS.** The measurement is complete (below). What is
> missing is Ian's ruling on the backfill, and that ruling changes the shape of the task rather
> than decorating it.

## Where this came from

Found 2026-09-14 by the **T-302** lane while checking its own spec's invariant 5 — the spec proposed
keying sign-in on `person_store_scope`, and the lane measured who actually holds those rows before
building it. ⭐ **That measurement is the whole reason T-302's gate is `employment OR scope` rather
than `scope` alone**, and it is why a mis-provisioned hire gets a legible refusal instead of a flat
`BAD_PIN`. This task is the other half: making the row exist in the first place.

## The measurement

`person_store_scope` rows are written in exactly three places:

| Writer | Who it covers |
|---|---|
| `packages/auth/src/roles.ts` — the `input.role === 'admin'` fan-out | admin appointments only |
| `packages/domain/src/stores/service.ts` — `fanStoreScopeToAdmins` | admins only, on store creation |
| `apps/erp/src/app/admin/users/actions.ts` — `setStoreScopeAction` | **a manual tick on an admin screen** |

⛔ **`createEmployment` (`packages/domain/src/people/index.ts`) writes the employment, its positions
and `reconcilePositionGrants` — and no scope row.** Neither does `createPerson`. So the founding
admin has scope and no employment; **a hired cashier has an employment and no scope unless a human
remembers the tick.**

## Why it is not cosmetic

`record_sale`, `submit_sales_day` and `record_till_count` are all `'store'`-scoped with
`staff: true` (`packages/auth/src/capabilities.ts`). So the staffer this produces **signs in
successfully and is then refused at the first sale**, and nothing on the hire screen mentions that
store scope exists at all.

⭐ **The reason this survived so long is its shape, not its size.** Every other gap in the
onboarding path announces itself — a blocking readiness row, an error message naming what is
missing, a script that does not exist. A missing scope row produces a person who looks correctly
hired from every screen that shows hiring.

## The decision that blocks it — Ian's, not a lane's

**What about everyone already hired?** The fix to `createEmployment` covers future hires only. The
existing population needs one of:

1. **A backfill migration** — grant scope at the employment's own store for every open employment.
   Simple, and it silently grants a capability set to people a human never ticked.
2. **A one-time script an admin runs and reviews** — slower, visible, and it makes somebody look at
   the list.
3. **Nothing** — the tick stays manual for the existing population, and only new hires are covered.

⚠️ **Do not pick one while writing the spec.** Option 1 changes who can do what in production
without anybody reviewing it, which is the kind of thing bible §7 exists to prevent; option 3
leaves a known trap in place for exactly the people most likely to hit it.

## Out of scope

- **T-302's sign-in gate.** Shipped (`94554a6`); its `employment OR scope` ruling stands and this
  task must not narrow it back to scope-only — that reintroduces the undiagnosable `BAD_PIN`
  the ruling was made to avoid.
- Any change to the capability matrix or to what `'store'` scope means.
