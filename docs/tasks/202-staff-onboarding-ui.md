# T-202 — Staff onboarding UI: the screen that closes DEF-131

> **Status:** ✅ **Shipped 2026-09-04.** Closes DEF-131. `/staff`, `/staff/hire`,
> `/staff/[employmentId]` built and live-smoketested on 9008; typecheck/unit/integration/build all
> green. Found DEF-150 (`seedCanonicalPositions` has no live caller anywhere) while smoketesting —
> reported, seeded by hand for this task's own verification, not fixed here (out of scope). Not
> committed — Ian's call.
> **Depends on:** T-154 (`positions` / `employments` / `employment_positions`, all shipped —
> `packages/domain/src/people/index.ts`), T-101 (`persons`), T-138 (`resolveActor`/`requireActor`).
> **Blocks:** every Phase 4/5 screen that names a real employee — attendance, payroll, credentials
> (T-203), performance. Nothing downstream has a live way to acquire an `employmentId` until this
> ships.

## Why this exists

T-154's own Out of scope said the UI was deliberately deferred: *"The roster screen arrives with
T-195, which has something to show."* T-195 shipped — but built the day-review queue, not staff
onboarding. Nobody picked the UI half back up. `createEmployment` / `endEmployment` /
`setEmploymentPositions` / `upsertStorePosition` / `listRoster` / `listPositions`
(`packages/domain/src/people/index.ts`) are built, tested, and have **zero callers outside their
own test fixtures.** There is no `apps/erp/src/app/{staff,people,roster}*` directory and no nav
entry.

⭐ **One gap T-154 didn't anticipate**: there is also no domain function anywhere that creates a
`persons` row. Grepped — the only writer in the whole repo is raw SQL in `scripts/dev-seed.ts:102`
(`insert into persons (org_id, display_name) values (...)`). `createEmployment` requires an
existing `personId`, so a real onboarding screen cannot work without first closing that hole too.
This task closes both: a person needs to exist before an employment can name one.

## Goal

A manager or admin can, from the running app: create a new person and hire them at a store in one
flow; hire an already-known person (who works another store) at a second store; assign or change
which positions an employment holds and which is primary; end an employment; add a store's own
position; and see the store's roster.

## Scope — files this task may create or modify

**New:**
- `packages/db/src/repo/persons.ts` — `insertPerson`, `searchPersons` (see Contract §1)
- `apps/erp/src/app/staff/page.tsx` — roster for the current store + "Hire" entry point
- `apps/erp/src/app/staff/actions.ts` — server actions wrapping the domain calls
- `apps/erp/src/app/staff/lib.ts` — `listStores`/`withOrgPrincipal` re-export + any list-loading
  helpers, following `apps/erp/src/app/items/lib.ts`'s shape
- `apps/erp/src/app/staff/[employmentId]/page.tsx` — one employment: positions, end employment,
  credentials link-out (a plain link to `/staff/[employmentId]/credentials` is enough; T-203 owns
  what's behind it — see Out of scope)
- `apps/erp/src/app/staff/hire/page.tsx` — the hire form: search-or-create person, store, starting
  status, start date, positions

**Modify:**
- `packages/db/src/index.ts` — export the new `personsRepo` (`export * as personsRepo from
  './repo/persons'`) and its row type
- `packages/domain/src/people/index.ts` — add `createPerson`, `searchPersons` (Contract §2)

**Do not touch:** `apps/erp/src/components/nav.tsx` — **T-203 is being built at the same time and
also needs one entry there.** Two agents editing the same file concurrently is exactly what bible
§3.4 forbids ("two agents must never touch the same file"). The coordinator adds both nav entries
after this task and T-203 both land; report the exact route and the capability it should gate on
(`enrol_staff`) so that edit is a one-line lookup, not a rediscovery.

Also do not touch `packages/db/schema/persons.ts` or `packages/db/schema/employment.ts` (no column
or table changes — everything needed already exists), `packages/domain/src/attendance/*` (T-203's
territory), any migration file.

## Contract

### 1. `packages/db/src/repo/persons.ts` — new

```ts
export interface PersonRow {
  id: string;
  orgId: string;
  displayName: string;
  isActive: boolean;
}

export async function insertPerson(tx: Tx, input: { orgId: string; displayName: string }): Promise<PersonRow>
export async function searchPersons(tx: Tx, input: { orgId: string; query: string; limit?: number }): Promise<PersonRow[]>
```

`searchPersons` is `ilike displayName` (`%query%`), org-scoped, ordered by `displayName`, default
limit 20. It exists so the hire flow can find "the same Maria who already works Lipa" rather than
minting a duplicate person — T-154 invariant 8 (one person, two stores, two employments) only
works if the UI ever offers the existing person back.

### 2. `packages/domain/src/people/index.ts` — additions

```ts
export async function createPerson(
  tx: Tx, actor: Actor,
  input: { storeId: string; displayName: string },
): Promise<PersonRow>

export async function searchPersons(
  tx: Tx, actor: Actor,
  input: { query: string },
): Promise<PersonRow[]>
```

`createPerson` authorises `enrol_staff` scoped to `input.storeId` — **the same capability
`createEmployment` already checks**, not a new one. `storeId` is context for the authorize call
only; it is never persisted on `persons` (bible §4.2 — a person has no store of its own, an
employment does). Trims `displayName`; refuses empty. `searchPersons` authorises `enrol_staff`
against **every store the actor covers** — reuse whatever the existing `enrol_staff` check already
does for a multi-store manager (grep `authorize()`'s implementation before assuming; if it takes
only a single `storeId`, authorise against each of the actor's stores via
`personCoversWholeOrg`/`storeIdsForPerson` from `packages/db/src/repo/access.ts` and refuse only if
none match — report back if this doesn't fit cleanly, per bible §3.4a).

### 3. Hire flow (`/staff/hire`)

Two steps in one form, not two screens (matching the "one `<form>` per action" convention DEF-130's
`/items` screen and DEF-136's order-line cards both use):

1. **Find or create the person.** A search box (`searchPersons`) with results to pick from, and a
   "create new" fallback that takes just a display name. ⚠️ Do not auto-create on every submit — a
   typo in an existing person's name must not silently mint a duplicate. Require an explicit pick:
   either "use this existing person" or "create new person named X."
2. **The employment.** Store (defaults to the actor's current store), starting status (defaulting
   to whichever of the seven `EmploymentStatus` values reads as "just hired" — v1/T-154 don't name
   a canonical default; `regular` or `probationary` are both defensible, pick one and say which in
   the report), start date (defaults to today), positions (multi-select from `listPositions` for
   the chosen store, defaulting to none — `createEmployment` already defaults an empty list to
   `Server`), and which of the picked positions is primary.

On submit: `withOrgPrincipal(actor.orgId, tx => { const person = existingPersonId ?? await
createPerson(tx, actor, {...}); return createEmployment(tx, actor, { personId: person.id, ...}); })`
— **one transaction**, so a person is never created with no employment to show for it if the
employment half fails validation (e.g. a second open employment at that store).

### 4. Roster (`/staff`)

`listRoster(tx, { storeId })` for the actor's current store (or a store picker if the actor covers
more than one — follow whatever pattern `apps/erp/src/app/items/page.tsx` or `/inventory` already
use for a store-scoped list with a switcher). Columns: staff code, name, status, positions (primary
marked), started on. A row links to `/staff/[employmentId]`.

### 5. Employment detail (`/staff/[employmentId]`)

- Positions: current assignment, a form calling `setEmploymentPositions`.
- End employment: a form taking `endedOn` + terminal status, calling `endEmployment`. ⚠️ Once
  ended, the positions form and the credentials link both become read-only display, not hidden —
  T-154 invariant 4: ending is not deleting, the history stays visible.
- Store's own positions: a small "add a position" form calling `upsertStorePosition`, visible from
  either this page or `/staff` (implementer's call; note which in the report).

### 6. Nav

One entry under whatever group heading fits the existing `nav.tsx` structure (read it before
naming one — `Staff`, `People`, or `Roster` are all defensible; match neighbouring entries'
convention). Gated to `enrol_staff`, so `admin`/`manager`/`super_admin` see it and `staff` does not.

## Invariants (inherited from T-154, exercised through the UI this time)

1. A person has at most one open employment per store — the form surfaces `createEmployment`'s
   refusal as a readable error, not a raw exception.
2. Ending an employment always takes a terminal status and an end date; both are required fields on
   the form, not optional ones defaulting silently.
3. Exactly one primary position; the positions form cannot submit with zero selected as primary
   when at least one is assigned (client-side hint is a nicety; the server call is what enforces
   it).
4. The same person, hired at a second store, is reachable through search rather than only through
   "create new" — prove this in the smoketest, not just in the domain tests T-154 already has.

## Tests

Integration tests for the two new repo/domain functions (`insertPerson`/`searchPersons`,
`createPerson`/`searchPersons`) in the existing `packages/domain/tests/integration/` shape.

**This lane's database is `shareat_test_202`.** T-203 and T-204 are running concurrently on
`shareat_test_203` and `shareat_test_204` respectively — do not use `shareat_test` or
`shareat_test_b` (bible §3.4 row 94: two suites against one database truncate each other's
fixtures). Create it if it doesn't exist (`psql -U postgres -p 5435 -c "CREATE DATABASE
shareat_test_202;"`), migrate it (`DATABASE_URL` pointed at it, `npm run db:migrate` — this task
adds no migration, so this only needs to run once), then point `TEST_DATABASE_URL` at it for `npm
run test:integration`. Run `ListAgents` before starting and again before this step, in case a peer
session unrelated to this batch of work is also active. Cases: create a person + hire in one flow · search finds an existing
person by partial name · search is org-scoped (a person in another org never matches) ·
`createPerson` refused for a store the actor doesn't cover · the whole hire transaction rolls back
if `createEmployment` refuses (no orphaned person... actually a person row IS allowed to exist
without an employment in general — T-101 doesn't forbid it — so state plainly whether the
implementation rolls the person creation back too, and why, rather than assuming).

No new UI test harness — smoketest live on 9008 per the project's definition of done (§9): hire a
new person, hire an existing one at a second store, assign/change positions, end an employment,
confirm the ended employment still renders. Screenshot or describe what was actually clicked;
Playwright via the project's existing harness (`reference_playwright_smoketest_harness`) if the
Chrome extension path is unavailable in this environment — say which was used.

## Out of scope — with reasons

**Credential enrolment (card/fingerprint)** — T-203/DEF-133, a separate screen; this task's
employment detail page may link out to it but builds nothing behind the link · **Pay rate** — T-154
already scoped this to Phase 5, unchanged · **Bulk import** — no evidence of need, not asked for ·
**Editing a person's `displayName` after creation** — not asked for; if it turns out to matter,
that's a `personsRepo` addition for a later task · **Terminal/credential admin** — T-203.

## Done when

- [x] `typecheck` clean.
- [x] `npm test` clean — 942/943 (1 pre-existing skip, unrelated).
- [x] `npm run test:integration` green on the assigned lane's database (`shareat_test_202`), real
      output reported — 78 files / 2114 tests. First run had 6 failures: 3 were this task's own
      test fixture missing `seedCanonicalPositions` (fixed, reverified 11/11 isolated), 3 were
      T-204's concurrent WIP in `inbox-ingestor.test.ts` (confirmed unrelated by file-mtime — those
      files were edited *during* this run).
- [x] `npm run build` succeeds with the dev server stopped first — exit 0.
- [x] Smoketested live on 9008: hire new, hire existing-at-second-store (one person row, not two),
      reposition, end (record stays visible, positions read-only), both stores' rosters re-checked
      correctly. Also exercised beyond the checklist: the duplicate-open-employment refusal reads
      as a banner not a crash (invariant 1), the store's own "add a position" form, and the
      credentials link resolving into T-203's real screen. Everything in this task's own scope was
      exercised; nothing was skipped.
- [x] Self-reviewed line by line (§9).
- [x] `docs/DEFECTS-REGISTER.md` DEF-131's row updated with what shipped and this task's number.
- [x] This file's status line updated.
