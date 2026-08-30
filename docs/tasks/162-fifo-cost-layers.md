# T-162 — FIFO cost layers: what the stock on the shelf actually cost

> **Status:** ⚠️ **BUILT AND APPLIED 2026-08-29 — storage and rules.** `stock_layers` +
> `stock_layer_consumptions`, migration `0064` (applied to dev and test), the repo, both
> registries, `planConsumption`/`planReversal`, **21 unit + 14 integration tests**.
> `typecheck` clean · **656 unit** · **1268 integration, 43 files**.
> ⛔ `consume.ts` — the transactional wrapper — is NOT built; §10.4.
> **Depends on:** T-161 (movements), T-145 (`supplier_invoice_lines`), T-151 (landed cost).
> **Decided, not open:** FIFO is bible row 110. **ADR-009 §1** established that *a delivery already
> IS a cost layer* — quantity, unit cost, one receipt. This task builds the storage and the
> consumption rule; it does not re-open the method.
> **Research not repeated:** `docs/discovery/20` §1 (Odoo's `stock.valuation.layer` read at source),
> and its verdict — **adopt the layer concept, skip the reposting engine**.

## 1. Goal

Every unit of stock on hand can name what it cost and which receipt it came from, and every unit
consumed relieves the **oldest** remaining layer first — so COGS is what was actually paid for the
goods that actually left.

## 2. The shape, and what is deliberately not in it

| | |
|---|---|
| **Adopted** | Odoo's layer concept: `quantity`, `unit_cost`, `remaining_quantity`, `remaining_value` per receipt |
| ⛔ **Skipped** | Odoo's full apparatus — cross-location reposting, negative-layer FIFO vacuum correction, backdated re-costing across warehouses. Discovery 20: *"even ERPNext does not attempt synchronous same-transaction reposting of a backdated correction"* |
| ⛔ **Skipped** | A running weighted-average column. ⚠️ v1 has one (`items.costPerUnit`) and it is **zero on 595 of 842 items — 71%** (T-145's header). A snapshot nobody maintains |
| ⭐ **The one exception** | The **2027-01-01 opening layer is weighted-average**, per ADR-009: *"the basis changes exactly once, at the boundary, by design."* One layer per item per store, from `opening_counts` |

## 3. Scope

**Create:** `packages/db/schema/stock-layers.ts` ·
`packages/db/migrations/<next>_t162_stock_layers.sql` ·
`packages/domain/src/stock/layers.ts` (pure FIFO rules) ·
`packages/domain/src/stock/consume.ts` (the transactional consumer) ·
`packages/db/src/repo/stock-layers.ts` ·
`packages/domain/tests/unit/fifo-rules.test.ts` ·
`packages/domain/tests/integration/stock-layers.test.ts`

**Modify:** `packages/db/schema/index.ts` · `packages/db/src/index.ts` ·
`classification.ts` · `rls/registry.ts` · `packages/domain/src/index.ts` · `_journal.json` ·
`docs/ROADMAP.html`

## 4. Contract

```
stock_layers                          -- one row per RECEIPT of an item into a store
  id                 uuid pk
  org_id, store_id
  item_id            uuid NOT NULL -> items
  received_at        timestamptz NOT NULL          -- the FIFO ordering key
  quantity           numeric(14,3) NOT NULL        -- as received, in BASE units
  unit_cost          numeric(14,4) NOT NULL        -- landed, per BASE unit
  remaining_quantity numeric(14,3) NOT NULL
  source_type        text NOT NULL                 -- 'delivery' | 'transfer_in' | 'opening' | 'production'
  source_id          uuid NOT NULL
  movement_id        uuid NOT NULL -> stock_movements
  is_provisional     boolean NOT NULL default true -- cost not yet confirmed by an invoice (T-163)
  created_at, updated_at

  check (quantity > 0)
  check (unit_cost >= 0)
  check (remaining_quantity >= 0 and remaining_quantity <= quantity)
  index (item_id, store_id, received_at) where remaining_quantity > 0

stock_layer_consumptions              -- APPEND ONLY. Which layer paid for which movement.
  id, org_id
  layer_id     uuid NOT NULL -> stock_layers
  movement_id  uuid NOT NULL -> stock_movements
  quantity     numeric(14,3) NOT NULL  check (quantity > 0)
  unit_cost    numeric(14,4) NOT NULL  -- snapshotted from the layer at consumption time
  created_at
  unique (layer_id, movement_id)
```

⚠️ **`unit_cost` is snapshotted onto the consumption row, and that is not a contradiction of
"derive, don't store."** T-145 already drew this line: *a balance is a consequence of facts and
must be recomputed, but a cost used in a past transaction **is** a fact.* Re-costing a layer next
year must not rewrite what a March COGS posting said.

### Domain surface

```ts
// pure — no DB, fully unit-testable
planConsumption(layers: Layer[], qty: Quantity): ConsumptionPlan | ShortfallError

// transactional
createLayer(tx, input): Promise<StockLayer>
consume(tx, { itemId, storeId, quantity, movementId }): Promise<ConsumptionResult>
  // -> { lines: [{ layerId, quantity, unitCost }], totalCost: Money }
reverseConsumption(tx, movementId): Promise<void>   // returns quantity to its own layers
valuation(storeId?, asOf?): Promise<{ itemId, quantity, value }[]>
```

## 5. Invariants

1. **Consumption is oldest-`received_at` first**, ties broken by `id` so the order is total and
   reproducible.
2. **A consumption may span several layers.** A 15 kg usage against layers of 10 and 8 consumes
   10 from the first and 5 from the second, and returns **two** cost lines.
3. **`remaining_quantity` never goes negative** — a CHECK constraint, so a bug in the planner is a
   failed transaction rather than a wrong number.
4. **Σ `stock_layer_consumptions.quantity` for a layer = `layer.quantity − layer.remaining_quantity`.**
   Checked continuously as a finding, not at year end (§15.13).
5. ⭐ **Σ (`remaining_quantity` × `unit_cost`) over open layers = the inventory control account
   balance.** This is invariant 6's inventory arm and Phase 3's exit gate. It becomes checkable in
   T-163/T-164 and is asserted in T-165.
6. **Layer quantity is reconciled against the movement ledger**, not maintained beside it: Σ open
   `remaining_quantity` for an item+store must equal T-161's `onHand` for that item summed across
   the store's locations. ⚠️ **A layer is per STORE; a movement is per LOCATION.** Moving stock
   between two rooms of one store consumes no layer.
7. **Reversing a consumption returns quantity to the exact layers it took it from**, never to the
   oldest open layer. A void that re-FIFOs is a silent re-costing.
8. **A shortfall is refused, never absorbed.** Consuming more than the open layers hold raises;
   there is no negative layer and no "vacuum" correction. ⚠️ This is the case Odoo solves with a
   whole subsystem — refusing it is the deliberate simplification (§2).
9. **`is_provisional` is a fact about the cost, never about the quantity.** A provisional layer is
   fully consumable; only its `unit_cost` is subject to correction (T-163).
10. **Correcting a provisional layer's `unit_cost` re-values only its OPEN remainder.** ⭐ Already
    consumed quantity keeps the cost the consumption row snapshotted, and the difference posts as a
    price variance in T-163 — it does not rewrite a closed month.

## 6. Tests

1. Two layers (10 @ ₱100, 8 @ ₱120); consume 15 → 10 @ ₱100 and 5 @ ₱120, total ₱1,600.
2. Consuming exactly one layer's remainder closes it (`remaining_quantity = 0`) and it drops out
   of the open-layer index.
3. Consuming 20 against 18 open **raises**, and no partial consumption is written.
4. Reversing the 15-unit consumption restores **10 and 5 to their original layers**, not 15 to the
   oldest — asserted per layer.
5. A layer received later but *dated* earlier is consumed first: FIFO orders by `received_at`, not
   by insertion.
6. ⭐ Correcting a provisional layer's unit cost from ₱100 to ₱110 with 4 of 10 already consumed:
   the open 6 re-value to ₱110, the consumed 4 stay at ₱100, and the function reports a ₱40
   variance for T-163 to post.
7. `valuation()` equals Σ open (`remaining` × `unit_cost`), and equals T-161's `onHand` in quantity
   — the two-way tie of invariant 6.
8. `planConsumption` is a pure function: same inputs, same plan, no DB, and it is unit-tested
   without Postgres.
9. Concurrency: two transactions consume 8 each from a single open layer of 10. One commits, one is
   refused by the CHECK. Final `remaining_quantity` is 2.
10. RLS: org isolation on both tables.

## 7. Out of scope

⛔ **Posting anything to the GL.** T-163 (receipt) and T-164 (consumption) own the journal. This
task computes cost; it does not book it.
⛔ **Per-location layers.** Layers are per store, per invariant 6. A room-to-room transfer moves
quantity and not cost, which is also what makes T-167 cheap.
⛔ **Weighted average as an alternative basis.** Row 110. The only average is the opening layer.
⛔ **Backdated re-costing that re-opens closed periods.** Invariant 10 confines a correction to the
open remainder, deliberately.
⛔ **Landed-cost allocation.** T-151 already derives it, by value, in a window function. This task
**consumes** that number; it does not recompute it.

## 8. ⚠️ Built 2026-08-29 — what landed, what did not, and why

**Landed, and complete to its own gate:**

| | |
|---|---|
| `packages/domain/src/stock/layers.ts` | `planConsumption` and `planReversal` — pure, no DB, no imports from `@shareat/db` |
| `packages/domain/src/stock/quantity.ts` | ⚠️ **Outside this task's declared file list**, and reported here per §3.3. Exact decimal quantity in integer thousandths — `money.ts` applied to the other axis. §9.1 is why it had to exist |
| `packages/domain/tests/unit/fifo-rules.test.ts` | 21 cases. Written first; confirmed failing for the right reason (missing module, then wrong numbers) before passing |

**Gate:** `typecheck` clean · `npm test` **634 passed (40 files)**.

⛔ **Not landed, and deliberately:** `stock_layers` / `stock_layer_consumptions`, the migration, the
repo, `consume.ts`, and the integration tests. **Three shared surfaces were occupied by live peer
sessions** at the time (`ListAgents`: two interactive peers mid-flight):

| Surface | State |
|---|---|
| **Port 9008** | A peer's dev server was LISTENING with an established connection — so ⛔ no `npm run build` (it clobbers the `.next` being served, bible §2.9) and ⛔ no smoketest |
| **`shareat_test`** | A peer had `packages/domain/tests/integration/remittance.test.ts` uncommitted and in flight. Two agents running `test:integration` TRUNCATE each other's fixtures (§3.4, observed 2026-08-23) |
| **`CAPABILITY-MATRIX.md` + `packages/auth/src/capabilities.ts`** | Both uncommitted and actively being edited by that peer |

⭐ **The migration journal was clean at `0060` and `packages/db/schema/` was untouched** — so the
schema half is *unblocked by peers*, and blocked only by its own gate: a table with no integration
test against real Postgres cannot be reported done (§9.3).

## 9. ⭐ Two findings from building it

### 9.1 ⛔ The 1e-6 quantity tolerance is DEAD, and carrying it forward would be a lie

v1 compares quantities with a `1e-6` tolerance (`stock-count.ts:20-26`, `stock-ledger.ts:38`) and
`docs/discovery/14` §K correctly reads it as *"a stated business tolerance, not a magic number."*
**It was — for FLOATS.**

⭐ **At `numeric(14,3)` the smallest representable non-zero difference is `0.001`. A `1e-6`
tolerance can never fire.** It is unreachable code that reads as a deliberate business rule and
would be maintained as one.

**Corrected in T-161 §6.6 and T-169 invariant 6**, both of which had inherited the constant from v1
without noticing it had lost its reason. ⚠️ **Money tolerances are untouched** — T-163's ₱0.99
invoice-match is a real judgement about supplier paperwork, and §16.6's rule that purpose-tuned
tolerances stay separate still holds.

### 9.2 ⚠️ `planReversal` takes what is OUTSTANDING, not the original sale

The first draft of test 3 asserted that two independent partial reversal plans sum to the full
reversal. **They do not** — both take from the newest layer, and the total came to ₱1,700 against
₱1,600.

⭐ **The test was wrong and the implementation was right, but the failure surfaced a real contract**
that neither this spec nor T-179 had stated: a second partial return must pass the *remaining*
consumption, so **`consume.ts` must derive outstanding rows from `stock_layer_consumptions` minus
prior reversals.** Now documented on the function itself, so it reaches the transactional half
rather than being re-derived from a bug in production.

## 10. ⚠️ Storage built 2026-08-29 — and where the test had to live

**Landed on top of §8's pure half:**

| | |
|---|---|
| `packages/db/schema/stock-layers.ts` | `stock_layers`, `stock_layer_consumptions` |
| `packages/db/migrations/0064_t162_stock_layers.sql` | ✅ Journalled, applied to `shareat_dev` and `shareat_test` |
| `packages/db/src/repo/stock-layers.ts` | `createLayer`, `openLayersForUpdate`, `applyConsumption`, `outstandingConsumptions`, `reverseConsumption`, `valuation` |
| `classification.ts` / `rls/registry.ts` | Both **PURGE** · `org_column`, ENABLE **and FORCE** |
| `packages/domain/tests/integration/stock-layers.test.ts` | 14 cases |

### 10.1 ⭐ The subledger TIES to the layer, as a constraint

Σ a layer's unreversed consumptions must equal `quantity − remaining_quantity`. Without it the two
are free to disagree **invisibly**: `remaining_quantity` looks authoritative and the subledger looks
complete, and only one of them is right.

⚠️ Deferred to COMMIT, because the consumption row and the layer decrement happen in one
transaction and neither order should be forced on the caller. ⛔ A **reversed** consumption is
excluded from the sum — that exclusion is what lets a void give quantity back and still tie.

### 10.2 Three more things the database now refuses

- `remaining_quantity` outside `[0, quantity]` — ⭐ so a planner bug is a **failed transaction
  rather than a wrong number**.
- Two layers for one stock-in movement — a retried receipt cannot double the cost basis.
- `is_provisional` disagreeing with `invoice_line_id`. ⭐ They are two views of one fact, so the
  flag cannot drift from it — which is the whole reason there is no `isExpensed` boolean anywhere
  in this design (§3.3, DEF-075).

### 10.3 ⛔ It lives in `packages/domain/tests`, and that is a layering rule

The test needs the **pure planner and the tables**. `packages/db` does not depend on
`@shareat/domain` — the arrow runs the other way (ADR-004) — so the same file under `db/tests`
could only reach the planner by a relative path climbing out of its own package. **That is a
dependency cycle wearing a disguise**, and it was written that way first before being moved.

⭐ T-160's and T-161's suites correctly stay in `packages/db`: they use raw SQL only.

### 10.4 Not built

**`consume.ts`, the transactional wrapper.** The repo carries every primitive and the tests drive
them through the planner exactly as a service would. ⚠️ The wrapper's real shape depends on its
first caller — T-163's receipt posting, which must create the layer and post `Dr 1310 / Cr 2120`
in one transaction — and inventing it ahead of that caller is how a signature ends up fitting
nothing. **The pieces are all here; the seam is T-163's to draw.**

⭐ `openLayersForUpdate` already takes the `FOR UPDATE` lock, so the concurrency guarantee does not
wait for the wrapper.

## 11. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts`: **PURGE** for both tables. `rls/registry.ts` NULLIF-guarded (DEF-077).
- [ ] `planConsumption` has no import from `@shareat/db` — verified by the existing
      app/package-boundary test, extended if needed.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] Test 9 fails before the CHECK exists and passes after.
- [ ] `docs/ROADMAP.html` updated.
