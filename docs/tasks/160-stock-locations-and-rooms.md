# T-160 — Stock locations: the room model every movement is keyed to

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
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

## 9. Done when

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
