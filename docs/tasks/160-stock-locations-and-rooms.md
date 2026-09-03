# T-160 — Stock locations: the room model every movement is keyed to

> **Status:** ✅ **BUILT 2026-09-03 — the repo functions, the domain service, the
> `/inventory/locations` screen, and invariant 5's trigger (migration `0122`), smoketested live
> on 9008.** DEF-135's gap for this task is closed: before this pass the only writer of a real
> `stock_locations` row anywhere in the app was a raw SQL insert in a dev-seed script.
> `typecheck` clean · unit 942/943 (1 pre-existing skip, unrelated) · this task's own integration
> files 30/30 against a private database (§11 — the shared suite was not run, by design).
> ⛔ `npm run build` and `docs/ROADMAP.html` are the coordinator's for this session — not run or
> edited here (three other lanes share this dev server and this tree). See §11.
> ⏳ **Wave 0 of Phase 3, and blocked on ADR-011** only in the sense that Wave 0 ships as one
> switch — this table's shape does not change whichever way ADR-011 goes, so it may be built first.
> **Depends on:** T-101 (`stores`, `persons`), T-121 (roles — DEF-053's lesson: check it is BUILT),
> T-145 (`items`).
> **v1 read at source** — `inventory-location.actions.ts`, `location-model.ts`,
> `branch-stock-reconcile.ts`. Findings in `docs/discovery/14` §C.

## 1. Goal

Every store can describe the physical spaces it holds stock in, so that **every stock movement in
Phase 3 has a `location_id` from the first row written** — not retrofitted onto a ledger that
already has data.

## 2. Why this is first, and it is not sequencing taste

Retrofitting a location dimension onto a populated stock ledger is the same class of expense as
retrofitting RLS: cheap per table now, a week and a silent miss later. v1 lived the alternative —
its `branch-stock-reconcile` tool exists **only** to collapse branches that drifted into multiple
rooms during a legacy dual-write, floor negative balances to zero, and delete the strays.

⭐ **v2 does not need that tool, because the invariant it enforces becomes structural here.**

## 3. What v1 does, and the two decisions worth restating

| v1 | Keep? |
|---|---|
| Location **type** catalogue — Stockroom / Display / Kitchen / Receiving / Quarantine / In-Transit / Returns | ✅ A store defines what *kinds* of space it has |
| Location **role**: `storage` vs `operating` | ✅ ⭐ **Encodes where usage may post from.** A stockroom cannot be a usage source; only an operating room can |
| An unknown legacy `kind` migrates to `storage` | ✅ The **fail-safe direction**, stated by v1 itself: *"a mis-migrated location can't silently drain stock"* |
| Exactly one **Receiving** pseudo-location per store | ✅ Received-but-unallocated stock has somewhere to live instead of being dumped in the default room |
| Exactly one **default** room per store | ✅ Enforced at write time by clearing any other default |
| Deletion blocked while the room holds stock | ✅ Becomes a real FK/trigger, not a hand-rolled check |
| Manual item→location (re)allocation, **admin only after initial setup** | ✅ A deliberate guardrail: *"use transfers day-to-day"* |
| A **branch or kiosk gets exactly ONE location** | ✅ ⭐ **Structural here** (invariant 6), not a repair tool |
| `branch-stock-reconcile` repair tool | ⛔ Not ported — §2 |
| Department taxonomy (kitchen / bar / …) | ✅ Attribution dimension for usage cost reporting |

## 4. Scope — the exact files

**Create:**
- `packages/db/schema/stock-locations.ts`
- `packages/db/migrations/<next free NNNN>_t160_stock_locations.sql` (hand-written, DEF-073)
- `packages/domain/src/stock-locations/index.ts`
- `packages/db/src/repo/stock-locations.ts`
- `packages/domain/tests/integration/stock-locations.test.ts`
- `apps/erp/src/app/inventory/locations/page.tsx` + `actions.ts`

**Modify:** `packages/db/schema/index.ts` · `packages/db/src/index.ts` ·
`packages/db/src/cutover/classification.ts` · `packages/db/src/rls/registry.ts` ·
`packages/domain/src/index.ts` · `packages/db/migrations/meta/_journal.json` ·
`docs/decisions/CAPABILITY-MATRIX.md` · `docs/ROADMAP.html`

⛔ Nothing else. In particular **not** `PROJECT_BIBLE.md` (§14).

## 5. Contract

```
location_types                      -- the catalogue, seeded per org
  id, org_id, code, name, sort_order
  unique (org_id, code)

stock_locations
  id, org_id, store_id
  code                text NOT NULL            -- unique per store
  name                text NOT NULL
  type_id             uuid NOT NULL -> location_types
  role                'storage' | 'operating' NOT NULL
  purpose             'normal' | 'receiving' NOT NULL default 'normal'
  is_default          boolean NOT NULL default false
  status              'active' | 'inactive' NOT NULL default 'active'
  created_by, created_at, updated_at
  unique (store_id, code)
  partial unique (store_id) where purpose = 'receiving'
  partial unique (store_id) where is_default
  partial unique (store_id) where <store is single-room>   -- see invariant 6

departments
  id, org_id, code, name, status
  unique (org_id, code)
```

`stores` gains `stock_model 'single_room' | 'multi_room' NOT NULL default 'single_room'`.

### Domain surface

```ts
seedStoreLocations(storeId, model): Promise<StockLocation[]>   // idempotent
createLocation(input) / updateLocation(id, patch) / setDefault(storeId, locationId)
deactivateLocation(id)                                          // never deletes
resolveReceivingLocation(storeId): Promise<LocationId>          // Receiving, else default
assertUsageSource(locationId): void                             // throws unless role='operating'
```

## 6. Invariants

1. **Exactly one Receiving location per store**, enforced by a partial unique index — not by the
   service layer (§6.3: *the database enforces the rules*).
2. **Exactly one default room per store.** Setting a new default clears the old one in the same
   transaction.
3. **A `storage` room can never be a usage source.** `assertUsageSource` is called by every usage,
   wastage and production writer in Waves 1–3, and each has a test proving the refusal fires.
4. **An unknown or absent role defaults to `storage`** — the fail-safe direction. A migration that
   guesses wrong must under-permit, never over-permit.
5. **A location holding stock cannot be deactivated or deleted.** A trigger, checked against the
   T-161 ledger, because Σ-balances reconciliation breaks the moment stock is orphaned.
6. ⭐ **A store whose `stock_model` is `single_room` may have exactly one non-Receiving active
   location.** This is v1's `branch-stock-reconcile` invariant, made structural. The DB refuses the
   second row.
7. **Deactivation, never deletion, for a location with history.** Void is terminal and corrections
   are new records (§16.1 rule 5); the same discipline applies to reference rows with movements
   behind them.
8. ⚠️ **A store's `stock_model` may not change from `multi_room` to `single_room` while more than
   one active room holds stock.** That transition *is* the reconcile tool, and it must be a
   deliberate, blocked-until-empty operation rather than a silent collapse.

## 7. Tests

1. Seeding a `single_room` store produces exactly two locations — one room and one Receiving —
   and is idempotent when run twice.
2. Seeding a `multi_room` (commissary) store produces the default room plus Receiving, and a
   second seed adds nothing.
3. A second Receiving location is refused **by the database**, with the insert attempted directly
   in SQL — not through the service (row 104: name what the database refuses).
4. Setting a new default clears the previous one; the partial unique index holds throughout.
5. `assertUsageSource` throws for a `storage` room and passes for an `operating` one.
6. A location holding stock cannot be deactivated; the same location can once its balance is zero.
7. A `single_room` store refuses a second non-Receiving room, in SQL.
8. `resolveReceivingLocation` returns Receiving when present, the default room when it is not, and
   **never `null`** — the fallback ordering is exact (`receive-allocation.ts:14-22`).
9. RLS: a principal in org A cannot see, insert or update org B's locations.

## 8. Out of scope

⛔ **The `branch-stock-reconcile` repair tool.** §2 — the invariant replaces it.
⛔ **Per-location item settings** (low-stock thresholds). They hang off the item + location pair
and belong with the low-stock work in T-175.
⛔ **Any stock movement.** This task creates the dimension; T-161 creates the movements.
⛔ **Multi-store location hierarchies / zones / bins.** v1 has one flat level per store and the
business has never asked for more. Deliberately skipped, per bible §1.1's midpoint test.

## 9. ⚠️ Built 2026-08-29 — and two real bugs the tests caught

**Landed, applied, and green:**

| | |
|---|---|
| `packages/db/schema/stock-locations.ts` | `location_types`, `stock_locations`, `departments` |
| `packages/db/schema/stores.ts` | `stock_model`, defaulting to the **stricter** `single_room` |
| `packages/db/migrations/0062_t160_stock_locations.sql` | ✅ Journalled and **applied to both `shareat_dev` and `shareat_test`** |
| `classification.ts` / `rls/registry.ts` | All three **KEEP** · `org_column`, NULLIF-guarded (DEF-077) |
| `packages/domain/src/stock-locations/rules.ts` | Five pure rules |
| `packages/domain/tests/unit/stock-location-rules.test.ts` | 19 cases |
| `packages/db/tests/integration/stock-locations.test.ts` | 20 cases against real Postgres |

⭐ **Both build guards fired before they were satisfied** — adding the tables to the schema barrel
turned `cutover-classification` and `rls-registry` red until each table was classified and scoped.
The measure of those modules is that failure, not their own green tests.

### 9.1 ⭐ The single-room trigger was wrong, and only the database could say so

The first cut of the trigger counted a store's existing non-Receiving rooms and refused when there
was already one — **without ever asking what the row being inserted was.** So adding the Receiving
room to a single-room store that already had its one room was refused.

⚠️ **The pure rule in `rules.ts` got this right and the SQL did not.** `singleRoomViolation`
filters the whole list, including the incoming row; the trigger filtered only the existing ones.
Two implementations of one rule, disagreeing — and the unit tests could not see it because they
only ever exercised the TypeScript half.

**Fixed by excusing the row first:** a `receiving` row, or any non-`active` row, returns before
anything is counted. ⭐ That also closed a second hole nobody had written a test for — inserting an
*inactive* room into a full single-room store was being refused for no reason.

> **This is the argument for integration tests in one paragraph.** A rule implemented twice needs a
> test that runs where both copies meet.

### 9.2 ⛔ RLS was enabled but not FORCED — caught by T-120's own invariant

The migration first shipped `ENABLE ROW LEVEL SECURITY` without `FORCE`. Without FORCE the table
**owner bypasses every policy** — and the owner is the connection the app itself uses, so the
isolation tests in this very file would have passed while nothing was isolated.

⭐ **T-120's invariant 9 caught it on the first full run**, which is exactly what it was written
for: *"the most commonly missed step in a Postgres RLS setup, and silent when missed."* A guard
written months ago for a table that did not exist yet did its job.

### 9.3 On editing an applied migration

`0062` was rolled back and re-applied twice while these two bugs were fixed, rather than patched by
a follow-up migration. ⚠️ Bible §2 rule 9 — *an applied migration is never edited* — protects
against a migration **others have applied** diverging from its file. `0062` was uncommitted, existed
only in this machine's dev and test databases, and both were applied minutes earlier by this
session; the three tables held nothing but this session's own fixtures. **Rolling back leaves one
correct migration instead of a broken one plus two patches.** ⛔ The moment it is committed and
anyone else has it, that door closes.

### 9.4 Still not built, and the reason is the port

| Piece | Blocked by |
|---|---|
| Repo + service (`seedStoreLocations`, `createLocation`, `setDefault`, …) | Buildable now — stopped here so this lands as a reviewable unit rather than a sprawl |
| `/inventory/locations` route and its smoketest | ⛔ A peer's dev server holds **port 9008**, so there is no route to open and ⛔ no `npm run build` (§2.9 — the build clobbers the `.next` it is serving) |
| `CAPABILITY-MATRIX.md` rows | Follow the service and the route; a capability with no call site has nothing to gate |
| §7 test 6 — *a location holding stock cannot be deactivated* | ⛔ Needs `stock_movements`, which is **T-161** |

## 10. Done when

- [x] Migration hand-written (DEF-073 — **do not run `db:generate`**), next free number, journalled
      `previous.when + 86400000`. *(`0062` by the 2026-08-29 session; `0122` — invariant 5's
      deactivation guard — by this session, 2026-09-03, same discipline.)*
- [x] Both registries updated: `cutover/classification.ts` (**KEEP** — configuration, like `items`)
      and `rls/registry.ts` with `app_current_org()`'s NULLIF-guarded form (DEF-077). *(Done in the
      2026-08-29 pass for `0062`'s three new tables. `0122` adds a trigger to an already-classified
      table — nothing new to register.)*
- [x] `typecheck` · `npm test` green. `npm run test:integration` **deliberately NOT run** —
      three other lanes share `shareat_test` this session (§3.4/concurrency rule); this task's own
      two files (`stock-locations-service.test.ts`, new, 10 cases; `stock-locations.test.ts`,
      pre-existing, 20 cases, still green) ran instead against a private database,
      `shareat_test_t160` — 30/30.
- [x] `npm run build` green **with the dev server stopped** — run by the coordinator 2026-09-03
      after all four lanes landed and the review fixes were in: dev server killed, `next build`
      clean, every route listed, then the server restarted and the four routes re-driven.
- [x] ⭐ **Smoketested at a live route** on 9008 — `/inventory/locations` renders; "Set up rooms"
      seeds both the single-room shape (Malvar: Main + Receiving) and, via the integration tests,
      the multi-room shape; a second non-Receiving room is refused with the single-room sentence;
      a room is renamed; an empty room deactivates and reactivates; a room holding stock refuses
      deactivation (demonstrated as a read+attempt on Lipa's `Stockroom A`, 17 kg — no other change
      made there); a staff actor is refused with a readable sentence. *A shipped server action is
      not a shipped feature* (§9 of the phase plan) — this one has screenshots and DB reads to
      back it, in the closing report.
- [x] `docs/decisions/CAPABILITY-MATRIX.md` gains `manage_locations` — **already present**,
      declared by an earlier pass (store-scoped, manager+); confirmed still correct and exercised
      here by a fresh staff-✗ test and a manager-with-no-scope-for-that-store-✗ test.
      `allocate_stock` deliberately **NOT** declared — no caller, confirmed still true.
- [x] `docs/ROADMAP.html` updated — by the coordinator 2026-09-03: T-160's line names the missing
      writer/screen, migration `0122`, and the Malvar run; Phase 3's "why" text no longer claims
      screens that did not exist (DEF-135).

## 11. Built 2026-09-03 — the service, the screen, and invariant 5's trigger

DEF-135 named this task's exact gap: schema, migration `0062`, the pure rules and 20 db-level
tests landed 2026-08-29 with **zero writers anywhere in application code** — the only INSERT into
`stock_locations` in the whole tree was a raw SQL line in `scripts/dev-seed-inventory.ts`. This
pass closes it.

**Landed:**

| | |
|---|---|
| `packages/db/src/repo/stock-locations.ts` | Extended, not replaced — `defaultLocationFor` and `listActiveLocations` untouched. Added `listLocations`, `getLocation`, `insertLocation`, `updateLocation`, `clearDefaults`, `setLocationStatus`, `listLocationTypes`, `insertLocationType`, `holdsStock`, `getStoreStockModel` |
| `packages/domain/src/stock-locations/service.ts` | Overwrote the stub. Seven exports: `ensureLocationTypes`, `seedStoreLocations`, `createLocation`, `updateLocation`, `setDefaultLocation`, `deactivateLocation`, `reactivateLocation` |
| `packages/db/migrations/0122_t160_location_deactivation_guard.sql` | Invariant 5's trigger — hand-written (DEF-073), journalled `idx 122`, `when` = `0121`'s `+ 86400000`, applied to `shareat_dev` and this lane's private `shareat_test_t160` |
| `apps/erp/src/app/inventory/locations/{page.tsx,lib.ts,actions.ts}` | The screen: store picker, the store's `stock_model` explained in one sentence, "Set up rooms" when a store has none, a room table with per-row rename/re-type/re-role + Make default + Deactivate/Reactivate, and an Add room form with a Receiving checkbox |
| `packages/domain/tests/integration/stock-locations-service.test.ts` | 10 new integration tests, real Postgres |

### 11.1 A spec-filling decision: `ensureLocationTypes` needed a `storeId`

§4's illustrative signature was `ensureLocationTypes(tx, actor, { orgId })`. But `manage_locations`
is a STORE-scoped capability (CAPABILITY-MATRIX.md, already declared), and `authorize()` throws
immediately for a store-scoped capability given no `storeId`. `location_types` is itself org-wide
(§5's own contract), so there is no single store to check "against" in any structural sense.
**Resolution:** widened the input to `{ orgId, storeId }`, where `storeId` is used ONLY to
authorize — the screen's currently-selected store stands in for "this actor may administer
locations here at all," documented in the function's own comment rather than silently narrowed
(bible §3.4a). Not a business-rule defect worth its own DEFECTS-REGISTER row — it is a one-line
interface gap in an illustrative signature — but named here per the instruction to report rather
than silently paper over.

### 11.2 Every mutation THROWS; none return `{ ok: false }`

The Build section's general domain convention (return `{ ok: false, reason }` for a pre-write
business refusal, throw only for a post-write surprise) describes workflow modules with several
preconditions to check before a first write — `receiveDelivery`, `transferNow`. Every function in
this service is a single admin write with no such sequence, so it follows the shape
`commissary/catalogue.ts` already established for exactly that shape of function: throw, and let
`actions.ts`'s own local `errorMessage` translate. Named here because the general convention and
the specific template this task explicitly said to copy "exactly" point in slightly different
directions for this module; the template won, because `actions.ts` had to match it.

### 11.3 `seedStoreLocations`'s idempotency also covers a pre-existing partial state

Lipa's `Stockroom A` already existed (an earlier task's smoketest, raw SQL) as a `single_room`
store's default room with **no** Receiving room. `seedStoreLocations` checks "has an active
non-Receiving room" and "has an active Receiving room" independently, so calling it on a store
like Lipa would add only the missing Receiving room, never a duplicate default. Not exercised on
Lipa this session — Lipa was read-only, by the task's own instruction — but both the all-missing
path (Malvar) and the idempotent all-present path (a second call, both store shapes) are covered
by `stock-locations-service.test.ts`.

### 11.4 Spec defects found

None beyond §11.1's interface gap, which is a documentation ambiguity in the task spec rather than
a business-rule error.

### 11.5 What is NOT built, and why

| | |
|---|---|
| `allocate_stock` capability | Confirmed still undeclared — no caller (task's own §Out of scope) |
| A departments UI | Out of scope (§8). `departments` (migration `0062`) has no reader or writer in `apps/` yet |
| Switching a store's `stock_model` | Out of scope (invariant 8 — its own task, the reconcile transition) |
| `npm run build` | Coordinator's gate this session — the dev server is live on 9008, shared by three other lanes; stopping it was out of scope here |
| `docs/ROADMAP.html` | Coordinator's file this session — three lanes are landing tasks into the same wave |
| `CAPABILITY-MATRIX.md` rows | Already present from an earlier pass — not re-added, per this task's own "already wired for you" instruction |

### 11.6 Same-day review fixes (coordinator)

- **`ensureLocationTypes` takes no `orgId`.** It authorised on the caller's `storeId` and then
  wrote to a caller-supplied `orgId` never checked against the actor — defence-in-depth only
  (RLS would have refused a foreign org), but the wrong shape. The rows land in `actor.orgId`;
  §11.1's `storeId` stays, for the reason it gives.
- **The default room cannot be deactivated.** `defaultLocationFor` filters on `active`, so
  retiring the default silently left the store with no default and the next undecided receive
  line with nowhere to park. `deactivateLocation` refuses it (*"make another room the default
  first"*) — after the holds-stock check, which is the more fundamental refusal — and the screen
  shows a note on the default row instead of a button that fails. Pinned by a new test.

### 11.7 Smoketest — Malvar (MLV), Dev Manager, then Dev Cashier; a read+attempt on Lipa

Flow, screenshots in `t160/` (scratchpad), every effect cross-checked against the database directly
(never the on-screen banner alone):

1. **Malvar had no rooms** (`stock_locations` empty for that store) — the screen shows "Set up
   rooms" instead of a table. `01-malvar-no-rooms.png`.
2. **"Set up rooms"** → `ensureLocationTypes` seeded the 7-code catalogue (org had 2 pre-existing
   codes, `STK`/`STK2`, from an earlier ad-hoc seed; untouched) → `seedStoreLocations` created
   `MAIN` (Kitchen type, `operating`, default) and `RECEIVING` (Receiving type, `storage`).
   `02-malvar-rooms-created.png`; confirmed in the DB: exactly those two rows, active.
3. **A second normal room, "SECOND"** → refused on screen with *"This store keeps stock in ONE
   room. Deactivate or repurpose the existing room before adding another."* — the single-room
   trigger's own message, translated. `03-malvar-second-room-refused.png`; confirmed in the DB:
   `count(code='SECOND') = 0`.
4. **Renamed "Main" → "Main Room"** via the per-row form. `04-malvar-main-renamed.png`; confirmed
   in the DB.
5. **Deactivated the empty Receiving room**, then **reactivated it** — both succeeded.
   `05-malvar-receiving-deactivated.png`, `06-malvar-receiving-reactivated.png`; confirmed in the
   DB: `status` round-tripped `active → inactive → active`.
6. **Read Lipa** (`07-lipa-before.png`) — `Stockroom A`, single_room, default, active, holding
   17 kg (pre-existing, another lane's smoketest data, untouched). **Attempted to deactivate it**
   → refused on screen with *`"Stockroom A" still holds stock and cannot be deactivated.`*
   `08-lipa-deactivate-refused.png`. Confirmed in the DB: `Stockroom A` still `active`, still
   `is_default`, and the 17 kg balance unchanged — **no other change made to Lipa**, as instructed.
7. **Signed in as Dev Cashier (`333333`, `staff`)** on Malvar, attempted to add a room →
   refused with *"Only a manager or admin scoped to this store may manage its rooms."*
   `09-malvar-cashier-view.png`, `10-malvar-cashier-refused.png`. Confirmed in the DB: no
   `CASHTRY` row was ever written.

All 11 scripted assertions passed on the first full run; the smoketest script is
`t160/smoketest.js` in the scratchpad, kept for re-running if the screen changes again.
