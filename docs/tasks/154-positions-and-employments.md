# T-154 — Positions and employments: the staff master record nobody owned

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> **Depends on:** T-101 (`persons`, `person_identities`), T-121 (`person_roles`, `person_store_scope`),
> T-138 (`sessions`, `resolveActor`) — all shipped.
> **Blocks:** T-156 (a punch needs somebody to punch against), T-157, and every Phase 5 task.
> **Owned by Phase 4 on the authority of `docs/CAPABILITY-GAPS.md:152`** — *"Staff master record +
> position taxonomy · **4** — load-bearing for 4 and 5; previously unowned."* Discovery 15's
> "Capabilities with no home in the plan" #1 and #2 are the underlying finding.

## Why this exists at all

Discovery 15 §"no home in the plan" #1, which is the whole argument:

> *"It's silently assumed to exist by P4 (attendance needs a `staffId` to punch against) and P5
> (payroll needs a rate to pay). If it's never explicitly scoped as its own deliverable, the risk is
> it gets built piecemeal inside P4/P5 without ever getting the 'one `person` table' spine treatment
> bible §7.1/decision #14 already commits to — **recreating exactly the four-loosely-linked-identities
> mess v2 is supposed to fix**."*

⭐ **Half of that fix already shipped.** T-101 built `persons` + `person_identities`, and T-138 built
`person_credentials` + `sessions`. What is missing is the **employment** half: the fact that a person
holds a job, at a store, in a position, with a status, between two dates. v1 calls that `staff`, and
it is where the pay rate, the position, and every self-dealing check hang.

**This task builds only the employment relationship.** Compensation is Phase 5 — see Out of scope,
which explains why splitting there is the right seam and not a dodge.

## Grounding — v1, read as requirements (bible §1.2b)

`ERP-rebuild/src/types/index.ts:700-750` (`StaffPlain`), `src/types/position.ts:60-90`,
`src/lib/actions/staff.actions.ts:27-33`.

### What v1 gets right, and is ported

- **Positions are a taxonomy, not a role.** Six canonical names —
  `Cashier · Cook · Server · Dishwasher · Slicer · Inventory Staff` (`position.ts:72`) — **plus
  store-defined extras**, because a store genuinely does invent its own. This is orthogonal to the
  `super_admin/admin/manager/staff` role axis T-121 already built, and conflating them would be a
  regression.
- ⭐ **A person holds MANY positions, and any of them can be the work they do that day.** v1:
  *"Source of truth for permissions/assignment (union of all). A staff can do the work of any listed
  position"* (`index.ts:712-714`). A cashier who cooks on Sundays is one person, not two records.
- **The default position is the least-privileged one.** `DEFAULT_POSITION_NAME = 'Server'`, chosen
  because *"'Server' is not referenced by any nav group or server-side gate, so an unspecified role
  lands on the floor-crew baseline instead of silently inheriting someone else's permissions"*
  (`position.ts:58-64`). ⭐ **That is fail-closed reasoning applied to a taxonomy**, and it is better
  than most of what surrounds it. Ported verbatim.
- **A staff code (`SE-001`) that humans use.** `formatStaffCode` (`staff.actions.ts:32`). Payroll
  paperwork and physical badges both need a short human key that is not a uuid.
- **Employment status is a real enum** — `regular · probationary · contractual · part-time ·
  resigned · terminated · inactive` (`staff.actions.ts:28`).

### What v1 gets wrong, and is corrected here

| v1 | Here | Why it matters |
|---|---|---|
| `position` **and** `positions[]`, with `position` documented as *"mirrors positions[0]"* | One child table. **No denormalised primary field** — the primary is a flagged row | Landmine #12: *"Two switches governed one behaviour; only one was enforced."* Two fields holding one fact drift, and v1's own comment shows it already knows they must be kept in step by hand |
| `isSlicer: boolean`, beside a `positions[]` that may contain `'Slicer'` | **Derived.** No column | The same landmine a second time in the same interface. A boolean that must agree with an array is a bug waiting for whoever edits one of them |
| `isActive: boolean` stored | **Derived** from status + effective dates, exposed as a view | Discovery 15 §8: *"`staff.active` derived, not directly toggled… treated as a projection invariant, not a field a form can drift from"* (`active-staff-count.ts:1-56`). v1 arrived at this conclusion and then kept the column |
| `linkedLocalUserId`, `linkedUserUid`, and a separate `staffIdentities` collection linking one person across stores | **All three deleted.** `person_id` is a foreign key; cross-store is `GROUP BY person_id` | Bible §7.1 and decision #14. This is the four-identities mess, and T-101 already retired it — v1's three link fields have nothing left to link |
| A staff record is store-scoped, so one person working two branches is **two records** with a manual admin link | One `persons` row, **two `employments` rows** | Discovery 15 §6: *"a staffer who works multiple branches has ONE real debt to the business, not one silo per store."* The salary-advance cross-store ledger stops being an aggregation problem and becomes a join |
| `dateHired` only | `started_on` **and** `ended_on` | An employment with no end cannot express *"they left in March"* without overloading the status, which is how a terminated staffer stays on a memo roster forever |

## Contract

### 1. `positions` — the taxonomy, canonical rows and store extras in one table

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk, `uuidv7()` | |
| `orgId` | `uuid not null` → `organizations` | |
| `storeId` | `uuid null` → `stores` | ⭐ **NULL means canonical** — org-wide, seeded, not editable by a store. Non-null is that store's own invention |
| `name` | `text not null` | |
| `isCanonical` | `boolean not null default false` | |
| `isActive` | `boolean not null default true` | Retire a position without deleting it; historical employments still reference it |
| `createdAt` / `updatedAt` / `createdBy` | | Per bible §4.2 rule 1 |

Constraints:
- `unique (org_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name)))`
  — hand-written in the migration, since Drizzle's builder cannot express it (the same note
  `persons.ts` already carries for `person_identities`).
- `check (is_canonical = (store_id is null))` — ⭐ **canonical and store-scoped are the same fact
  stated twice, so the database holds them to it** rather than trusting the writer.

**Seed the six canonical rows** per org: `Cashier · Cook · Server · Dishwasher · Slicer ·
Inventory Staff`. Idempotent, in the shape `packages/db/seed/chart-of-accounts.ts` already uses.

### 2. `employments` — a person holds a job at a store

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | |
| `orgId` / `storeId` | `uuid not null` | §4.2 rule 2 |
| `personId` | `uuid not null` → `persons` `on delete restrict` | ⭐ **The whole point.** No `fullName`, no `email`, no `contactNo` — those are the person's, and duplicating them here rebuilds the mess |
| `staffCode` | `text not null` | `SE-001`, per store. See §3 |
| `employmentStatus` | `text not null` CHECK | v1's seven values, unchanged |
| `startedOn` | `date not null` | |
| `endedOn` | `date null` | |
| `notes` | `text null` | |
| `photoFileId` | `uuid null` → `stored_files` | T-141 brokered upload; never a data URL |
| `createdAt` / `updatedAt` / `createdBy` | | |

Constraints:
- `unique (store_id, lower(staff_code))`.
- ⛔ **`unique (person_id, store_id) where ended_on is null`** — a person holds **at most one open
  employment per store**. Two open employments at one store is the shape that lets a punch land on
  the wrong one, silently, and payroll pay it twice.
- `check (ended_on is null or ended_on >= started_on)`.
- `check ((employment_status in ('resigned','terminated')) = (ended_on is not null))` — ⭐ a
  terminated employment with no end date, or an end date with a live status, are both
  unrepresentable. v1 has `resigned`/`terminated` as values and *no end date at all*, so "when did
  they leave" is currently unanswerable.

### 3. `staffCode` — a per-store sequence, allocated in the same transaction

`SE-001`, `SE-002`, … per store, formatted exactly as `formatStaffCode` does
(`staff.actions.ts:32-34`). Allocate with `select max(...) + 1 ... for update` inside the creating
transaction, **not** a Postgres sequence: a sequence is global and gappy, and this number is printed
on a badge. A gap is confusing to a manager in a way a lock is not.

### 4. `employment_positions` — many positions, one primary

| Column | Type |
|---|---|
| `id` | `uuid` pk |
| `employmentId` | `uuid not null` → `employments` **`on delete cascade`** |
| `positionId` | `uuid not null` → `positions` `on delete restrict` |
| `isPrimary` | `boolean not null default false` |

- `unique (employment_id, position_id)`.
- `unique (employment_id) where is_primary` — ⭐ **exactly one primary, enforced.** This is the
  partial-unique-index pattern `person_roles_active_person_org_unique` already uses.
- `cascade` here is deliberate and matches `person_identities`: a position assignment is genuinely
  *part of* the employment, not an independent record (§4.2 rule 3).
- **Creating an employment with no positions assigns `Server`**, per v1's least-privilege default.
  Enforced in the service, not the schema — a CHECK cannot see a child table.

### 5. `v_active_employments` — the derived view that replaces `isActive`

```sql
create view v_active_employments as
  select e.*, p.display_name
  from employments e join persons p on p.id = e.person_id
  where e.ended_on is null
    and e.employment_status not in ('resigned', 'terminated', 'inactive')
    and p.is_active;
```

⭐ **Nothing may store an `is_active` boolean on `employments`.** §4.2 rule 7, and discovery 15's
finding that v1 treats the active count as a projection invariant while still carrying the field.
The view is the answer to *"who is on the roster"*, and the mirror publisher (T-181) reads it.

### 6. Service layer — `packages/domain/src/people/`

```ts
createEmployment(tx, actor, input): Promise<Employment>   // allocates staffCode, defaults position
endEmployment(tx, actor, { employmentId, endedOn, status }): Promise<Employment>
setEmploymentPositions(tx, actor, { employmentId, positionIds, primaryPositionId }): Promise<void>
upsertStorePosition(tx, actor, input): Promise<Position>
listRoster(tx, { storeId }): Promise<RosterRow[]>          // reads the view
```

Every one begins with `authorize(actor, ...)`, and `actor` comes from `resolveActor` — **never a
parameter** (§7.1, and T-138 exists precisely so this is now possible).

### 7. Capability

`enrol_staff` **already exists** in `packages/auth/src/capabilities.ts` and the matrix
(`admin ✅ · manager ✅ · staff ✗`). ⭐ **It fits, so do not add a new one.** Editing a store's own
position list is `manage_store_settings`, also already present.

> **If the implementer finds it needs a capability that does not exist**, that is a
> registry-and-count edit and it lands as **its own first commit** (lane constraint), touching
> `capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md`, and the matrix test together — never
> mixed into the feature commit.

## Invariants

1. A person has at most one open employment per store; a second is refused, not silently created.
2. A `resigned`/`terminated` employment always has an `ended_on`, and a live one never does.
3. Every employment has exactly one primary position.
4. Ending an employment does **not** delete it, its positions, or its punches — the audit trail is
   the point.
5. `staffCode` is unique per store and gap-free in the ordinary case.
6. A canonical position cannot be edited or deleted by a store; a store's own can.
7. `v_active_employments` is the only answer to "is this person on the roster." No stored boolean.
8. One person, two stores, two employments — and `group by person_id` finds both. (This is the
   cross-store case discovery 15 §6 says v1 solves by manual admin linking.)
9. Deleting a `person` with an employment is **refused** by FK, not cascaded.

## Tests

Integration, real Postgres, in the shape `packages/domain/tests/integration/` already uses.
`$env:TEST_DATABASE_URL` = **`shareat_test_b`** for this lane. Never `shareat_test` — a peer session
is using it and both suites truncate (bible §3.4, and the 2026-08-23 T-106/T-107 collision).

Required fixtures: a plain hire · a second open employment at the same store (**refused**) · the same
person hired at a second store (**allowed**, and the cross-store query finds both) · a hire with no
positions (gets `Server`) · setting a primary, then moving it · terminating without an end date
(**refused**) · an end date before the start (**refused**) · a store position colliding with a
canonical name (**refused**) · `staffCode` allocation under two concurrent creates in the same store
· the view excluding each of the four inactive shapes · deleting a person who has an employment
(**refused**).

## Out of scope — each with its reason

**Pay rate and pay type** — Phase 5, and effective-dated when it lands (discovery 15 §5: *"changes
to a staffer's rate are versioned, never overwritten, so a past payslip can be reconstructed"*).
⭐ **The seam is right here and not arbitrary:** an employment is a *fact about a job*, a rate is a
*fact about money*, they change on different cadences, and Phase 4 posts nothing to the ledger ·
**Signature capture** — Phase 7, memos are its only consumer · **The POS `serverProfileId` mapping**
— Phase 7 performance scoring, and it depends on the POS seam · **Infractions and performance** —
Phase 7 · **Leave** — T-165, in this phase · **`person_credentials` for these people** — T-138 built
the table; enrolling a clock credential is T-185 · **Any UI** — this task is schema and service.
The roster screen arrives with T-195, which has something to show. (⚠️ Originally promised as "T-166"; the inventory lane took that number for Deliveries.)

## Done when

- [ ] All nine invariants pass against real Postgres on `shareat_test_b`.
- [ ] Migration hand-written per DEF-073, numbered in **0070–0089**, with the `meta/_journal.json`
      row hand-added as `previous.when + 86400000`.
- [ ] New tables classified in `packages/db/src/cutover/classification.ts` **and** registered in
      `packages/db/src/rls/registry.ts` — ⭐ **as their own first commit**, before the feature.
- [ ] The six canonical positions seed idempotently; re-running changes nothing.
- [ ] `npm run typecheck` · `npm test` · `npm run test:integration` green, real output reported.
- [ ] Self-reviewed line by line (§9).
