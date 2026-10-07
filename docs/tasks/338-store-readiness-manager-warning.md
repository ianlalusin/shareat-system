# T-338: store readiness warns when a store has no manager

**Status:** SPEC 2026-10-08 (Opus planner). Written at HEAD `9e89a0b`. Reserved 2026-09-24, queued after T-336 (done).
**Model:** Sonnet for the slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** none. No table, no column, no capability. (If one turns out to be needed, it is a spec defect: stop and
report. Do not number it; the next number is reserved by another lane.)

**Ruling (Ian, 2026-09-24), binding:** manager stays a ROLE that an admin assigns to a person; it is never a seeded
position. There is one organisation-wide admin, and managers are scoped per store. The adminless-manager elevation
stays as it is. The store-readiness checklist (the one that already reports room / adminScope / salesChannel / signIn)
gains an item: "No manager assigned to this store", shown when no person holding the `manager` role has an active
store-scope row for that store. The item is a warning only and blocks nothing.

## Goal
- An admin opening `/admin/stores/[id]` sees, in the Readiness list, whether anyone manages this store, and a link to
  the screen that fixes it. Nothing is blocked by it.

## Assessment (research-evaluate-propose, bible row 283)
- **Verdict: build it, as one derived check.** Smallest possible form; the machinery already exists.
- **Stated reason holds.** Nothing in v2 gives a store a manager: `createStore` fans scope to admins only
  (`stores/service.ts:201`, `fanStoreScopeToAdmins`), `assignRole` fans only for `admin` (`packages/auth/src/roles.ts:139`),
  and a manager's store comes only from a hand tick on `/admin/users/[personId]` (`admin/users/actions.ts:93-124`,
  `setStoreScopeAction`) or a hire there. So a new store has no manager until someone remembers, and no screen says so.
- **v1 (goal, not method).** v1's checklist (`ERP-rebuild/src/lib/stores/store-readiness.ts:62-159`, 12 steps) has no
  manager step. Its goal is v2's: "can this store run without someone finding a gap the hard way". A store with no
  manager still runs (the admin covers it), so the gap is a warning, which is what Ian ruled.
- **Live data.** Dev DB (`shareat_dev`, 2026-10-08): 1 active `manager` role in total; of 9 stores, `LIP` has 1 scoped
  manager, the other 8 (test stores) have 0. Production NOT read (no access from here): the number that matters is
  "active stores with zero scoped managers" on `159.223.46.224`. The assessment stands without it: one query per page
  load, non-blocking, so a high count is noise at worst, never a stop.
- **Industry / open source.** A setup checklist of derived, non-blocking warnings is the standard onboarding pattern,
  and is what this checklist already is (T-222/T-243). Nothing to adopt: it is one predicate in an existing function.
- **Cost.** One repo function, one array entry, one route constant, 11 tests. No migration, no UI change (the panel
  renders checks generically, T-243).

## Census, verified at source

### The readiness surface
- `storeReadiness(tx, actor, store)` (`packages/domain/src/stores/service.ts:604-706`) returns `ReadinessCheck[]`
  (type `:566-581`): `room`, `adminScope`, `salesChannel`, `signIn` (all `blocking: true`) and `openingDate`
  (`:690-704`, `blocking: false`, T-346). Authorized on `manage_stores` (`:66`, `:609`). Derived on read, never
  stored (`:597-603`, bible row 176; `stores.test.ts` asserts no readiness column exists).
- Remedy routes live only in `READINESS_REMEDY_ROUTE` (`:591-595`). `apps/erp/tests/readiness-remedy-routes.test.ts:37-63`
  parses that object and fails on a route with no `page.tsx`.
- Only caller: `apps/erp/src/app/admin/stores/lib.ts:64`. The page (`apps/erp/src/app/admin/stores/[id]/page.tsx:65`)
  counts ONLY `!c.ok && c.blocking` into the amber "N things still stop this store working" banner (`:93-101`) and
  renders every check generically, with its remedy link while `!ok` (`:107-131`). So a `blocking: false` check shows
  as an amber bullet in the list and stays out of the banner. No page change is needed.
- Existing tests reach checks by key (`stores.test.ts:179-237`, `.find((c) => c.key === …)`). None asserts the length
  or the key list, so a sixth check breaks nothing.

### How managers are assigned per store today
- Role: `person_roles` (`packages/db/schema/access.ts:56-86`), one active row per (person, org); `revoked_at is null`
  = active; values `super_admin|admin|manager|staff`. Set by `assignRoleAction` → `assignRoleAsActor`
  (`admin/users/actions.ts:60-67`).
- Store: `person_store_scope` (`access.ts:98-130`), one row per (person, store), revoked by DELETE
  (`repo/access.ts:350-356`), so "active scope row" = the row exists. `source` is `employment|manual|fan_out`; all
  three count.
- `assignRole` for `manager` writes NO scope (`roles.ts:139` fans for `admin` only). The adminless-manager elevation
  (`roles.ts:104-117`) is grants, not scope, and is untouched here.
- `persons.is_active` (`schema/persons.ts:28`) exists. No app code sets it false today (grep); the ETL may import
  inactive people. `persons.kind` (`:37`) separates terminals from people.

## Rulings (planner)
- **R1. A new check `manager`, `blocking: false`, `kind: 'manual'`,** after `signIn`, before `openingDate`.
  - Label: **"A manager is assigned"** (the list states the goal, like its siblings; the warning sentence is the
    detail).
  - Detail when 0: **"No manager assigned to this store. Give a person the manager role and this store in their scope,
    under Users and roles."** (Ian's words lead.)
  - Detail when n ≥ 1, names in name order: **"Managed by Ana Cruz."** / **"Managed by Ana Cruz, Ben Reyes."** Names,
    not a count: the admin's next question is "who", and the query already joins `persons`.
  - Remedy: `{ href: READINESS_REMEDY_ROUTE.manager, label: 'Assign a manager in Users and roles →' }`, with
    `READINESS_REMEDY_ROUTE.manager = '/admin/users'`. No `?store=`: `/admin/users` takes no store param, same as
    `signIn` (`service.ts:684-686`).
  - `kind: 'manual'`: who runs this store is a business fact, not a construction guarantee.
- **R2. The predicate is one query in `accessRepo`:** `activeManagerNamesAtStore(tx, orgId, storeId): Promise<string[]>`.
  `person_roles r` join `person_store_scope ps on ps.person_id = r.person_id and ps.store_id = $store` join
  `persons p on p.id = r.person_id`, where `r.org_id = $org and r.role = 'manager' and r.revoked_at is null and
  p.is_active`, distinct, ordered by `p.display_name`.
  - `manager` only. An admin or super_admin scoped here does NOT clear it. Ian ruled one org-wide admin and per-store
    managers, and every active store already has every admin scoped (the `adminScope` check), so counting admins would
    make this check always green.
  - `p.is_active` is required: an inactive person "managing" a store is exactly the gap this check exists to show.
  - `r.org_id` is required: a role in another org never counts (tenancy, bible §15.11; RLS backstops it).
- **R3. Shown for every store, active or not.** Readiness is already computed for inactive stores; this follows.
- **R4. Nothing else changes.** No banner text, no blocking, no finding, no notification, no new capability. The
  generic renderer carries it.

## Parallel plan
| Slice | Files (BUILDER) | Shared state | Parallel-safe with |
|---|---|---|---|
| S1 | `packages/db/src/repo/access.ts` (one new function, after `activeAdminPersonIds` `:450`), `packages/domain/src/stores/service.ts` (`READINESS_REMEDY_ROUTE` and `storeReadiness` only) | the lane DB | any lane not in these two files |

No migration, no `classification.ts`, no RLS registry, no `POSTING-PATTERNS.md`. Not touched:
`apps/erp/src/app/settings/pos-link/**`, `packages/domain/src/pos/**` (another lane), `apps/erp/src/app/admin/stores/**`
(R4: no page change).

## Invariants
- I1. Readiness stays derived: no column, no cache (the existing `stores.test.ts` DERIVED test stays green).
- I2. The blocking banner count on `/admin/stores/[id]` is unchanged by this check in every case.
- I3. No new capability; `storeReadiness` authorizes first, as today (`manage_stores`).
- I4. No money, no posting.

---

## S1: the `manager` check
**BUILDER:**
- `repo/access.ts`: `activeManagerNamesAtStore` (R2), with a doc comment naming T-338 and why admins do not count.
- `stores/service.ts`: `manager: '/admin/users'` in `READINESS_REMEDY_ROUTE` (update its doc comment); one call to the
  repo function beside the other reads (`:611-619`); the R1 check object between `signIn` and `openingDate`, with a
  comment citing Ian's 2026-09-24 ruling and that it is non-blocking on purpose.

**TESTER:**
- `packages/domain/tests/integration/t338-manager-readiness.test.ts` (new). Fixture: `rolesFixture`/`makeStore` from
  `t346-store-opening-date.test.ts:72-103` (copy, do not import across test files): one org, an admin, one store.
- `apps/erp/tests/integration/t338-manager-readiness-page.test.ts` (new). Render harness from
  `t380-s2-money-and-refill.test.ts:436-439` (`StorePage` + `renderToStaticMarkup`).
- `apps/erp/tests/readiness-remedy-routes.test.ts` is NOT edited: it reads the object, so the new route is checked
  automatically.

**Tests (domain), each naming the mutant that kills it:**
- **M1** (red on HEAD). A fresh store, admins only → `manager` exists, `ok` false, `blocking` false, `kind` `'manual'`,
  detail starts "No manager assigned to this store", remedy `{ href: '/admin/users', label: 'Assign a manager in Users
  and roles →' }`. Mutants: `blocking: true` → red; remedy dropped → red.
- **M2.** P holds `manager` and a scope row for the store → `ok` true, detail "Managed by P." Mutant: the repo
  function returns `[]` always → red.
- **M3** (admins do not count). The admin is scoped here (fan-out), and a second `admin` holds a manual scope row →
  `ok` false. Mutant: `r.role in ('manager','admin')` → red.
- **M4** (scope is per store). P is `manager` with scope at store B only → store A `ok` false; store B `ok` true.
  Mutant: drop the `ps.store_id` condition (any scope row) → A red.
- **M5** (role must be active). P's manager role is revoked (P now holds `staff`), scope row kept → `ok` false.
  Mutant: drop `revoked_at is null` → red.
- **M6** (person must be active). P is `manager`, scoped, `persons.is_active = false` → `ok` false. Mutant: drop
  `p.is_active` → red.
- **M7** (org). P is `manager` in org B, with a scope row (inserted as superuser) on org A's store → org A's check
  `ok` false. Mutant: drop `r.org_id = $org` → red. If RLS already hides P so the mutant stays green, say so in the
  report and keep M7 as a pin, not a killer.
- **M8** (names). Two managers, "Ben Reyes" inserted before "Ana Cruz" → detail exactly "Managed by Ana Cruz, Ben
  Reyes." Mutant: no `order by` → red.
- **M9** (control). The other five keys keep their `blocking` values (`room`, `adminScope`, `salesChannel`, `signIn`
  true; `openingDate` false). Pin only.

**Tests (web):**
- **W1** (red on HEAD). `/admin/stores/[id]` for a store with rooms, a channel and a PIN holder but no manager: the HTML
  has "A manager is assigned", "No manager assigned to this store" and a link to `/admin/users` labelled "Assign a
  manager in Users and roles →", and does NOT have "still stop this store working". Mutant: `blocking: true` → the
  banner appears → red.
- **W2.** The same store after P is made manager and scoped → "Managed by P." and no `/admin/users` remedy link.
  Mutant: `ok` hard-coded false → red.

**Smoke (9008):**
1. Create a store at `/admin/stores` → Readiness shows "A manager is assigned" with an amber bullet, the "No manager
   assigned to this store" detail and the Users link; the blocking banner count does not include it.
2. Follow the link, give a person the `manager` role and tick the new store in their scope → back on the store page
   the check is green: "Managed by {name}."
3. Screenshot both, at 375px and in dark mode.

---

## Out of scope
- N1. Auto-scoping a manager on store creation, or a "pick a manager" box on the create-store form. A workflow, not a
  warning; Ian ruled a warning.
- N2. A finding on `/findings` for a store with no manager. Readiness is the one place this lives; a second copy would
  drift.
- N3. A `?store=` filter on `/admin/users`. A behaviour change on another screen; the `signIn` remedy has the same gap.
- N4. Excluding `persons.kind = 'terminal'`. A terminal is never given a role (T-304); if one were, that is a defect in
  role assignment, not here.
- The bible, the register and the ROADMAP. The orchestrator records Ian's 2026-09-24 ruling in bible §13 at wrap-up:
  today it lives only in this task doc.

## Done when
- S1 green; each red shown red on HEAD or against its named mutant before the build.
- Typecheck clean. Unit suite passes (including `readiness-remedy-routes.test.ts` with the new route). The FULL
  integration suite passes on a fresh gate DB before any push. `npm run build` passes with the dev server stopped.
  Touched files are LF.
- Smoke done on 9008 with screenshots.
- The builder touched only the BUILDER paths, and the tester only the TESTER paths.

## Questions only Ian can answer
None. R1-R4 follow his 2026-09-24 ruling; the label wording and "names, not a count" are presentation.

## Ruling log
- 2026-09-24, Ian: manager is a role, per store; readiness warns and blocks nothing.
- 2026-10-08, planner: R1-R4. No migration. Admins do not clear the check; inactive persons and revoked roles do not
  either. No page change.
