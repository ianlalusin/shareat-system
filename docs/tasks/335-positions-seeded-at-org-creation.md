# T-335 — every organisation can hire from day one (DEF-150)

**Status:** SPECCED 2026-09-23 by a planner subagent, revised for the auditor's 8 findings, APPROVED by the orchestrator, NOT BUILT. Queued after T-334 slice 3 tranche 1. §5's duplicate-"Server" resolution is OPEN for Ian (the build is report-only).
**Closes:** DEF-150 (`docs/DEFECTS-REGISTER.md:232`). Re-observed live 2026-09-23: a smoke org made by
`scripts/bootstrap-org.ts` could not hire until the six were seeded by hand.
**Approved:** Ian approved speccing a fix (orchestrator, 2026-09-23). No ruling of his is needed to BUILD
this. One sibling gap in §8 does need him, and this task does not touch it.
**Migration slot:** ⛔ **none.** No schema change and no data migration (§6). `0157` stays free.
**Model:** Sonnet builds this. It is wiring onto a seed that already exists and is already idempotent.

---

## 1. Goal (bible §1.2d, four steps)

1. **v1 at source.** `ERP-rebuild/src/types/position.ts:72` defines `CANONICAL_POSITION_NAMES` (the
   six). `getCanonicalPositions(storeId)` (`:87-100`) **synthesises** them in memory for every store.
   They are never stored (`id: 'canonical:<name>'`, `createdByUid: 'system'`). The one caller is
   `lib/actions/position.actions.ts:87`: `[...getCanonicalPositions(storeId), ...configured]`.
   A blank pick falls back to `DEFAULT_POSITION_NAME = 'Server'` (`:58-70`).
2. **v1's GOAL, in one sentence:** *every store can staff the six canonical jobs from the moment it
   exists, with no setup step, and a hire with no job picked lands on the least-privileged one.*
3. **Live data.** Not counted: v1 cannot fail here. Its canonical six are computed, not stored, so
   no store can be missing them. The need is proven by construction. There is no data to trust or
   distrust.
4. **v2 against that goal.** v2 stores the six as rows (`positions`, T-154). It has to, because
   `employment_positions.position_id` and `position_capability_defaults` both need an FK target. So
   v2 has a failure mode v1 lacks: the rows can be absent. The bar is that **absence is not reachable
   through any supported path**, and that the one existing gap (already-created orgs) gets closed
   once and **reported** rather than assumed.

## 2. Evidence: which paths create an organisation (question 1)

| Path | Creates an org? | Seeds the six today? |
|---|---|---|
| `createOrganization` (`packages/domain/src/organizations/index.ts:130-175`) | ✅ the only `insertOrganization` caller (`:154`) | ❌ it seeds the chart, the categories and the periods (`:168-173`), **not positions** |
| `bootstrapOrganization` (`:335-432`), called by `scripts/bootstrap-org.ts:213` and `apps/erp/src/app/setup/actions.ts:72` | via `createOrganization` (`:377`) | ❌ |
| Any admin screen | ❌ none. Bootstrap refuses once any org exists (`:344-349`) | n/a |
| ETL / cutover | ❌ `packages/etl/src` has no match for `position` or `insert into organizations` (grep, 2026-09-23). `classification.ts:257-275` marks `positions`/`employments`/`employment_positions` as `keep`, so the purge never touches them | n/a |
| `scripts/dev-seed.ts:67-71` | ❌ it *selects* an existing org and re-seeds the chart and categories only (`:86-89`) | ❌ |
| Test fixtures (≈111 raw `insert into organizations`) | yes, bypassing the domain | they call `seedCanonicalPositions` themselves (13 files) |

`seedCanonicalPositions` (`packages/domain/src/people/index.ts:279-281`) has **zero non-test callers**
(grep, 2026-09-23). So **every org created through a supported path, and never seeded by hand, has
zero positions.** That potentially covers production's one org and every dev, smoke and lane DB.
`shareat_dev` is a known exception: it was hand-seeded on 2026-09-04 (DEF-150's disposition).

**Production at cutover.** The cutover does not create orgs and does not purge positions, so the
cutover itself neither causes nor fixes the gap. What matters is whether production's existing org
(`SHAREAT OPC`, named in `0152`'s header) already has its six. **I could not verify that.** Migration
`0152` ran in production and gates on open employments having positions. That hints the six exist
there, but they would have been seeded by hand. §5 step 1 answers it with a genuinely read-only
`select count(*)`. That is the first thing the builder runs against production.

## 3. Where the seeding belongs (question 2): inside `createOrganization`

⭐ **Recommendation:** call `employmentRepo.seedCanonical(tx, org.id)` inside `createOrganization`,
on the caller's transaction, next to the chart, category and period seeds.

- It is the **only** writer of `organizations` (repo header, `packages/db/src/repo/organizations.ts:4-9`,
  and `insertOrganization` has one caller). Both bootstrap callers, and every test that uses the domain
  path, inherit the seed without changing.
- It follows the established rule for reference data: an org *"always has its chart of accounts,
  its expense categories, and a year of fiscal periods … or it does not exist"* (`:123-128`). The six
  join that list. There is then one place that answers "what is an org born with".
- It is atomic with the org. A failed bootstrap rolls back the positions too (T3).

**Why the other two lose:**

- **Lazily inside `createEmployment`: loses.** (a) It fixes only the blank-hire branch. `/staff/hire`
  renders its picker from `listPositions` *before* any hire (`apps/erp/src/app/staff/hire/page.tsx:144-147`,
  *"No positions defined for this store yet"*), and the `/admin/access-defaults` grid is empty for
  the same reason (`page.tsx:88,149`). So a manager still cannot pick Cashier. (b) It writes org-wide
  reference data under `enrol_staff`, a **store**-scoped capability. That is an authority mismatch.
  (c) It turns a read-shaped fallback into a hidden write, so the next reader of `resolvePositions`
  has to know it can mutate the taxonomy.
- **A DB trigger `AFTER INSERT ON organizations`: loses, and not by much.** Bible row 156 *does* use
  a trigger for a store's five money accounts, *"because there is no `createStore` service … four
  paths"*. Here there is exactly **one** path, so row 156's premise is absent. Against it:
  (a) the six would be copied into plpgsql, a second source of truth next to `CANONICAL_POSITIONS`
  (`packages/db/schema/employment.ts:56-63`). The access-defaults ordering reads that constant
  (`apps/erp/src/app/admin/access-defaults/lib.ts:179`).
  (b) **It would break existing tests, and I verified this.**
  `packages/db/tests/integration/position-access-backfill.test.ts:324-326` inserts an org by raw SQL and
  then inserts canonical `'Cashier'` **without** `on conflict`. Under a trigger that is a 23505, and
  the same shape repeats at `:348-352`, `:378-384`, `:403-409`, `:430-436`, `:467-471` and `:509-519`.
  (c) It would split "what an org is born with" across two mechanisms (three seeds in TS, one in a
  trigger).
- **What stops a second path from skipping it:** a unit guard (U1) that fails the build if
  `insertOrganization(` gains a second non-test caller. That is the same shape as
  `tests/unit/system-transaction-callers.test.ts`.

**`seedCanonical` really is idempotent. Verified by reading, not by trusting its comment.**
`packages/db/src/repo/employment.ts:56-63` does `insert … (org_id, null, name, true) on conflict do nothing`.
It works because the one unique index is `positions_org_scope_name_unique` on
`(org_id, coalesce(store_id, nil-uuid), lower(trim(name)))` (`migrations/0080_…:35-36`). All canonical
rows of an org fall in one group, case- and whitespace-insensitively. Today the `on conflict` has no
target, so it would swallow *any* unique violation. The only other unique constraint today is the PK,
a fresh `uuidv7()`, so that is harmless now, but §4 gives the clause an explicit target anyway. Canonical rows cannot be retired
(`packages/domain/src/people/position-defaults.ts:243-260`), so the `Server` fallback, which does not
filter `is_active`, cannot resolve to a retired row.

## 4. Contract: exact files, and nothing else

| File | Change |
|---|---|
| `packages/db/src/repo/employment.ts` | `seedCanonical` returns `{ inserted: number }` (add `returning id`, count the rows). ⭐ **Give its `on conflict` an explicit target**, the `0080` index expression: `on conflict (org_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name))) do nothing`. Then a future second unique constraint raises loudly instead of being swallowed, which would make `inserted` under-report. Add `canonicalNameCollisions(tx, orgId)`, a read-only query returning store-scoped rows (`store_id is not null`) whose `lower(trim(name))` equals a canonical name |
| `packages/domain/src/people/index.ts` | `seedCanonicalPositions` passes the new return value through. No other change |
| `packages/domain/src/organizations/index.ts` | `createOrganization` calls `employmentRepo.seedCanonical(tx, org.id)` after the period seed. `CreateOrganizationResult` gains `readonly positionsSeeded: number`. The doc comment at `:120-129` names the fourth seed |
| `scripts/bootstrap-org.ts` | Two print lines: the plan (`:168-169`, "canonical positions : seeded for this org") and the result (`:226-228`, `positionsSeeded`). ⛔ Nothing else. The comment at `:205-208` forbids a step the screen skips |
| `scripts/backfill-canonical-positions.ts` (new) + one `package.json` script line | §5 |
| `packages/domain/tests/integration/t335-positions-at-org-creation.test.ts` (new) | T1–T7, T5b, T6b |
| `tests/unit/organization-insert-callers.test.ts` (new) | U1 |

⛔ **Do not touch** `apps/erp/**` (other sessions are editing `staff/**`, `expenses/**`,
`components/ui/**`, `globals.css`), `scripts/dev-seed.ts`, any migration, `CANONICAL_POSITIONS`,
`position_capability_defaults`, or `authorize()`. The hire screen's empty-state branch simply stops
being reachable for a new org. It stays in place as a correct message for a genuinely empty store.

## 5. Existing orgs with zero positions (question 3): a one-shot script, not a migration

`scripts/backfill-canonical-positions.ts` is modelled **line for line** on
`scripts/backfill-fiscal-periods.ts`:
- a dry run by default that runs the real seed and then rolls back through the sentinel;
- `--confirm` to commit;
- one transaction per org, taken from `schedulerRepo.listOrgsToRun`, with the same `transaction()` door.

Per org it prints: `inserted N · canonical now 6/6 · collisions: <store code · position id · name, or none>`.

- ⛔ **The dry run is NOT read-only.** It is a write-then-rollback probe: the INSERTs really execute,
  take row locks and run the triggers, and then the transaction rolls back. So the production
  sequence has a genuinely read-only step first:
  1. **Read only:** `select count(*) from positions where org_id = <prod org> and store_id is null and is_canonical`,
     plus the collision query (§4) as a plain `select`. **If the count is 6, stop.** Production
     needs no write-probe and no backfill. Record the count and the collision list in the report.
  2. Only if it is below 6: the dry-run probe, and then `--confirm`. Both need the orchestrator's go.
- **Collisions are reported, never resolved. ⚠️ OPEN: needs Ian's ruling.** Before this fix,
  `upsertStorePosition` refused a canonical name only if the canonical row existed
  (`people/index.ts:246-252`). In an unseeded org a store could therefore have made its own `Server`.
  After the backfill that store has **two `Server` rows**, one org-wide and one store-scoped, and
  both are legal under the index because they fall in different groups. **What people see:**
  `listPositions` returns `store_id is null OR store_id = <this store>`, ordered by `is_canonical asc`
  and then name (`repo/employment.ts:65-77`). So `/staff/hire` and `/staff` show **two "Server"
  options, and not even next to each other**: the store's own one sorts among the non-canonical rows
  first, the canonical one later. **What goes wrong unseen:** they have different `position_id`s, so
  `position_capability_defaults` can be set on one and not the other. Two people both "Server" at
  one store then hold different access, and nothing on screen says why. Row 156's *"backfill ADOPTS
  before it seeds"* is the likely shape (re-point `employment_positions` and the defaults, retire
  the store row), but **adopting changes who holds what access, so it is Ian's call.** The script
  names each collision by **store code and position id** and changes nothing.
- **How idempotency is proven:** T4 at the repo level, plus running the script twice on a scratch DB.
  The second run must print `inserted 0` for every org.
- **Run order:** smoke DB, then `shareat_dev` (dry run, then `--confirm`, both directly), then
  production as above.

## 6. Migration (question 5): none needed

- The fix for new orgs is code. The backfill inserts **data** into an unchanged table. RULES §1 rule 9
  and ADR-012 govern schema changes. `backfill-fiscal-periods.ts:7-9` states the same distinction, and
  T-332 (`docs/tasks/332-…:281`) chose a script over a migration for the same reason.
- A data migration would also have to copy the six into SQL (§3's second-source problem). It could
  not report collisions readably.
- ⚠️ **It would also land a hazard.** `0156` is allocated to T-276 and **not yet written** (journal
  head is `0155`). If a `0157` is applied before `0156` exists, drizzle skips any later migration
  whose `when` is older than the last applied one (DEF-039's shape). **If the orchestrator overrules
  this and wants a migration, T-276 must land first, or be re-slotted after it.**

## 7. Invariants and tests: every one is negative-capable

Each test is first run against today's code, and the builder records that it **fails for the stated
reason** (RULES §2, "tests before implementation").

| # | Invariant | Test | What a broken implementation fails on |
|---|---|---|---|
| T1 | A freshly bootstrapped org has exactly the six, all `store_id null`, `is_canonical true`, **and the returned `positionsSeeded` equals the rows actually inserted** | `bootstrapOrganization` on a clean schema, then select names by `org_id`. Assert **set equality** with `CANONICAL_POSITIONS` (sorted arrays `toEqual`), not a count. Assert `result.positionsSeeded === 6` **and** equal to the selected row count | Today: **0 rows**. A wrong or misspelled six (`'Inventory staff'`, a seventh) passes a count but fails set equality. A hard-coded `positionsSeeded: 6`, or one that counts attempts instead of `returning` rows, is caught by T4(a)'s second call reporting 0. A seed in `bootstrapOrganization` rather than `createOrganization` passes T1 but fails T6's `createOrganization`-only call |
| T2 | A blank hire into a fresh org gets **`Server`** as its single primary | `createEmployment` as the bootstrap admin with no `positionIds` | Today: throws *"The default position 'Server' is missing"*. The test asserts the position **name is `Server`**, not merely "one primary exists", so a fallback resolving to `Cashier` (first in the list) fails |
| T3 | The seed is atomic with the org | extend the injected-failure shape of `first-run-setup.test.ts` case 2: fail after `createOrganization`, then count positions for that code | a seed run on its own connection or transaction leaves 6 orphan rows, so the count is not 0 |
| T4 | Seeding twice creates no duplicates, and a pre-existing canonical differing only in case or space is honoured | (a) `seedCanonical` ×2, asserting `inserted` 6 then 0 and a count of 6; (b) raw-insert canonical `' server '`, then seed, asserting `inserted` = 5 and a count of 6 | dropping `on conflict`: (a) throws 23505; an index without `lower(trim)`: (b) inserts 6 and counts 7 |
| T5 | ⛔ **Seeding grants nothing.** Bible rows 198/210: a position carries *defaults*, and the six arrive with none | After bootstrap and a blank hire, assert `position_capability_defaults` has **0 rows** for the org, `person_grants` has **0** `grant_source='position'` rows for the hire, and `authorize(hire, 'record_sale', {storeId})` **rejects**. **Control:** the admin then runs `setPositionDefault(Server, record_sale)`, and the same `authorize` passes | a build that copies `0152`'s 21 capabilities onto the new positions fails all three. The control proves the refusal comes from the missing defaults and not from a broken actor fixture, so the rejection test cannot be vacuous |
| T5b | ⛔ **An org already in `0152`'s state keeps its defaults exactly, and the new canonical rows grant nothing.** | Fixture: an org holding a store-scoped position with `position_capability_defaults` rows and the matching `person_grants` (`grant_source='position'`), and **zero** canonical rows. Snapshot both tables for the org (sorted `id, position_id, store_id, capability, revoked_at` / `id, person_id, grant_name, source_ref, revoked_at`), run the backfill's per-org function, snapshot again | Before and after must be `toEqual`, with the same row count and content. Any `position_capability_defaults.position_id` pointing at one of the six new ids makes the count go up, which is exactly how a build that "helpfully" copies an existing store position's defaults onto the canonical ones fails. A backfill that calls `reconcilePositionGrants` and revokes or re-tags a grant changes `revoked_at` / `grant_source` |
| T6b | The picker source shows the six for a **new** store (D6) | After `createOrganization` and `createStore` (a second store, created after the org), call `employmentRepo.listPositions(tx, orgId, newStoreId)`. That is the exact source of `positionsForStore` (`apps/erp/src/app/staff/lib.ts:41-42`) and of the access-defaults grid (`admin/access-defaults/lib.ts:331`). Assert the names are set-equal to `CANONICAL_POSITIONS`. ⚠️ Asserted at the repo boundary in the new T-335 test file. `apps/erp/tests/*` and `staff/**` are being edited by other sessions | Today: `[]`. A seed written per *store* at bootstrap only (the first store) would pass T1 and fail here |
| T6 | Tenancy: seeding org A writes nothing into org B | two orgs via `createOrganization`: each has exactly 6, and every row's `org_id` is its own | a cross-join or unscoped seed gives 12 per org (`0152`'s header documents this exact bug class, bypassing RLS under the owner role) |
| T7 | The backfill reports a collision and changes nothing about it | org with 0 canonical rows plus a store-scoped `Server`, then the script's per-org function: 6 inserted, the collision list names that row **by store code and position id**, and the row keeps its `id`, `store_id` and `is_active` | a silent script, or one that "adopts" or deletes the row |
| U1 | `insertOrganization(` has exactly **one** non-test call site, in `packages/domain/src/organizations/index.ts` | scan the source roots the way `system-transaction-callers.test.ts` does (all nine, per DEF-295) | ⛔ **It must also assert that it found ≥1 call.** Otherwise a scanner reading the wrong roots passes on zero, the vacuous shape from T-334 slice 2b. A second org-creation path fails it |

Existing suites that must stay green, **run as a full integration suite before any push**
(bible §9 rule 3 — a lane-scoped run cannot certify this): `first-run-setup.test.ts`,
`organizations.test.ts`, `t332-store-config-seeding.test.ts`, `position-defaults.test.ts`,
`employment.test.ts`, `access-defaults-lib.test.ts`, and the 13 fixture files that call
`seedCanonicalPositions` (now a no-op after a `createOrganization`, and still the only seed after a
raw insert).

**§9.4 smoketest:** follow `docs/SMOKETEST.md`. Use a *scratch* DB with zero orgs, because bootstrap
refuses otherwise. Run `bootstrap-org.ts`, sign in with its PIN on 9008, and open `/staff/hire`: all
six are listed. Hire with nothing ticked; the new row on `/staff` shows `Server` as primary. Take a
screenshot.

## 8. Out of scope, bluntly

- ⛔ **A fresh org's six carry NO access defaults, so a Cashier hired there cannot `record_sale`
  until an admin configures `/admin/access-defaults`.** Since T-318 slice C the `staff` baseline is
  empty (row 210). `0152` backfilled defaults **once** for the positions and stores that existed on
  2026-09-14. Nothing writes defaults for a later org or store (writers: `position-defaults.ts` and
  the admin screen only, grep 2026-09-23). This task deliberately does not fix it (T5 pins that).
  **Which capabilities each canonical position gets by default is Ian's decision.** It is filed as
  **DEF-413** by the orchestrator, and it needs its own task.
- Merging or adopting store-scoped positions that collide with a canonical name. §5 only reports them.
  ⚠️ **OPEN: needs Ian's ruling** (the two-`Server` consequence in §5).
- `scripts/dev-seed.ts`. The backfill script covers existing dev DBs, and new ones get the six through
  bootstrap.
- Renaming, re-ordering or extending `CANONICAL_POSITIONS`. Any change to `/staff/hire`, `/staff` or
  `/admin/access-defaults`. Any change to `authorize()` or the capability matrix.
- Running `--confirm` against production without the orchestrator's go.

## 9. Done when

T1–T7, T5b, T6b and U1 are written, each has been seen failing for its stated reason, and all pass.
Typecheck is clean. The unit suite passes. The **full** integration suite passes. `npm run build`
succeeds with the dev server stopped. The §7 smoketest has a screenshot. The backfill output is
recorded for the smoke DB and `shareat_dev`. For production, the read-only count from §5 step 1 is
recorded, plus the collision list. DEF-150 is marked FIXED in the register with the commit and the
test names. **The access-defaults gap is on file as DEF-413** (orchestrator-filed) and is cited from
DEF-150's fix row. Any collisions found are reported to Ian as OPEN. The bible is **not** amended, because no decision was made that
§4.4/row 56 does not already cover. If the orchestrator overrules §6, that becomes a decision and gets
a row.

## 10. Not verified by this planner

- Whether production's `SHAREAT OPC` already has the six (§2). §5 step 1's read-only count answers it.
- Whether any org has a store-scoped position named like a canonical one today. The §5 collision
  query answers it.
- Whether the SYSTEM role, when `SYSTEM_DATABASE_URL` is set, may INSERT into `positions`. Chart and
  category inserts on the same transaction imply it can, but I did not check the grants.
- Whether `transaction()` in a script passes `positions`' RLS on production's connection role. It
  follows whatever `backfill-fiscal-periods.ts` proved, which I did not confirm was run in production.
- v1 live-data counts for Firestore `positions` (not queried; §1 step 3 explains why they do not bear
  on the goal).
- That DEF-413's row exists in the register as described. The orchestrator is adding it; I did not read it.
