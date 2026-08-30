# T-177 — POS item mapping and the daily usage pull

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-161, T-162, T-164, T-168, T-176 (recipes), T-169 (the freeze it must respect),
> T-123 (sales day — the pull is scoped to one).
> **v1 read at source** — `pos-item-map.actions.ts` (981 lines), `pos-usage-pull.actions.ts`
> (690 lines). `docs/discovery/14` §L. Cross-app seams: `docs/CROSS-APP-MAP.md`.

## 1. Goal

A day's POS sales turn into inventory consumption, so on-hand stays honest against what was actually
sold — instead of drifting until the next physical count explains it as shrinkage.

## 2. Why this is not optional, stated with the consequence

`CAPABILITY-GAPS.md`: *"Without it every sale fails to decrement stock unless someone hand-enters
usage daily. **Inventory numbers drift from day one of cutover.**"*

⚠️ **And under the perpetual shape the drift is no longer only a quantity problem.** Stock that is
never consumed is stock whose cost never reaches COGS — so gross margin looks *better* every day it
is missing, and the correction arrives as a lump at the next count. **The gate (`Σ` inventory
accounts = `Σ` layer value) stays green the whole time**, because both sides are equally wrong.
This is the one Phase 3 failure the exit gate cannot catch.

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| A POS item maps to **(a)** one stock item, **(b)** a production recipe whose ingredients it explodes, or **(c)** an explicit *"sells, consumes no ERP stock"* decision | ✅ ⭐ The third option is the important one: a decision, recorded, not an absence |
| ⭐ **Physical, not billable, quantity** — sold **+ comped**, minus voided | ✅ *"A comped drink still left the fridge, and deducting only what was charged for would surface every giveaway as unexplained shrinkage at the next stock count"* |
| **Plan → draft → finalize, section-scoped** (direct / recipe / orphan) | ✅ A partial finalize does not need the whole day resolved at once |
| ⭐ **Confirm-what-you-saw write contract** | ✅ The server **rebuilds** the plan and refuses to write anything the client did not confirm (a subset-of-confirmed-keys check), and separately refuses a POS snapshot older than an hour. **Prevents both a stale UI writing wrong numbers and a hostile client inflating quantities** |
| **"This item can't be mapped" request → manager decision** | ✅ Whoever hits it mid-pull flags it; a manager approves (silences it) or rejects (returns it to unmapped). The request never moves stock |
| **Shared-product override with confirmation** | ✅ Sharing one stock item across POS items is legal (*"chopsticks belong to three different boxes"*) but a **direct** map still needs explicit confirmation, *"where sharing is usually a mis-click rather than intent"* |
| **Count-freeze respected during the pull** | ✅ Same refusal as a manual usage post |
| ⛔ **Meat excluded from mapping** | **NOT inherited** — §4 |

## 4. ⭐ The exclusion v2 does not inherit

v1 **blocks** mapping any meat product to a POS item, because `meatUsageRecords` carries no
`locationId`: posting one would move the store balance while leaving the per-location balance
untouched. v1 caught this at map-save time rather than discovering it later, which was the right
call **given its data model**.

> **v2 has no such gap.** T-145 made `items` one table with `kind`, and T-161 gives every movement a
> `location_id`. **Meat maps like anything else, and the carve-out is deleted.**

⭐ *"A real architectural gap caught and blocked at the earliest possible point; ERPv2 should decide
up front whether meat gets per-location tracking, closing this gap rather than inheriting the
exclusion."* — `docs/discovery/14` §L. **It did, in T-160/T-161. This is that decision arriving.**

## 5. Scope

**Create:** `packages/db/schema/pos-mapping.ts` ·
`packages/db/migrations/<next>_t177_pos_mapping.sql` ·
`packages/domain/src/pos/item-map.ts` · `packages/domain/src/pos/usage-pull.ts` ·
`packages/domain/src/pos/plan.ts` (pure — the explosion and the diff) ·
`packages/db/src/repo/pos-mapping.ts` ·
`apps/erp/src/app/inventory/pos-usage/page.tsx` + `actions.ts` ·
`apps/erp/src/app/inventory/pos-map/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/pos-usage-pull.test.ts` ·
`packages/domain/tests/unit/pos-plan.test.ts`

**Modify:** barrels · `classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`repo/findings.ts` · `docs/CROSS-APP-MAP.md` · `_journal.json` · `docs/ROADMAP.html`

## 6. Contract

```
pos_item_maps
  id, org_id, store_id
  pos_item_key  text NOT NULL              -- POS's own identifier, verbatim
  pos_item_name text NOT NULL              -- as POS calls it, for the picker
  mode          'direct' | 'recipe' | 'no_stock' NOT NULL
  item_id       uuid NULL -> items         -- required for 'direct'
  recipe_id     uuid NULL -> production_recipes  -- required for 'recipe'
  quantity_per_sale numeric(14,6) NULL     -- required for 'direct'
  status        'active' | 'inactive' NOT NULL default 'active'
  created_by, created_at, updated_at
  unique (store_id, pos_item_key) where status = 'active'
  check ((mode='direct'  and item_id   is not null and quantity_per_sale is not null)
      or (mode='recipe'  and recipe_id is not null)
      or (mode='no_stock' and item_id is null and recipe_id is null))

pos_map_requests                            -- "this can't be mapped" -> manager decision
  id, org_id, store_id, pos_item_key, pos_item_name, note
  status 'requested' | 'approved' | 'rejected' NOT NULL default 'requested'
  requested_by, requested_at, decided_by, decided_at, decision_note

pos_usage_pulls
  id, org_id, store_id, sales_day_id -> sales_days
  snapshot_taken_at timestamptz NOT NULL    -- invariant 4's staleness clock
  status 'planned' | 'finalized' | 'void' NOT NULL default 'planned'
  finalized_at, finalized_by
pos_usage_pull_lines
  id, pull_id (cascade), section 'direct' | 'recipe' | 'orphan' NOT NULL
  pos_item_key, item_id, quantity, usage_record_id uuid NULL -> stock_usage_records
```

```ts
buildPlan(storeId, salesDayId): Promise<Plan>     // pure explosion over a POS snapshot
finalizeSections(pullId, sections, confirmedKeys): Promise<FinalizeResult>
upsertMap / requestMap / decideMapRequest
```

## 7. Invariants

1. ⭐ **Quantity is PHYSICAL: sold + comped − voided.** Never the billable quantity. §3.
2. ⭐ **The server rebuilds the plan and writes only keys the client confirmed.** A confirmed key
   the rebuild no longer produces → `PLAN_CHANGED`, refused. A key the client did not confirm is
   never written, even if the rebuild produces it.
3. **A POS snapshot older than one hour is refused** — `SNAPSHOT_STALE`. ⚠️ The constant is named
   with its reason, not inlined.
4. **Finalizing is section-scoped and idempotent per (pull, section).** A second finalize of the
   same section is refused, not re-posted.
5. **Finalize writes T-168 usage records and posts through T-164.** ⛔ It does not write movements or
   journal entries itself — one implementation of the consumption rules.
6. **A `no_stock` mapping consumes nothing and is not an orphan.** ⭐ It is a recorded decision, and
   the orphan section must not re-surface it every day.
7. **An unmapped POS item lands in the `orphan` section**, blocks nothing, and may be requested by
   **anyone who can record usage** — not gated to managers. ⭐ *The person who hits it is the person
   who knows.*
8. **A `direct` map to an item already directly mapped elsewhere requires explicit confirmation.**
   Recipe maps do not — sharing is normal there.
9. **A frozen location refuses its lines**, and the rest of the pull still finalizes.
10. **Period lock applies**, keyed to the sales day's date.
11. **Meat maps like anything else** — §4. ⛔ No `kind` carve-out anywhere in this module.
12. **A pull is scoped to one store and one sales day**, and a second pull for the same pair is
    refused while one is `planned`.

## 8. Tests

1. ⭐ **Physical quantity:** 10 sold, 2 comped, 1 voided → **11** consumed, not 10 and not 12.
2. A `recipe` map explodes to its ingredient lines, each converted through T-176's unit rules; an
   unconvertible unit blocks that line and not the pull.
3. A `no_stock` map consumes nothing and does **not** appear in the orphan section.
4. An unmapped item appears as an orphan; requesting it writes a request and **moves no stock**;
   approving silences it; rejecting returns it to unmapped.
5. ⭐ `PLAN_CHANGED`: mutate the underlying POS data between plan and finalize; the finalize is
   refused and **nothing is written**.
6. ⭐ A confirmed-keys list containing a key the rebuild does not produce is refused. A rebuild key
   absent from the confirmed list is **not written**. *Two directions, two assertions — a naive
   implementation passes one.*
7. `SNAPSHOT_STALE`: a 61-minute-old snapshot is refused.
8. Finalizing the `direct` section leaves `recipe` and `orphan` open; a second finalize of `direct`
   is refused.
9. Finalizing posts `Dr 5110 / Cr 1310` at FIFO cost through T-164 — cost asserted.
10. A line targeting a frozen location is refused and the other lines still finalize.
11. ⭐ **A meat item maps and pulls normally** — the test that proves §4's carve-out is gone.
12. A second `direct` map onto an already-directly-mapped item without confirmation is refused;
    with it, accepted.
13. Live route on 9008: plan a day, finalize one section, and see on-hand and COGS move.

## 9. Out of scope

⛔ **Writing to POS.** ADR-003's one-backend-four-frontends direction still has POS as its own live
system in Q1. This reads a snapshot; it never writes back. ⚠️ `docs/CROSS-APP-MAP.md` gets a row.
⛔ **Real-time per-sale decrement.** A daily pull is what the business does and it is what v1 does.
Per-sale decrement is a different architecture and nobody has asked for it.
⛔ **Menu management.** T-149: *"POS owns the menu; this is the ERP's statement of intent."*
⛔ **Recipe authoring.** T-176.
⛔ **Reconciling POS revenue.** T-123 owns the sales day; this task owns only the stock side.

## 10. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts`: maps **KEEP** (configuration — nobody wants to re-map a menu on
      1 January), pulls and requests **PURGE**. `rls/registry.ts` NULLIF-guarded.
- [ ] `docs/CROSS-APP-MAP.md` gains the POS → ERP snapshot seam, including where the snapshot comes
      from and who owns its freshness.
- [ ] `posUsagePullNotRun` registered in `repo/findings.ts` — ⭐ **the detector that catches §2**,
      because the exit gate cannot: a verified sales day with no finalized pull.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `manage_pos_map`, `request_pos_map` (any usage-recorder),
      `decide_pos_map_request` (manager), `finalize_pos_usage_pull` (manager) — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
