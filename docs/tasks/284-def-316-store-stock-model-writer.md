# T-284 / DEF-316 — `stores.stock_model` has never had a writer

**Reported by Ian, 2026-09-12:** *"shareat lipa needs more than 1 storage room, i can not edit the
store, store must be editable."*

## The defect

`stores.stock_model` was created by migration **0062** (`0062_t160_stock_locations.sql:125`) with a
CHECK constraint and a guard trigger. `updateStoreDetails`
(`packages/domain/src/stores/service.ts:184`) accepts `name`, `timezone`, `address`,
`contactNumber`, `tinBranchCode` — and `UpdateStorePatch` (`packages/db/src/repo/stores.ts:168`)
declares exactly those five.

⭐ **There is no writer for `stock_model` anywhere in the repository.** Every store has been
`single_room` — the column's default, and the stricter of the two — since T-160 created it, with
no path to change it. Shareat Lipa cannot hold a second stockroom because nothing can say it may.

This is the fourth instance of the "built, registered, never called" shape this week: DEF-299,
DEF-260, DEF-314.

## ⛔ The guard the database does not have — DEF-316

`stock_locations_single_room_guard_trg` (`0062:163`) fires on **`stock_locations`**, reads the
store's `stock_model` at that moment, and refuses a second non-Receiving room. **Nothing fires on
`stores` when `stock_model` itself changes.** `grep 'ON "stores"' packages/db/migrations/*.sql`
returns a unique index, an RLS policy, and one unrelated money-accounts `AFTER INSERT` — no
`AFTER UPDATE OF stock_model`. Confirmed structurally by system32-85, filed as DEF-316.

So `multi_room → single_room` on a store already holding two rooms lands in a state the invariant
forbids, silently, and every *later* room insert then refuses by pointing at a condition the store
was already in.

⭐ **This has never fired because no writer existed. This task is what makes it reachable** — so
the guard ships in the same change that creates the risk, not after it.

⚠️ **Disclosed single-layer state, and not a resting place.** The refusal below is service-layer
only. RULES §6.3 / bible §15.11 — *no layer may be the only one for a given risk* — wants an
`AFTER UPDATE OF stock_model ON stores` trigger reusing `0062:132-161`'s own counting query. It
belongs in the next migration that touches this area; no slot is claimed here (0145 is lane A's,
0146 is earmarked for T-276). DEF-316 carries the disposition.

## The design

A dedicated `setStoreStockModel`, **not** a sixth field on `updateStoreDetails`.

⭐ `stock_model` is an **invariant, not a preference** — the schema says so in as many words. It
needs a pre-flight check that the other five fields do not, and a refusal message about rooms,
which is not a thing a general store-details save should have to know. Same reasoning that gave
`setWastageMonitor` its own function and its own capability constant one section below.

### The refusal reuses the existing pure rule

`singleRoomViolation(model, locations)` (`packages/domain/src/stock-locations/rules.ts:115`)
already answers exactly this question and is already tested. ⛔ **It is called, not copied.**
`0062`'s own header records that a second copy of this rule in SQL got it wrong — *"the pure rule
filtered the whole list and got it right; the SQL did not, and only a test against real PostgreSQL
could see the two disagree."*

Capability: **`manage_stores`** — this file's existing `CAPABILITY`. Opening a second stockroom is
structural, an admin's act, not store settings.

## ⚠️ What this task deliberately does NOT do

`remittance_cadence` and `unremitted_ceiling` have **no writer either** — the same defect, found
while confirming this one. They are not fixed here because they are a different decision: the two
are bound by `stores_pooling_requires_ceiling_check` (a long cadence may not exist without a
number bounding the pile), the ceiling is money, and `CADENCE_DAYS` feeds the overdue calculation
that remittance screens already read. That is a pooling feature, not an edit box, and widening
this task into it would be scope creep on a shared tree. **Reported to Ian for sequencing.**

## Files this task may touch

- `packages/domain/src/stores/service.ts`
- `packages/db/src/repo/stores.ts`
- `apps/erp/src/app/admin/stores/actions.ts`
- `apps/erp/src/app/admin/stores/[id]/page.tsx`
- `packages/domain/tests/**` — the guard's own test
- `docs/tasks/284-def-316-store-stock-model-writer.md` (this file)

## Definition of done

typecheck clean · unit green · the downgrade refusal proven by a test that FAILS without the guard ·
⚠️ smoketest on 9008 owed.
