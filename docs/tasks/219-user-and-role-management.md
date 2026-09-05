# T-219 — User and role management (`/admin/users`)

> **Status:** 📋 **Specified, not started.** Written 2026-09-05 by the Opus planner after the
> T-211/T-217 session's handoff named this the largest remaining "built but no caller" gap.
> Closes **DEF-167**. **Depends on:** nothing — every primitive it needs is built, tested and
> exported today. Numbered 219 because 213–216 are reserved by
> `docs/plans/phase-6-reporting-and-dashboards.md`, 217 shipped, and 218 is in flight with
> `ianla-25`.
>
> ⚠️ **Scope decided by Ian, 2026-09-05:** user/role management **only**. Store
> creation/management is explicitly **not** in this task — see *Out of scope*.

## Why this exists

`assignRole` and `elevateManager` (`packages/auth/src/roles.ts`) and the whole of `accessRepo`
(`packages/db/src/repo/access.ts`) are complete, exported from `@shareat/auth` /`@shareat/db`, and
covered by integration tests. **Confirmed by grep on 2026-09-05: they have zero production
callers.** The only hit anywhere outside `packages/*/tests/` is the barrel re-export in
`packages/auth/src/index.ts:18`. Even `scripts/dev-seed.ts:102` writes `person_roles` with raw SQL
because no function was reachable. Logged as **DEF-167**; this task owns it.

**The consequence is not cosmetic, and it is why this outranks the rest of Phase 7.**
`authorize.ts:99-105` treats *no active role* as a hard denial — deliberately, with its own comment:
*"an unconfigured person is authorized for NOTHING, not 'staff by default'."* Nothing in the hire
flow (`/staff/hire`, T-202) assigns a role. So the chain T-217 completed one link of —

> hire → issue a sign-in PIN → **sign in** → *(nothing)*

— ends there. A person hired and given a PIN today can authenticate and is then authorized for
zero capabilities at zero stores. **T-217 made them able to sign in; this task is what makes
signing in mean something.** A fresh org's second admin, likewise, can only be created by hand in
Postgres.

Two decisions already recorded in `docs/decisions/CAPABILITY-MATRIX.md` are waiting on precisely
this screen to exist, and both are named in that file as things that would otherwise be lost
between tasks:

- **§C.1** — `manage_users` is one boolean, so an admin holding it may assign *any* role, including
  another `admin`. That is the lateral move bible row 116 exists to prevent. The ADR is explicit
  that this is **not** fixable inside `authorize()` (which correctly answers *"may this actor use
  this capability?"*): *"a capability answers 'what may you do', never 'to whom'. Where the
  target's own level matters, the check belongs at the call site and must be tested there."* This
  task builds the first call site.
- **§C.2** — assigning the `admin` role must materialise a `person_store_scope` row for every store
  in that org, at assignment time (*"rows, never a bypass"*, bible row 114). **`assignRole` does not
  do this today** — it implements §B.1's elevated-grant fallback and nothing else. An admin
  appointed through this screen would be authorized for nothing store-scoped. Filed against
  ourselves in `DEFECTS-REGISTER.md` section E and fixed here, because the fix belongs in
  `assignRole` — putting it in the server action would leave the next caller to rediscover it.

## Goal

An admin can see every person in the org with their current role, store scope and capability
grants; can assign or change a role, grant and revoke store scope, and grant and revoke individual
capabilities — each write gated server-side, each refusal tested, and neither the actor's own
access nor the org's last admin removable through the screen.

## Scope — files this task may create or modify

**New:**
- `apps/erp/src/app/admin/users/page.tsx` — the roster: everyone in the org, their role, store
  count, grant count
- `apps/erp/src/app/admin/users/[personId]/page.tsx` — one person: role, store scope, grants
- `apps/erp/src/app/admin/users/actions.ts` — the three server actions (§3)
- `apps/erp/src/app/admin/users/lib.ts` — server-only reads, mirroring
  `apps/erp/src/app/staff/lib.ts`'s shape exactly (plain reads straight to the repo; anything
  capability-bearing goes through the domain/auth layer and takes the full `Actor`)

**Modify:**
- `packages/db/src/repo/persons.ts` — add `listWithAccessForOrg` (§2). The only reads that exist
  today are `getPersonById` and an `ilike` search; the list page has nothing to call.
- `packages/auth/src/roles.ts` — `assignRole` gains §C.2's store-scope materialisation (§4)
- `apps/erp/src/components/nav.tsx` — a new final group (§6)
- `docs/DEFECTS-REGISTER.md` — DEF-167 closed; the §C.2 gap and the unlinked-`/settings` gap filed
- `docs/decisions/CAPABILITY-MATRIX.md` — §C.1 and §C.2 marked implemented, citing this task

**Do not touch:** `packages/auth/src/authorize.ts` (§C.1 is explicit that the fix does not belong
there — a change here is a spec defect, report it rather than making it) · `packages/auth/src/
capabilities.ts` (the matrix is a `CAPABILITY-MATRIX.md` decision, not an implementation one;
`manage_users` and `grant_capability` already exist, org-scoped, admin+super_admin true) ·
`packages/db/src/repo/access.ts` (every read and write this screen needs is already there — if one
genuinely is not, report it, do not add SQL mid-task) · `packages/db/src/repo/findings.ts` and its
tests (**`ianla-25` is on T-218 in this same shared tree**) · any migration (no schema change: the
three access tables exist and are correct) · `packages/db/src/repo/stores.ts` (see *Out of scope*).

## Contract

### 1. Route shape, and why it is person-scoped

`/admin/users` and `/admin/users/[personId]` — keyed on **`personId`, not `employmentId`.**

A person may hold two employments at two stores (T-154 invariant 8: *one person, two stores, two
employments*) but holds **exactly one active role per org** — enforced by the partial unique index
behind `activeRoleForPerson`. Hanging role controls off `/staff/[employmentId]` beside T-217's PIN
section would therefore render one fact on two pages, with two forms able to write it. Store scope
and capability grants are person-level for the same reason.

Add a link from `/staff/[employmentId]` to `/admin/users/[personId]` — the employment page is where
someone will look first, and a link costs nothing. Do **not** add controls there.

### 2. `personsRepo.listWithAccessForOrg(tx, orgId)`

One query, ordered by `displayName`. Per row: `id`, `displayName`, `isActive`, the active role
(`role`, `grantedAt`, or `null` for none), a store-scope **count**, and an active-grant **count**.
`persons` LEFT JOIN `person_roles` (on `revoked_at is null`) plus scalar subqueries or grouped
counts for the two totals — not N+1 per person, and not the whole org's rows fetched to be counted
in TypeScript.

⚠️ **"No role" is a first-class state on the list, rendered plainly**, not an empty cell — it means
*this person cannot do anything*, which is the whole finding above and the single most useful thing
this screen can tell an operator at a glance.

### 3. The three server actions

Every one resolves its actor through `requireActor()` (`apps/erp/src/lib/session.ts` — the only
place a request becomes an `Actor`; `tests/unit/no-client-supplied-actor.test.ts` holds that
closed repo-wide) and calls `authorize()` before writing. All three run inside one
`withOrgPrincipal` transaction each.

**a. `assignRoleAction(personId, role)`** — `authorize(tx, actor, 'manage_users', {})`, then
**§C.1's target check**: assigning `'admin'` or `'super_admin'` additionally requires the actor's
own active role to be `'super_admin'`. Read the actor's role from `accessRepo.activeRoleForPerson`
— resolved from Postgres, never from the form. On refusal, throw `AuthorizationError` with a
message naming the target level, so the custom `error.tsx` T-217 shipped renders it. Then call
`assignRole(tx, { personId, orgId, role, grantedBy: actor.personId })`.

**b. `setStoreScopeAction(personId, storeId, granted: boolean)`** — `authorize(tx, actor,
'manage_users', {})`, then `accessRepo.grantStoreScope` / `revokeStoreScope`. Both are already
idempotent (grant is `onConflictDoNothing`; revoke is a plain delete, per that file's own note that
store scope answers *"who can see Davao right now?"*, not a history question). A per-store toggle,
not a free-text store id.

**c. `setCapabilityGrantAction(personId, capability, granted: boolean)`** —
`authorize(tx, actor, 'grant_capability', {})` (org-scoped; admin ✅, manager ✗ — already in the
matrix), then `accessRepo.grantCapability` / `revokeGrantById`. The picker's options come from
`CAPABILITIES` (`@shareat/auth`), never a hand-written list, so it cannot drift from the matrix.
`revokeGrantById` throws on an already-revoked id by design — map that to a friendly message rather
than letting a stale page produce a raw error.

### 4. `assignRole` gains §C.2's materialisation

Inside the existing function, after the role row is inserted: if the assigned role is `'admin'`,
grant a `person_store_scope` row for **every active store in the org** —
`accessRepo.activeStoreIdsForOrg(tx, orgId)` then `grantStoreScope` per id, both already present.
Return them on `AssignRoleResult` as `materialisedStoreIds`, alongside the existing
`elevatedGrants`, so the caller can say *"this admin was given scope for 5 stores"* rather than the
write being invisible.

Same shape and same reasoning as the §B.1 fallback already in that function: **decide once, at the
moment a human is present, and store the answer** — rather than inferring it on every check.

⚠️ **A role change does NOT auto-revoke store scope.** Demoting an admin to manager leaves their
rows in place. That is deliberate: revoking is destructive, `person_store_scope` is *rows, never a
bypass* so the rows are plainly visible on the detail page, and an operator trimming them
deliberately is safer than a demotion silently cutting someone's access to five stores. **State
this on the page** where the scope list is shown after a demotion — an invisible retained
permission is the failure mode this warning exists to prevent.

### 5. Two lockout guards — server-side, in the action, each with its own test

1. **An actor may not change their own role, or revoke their own store scope or grants.** Compare
   `actor.personId` to the target. The screen may render the controls disabled for clarity, but the
   check that counts is the server one (RULES rule 7).
2. **The org's last active admin may not be demoted.** Before an `assignRole` that moves a person
   *off* `'admin'`, assert some *other* person holds an active `admin` role in that org.
   `accessRepo.hasActiveAdmin` answers the org question; exclude the target.

Both refuse with a plain message naming the reason. These are not hypothetical: a POS-side signup
flow demoted a live admin and created exactly this lockout, and §C.2's own closing note ("two things
now depend on Ian personally") means an org locked out of `manage_users` is not self-recoverable.

⚠️ Guard 2 interacts with §B.1: revoking the last admin is what makes the *next* manager
appointment fire the elevated-grant fallback. Guard 2 blocks a **demotion**, which is the operator
mistake; it does not, and must not, change what `assignRole` does when an org legitimately has no
admin.

### 6. Nav

Add a final group — **"Setup"** — carrying `/admin/users`. While in that file, add the existing
`/settings` and `/settings/attendance` (T-201): both have shipped screens and are **linked from
nowhere**, the exact defect that file's own doc comment was written about (*"twenty-seven routes
existed and not one was linked from anywhere… invisible in a test suite and invisible in a
build"*). Two lines in a file this task already modifies; filed as its own register row so it is
not lost if this task is deferred.

Nav is rendered from the session, not gated per capability today — do not introduce per-link
capability filtering here. A manager clicking through to `/admin/users` gets the real refusal from
the server (`manage_users` is matrix-false for manager), which is the correct and already-tested
behaviour; hiding links is presentation, and the gate is the write.

## Invariants

1. **No client-supplied actor.** Every action resolves the actor from the session cookie
   (`requireActor`), never from a form field, including `grantedBy`.
2. **`authorize()` is never modified to express §C.1.** The target-level condition lives at the
   call site, per the ADR's own instruction.
3. **A role change stays REVOKE + INSERT** — never an UPDATE in place — so *"what was their role in
   March?"* stays answerable. `assignRole` already does this; do not bypass it by calling
   `insertRole` directly.
4. **A capability grant is append-and-revoke, never deleted** (`CAPABILITY-MATRIX.md` §B); the
   detail page shows revoked grants with their revocation date, because invariant 11 requires them
   to stay queryable.
5. **The capability picker is derived from `CAPABILITIES`**, never hand-listed.
6. Neither guard in §5 is enforceable in the client alone.

## Tests

Integration, against real Postgres, following `packages/auth/tests/integration/authorize.test.ts`'s
existing seeding shape. **Every ✅ needs a test proving the ✗ fires** (`CAPABILITY-MATRIX.md`'s own
process):

- `listWithAccessForOrg` — a person with no role, one with a role, one with role + scope + grants;
  counts correct; another org's persons absent.
- **§C.1:** an `admin` actor assigning `'manager'` succeeds; the same actor assigning `'admin'`
  **is refused**; a `super_admin` actor assigning `'admin'` succeeds. This is the test the ADR asks
  for by name.
- **§C.2:** assigning `'admin'` in an org with 3 active stores creates 3 `person_store_scope` rows
  and returns them; an inactive store is excluded; re-assigning is idempotent (the repo's
  `onConflictDoNothing`).
- **§5 guard 1:** an actor assigning a role to themselves is refused.
- **§5 guard 2:** demoting the only active admin is refused; demoting one of two succeeds.
- A `manager` actor is refused `manage_users` and `grant_capability` (matrix-false, no grant).
- Store-scope grant/revoke and capability grant/revoke round-trip, and a revoked grant remains
  readable with its `revokedAt`.

⚠️ **`ListAgents` before running `test:integration`.** `ianla-25` holds T-218 in this tree and both
sessions share one `shareat_test` database. A per-lane DB (`shareat_test_lane25`, already migrated)
exists for exactly this; `scripts/make-test-dbs.mjs` makes another.

## Out of scope — with reasons

**Store creation and management (`/admin/stores`) — Ian's decision, 2026-09-05: a separate task.**
The blueprint bundles it with this one; it is a bigger question than a form. No `createStore`-shaped
function exists anywhere — `packages/db/src/repo/stores.ts` holds only cash-custody policy
(`cashPolicy`/`setCashPolicy`) plus an inbox-relay lookup. Creating a store means choosing its
remittance cadence and unremitted ceiling behind a DB check constraint
(`stores_pooling_requires_ceiling_check`), and **§C.2's own consequence applies in reverse**: *a
store created later appears in nobody's scope*, so `createStore` must fan out scope rows to that
org's existing admins or a new branch is invisible to the person who just opened it — failing like
a permissions bug rather than a missing row. That is a domain function with an invariant and its own
spec, not an afterthought here.

**Org creation and `super_admin` management** — one org, one super-admin today; `CAPABILITY-MATRIX.md`
§"Worth being conscious of" records that assigning an admin depending on Ian personally is *"a known
dependency, not a flaw"* at this scale. Building a UI to change that pre-empts a decision nobody has
made.

**Per-link capability filtering in the nav** — §6.

**Bulk role assignment** — 126 staff, assigned once each on hire. No evidence one-at-a-time is the
constraint.

**Changing the capability matrix itself** — a `CAPABILITY-MATRIX.md` decision (bible §14: only the
Opus planner amends; an implementer reports and stops).

**DEF-063 (PIN sign-in rate limiting)** — separately logged, recommended for reactivation in the
2026-09-05 handoff, not this task's.

## Open questions

- **Should `manage_users` move to `manager`, scoped to their own org?** `CAPABILITY-MATRIX.md`
  §Open 3 already predicts this as *"the friction point"* and sets the trigger: *"if it happens
  twice, move it."* Building this screen is what will produce the first real evidence either way —
  worth watching, not worth pre-empting. Ian/Opus.
- **Should demoting an admin offer to revoke their store scope in the same action?** §4 deliberately
  says no for v1. If an operator hits it twice, revisit.

## Done when

- [ ] `typecheck` clean.
- [ ] `npm test` clean.
- [ ] `npm run test:integration` green against real Postgres, this task's new tests included —
      `ListAgents` first.
- [ ] `npm run build` succeeds with the dev server stopped first.
- [ ] **Smoketested live on 9008**: a person with no role shows as such on `/admin/users`; assigning
      `staff` lets them reach a staff-permitted screen they were refused before; an admin actor is
      refused when assigning `admin`; assigning `admin` as super-admin materialises scope for every
      store and the page says so; demoting the last admin is refused; self-demotion is refused; a
      capability grant lets a manager past a matrix-false gate and revoking it closes that gate
      again.
- [ ] Self-reviewed line by line.
- [ ] `docs/DEFECTS-REGISTER.md`: DEF-167 closed; the §C.2 gap and the unlinked-`/settings` gap
      filed in section E.
- [ ] `docs/decisions/CAPABILITY-MATRIX.md` §C.1 and §C.2 marked implemented, citing this task.
- [ ] This file's status line updated.
