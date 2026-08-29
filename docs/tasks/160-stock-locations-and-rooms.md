# T-160 — Stock locations: the room model every movement is keyed to

> **Status:** ⚠️ **PARTLY BUILT 2026-08-29 — schema, pure rules and both registries. §10.**
> Migration written but **NOT journalled**; repo, service, UI and integration tests not built.
> `typecheck` clean, `npm test` **656 passed (41 files)**. ⛔ Blocked, not deferred by choice: a
> peer session held `_journal.json`, the shared test database and port 9008. §9 names each.
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

## 9. ⚠️ Built 2026-08-29 — what landed, what did not, and why

**Landed and green:**

| | |
|---|---|
| `packages/db/schema/stock-locations.ts` | `location_types`, `stock_locations`, `departments` |
| `packages/db/src/cutover/classification.ts` | All three **KEEP** — ⭐ the rooms survive a purge; the stock in them does not, because stock lives in `stock_movements` (T-161), which purges independently. Purging the rooms would delete the default-room and Receiving configuration a store needs before it can receive anything |
| `packages/db/src/rls/registry.ts` | All three `org_column`, NULLIF-guarded (DEF-077) |
| `packages/domain/src/stock-locations/rules.ts` | `resolveReceivingLocation`, `assertUsageSource`, `normaliseRole`, `defaultsToClear`, `singleRoomViolation` — pure |
| `packages/domain/tests/unit/stock-location-rules.test.ts` | 19 cases, written first and confirmed failing for the right reason |
| The migration | Written, reviewed, complete — and **parked in §9.1 below rather than committed as a file**. ⛔ See why |

⭐ **Both build guards fired before they were satisfied**, which is the point of them: adding the
tables to the schema barrel turned `cutover-classification.test.ts` and `rls-registry.test.ts` red
until each table was classified and scoped. Recorded because *the measure of those modules is the
build failure, not their own green tests* — and this is that failure working.

**Not landed, and each for a named reason — not a judgement call:**

| Piece | Blocked by |
|---|---|
| The migration, as a file | ⛔ `packages/db/tests/migration-journal.test.ts` requires **every `.sql` to have a journal entry and vice versa** — so an unjournalled migration file is not a valid state in this repo, it is a red build. And `migrations/meta/_journal.json` was **uncommitted and modified** by a peer building T-153: editing it would have swept their in-flight entry 61 into this commit, the exact mistake that put decision row 164 on the wrong branch earlier the same day. ⭐ Leaving the `.sql` untracked instead would have been worse — the next peer to `git add -A` commits a migration with no journal entry and breaks their own build. **So the SQL lives in §9.1, where it is committed, reviewable, and inert** |
| `stores.stock_model` in the drizzle schema | ⛔ A column on an **existing** table. Declaring it before the migration runs makes every `SELECT` against `stores` name a column the database lacks — which breaks the **other sessions sharing this checkout**, not just this branch. It is in the migration; it enters the schema when the migration applies |
| Repo, service, UI route | ⛔ Need the tables to exist |
| Integration tests | ⛔ Shared `shareat_test`; a peer had integration tests in flight (§3.4 — two runs truncate each other) |
| Smoketest on 9008 | ⛔ A peer's dev server held the port, so ⛔ `npm run build` too (§2.9) |

⭐ **The three new tables are additive and therefore safe to land alone**: nothing existing queries
them, the purge script only touches `purge`-class tables, and the test harness truncates by
explicit list rather than by enumerating the schema. That was checked before adding them, not
assumed.

### 9.1 The migration, parked

⭐ **Recreate it as `packages/db/migrations/00NN_t160_stock_locations.sql` when `_journal.json` is
free**, append the matching journal entry — `{ "idx": NN, "version": "7", "when": <previous
entry's `when` + 86400000>, "tag": "00NN_t160_stock_locations", "breakpoints": true }` — and
re-add a `--> statement-breakpoint` marker after each statement, matching 0059–0061.

⚠️ Then add `stores.stock_model` to `packages/db/schema/stores.ts` **in the same change**, never
before: it is a column on an existing table, and declaring it early makes every `SELECT` against
`stores` name a column the database does not have.

```sql
-- 0062 — T-160: the room model every stock movement is keyed to.
--
-- HAND-WRITTEN, like 0020-0061. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔⛔ NOT YET JOURNALLED, AND THEREFORE NOT YET APPLIED. READ THIS BEFORE RUNNING ANYTHING. ⛔⛔
--
-- `migrations/meta/_journal.json` was held UNCOMMITTED by a peer session building T-153 when this
-- file landed, and editing it would have swept their in-flight entry into this commit — the exact
-- mistake that put decision row 164 on the wrong branch earlier the same day. So this file exists,
-- reviewed and complete, with no journal entry.
--
-- ⭐ TO FINISH IT, once 0061 is committed: append ONE entry to `_journal.json` —
--     { "idx": 62, "version": "7", "when": <0061's `when` + 86400000>,
--       "tag": "0062_t160_stock_locations", "breakpoints": true }
--   then `npm run db:migrate`, then run the T-160 integration tests.
--
-- ⚠️ If a peer has already taken 0062, renumber the file and the tag together. Nothing else in the
-- repo references this number.
--
-- ⚠️ ALSO DEFERRED WITH IT: `stores.stock_model`, at the bottom of this file. It is a column on an
-- EXISTING table, so declaring it in the drizzle schema before this migration runs would make
-- every `SELECT` against `stores` name a column the database does not have — breaking the other
-- sessions sharing this checkout, not merely this branch. The schema file says so too.

-- ---------------------------------------------------------------------------------------------
-- 1. What KINDS of space a store can have.
--
-- Per org, not global: a commissary and a kiosk describe themselves differently, and neither
-- should have to invent private vocabulary inside a shared list.
CREATE TABLE "location_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_types_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "location_types_name_not_blank_check" CHECK (length(trim("name")) > 0)
);

ALTER TABLE "location_types" ADD CONSTRAINT "location_types_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "location_types_org_code_key" ON "location_types" ("org_id", "code");

-- ---------------------------------------------------------------------------------------------
-- 2. The rooms themselves.
--
-- ⭐ `role` is a CONTROL, not a label: a storage room may hold and receive stock but nothing may be
-- CONSUMED from it. Only an `operating` room (kitchen, display) can be a usage source. Defaulting
-- to 'storage' is the FAIL-SAFE direction — v1's own words, worth keeping because the safe way
-- round is not obvious until you have picked the wrong one: "a mis-migrated location can't
-- silently drain stock."
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"role" text DEFAULT 'storage' NOT NULL,
	"purpose" text DEFAULT 'normal' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "stock_locations_role_check" CHECK ("role" IN ('storage', 'operating')),
	CONSTRAINT "stock_locations_purpose_check" CHECK ("purpose" IN ('normal', 'receiving')),
	CONSTRAINT "stock_locations_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "stock_locations_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "stock_locations_name_not_blank_check" CHECK (length(trim("name")) > 0),
	-- The Receiving room is a parking spot, never a kitchen.
	CONSTRAINT "stock_locations_receiving_is_storage_check"
		CHECK ("purpose" <> 'receiving' OR "role" = 'storage')
);

ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_type_id_location_types_id_fk"
	FOREIGN KEY ("type_id") REFERENCES "location_types"("id") ON DELETE RESTRICT;
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "stock_locations_store_code_key" ON "stock_locations" ("store_id", "code");
CREATE INDEX "stock_locations_store_status_idx" ON "stock_locations" ("store_id", "status");
CREATE INDEX "stock_locations_org_idx" ON "stock_locations" ("org_id");

-- ⭐ INVARIANTS 1 AND 2, AS THE DATABASE REFUSES THEM — not as something the service remembers.
-- Bible row 104: name the statement the database rejects, never the call our code declines to
-- make. Partial, so an inactive room neither holds the slot nor blocks a new one.
CREATE UNIQUE INDEX "stock_locations_one_receiving_per_store"
	ON "stock_locations" ("store_id") WHERE "purpose" = 'receiving' AND "status" = 'active';

CREATE UNIQUE INDEX "stock_locations_one_default_per_store"
	ON "stock_locations" ("store_id") WHERE "is_default" AND "status" = 'active';

-- ---------------------------------------------------------------------------------------------
-- 3. Departments — what usage is attributed to.
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "departments_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "departments_name_not_blank_check" CHECK (length(trim("name")) > 0)
);

ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "departments_org_code_key" ON "departments" ("org_id", "code");

-- ---------------------------------------------------------------------------------------------
-- 4. How a store organises stock — INVARIANT 6, made structural.
--
-- ⭐ v1 ships `branch-stock-reconcile.actions.ts` purely to REPAIR branches that drifted into
-- several rooms: floor the negative balances, move everything into a canonical room, delete the
-- strays. This constraint is that tool's reason for existing, removed.
ALTER TABLE "stores" ADD COLUMN "stock_model" text DEFAULT 'single_room' NOT NULL;
ALTER TABLE "stores" ADD CONSTRAINT "stores_stock_model_check"
	CHECK ("stock_model" IN ('single_room', 'multi_room'));

-- One non-Receiving active room per single_room store. ⚠️ Expressed as a partial unique index on
-- (store_id) over the rows that count, which needs the store's model on the row — so it is
-- enforced by trigger instead, because a unique index cannot reach into `stores`.
CREATE OR REPLACE FUNCTION "stock_locations_single_room_guard"() RETURNS trigger AS $$
DECLARE
	model text;
	room_count integer;
BEGIN
	SELECT "stock_model" INTO model FROM "stores" WHERE "id" = NEW."store_id";
	IF model <> 'single_room' THEN RETURN NEW; END IF;

	SELECT count(*) INTO room_count FROM "stock_locations"
		WHERE "store_id" = NEW."store_id" AND "purpose" <> 'receiving' AND "status" = 'active'
		  AND "id" <> NEW."id";

	IF room_count >= 1 THEN
		RAISE EXCEPTION 'store % is single_room and already has an active non-Receiving room',
			NEW."store_id";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_locations_single_room_guard_trg"
	BEFORE INSERT OR UPDATE ON "stock_locations"
	FOR EACH ROW EXECUTE FUNCTION "stock_locations_single_room_guard"();

-- ---------------------------------------------------------------------------------------------
-- 5. RLS — added AS THE TABLE IS CREATED, never retrofitted (bible row 112).
--
-- ⚠️ `app_current_org()`'s NULLIF-guarded form, not a raw `current_setting` cast — DEF-077: a
-- pooled connection leaves `app.org_id` as '' rather than NULL, and the raw cast then 500s.
ALTER TABLE "location_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "location_types_org_isolation" ON "location_types"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
CREATE POLICY "stock_locations_org_isolation" ON "stock_locations"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
CREATE POLICY "departments_org_isolation" ON "departments"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
```

## 10. Done when

- [ ] Migration hand-written (DEF-073 — **do not run `db:generate`**), next free number, journalled
      `previous.when + 86400000`.
- [ ] Both registries updated: `cutover/classification.ts` (**KEEP** — configuration, like `items`)
      and `rls/registry.ts` with `app_current_org()`'s NULLIF-guarded form (DEF-077).
- [ ] `typecheck` · `npm test` · `npm run test:integration` green. ⚠️ Check `ListAgents` first —
      the integration suite truncates a shared database (§3.4).
- [ ] `npm run build` green **with the dev server stopped**.
- [ ] ⭐ **Smoketested at a live route** on 9008 — `/inventory/locations` renders, creates a room,
      and refuses a second Receiving with a readable error. *A shipped server action is not a
      shipped feature* (§9 of the phase plan).
- [ ] `docs/decisions/CAPABILITY-MATRIX.md` gains `manage_locations` and `allocate_stock`
      (admin-only), each with a test proving the ✗ fires.
- [ ] `docs/ROADMAP.html` updated — standing rule, Ian 2026-08-28.
