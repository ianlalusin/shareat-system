**Status:** SPECCED 2026-09-24 by a planner subagent. BUILT 2026-09-24. Depends on T-335.

# T-336: every new store opens with Ian's per-position access defaults (DEF-413)

**Closes:** DEF-413 (`docs/DEFECTS-REGISTER.md:620`, "blocks any NEW branch or org from operating").
**Contract:** `docs/decisions/PROPOSAL-DEF-413-default-position-capabilities.md`, RULED "approve all"
2026-09-24. Every cell of its table is fixed. This spec decides only **where**, **when** and **how**.
**Migration slot:** ⛔ **none** (§6). `0157` stays free.
**Model:** Sonnet builds this. The one call that needs Ian first is §3's ⚠️ OPEN item.

---

## 1. Goal (bible §1.2d)

1. **v1 at source.** v1 had no defaults table. Access came from nav groups and server checks keyed
   on position name (the proposal's evidence table, `sidebar-nav.tsx:112-222`, and the cited actions).
   The rule held in every store from the moment the store existed.
2. **v1's GOAL:** *a store's six canonical jobs can do their everyday work from the moment the store
   exists, and a hire with no job picked can do almost nothing.*
3. **Live data.** v1 cannot fail here because its rules are code, not rows. In v2, `0152` wrote rows
   once (2026-09-14) for the stores that existed then. Nothing writes defaults for a later store
   (writers: `setPositionDefault` and `0152` only, per the T-335 grep of 2026-09-23).
4. **v2 against that goal.** Defaults are rows keyed per (position, **store**), so the store is where
   the seeding must happen. The bar is that **a store with zero defaults cannot be reached through
   `createStore`**, and that no existing row anywhere changes.

## 2. The premise the brief got wrong: not "inside `createOrganization`"

The brief asked for the seed "in the SAME place and transaction" as T-335's position seed. **That
cannot work.** `position_capability_defaults` has `store_id NOT NULL` and `set_by NOT NULL →
persons` (`packages/db/schema/position-capability-defaults.ts:48-57`, header §"store_id is NOT NULL
even for a canonical position": *"a default is per (position, store), always"*). Inside
`createOrganization` (`packages/domain/src/organizations/index.ts:130-175`) the org has **zero
stores and zero persons**. The first admin is step 5 and the first store is step 6 of
`bootstrapOrganization` (`:380-393`). A row written there has nothing to point at.

⭐ **The seed goes in `createStore`** (`packages/domain/src/stores/service.ts:86-127`), as step 2c,
on the caller's transaction:
- It is **the only production INSERT into `stores`** (`service.ts:112-115`, T-332's finding). Both
  `bootstrapOrganization` (`:389`) and `/admin/stores` (`apps/erp/src/app/admin/stores/actions.ts:62`)
  already go through it. So one call covers a new org's first store *and* every later store.
- **The precedent is exact:** T-332 put `seedAttendanceConfig` in the same place for the same
  reason, attributing to `actor.personId` (`service.ts:106-117`).
- It is still **the same transaction as T-335's seed** during bootstrap: `createOrganization`
  (positions) and `createStore` (defaults) both run on the one `tx` of `bootstrapOrganization`.
  T-335's positions exist before step 6 runs. So a new org is usable from day one, and a failed
  bootstrap rolls back both.
- **Attribution is honest.** `set_by = actor.personId` is the admin who opened the store, a human
  present at that moment (bible row 120's "decide once, when a human is present"). At bootstrap that
  is the first admin. No synthetic grantor (compare `createFirstAdmin`'s header).
- **Authority is consistent.** `manage_stores` holders (super_admin, admin) ⊆ `grant_capability`
  holders (super_admin, admin) (`docs/decisions/CAPABILITY-MATRIX.md:139-140`). So the seed never
  writes an access decision its actor could not have made by hand. U2 pins this.

## 3. Item 3, resolved from the schema: per STORE, and a later store gets them at birth

Defaults key on `(position_id, store_id, capability)` (`position_capability_defaults_active_unique`,
schema `:66-68`). They are **per store**. Seeding in `createStore` means a store added later gets
the ruled table the moment it is created. No backfill or trigger is needed, and nothing "copies from
store 1". So the proposal's unsettled line (`PROPOSAL…:165-166`) is closed.

⚠️ **OPEN: needs Ian's one-line confirmation before merge (does not block the build).** A store
added later **to production's existing org** also gets the ruled table, which is *fewer* than
`0152`'s all-21. The ruling says "only for organisations created from now on". This is **not** a
trim, because a new store has no rows and no people, so nobody loses access (the concern behind
ruling item 2, `PROPOSAL…:126-128`). The only alternative for production's next branch is **zero**
defaults, which is DEF-413 itself: the register row names "any NEW **branch**". *Recommend: yes,
every new store.* If Ian says no, the build needs an org discriminator that does not exist today.
Stop and re-spec. Do not invent one.

## 4. Item 1: one source of truth, a typed constant in the domain

`CANONICAL_POSITION_DEFAULTS` is exported from `packages/domain/src/people/position-defaults.ts`,
beside `OFFERABLE_TO_POSITIONS`, and re-exported through the `people` barrel (`people/index.ts:32`).
T-290 lost a re-export once, so it is not optional.

```ts
export const CANONICAL_POSITION_DEFAULTS: Readonly<
  Record<(typeof CANONICAL_POSITIONS)[number], readonly Capability[]>
> = { Cashier: [/* 18 */], Cook: ['record_stock_movement', 'record_wastage'], Server: ['record_wastage'],
      Dishwasher: ['record_wastage'], Slicer: ['record_stock_movement', 'record_wastage', 'request_pos_map'],
      'Inventory Staff': [/* 11 */] };
```

- **Why not beside `CANONICAL_POSITIONS`** (`packages/db/schema/employment.ts:56-63`): `packages/db`
  must not know `@shareat/auth`'s members (ADR-004; the schema header's "`capability` carries NO CHECK
  constraint, deliberately"). A `Capability`-typed table there would reverse the dependency.
- **`Record<CanonicalName, …>` is the drift guard.** If a seventh canonical name is added, or one is
  renamed, typecheck fails until this table answers for it.
- **The admin grid cannot drift from it because the grid has no copy.** `gridDataForStore` renders
  the stored rows (`apps/erp/src/app/admin/access-defaults/lib.ts:210-233, 328-345`), and the seed
  wrote those rows from this constant. ⛔ No "recommended" badge and no second list on the screen.
- Cells are copied from `PROPOSAL…:41-79` by capability **name**, in the proposal's column order.

## 5. Item 2: how it is written, and why production cannot be touched

`seedStoreAccessDefaults(tx, actor, storeId)` lives in `position-defaults.ts` and is called **only**
from `createStore` step 2c, after `insertStore` and before the fan-out.
1. **Virgin-store guard.** If `positionDefaultsRepo.anyDefaultAtStore(tx, storeId)` finds **any**
   row for the store, active or revoked, it **throws**. This is what guarantees at the code level that
   no existing store, and so none of production's `0152` rows, can be seeded or re-seeded, even by a
   future caller. It can never fire inside `createStore`, because the store id was minted a moment
   earlier on this `tx`.
2. Read the org's canonical positions with the existing `employmentRepo.listPositions(tx, orgId,
   storeId)`, filtered to `isCanonical && isActive`. Match by exact name against `CANONICAL_POSITIONS`.
3. Build `{positionId, capability}` pairs from the constant. Filter every pair through
   `OFFERABLE_TO_POSITIONS` and **throw** on any miss. The constant must never contain one, and U1
   pins that, but the runtime check is the last line.
4. `positionDefaultsRepo.insertDefaultsForNewStore(tx, {orgId, storeId, setBy, pairs})`: one INSERT
   with `on conflict (position_id, store_id, capability) where revoked_at is null do nothing` (an
   explicit target, T-335 §4's lesson) and `returning id`. Returns `{ inserted }`.
5. **No `reconcilePositionGrants` call.** A store minted on this `tx` has no employments, so there is
   nobody to grant to. Grants arrive at hire through `createEmployment` (`people/index.ts:107`). The
   closed importer list (`tests/unit/position-defaults-callers.test.ts:51`) stays unchanged.
6. **An org with no canonical rows** (a raw fixture, or a pre-T-335 org not yet backfilled) seeds
   **0** and reports `missingCanonical: string[]`. It does not throw. `stores.test.ts:51-68` creates
   stores in such orgs, and T-335's backfill owns the positions.

`CreateStoreResult` gains `accessDefaultsSeeded: number` (38 for a full org: 18+2+2+2+3+11, after the 2026-09-24 amendment).
`BootstrapOrganizationResult` passes it through. `scripts/bootstrap-org.ts` prints one result line.

## 6. Item 5: no migration

The schema is unchanged. The write is a code path on new stores only. No existing row is written, so
there is nothing for a data migration to do (RULES §1 rule 9 governs schema changes; T-335 §6 made
the same call). A SQL seed would also copy the table into plpgsql as a second source of truth. ⚠️ If
anyone overrules this: `0156` is T-276's and unwritten, and a `0157` applied first is skipped by
drizzle (DEF-039's shape). T-276 would have to land first.

## 7. Contract: exact files, and nothing else

| File | Change |
|---|---|
| `packages/domain/src/people/position-defaults.ts` | `CANONICAL_POSITION_DEFAULTS`, `seedStoreAccessDefaults` (§5) |
| `packages/domain/src/people/index.ts` | re-export both |
| `packages/db/src/repo/position-defaults.ts` | `anyDefaultAtStore`, `insertDefaultsForNewStore`. No capability knowledge (file header) |
| `packages/domain/src/stores/service.ts` | step 2c. Import the **leaf** `../people/position-defaults`, never the barrel (cycle, `service.ts:48-50`). Result field |
| `packages/domain/src/organizations/index.ts` | `BootstrapOrganizationResult.accessDefaultsSeeded` passthrough only |
| `scripts/bootstrap-org.ts` | one print line: `access defaults : N across 6 positions` |
| `packages/domain/tests/integration/t335-positions-at-org-creation.test.ts` | ⚠️ **amend T-335's T5**: its "`position_capability_defaults` has 0 rows" becomes "exactly the ruled rows". Its `record_sale`-refused assertion **stays true** (Server holds only `record_wastage`), and its control stays |
| `packages/domain/tests/integration/t336-access-defaults-at-store-creation.test.ts` (new) | I1–I8 |
| `tests/unit/t336-canonical-position-defaults.test.ts` (new) | U1–U3 |
| `apps/erp/tests/integration/t336-access-defaults-grid-seeded.test.ts` (new) | G1. A **new** file, because other sessions are editing `apps/**` |
| `docs/DEFECTS-REGISTER.md` | DEF-413 row → FIXED at done (edit by grep, never read whole) |

⛔ **Do not touch:** `authorize()`, `CAPABILITY_MATRIX`, `CANONICAL_POSITIONS`, `reactivateStore` (a
reactivated store keeps its old rows, and the virgin guard would throw anyway), `setPositionDefault`,
any migration, `apps/erp/src/**`, `scripts/dev-seed.ts`, or the bible (RULES §1 rule 14).

## 8. Invariants and tests: every one has a negative half

Write each test first. Run it against T-335-only code and record that it fails **for the stated
reason** (RULES §2; bible §9 rule 2). Actors hire through `createEmployment` and check through real
`authorize()`. Grants are never inserted by hand.

| # | Invariant | Test (positive / NEGATIVE) | A broken build fails on |
|---|---|---|---|
| U1 | The constant is exactly the ruling, and a subset of the 21 | Assert a **literal** expected table, typed out from `PROPOSAL…:43-48` in the test (an independent oracle; do not import the constant to build the expectation, per `access-defaults-lib.test.ts:21-27`) `toEqual` the constant, with values **sorted** and keys the six. Every value ⊆ `EVERYDAY_CAPABILITIES` (`_fixtures/staff-everyday-access.ts:11`) and ⊆ `OFFERABLE_TO_POSITIONS`. NEGATIVE: ∩ `SUPER_ADMIN_ONLY_CAPABILITIES` = ∅, and `close_period` is absent from all six | a mis-ticked cell; a Cashier given R5/R6/F4 (`0152` copied); `OFFERABLE_TO_POSITIONS` pasted in |
| U2 | Seeding never outruns its actor | every role with `manage_stores` also has `grant_capability` in `CAPABILITY_MATRIX` | a matrix change letting a manager open stores silently lets it write access defaults |
| U3 | `seedStoreAccessDefaults` has **exactly one** non-test caller, `stores/service.ts` | scan the nine source roots as `system-transaction-callers.test.ts` does (DEF-295). ⛔ Assert **≥1 hit**, or a wrong-roots scan passes on zero (the T-334 slice 2b vacuity) | a second caller, e.g. `reactivateStore` or a script over existing stores |
| I1 | A fresh org's store holds exactly the ruled table | `bootstrapOrganization` on an empty DB. Per position name, the **set** of active `capability` at the store `toEqual` the literal oracle (sorted arrays, never counts). `accessDefaultsSeeded === 36`, **and** equal to a `count(*)`. `set_by` = the first admin on every row | today: 0 rows. A build writing all 21 per position passes a "Cashier has ≥18" check and fails set equality on Cook/Server. A hard-coded 36 fails I4's second call |
| I2 | A Cashier can do its 18 and not the rest | hire into Cashier; `authorize` **passes** for each of the 18. NEGATIVE: **refused** for `record_customer_return`, `create_wholesale_order`, `request_pos_map` (what separates the ruling from `0152`) **and** for `void_sales_day`, `void_statutory_discount`, `refund_customer`, `record_ar_collection` (ruling items 3–4; a leak beyond the 21) | a build copying `0152` passes the 18 and fails R5/R6/F4. A build seeding `OFFERABLE_TO_POSITIONS` fails the voids |
| I3 | A blank hire (Server) gets exactly log-wastage | hire with no `positionIds`. That person's active `person_grants` with `grant_source='position'` are set-equal to `['record_wastage']`, and `authorize(record_wastage)` passes. NEGATIVE: `record_sale` and `submit_sales_day` are refused (Ian's T-318 report, `318…:33`) | Server given Cashier's set; the fallback resolving to the wrong position |
| I4 | Virgin-store guard and idempotence | (a) calling `seedStoreAccessDefaults` again on the bootstrapped store **throws**, and the row count is unchanged. (b) the repo insert called twice directly returns `inserted` 36 then 0 | removing the guard makes (a) not throw. Dropping `on conflict` makes (b) raise 23505 |
| I5 | ⛔ **Existing defaults are byte-identical** (ruling item 2) | Fixture org in `0152`'s state: store S1 with all 21 for all six canonical positions (raw SQL, attributed to its admin) plus a holder's `person_grants`. Snapshot both tables sorted (`id, position_id, store_id, capability, set_by, set_at, revoked_at` / `id, person_id, grant_name, grant_source, source_ref, revoked_at`). Then (i) `createOrganization` + first admin + `createStore` for a **second** org, (ii) `createStore` S2 in the **same** org, (iii) `seedStoreAccessDefaults` on S1, which must throw. Re-snapshot: S1's rows and all grants are `toEqual` to before. S2 holds exactly the ruled table | a seed keyed on org rather than store rewrites or duplicates S1. A "top-up" that inserts missing ruled pairs into S1 changes the count. A reconcile on S1 changes `revoked_at` |
| I6 | Tenancy | two orgs through bootstrap-equivalent paths. Every seeded row's `org_id` and `position_id` belong to its own org, 38 each | an unscoped `listPositions` or cross-join gives 72, or puts org B's position ids in org A (`0152` header's bug class) |
| I7 | Atomicity | inject a failure after `createStore` in `bootstrapOrganization` (the `first-run-setup.test.ts` case-2 shape). Defaults count for that org code = 0 | a seed run on its own connection or transaction |
| I8 | A later store gets them, and a positionless org gets none quietly | (a) `createStore` a second store after bootstrap: exactly the ruled table there. (b) raw org with 0 canonical rows: `createStore` succeeds, seeds 0, `missingCanonical` lists all six | (a) a seed only at bootstrap. (b) a throw breaks `stores.test.ts` |
| G1 | **The one UI assertion:** the grid shows the ticks | bootstrap, then `gridDataForStore(admin, storeId)`. For each position, `activeDefaults.get(position.id)` is set-equal to the oracle. NEGATIVE: `activeDefaults.get(serverId)` does **not** contain `record_sale` | today: an empty map, so every cell is unticked |

**Full integration suite before any push** (bible §9 rule 3, DEF-412). The ones most at risk:
`organizations.test.ts`, `first-run-setup.test.ts`, `t332-store-config-seeding.test.ts`,
`stores.test.ts`, `position-defaults.test.ts`, `employment.test.ts`, the amended T-335 file, and any
suite that bootstraps, hires, then asserts a refusal. That last shape is the one a seeded
`record_wastage` or Cashier row can flip. List every file you changed to keep it green, and why.

**§9.4 smoketest:** `docs/SMOKETEST.md` on a scratch DB with zero orgs. `bootstrap-org.ts` prints
`access defaults : 38`. Sign in on 9008 and open `/admin/access-defaults`: Cashier has 18 ticks and
Server has 1. Then open `/admin/stores`, add a store, switch the grid to it, and see the same ticks.
Screenshot both.

## 9. Out of scope

- Trimming production's `0152` rows (ruling item 2). Ian does it from `/admin/access-defaults`.
- Existing stores with zero defaults (a store created between 2026-09-14 and this landing). Report
  it with a read-only `select store_id, count(*) … group by store_id` at cutover. Do not backfill it.
- Any "reset to recommended" control or badge on the grid. POS use of `record_sale`/`create_wholesale_order`.
- Merging colliding store-scoped positions (T-335 §5, OPEN for Ian).

## 10. Done when

U1–U3, I1–I8 and G1 are written, each has been seen failing for its reason, and all pass. T-335's T5
is amended and green. Typecheck is clean. The unit suite passes. The **full** integration suite
passes. `npm run build` succeeds with the dev server stopped. Smoketest screenshots are taken.
DEF-413 is FIXED in the register with commit and test names. §3's OPEN item has Ian's answer. If it
is "yes", the Opus planner adds a bible §13 row ("defaults are seeded per store at `createStore`;
new stores in existing orgs included"), because that is a decision. The builder does not add it.

## 11. Not verified by this planner

- That T-335 lands as specced, positions seeded in `createOrganization` before `createStore`. §2's
  "same transaction" depends on it.
- That the SYSTEM role (bootstrap's `systemTransaction`) may INSERT into
  `position_capability_defaults` under RLS. The app role can, because `setPositionDefault` does. I
  did not read the grants in `packages/db/src/rls/registry.ts`. I1 will show it.
- How many existing tests bootstrap, hire, then assert a refusal. Not censused. The full suite answers it.
- Whether production has stores created after 2026-09-14 with zero defaults (§9's read-only count).

## RULED by Ian 2026-09-24 (see PROPOSAL-DEF-413, "Amendment"): 1 → yes, every new store; 2 → yes, a hire gets `staff` automatically; AND every position gets F1 + F3.
1. **Should every new store get the ruled defaults, including new branches in the existing org?**
   The planner recommends yes; the ruling said "new orgs".
2. **Onboarding is two manual steps** (auditor; DEF-167 is fixed by design): hire → an admin assigns
   a role at `/admin/users/[personId]` → only then do position defaults apply. A new hire is inert
   until step 2 and nothing prompts for it. Should `/staff/hire` assign the `staff` role
   automatically, or at least warn?

**Auto-`staff` delta (builder SPEC, approved 2026-09-24):** `createEmployment`, immediately before
`reconcilePositionGrants`. If `accessRepo.activeRoleForPerson(tx, personId, orgId)` returns nothing,
it calls `accessRepo.insertRole({ role: 'staff', grantedBy: actor.personId })`. A person who already
holds any role is untouched. `staff` grants nothing by itself (its CAPABILITY_MATRIX row is all
false); it only unblocks authorize() axis 1, so position-sourced grants apply.
**Plus store scope (orchestrator, 2026-09-24, from the tester's case c):** the `staff` role alone
still leaves a new hire refused ("no store scope"). This goes against Ian's intent that a hire can
work from day one. So `createEmployment` also grants `person_store_scope` for the hired store,
guarded against duplicates, and only for that store. Least privilege is unchanged: position
defaults still decide what they can do.

**⛔ SCOPE LIFECYCLE: RULED 2026-09-24 (auditor finding 1; Opus judgement; orchestrator).** The
hire-time scope grant was never revoked: a terminated cashier kept sign-in, and grants leaked across
stores. **Fix A, with migration `0156`** (re-allocated from T-276, which moves to `0157`, so no gap
is ever applied out of order): `person_store_scope.source` ∈ {`employment`,`manual`,`fan_out`},
NOT NULL, backfilled as `manual`/`fan_out`. The hire writes `employment`. An admin grant ALWAYS sets
`manual`, including an upsert over an `employment` row. `endEmployment` deletes the row only when
`source='employment'` AND no other open employment exists at that store. Option B (authorize
accepts an open employment) was rejected: scope rows also drive reports, statutory discounts and
store lists, and B would make one layer the only guard (§15.11). Tests 1–7 as listed in the
orchestrator's brief. The remaining person-level-grant leak is **DEF-414**, out of scope.
**0156 backfill (ruled 2026-09-24, auditor research):** every pre-existing row is backfilled as
`manual`. No row existing before T-336 can be hire-sourced, and only `employment` rows are ever
deleted, so a fan_out/manual label on old rows is never load-bearing. A timestamp-window
heuristic was rejected: it risks a wrong label and buys no safety.
**Audit round 2 rulings (2026-09-24):** `source` gets `DEFAULT 'manual'` (147 raw writers). Source
priority is manual > fan_out > employment, so a fan-out upgrades an `employment` row and a
promoted ex-hire keeps admin scope. An admin unticking an employed person's store is ALLOWED: it is
an explicit act, and re-ticking restores the row as `manual`. `seedStoreAccessDefaults`
re-authorizes `manage_stores`. The ERP store-created message surfaces a shortfall in the defaults.
Known residual, accepted: the auto-`staff` role is not revoked at termination. It is not
exploitable (axis 2 refuses without scope), but leavers keep an active role row. Candidate follow-up.

**Open UI item (auditor, 2026-09-24):** unticking the store scope of a person who STILL has an open
employment there silently removes all their store-scoped permissions, while they keep their job and
PIN. `/admin/users` must warn at that point: "This person still works at this store; they will lose
all permissions here." Not built. Candidate follow-up.
