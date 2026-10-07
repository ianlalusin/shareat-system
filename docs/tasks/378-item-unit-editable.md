# T-378: an item's unit is chosen, never defaulted, and correctable until it has history; a request keeps what it is sold as

**Status:** SPEC 2026-10-06 (Opus planner). Written at HEAD `4d9fbf9`. ✎REV-0 Reviewed 2026-10-06 by an independent **DONE 2026-10-07:** S1+S2 `3353c72` (0186), S3 `f6403fd`, tests caught up `f8ef329`. Full gate on fresh `shareat_test_orch_gate9`: typecheck 0, build 0, integration 5387/5389 with the 2 failures passing alone (laptop sleep) and 1 real regression fixed in `f8ef329`; unit 240/242 (two load-only flakes pass alone). Smoked on 9008: 5/5. DEF-600 logged.
reviewer, and amended in place (✎REV-1 to ✎REV-12). Every file:line in §Research and §Census was checked against HEAD
and holds. The C2 counts are corrected by REV-1.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** **0186** (S2), hand-authored per `docs/decisions/ADR-012-hand-authored-migrations.md` §5. ⛔ It adds a
trigger, so it is gated on the **FULL** integration suite on a fresh gate DB. Its prechecks go in `docs/ops/README.md`'s
deploy-gate table (§Prechecks below).
**Defects:** two, new. The orchestrator files them (proposed **DEF-598** and **DEF-599**; the register's head is DEF-597).
- **DEF-598** (⛔, stock and cost): the unit of a new item silently defaults to `kg`, and no screen can correct it.
  Ian, 2026-10-06: *"i tried to add coke 1.5 it defaulted to kg while it must be pcs for uom and i can not edit it
  anymore. make uom editable null default so it makes sure its filled right"*, and *"and must be editable once approved"*.
- **DEF-599** (🔸, selling): *"sold alacarte and sold wholesale does not persist after approval"* (Ian, 2026-10-06).

## Goal
- Nobody gets a unit they did not pick. Every form that sets an item's unit starts blank, and the server refuses a
  missing or unknown unit in a plain sentence.
- A wrong unit can be corrected after approval, by a super-admin, while correcting it reinterprets nothing.
- Once an item has history, its unit is fixed, and the database says so. The sentence says why.
- What the requester ticked (bought / sold à la carte / sold wholesale) reaches the item at approval.
- Every unit change leaves an audit row.

## Research, evaluate, propose (bible row 283; skill invoked before planning)
1. **Verdict.** Build it, at this size: a DB history guard, one audited unit-change path, request flags carried through.
   Do NOT build a "restate history with a factor" now. It is Q1 for Ian.
2. **The stated reason holds**, for both reports.
   - `page.tsx:224` defaults the unit to `kg`, and `required` cannot catch a default.
   - No screen changes `base_unit`. `updateItem` accepts it (`domain/items/index.ts:90`, `manage_items`) but has no
     caller that passes it.
   - The request drops the flags. The form's own small print admits it (`page.tsx:262-265`: *"a request carries only
     name, kind and unit"*), but the checkboxes are still drawn above the Request button.
   - ⭐ A second reason Ian did not name: **an unguarded relabel is the real hazard**. `updateItem` already lets a
     manager rewrite `base_unit` on an item with years of stock, with no check and no record. Only the missing screen
     prevents it today.
3. **What exists.**
   - **v2:** the merge guard refuses unequal units (`domain/items/index.ts:612-622`). The CHECKs are
     `items_base_unit_check` (0047:43) and `item_requests_base_unit_check` (0050:84). The 0125 slab-unit trigger
     (`0125_t176_production.sql:54-77`) fires only on the CHILD row, so changing a slab's unit under its sliced children
     is not refused today. ✎ This is a gap: invariant 7 can be broken from the parent side. This spec closes it.
   - **audit_log** has one writer pattern, `auditLogRepo.append` (`packages/db/src/repo/audit-log.ts:36`; used at
     `domain/pos/store-link.ts:124`). **Item edits are not audited today** (`updateItem` writes `updated_at` only,
     `repo/items.ts:106-111`).
   - **v1** (`ERP-rebuild/src/app/inventory/items/page.tsx:50`) has the same `useState('kg')` default (v2 copied the
     bug), and its edit dialog (`:68`, `:161`) relabels the unit freely, with no history check. **Goal:** let the unit
     be corrected. **v1's method:** silent reinterpretation. v1 data shows wrong units are real: 33 items in `box`/`pack`,
     and `white onion` in pcs at one store and kg at the others (`schema/items.ts:9-11`, `:70-72`).
4. **Industry.**
   - **Odoo** refuses a product's UoM change once stock moves exist, and the user archives and re-creates it
     (`product.template` UoM write check; odoo/odoo `addons/stock/models/product.py`).
   - **ERPNext** refuses a default-UOM change after transactions (*"Default Unit of Measure for Item … cannot be changed
     directly because you have already made some transaction(s) with another UOM"*, frappe/erpnext
     `erpnext/stock/doctype/item/item.py`, `validate_uom`). Its old "UOM Replace Utility" did the factor restate, and
     was removed for being unsafe.
   - So both refuse after history. Q1(b) is the restate that ERPNext withdrew.
5. **Open source.** Nothing to adopt. This is a trigger and a form, and both products above are GPL/LGPL, cited as
   pattern only.
6. **Effort against use.**
   - **Effort:** S1 ~½ day, S2 ~1 day, S3 ~1½ days.
   - **Use:** every new item (the form is used per item). The relabel guard protects every item with history.
   - **Not reachable here:** production's count of items, how many have history, and whether Coke 1.5 does. P0186b
     returns those numbers before the push.
   - **If never built:** every new item risks `kg`, and Ian's Coke stays wrong.
7. **Scope.** The parts in scope are below. Each deliberate omission is listed in §Out of scope with its reason.

## Census, verified at source

### C1. Every place that sets an item's unit
- `apps/erp/src/app/items/page.tsx:224`. The one form, used both to request (`requestItemAction`) and to add directly
  (`createItemAction`, `formAction` at `:272`).
  - `defaultValue="kg"`.
  - Options from a page-local `UNITS` (`:21`), a second copy of `BASE_UNITS` (`schema/items.ts:74`).
  - `kind` has the same trap (`:216`, `defaultValue="raw_material"`).
- The actions cast without checking: `str(formData,'baseUnit') as BaseUnit` (`actions.ts:84`, `:108`). An empty string
  reaches the DB, and the CHECK refuses it. `errorMessage` (`actions.ts:54-64`) has no sentence for
  `items_base_unit_check` or `item_requests_base_unit_check`, so the person gets the generic fallback.
- Domain writers: `requestItem` (`domain/items/index.ts:496-528`), `createItem` (`:51-73`), `approveItemRequest`
  (`:531-561`, copies `req.baseUnit`), and `updateItem` (`:82-105`, accepts `baseUnit`; its only app caller,
  `updateItemFlagsAction` `actions.ts:127-142`, does not pass it).
- Repo: `itemsRepo.insertItem` (`repo/items.ts:50`) and `updateItem` (`:89-112`). No ETL or seed writes `items` (grep
  of `packages/etl/src`: none). 0047:151 is a one-time backfill.
- **The approve screen** (`page.tsx:118-156`) shows *"measured in {r.baseUnit}"* (`:131`). It cannot correct the unit,
  and it shows nothing about how the item is sold.

### C2. Tables that state a quantity or price in an item's base unit (the history the guard reads)
Every FK to `items(id)` in `public`, from the migrations: **25 FK columns on 24 other tables, plus 3 self-references
on `items`** (28 references). **25 block a unit change** (22 columns on 21 tables, plus the 3 self-references), and
**3 are exempt**.

| # | Table.column | Migration | Why it is unit-bearing |
|---|---|---|---|
| 1 | `supplier_invoice_lines.item_id` | 0047 | quantity × `conversion_factor` to base, price per base derived |
| 2 | `price_list_items.item_id` | 0047 | `rate` per unit |
| 3 | `trade_order_lines.item_id` (born `wholesale_order_lines`, 0053) | 0053 | quantities, `dispatch_cost` |
| 4 | `item_pricing.item_id` | 0056 | fixed peso per base unit |
| 5 | `opening_counts.item_id` | 0059 | quantity, `unit_cost` |
| 6 | `stock_movements.item_id` | 0063 | the ledger, in base units |
| 7 | `stock_layers.item_id` | 0064 | quantity, landed cost per base unit (consumptions hang off layers) |
| 8 | `delivery_lines.item_id` | 0066 | quantities, factor, `unit_cost` |
| 9 | `stock_usage_lines.item_id` | 0067 | quantity |
| 10 | `count_lines.item_id` | 0068 | counted / expected quantity |
| 11 | `commissary_item_offerings.item_id` | 0069 | `manual_cost` per base unit |
| 12 | `commissary_item_map.commissary_item_id`, `.branch_item_id` | 0069 | a unit-matched pairing (DEF-184) |
| 13 | `store_item_thresholds.item_id` | 0072 | `low_stock_threshold` quantity |
| 14 | `stock_transfer_lines.item_id` | 0117 | quantity |
| 15 | `stock_reservations.item_id` | 0117 | quantity |
| 16 | `supplier_return_lines.item_id` | 0118 | quantity, `unit_cost` |
| 17 | `customer_return_lines.item_id` | 0119 | quantity, cost |
| 18 | `production_recipes.output_item_id` | 0125 | `output_quantity` |
| 19 | `production_recipe_lines.item_id` | 0125 | converted against the item's base unit at cook time |
| 20 | `production_record_lines.item_id` | 0125 | quantity |
| 21 | `pos_item_maps.item_id` | 0127 | `quantity_per_sale` |
| 22 | `pos_usage_pull_lines.item_id` | 0127 | quantity |
| 23 | `items.parent_slab_item_id` (a child points at this item) | 0125 | invariant 7: child unit = slab unit |
| 24 | `items.cost_basis_item_id` (another item prices off this one) | 0056 | cost per base unit borrowed |
| — | `items.merged_into_id` (a merged duplicate points at this one) | 0050 | merged histories share a unit (merge rule) — **blocks** |
| ex | `supplier_items.item_id` | 0048 | a declaration, no quantity or price |
| ex | `store_item_sellability.item_id` | 0052 | three booleans |
| ex | `item_requests.created_item_id` | 0050 | provenance only |

So **25 references block** (the 22 FK columns in rows 1–22, plus 3 self-references) and **3 are exempt**.

✎REV-1 (reviewer, 2026-10-06) **The counts above are off by one; the table is right.** Row 12 is TWO columns, so rows
1–22 are **23 FK columns on 22 tables**. Grep of `packages/db/migrations/*.sql` for `REFERENCES ... items("id")`
returns **29** FKs: **26** on 25 other tables + 3 self-references. **26 block** (23 + 3) and 3 are exempt. The builder
writes 26 `EXISTS`, not 25. B3 reads `pg_constraint`, so it would catch the miss, but do not build to the wrong number.
- **Non-FK carriers, checked:** no `schema/` table stores an item code/name or a quantity in an item's unit without an
  `item_id` FK, except two that reach the item **transitively**: `stock_layer_consumptions` (via `stock_layers`) and
  `trade_discrepancies` (via `trade_order_lines`). A consumption or discrepancy needs its parent row, so the parent's
  `EXISTS` covers it. JSON: `pos_v1_day_feeds.payload` holds POS menu sales (servings, keyed by POS item, unit-free
  until `pos_item_maps`, row 21). `pos_usage_pull_lines.blocked` and `production_records.soft_warnings` sit on rows
  that already have an `item_id` or a parent with one.
- ⚠️ **B3 cannot see a future non-FK carrier.** Its header says so, and the C2 table is the place to add one.
- ✎REV-2 **Outgoing reference missed: the item's OWN `cost_basis_item_id`.** Row 24 blocks when another item prices off
  THIS one. It does not block when this item prices off another. If X (kg) borrows Y's cost per kg and X changes to
  pcs, X's price reads ₱/kg as ₱/pcs. The fix is a 27th leg, `EXISTS (SELECT 1 FROM items WHERE id = p_item AND
  cost_basis_item_id IS NOT NULL)`. B3 lists it as a named extra, because it is not an incoming FK.
  - The item's own `parent_slab_item_id` needs no leg: `items_check_parent_slab_unit_trg` (0125:54-78) already refuses
    a child whose unit differs from its slab.
  - Pre-existing and out of scope: `setCostBasisItem` (`domain/items/index.ts:789-826`) never compares units, so a kg
    item can borrow from a pcs item today. Filed as **N5**.

## Rulings (planner)
- **R1. No default unit or kind. Required, and refused by the database in a sentence.**
  - The request/create form's "Measured in" select: first option `<option value="">Choose a unit</option>`,
    `defaultValue=""`, `required`, with the options from `BASE_UNITS` (the page-local `UNITS` is deleted).
  - "Kind" gets the same treatment ("Choose a kind").
  - The server rule is the existing CHECKs, nothing in TypeScript (RULES §6 item 3).
    - `CONSTRAINT_MESSAGES` gains `items_base_unit_check` and `item_requests_base_unit_check`, both with the sentence
      **"Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll."**
    - Kind has its CHECKs too: `items_kind_check` (0047:42) and `item_requests_kind_check` (0050:83). Both map to
      **"Choose what kind of item this is."**
    - Those are four new keys. The count guards move 32 → 36.
  - The action keeps its cast. It must not substitute a value for a blank one.
- **R2. The unit is editable until the item has history. The database decides "has history", once.**
  - 0186 adds `items_unit_history_exists(p_item uuid) RETURNS boolean`: one `EXISTS` per row of C2's 25 blocking
    references, ORed together. `STABLE`, invoker (no `SECURITY DEFINER`, the 0185 convention: RLS on
    `app_current_org()` applies, and every referencing row shares the item's org).
  - Trigger `items_base_unit_fixed`: `BEFORE UPDATE OF base_unit ON items FOR EACH ROW WHEN (OLD.base_unit IS DISTINCT
    FROM NEW.base_unit)`. It raises when `items_unit_history_exists(OLD.id)` is true:
    - message **"This item's unit can no longer change: it already has stock, counts, invoices, recipes, prices or
      orders recorded in its current unit, and changing it would re-read every one of them in the new unit."**
    - `USING ERRCODE = '23514', CONSTRAINT = 'items_base_unit_fixed'`.
    - The same sentence is a `CONSTRAINT_MESSAGES` entry (count 36 → 37). No ids, no names in it.
  - ✎REV-3 **The race, and the lock that closes it (⛔ required).** The UPDATE takes `FOR NO KEY UPDATE` on the items
    row, because `base_unit` is in no unique index. A concurrent first stock insert's FK check takes `FOR KEY SHARE`.
    **Those two locks do not conflict.** Tx B inserts the item's first `stock_movements` row and has not committed.
    Tx A's trigger sees no history (B is invisible to it) and commits `kg → pcs`. B then commits a kg quantity onto a
    pcs item, which is exactly the reinterpretation this task forbids.
    - **Fix:** the trigger function first runs `PERFORM 1 FROM items WHERE id = OLD.id FOR UPDATE;`. `FOR UPDATE`
      conflicts with `FOR KEY SHARE`, so A waits for B.
    - It then calls `items_unit_history_exists(OLD.id)` in a **separate** statement. Under READ COMMITTED that
      statement takes a fresh snapshot and sees B's committed row. Under REPEATABLE READ, A gets a serialization
      failure. Both are safe.
    - **The residual case is named, not fixed.** A goes first and commits. B read `kg` before A committed, and inserts
      after. B's FK check waits for A, then passes. Closing that needs every stock writer to lock the item `FOR SHARE`
      when it reads the unit, which is out of scope. The window is one super-admin click against one in-flight write.
      Log it in the register with the fix.
  - ✎REV-4 **RLS: invoker is right, but copy ALL of 0185's convention, including its fail-closed branch.**
    `sales_day_store_is_linked` (0185:35-48) checks `app_current_org() IS NULL` and refuses unless the role is
    superuser or BYPASSRLS. Production's app role is neither (`docs/ops/README.md` §2026-09-12).
    - Without that branch, an invoker function in a session with no org reads every referencing table as empty under
      RLS. It answers **false**, which means "no history" and "editable".
    - Today `items` RLS would also hide the row being updated, so this is defence in depth. The page reader
      `unitHistoryExists` has no such second wall.
    - **Ruling:** when there is no org context and the role cannot bypass RLS, the function returns **true** (locked).
      It does not raise, so the page shows the locked sentence rather than a 500.
    - Every referencing table's policy is `app_current_org()` only (grep of `rls/registry.ts`: no other
      `app_current_*`), so in-org visibility is complete.
  - ✎REV-5 **Write it as a plpgsql `IF EXISTS … THEN RETURN true` ladder, indexed tables first**, not one ORed SQL
    expression. Postgres does not promise left-to-right `OR`, and an item with no history pays for every leg on every
    `/items/{id}` render. These legs have no index leading on the item column, so each is a sequential scan:
    `count_lines`, `stock_layers` (only a partial index), `commissary_item_offerings`, `commissary_item_map`,
    `price_list_items`, `opening_counts`, `store_item_thresholds`, `production_recipes.output_item_id`, and
    `items.cost_basis_item_id`/`merged_into_id`. Those tables are small today. Put them last, and add no index in
    0186.
  - Classified in `packages/db/src/triggers/registry.ts` as `kind: 'validator', mode: 'origin'`. It reads other
    tables' current rows, so it must stay silent on a replica-mode restore (registry header's test).
  - ⭐ **The page reads the same function** to show the form or the locked sentence, through a new repo read
    `itemsRepo.unitHistoryExists(tx, itemId)` = `select items_unit_history_exists($1)`. One definition, two readers. The
    page's view is a courtesy; the trigger is the rule.
  - ✎ The trigger also closes the 0125 gap: a slab with sliced children (row 23) can no longer change unit.
- **R3. The refusal does NOT point to merge.** Merge refuses unequal units (`domain/items/index.ts:616-622`), so for a
  wrong unit with history it is a dead end. Its sentence, *"Fix the unit on one of them first"*, is now true only while
  one of the two has no history. That is fine, and it is not reworded here. The way out for an item with history is
  Q1.
- **R4. Who: `approve_item` (super-admin). No new capability.**
  - The unit is part of the identity a super-admin approved, and the bar to correct it is the bar that set it.
  - New domain function `changeItemBaseUnit(tx, actor, { itemId, baseUnit })`:
    - `authorize(trx, actor, 'approve_item', {})` first;
    - read the item (`gone` if absent);
    - if the unit is unchanged, return `{ changed: false }` and write nothing;
    - else `itemsRepo.updateItem(trx, orgId, itemId, { baseUnit })`, then `auditLogRepo.append` (R6).
  - `updateItem` (domain) **refuses a `baseUnit` key** with `refuse(...)`: *"Change the unit with Change unit on the
    item's page."* It is also removed from its `values` type. One audited path; `manage_items` keeps the flags.
  - `docs/decisions/CAPABILITY-MATRIX.md`: the `approve_item` row's note gains *"T-378: also changes an item's unit
    (while it has no history)."* No new row.
- **R5. The approver confirms the unit and the three flags at approval.**
  - The approve form (`page.tsx:140-143`) gains the "Measured in" select, pre-selected to the requester's unit (a
    choice someone made, not a default), and the three checkboxes, pre-ticked from the request.
  - `approveItemRequest` input gains optional `baseUnit`, `isPurchasable`, `sellableRetail`, `sellableWholesale`. If
    absent, it uses the request's.
  - The `item_requests` row is not changed. It keeps what the requester asked for, frozen like `similar_warning`
    (`schema/items.ts:217-218`). The item carries what the approver approved, and the two can be compared.
  - No audit row for this: the item is born with these values, and `created_by` is the approver.
- **R6. Audit: one `audit_log` row per real unit change.**
  - `{ actorPersonId, action: 'change_item_base_unit', entity: 'items', entityId: itemId, before: { baseUnit },
    after: { baseUnit }, source: 'web' }`.
  - Appended AFTER the UPDATE, in the same transaction, so a refused change writes none.
- **R7 (DEF-599). The request carries the flags. Pick: columns on `item_requests`, NOT NULL with the item's defaults.**
  - 0186: `is_purchasable boolean NOT NULL DEFAULT true`, `sellable_retail boolean NOT NULL DEFAULT false`,
    `sellable_wholesale boolean NOT NULL DEFAULT false`.
  - Why on the request: the requester knows how it is sold, and R5 lets the approver correct it.
  - Why not nullable: a NULL would mean "asked before 0186", and only pre-0186 pending rows could hold one. Those rows
    get exactly what approval gives them today, and the approver sees and confirms them on R5's form. A NULL branch
    would be a third state for a handful of rows (P0186a counts them).
  - A constant default is a metadata-only `ADD COLUMN`, with no table rewrite.
  - `requestItemAction` reads them with `flag()` (`actions.ts:39`), the same as `createItemAction`. `requestItem` stores
    them, and `approveItemRequest` copies them (subject to R5).
  - `isPurchasable` is on the same path and was dropped the same way. It showed only when the requester unticked it,
    because its default is `true`. It is fixed by the same change.
  - The small print at `page.tsx:260-266` is rewritten: these apply to a request too, and the super-admin confirms
    them at approval.

## Parallel plan
| Slice | DEF | Files (BUILDER) | Shared state | Order |
|---|---|---|---|---|
| S1 | 598 | `apps/erp/src/app/items/page.tsx` (request form selects only, `:21`, `:214-229`), `apps/erp/src/lib/constraint-messages.ts` | constraint-message count guards | first; shippable without 0186 |
| S2 | 598, 599 | `packages/db/migrations/0186_t378_item_unit_fixed_and_request_flags.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/schema/items.ts`, `packages/db/src/triggers/registry.ts`, `packages/db/src/repo/items.ts` (`unitHistoryExists`, request flag columns in `ItemRequestRow`/`insertItemRequest`), `apps/erp/src/lib/constraint-messages.ts` (one key) | journal, count guards, a lane DB | after S1 (both edit `constraint-messages.ts` and its guards) |
| S3 | 598, 599 | `packages/domain/src/items/index.ts` (`changeItemBaseUnit`, `updateItem`, `requestItem`, `approveItemRequest`, `RequestItemInput`), `packages/domain/src/index.ts` (export, if items are re-exported there), `apps/erp/src/app/items/actions.ts`, `apps/erp/src/app/items/page.tsx` (approve form, small print), `apps/erp/src/app/items/[id]/page.tsx` (unit section), `apps/erp/src/app/items/lib.ts` (`unitHistoryExists` loader), `docs/decisions/CAPABILITY-MATRIX.md` (`approve_item` note) | a lane DB | after S2 |

None of the slices touches `POSTING-PATTERNS.md`, `classification.ts` or `rls/registry.ts`: no new table, and RLS on
`items`/`item_requests` is unchanged.

## Invariants
- I1. No money moves and no row is rewritten. 0186 does no data surgery (deploy-gate rule).
- I2. One rule, one place: "has history" exists only as `items_unit_history_exists`. No TypeScript copy decides it.
- I3. Refusal sentences carry no ids or item names (they travel in `?error=`).
- I4. No new capability. `authorize()` stays first in every touched domain function.
- I5. An applied migration is never edited. If 0186 is wrong after it lands, the fix is 0187.

---

## S1: DEF-598, no default unit
**BUILDER:**
- `items/page.tsx`: R1 for the "Measured in" and "Kind" selects. Import `BASE_UNITS` from `@shareat/db` and delete
  `UNITS`.
- `constraint-messages.ts`: the four keys (R1).

**TESTER:**
- New `apps/erp/tests/integration/t378-s1-item-unit-no-default.test.ts`. Render harness from `t350-s2-render.test.ts`,
  action harness from `t365-supplier-bank-audit-web.test.ts` (`RedirectSignal`, `ACTOR_HOLDER`).
- Edit the count guards: `apps/erp/tests/constraint-messages.test.ts:174` and
  `apps/erp/tests/integration/constraint-message-lookup-mechanism.test.ts:133` (32 → 36).
- Edit `apps/erp/tests/integration/constraint-message-lookup.test.ts`: provoke each new key for real (the `:425`
  guard demands it).

**Tests:**
- **U1** (red on HEAD). `/items` HTML: the `baseUnit` select's first option is `value=""` "Choose a unit" and is the
  selected one; no other option carries `selected`; `required` is present; the options are exactly `BASE_UNITS`.
  **U1b**, the same for `kind`. Mutants:
  - restore `defaultValue="kg"` → U1 red;
  - restore `defaultValue="raw_material"` → U1b red;
  - drop `required` → U1 red.
- **U2** (red on HEAD: the generic sentence). `requestItemAction` with `baseUnit` = `''` → redirect `error` = R1's unit
  sentence, and no `item_requests` row. Mutants:
  - delete the `item_requests_base_unit_check` entry → U2 red;
  - the action writes `|| 'kg'` → U2 red (a row exists).
- **U3**. `createItemAction` (super-admin) with `baseUnit` = `'box'` → the same sentence via `items_base_unit_check`,
  and no `items` row. Mutant: delete that entry → U3 red.
- **U4** (control). `pcs` → `ok` redirect; the request row's `base_unit` = `'pcs'`.
- Mutant (lookup file): any one of the four keys unprovoked → the `:425` guard red.

**Smoke (9008):** `/items`: the select reads "Choose a unit". Submit with it blank: the browser stops it. Remove
`required` in devtools and submit: the red banner shows the sentence. Screenshots at 375px and in dark mode.

---

## S2: 0186, the history guard and the request flag columns
**BUILDER:**
- `0186_t378_item_unit_fixed_and_request_flags.sql`, ADR-012 §5:
  - header naming T-378, R2 and R7, and why;
  - `--> statement-breakpoint` between statements;
  - the function (R2: every row of C2's blocking list, one `EXISTS` each), the trigger function, and the trigger;
  - the three `ALTER TABLE "item_requests" ADD COLUMN …` (R7);
  - journal entry idx 186, `when` = 1802057507084 + 86 400 000.
  - The header carries the prechecks below, verbatim.
  - No GRANT is needed: `items` UPDATE and `item_requests` INSERT/UPDATE are already granted. The builder confirms this
    against 0169 and later.
- `schema/items.ts`:
  - the three columns on `itemRequests`;
  - a `// NOTE: base_unit history guard (items_unit_history_exists + items_base_unit_fixed) hand-added in migration
    0186` beside `baseUnit` (§5 item 3);
  - the header's T-176 note gains a pointer to 0186 for the parent side of invariant 7.
- `triggers/registry.ts`: `items_base_unit_fixed`: `{ table: 'items', mode: 'origin', kind: 'validator', reason: … }`.
- `repo/items.ts`:
  - `unitHistoryExists(tx, itemId): Promise<boolean>`;
  - the three fields on `ItemRequestRow` and as optional inputs on `insertItemRequest`. Omitted means the DB default.
- `constraint-messages.ts`: `items_base_unit_fixed` (R2).

**TESTER:**
- New `packages/db/tests/integration/t378-s2-base-unit-fixed.test.ts`, as `APP_ROLE` under an org principal.
- Edit `apps/erp/tests/integration/constraint-message-lookup.test.ts` (provoke `items_base_unit_fixed`) and the two
  count guards (36 → 37).

**Tests:**
- **B1** (control). An item with no references: `UPDATE items SET base_unit='pcs'` succeeds.
- **B2** (red on HEAD). One leg each for `stock_movements`, `supplier_invoice_lines`, `pos_item_maps`,
  `production_recipe_lines`, `store_item_thresholds`, `item_pricing`, and `items.parent_slab_item_id` (a sliced child
  of a slab). One referencing row → the UPDATE is refused with SQLSTATE `23514`, constraint `items_base_unit_fixed`,
  and the unit is unchanged. Mutants:
  - drop the trigger → every leg red;
  - drop any one leg's `EXISTS` → that leg red.
- **B3** (the drift guard; the completeness proof B2 cannot give). Read every FK whose target is `items(id)` from
  `pg_constraint`, plus `items`' own three self-references. Each `(table, column)` must appear in
  `pg_get_functiondef('items_unit_history_exists'::regproc)` or in the test's `EXEMPT` list, which is exactly
  `supplier_items.item_id`, `store_item_sellability.item_id` and `item_requests.created_item_id`, each with C2's reason.
  Mutants:
  - delete any one table from the function → B3 red;
  - a scratch migration adding a table with an FK to `items` → B3 red (the next lane's reminder).
  - ✎REV-6 **Match per leg, not by substring, or B3 is vacuous.** A plain `includes(table) && includes(column)` on
    the function text passes when a dropped leg's column survives as a substring elsewhere. `item_id` is inside
    `created_item_id`, `branch_item_id` and `output_item_id`. A table name in a comment also passes it.
    - **Rule:** strip `--` and `/* */` comments from `pg_get_functiondef`. Then require, for each `(T, C)`, a match of
      `/FROM\s+"?T"?\s+(?:\w+\s+)?WHERE\s+(?:\w+\.)?"?C"?\s*=\s*p_item\b/i`.
    - The self-references are the same shape (`FROM items WHERE parent_slab_item_id = p_item`), so they need no special
      case.
    - Extra mutants: move one leg into a comment → B3 red. Change one leg's column to `item_id` on
      `commissary_item_map` → B3 red for `branch_item_id`.
    - B3 also asserts REV-2's outgoing `cost_basis_item_id IS NOT NULL` leg by name.
- ✎REV-7 **B7 (the race, REV-3).** Two connections, both as `APP_ROLE` under the same org.
  - Connection 2 begins a transaction and inserts the item's first `stock_movements` row. It does not commit.
  - Connection 1 runs `UPDATE items SET base_unit = 'pcs'` and must block. Assert that with `pg_locks`, or a
    `lock_timeout` that fires.
  - Connection 2 commits. Connection 1 is then refused with `items_base_unit_fixed`.
  - Mutant: drop the `FOR UPDATE` → connection 1 commits the change → B7 red.
- ✎REV-8 **B8 (fail-closed, REV-4).** As `APP_ROLE` with no `app.org_id` set, `items_unit_history_exists(<B1's item
  id>)` returns **true**. Mutant: delete the NULL-org branch → it returns false → B8 red.
- **B4**. Not every write is a change. On an item WITH history:
  - `SET base_unit = base_unit` succeeds;
  - `SET name = …` succeeds.
  - Mutant: drop the `WHEN (… IS DISTINCT FROM …)`, or use `BEFORE UPDATE` without `OF base_unit` plus no distinct
    check → B4 red.
- **B5**. `items_unit_history_exists`: false on B1's item, true on each B2 item.
  - ✎REV-9 **B5b.** Run the header's P0186b-pre query, read from the migration file with a regex between two marker
    comments, against the B1/B2 fixtures. For every fixture item it must agree with the function. Mutant: drop one
    leg from the header query → B5b red. Without this, the query Ian runs before the push is an unreviewed second copy
    of the rule (I2).
- **B6** (R7). Insert an `item_requests` row without the three columns → `true`, `false`, `false`. Insert with
  `sellable_retail = NULL` → NOT NULL violation. Mutant: a nullable column → B6 red.
- Existing guards: the t354 T-legs (`packages/db/tests/integration/t354-immutability-triggers-always.test.ts`) go red
  if the registry entry is missing. The journal tests go red if the `when` is off the grid.

✎REV-10 **Who adds the deploy-gate rows, and when.** Pushing to main deploys (`docs/ops/README.md` §Deploy gate). So
the rows go into that table **in S2's own commit**, not at wrap-up: one `0186 (T-378 S2)` row, with the check "P0186a
pending requests; P0186b-pre items with/without history (SQL in the 0186 header)" and "Must be" = *"informational, any
count; Ian reads off wrong units"*. `docs/ops/README.md` is added to S2's BUILDER files. The orchestrator still runs the
prechecks with Ian.

**Prechecks (the orchestrator runs them READ ONLY with Ian):**
- **P0186a**: `SELECT count(*) FROM item_requests WHERE status = 'requested';`
  - **Informational. Any number is fine.**
  - These pending rows get `true`/`false`/`false`. Ian confirms each on R5's approve form.
- **P0186b**: the list of which items can still change unit.
  ```sql
  SELECT i.name, i.base_unit, i.status, items_unit_history_exists(i.id) AS has_history
  FROM items i ORDER BY has_history, i.name;
  ```
  - ⚠️ This uses 0186's function, so it runs AFTER the migration. Before the push, run P0186b-pre instead. It is the
    same query, with `items_unit_history_exists(i.id)` replaced by the function body's `EXISTS` list, pasted from the
    migration header.
  - **Informational.** Ian reads off any wrong unit. One without history is fixed on screen after the deploy. One with
    history is Q1. Coke 1.5 is the row to look for.
- No row can violate 0186 at apply time: the trigger guards only future UPDATEs, and the new columns have defaults.

**Gate:** the FULL integration suite on a fresh gate DB (a trigger migration; memory: full-suite-for-migrations), plus
`npm run test` (journal guards), plus the ADR-012 §5 item 8 scratch-DB apply.

---

## S3: the unit-change path, the approve form, the request flags
**BUILDER:**
- `domain/items/index.ts`:
  - `changeItemBaseUnit` (R4, R6);
  - `updateItem` refuses `baseUnit` and drops it from its type (R4);
  - `RequestItemInput` gains the three optional flags, and `requestItem` stores them (R7);
  - `approveItemRequest` takes the R5 overrides and passes the flags to `insertItem`.
  - Export `changeItemBaseUnit` from `@shareat/domain`. `tests/unit/domain-actions-have-callers.test.ts` requires an
    app caller, which is the new action.
- `items/actions.ts`:
  - new `changeItemUnitAction` (`itemId`, `baseUnit`) → `backToItem` with `ok` = **"Unit changed to {unit}."**, or
    `error` = `errorMessage(err)`. On no change, `ok` = **"The unit is already {unit}."**;
  - `requestItemAction` reads the three flags (R7);
  - `approveItemRequestAction` reads `baseUnit` and the three flags (R5).
- `items/[id]/page.tsx`: a "Measured in" section above "What it may be bought and sold as".
  - If `unitHistoryExists` is false: a form with the select (pre-selected to the current unit, options `BASE_UNITS`),
    the button **"Change unit"**, and *"Only a super-admin can change it, and only until the item has stock, counts,
    invoices, recipes, prices or orders."*
  - If true: no form. Instead R2's sentence plus *"It is measured in {unit}."*
- `items/lib.ts`: a loader for `unitHistoryExists` under `withOrgPrincipal`.
- `items/page.tsx`:
  - the approve form (R5): unit select pre-selected to `r.baseUnit`, and the three checkboxes `defaultChecked` from
    the request;
  - the request card's sub-line adds `soldAsLabel` of the request;
  - the small print at `:260-266` is rewritten (R7).
- `CAPABILITY-MATRIX.md`: the `approve_item` note (R4).

**TESTER:**
- New `packages/domain/tests/integration/t378-s3-item-unit-and-flags.test.ts`. Fixture from `items.test.ts:62-105`
  (`fixture`, super-admin/admin/manager actors) and `invoiceWithLines` (`:117`) for history.
- New `apps/erp/tests/integration/t378-s3-item-unit-web.test.ts`. Harnesses as S1.

**Tests (domain):**
- **D1** (red on HEAD: no function). A super-admin on an item with no history, kg → pcs:
  - the unit is `pcs`, and the result is `{ changed: true }`;
  - exactly one `audit_log` row: `action` `change_item_base_unit`, `entity` `items`, `entity_id`, `before`
    `{"baseUnit":"kg"}`, `after` `{"baseUnit":"pcs"}`, `actor_person_id` = super-admin, `source` `web`.
  - Mutants:
    - drop the append → D1 red;
    - swap before and after → D1 red.
- **D2** (the ✗ legs, CAPABILITY-MATRIX). An admin and a manager → `AuthorizationError`, the unit is unchanged, and
  there is no audit row. Mutant: `authorize(…, 'manage_items')` → D2 red.
- **D3**. The same call on an item with one invoice line → refused, `items_base_unit_fixed` in the cause, the unit is
  unchanged, and there is no audit row.
  - D3 proves the plain-sentence path: `errorMessage(err)` = R2's sentence. B2/B3 prove the rule itself.
  - Mutant: the trigger's `CONSTRAINT = 'items_base_unit_fixed'` renamed → D3 red (the generic sentence).
- **D4**. Unchanged unit → `{ changed: false }` and no audit row. Mutant: append unconditionally → D4 red.
- **D5**. `updateItem(tx, manager, id, { baseUnit: 'pcs' } as never)` → refused with R4's sentence, and the unit is
  unchanged. Mutant: `updateItem` passes `baseUnit` through → D5 red.
- **F1 / F2 / F3** (red on HEAD, DEF-599). One leg per flag: request with `isPurchasable: false` / `sellableRetail:
  true` / `sellableWholesale: true`, then approve with no overrides → the item has that flag.
  - Mutants:
    - `requestItem` omits one flag → that leg red;
    - `approveItemRequest` omits one flag (DB default) → that leg red.
  - (`isPurchasable` is the only leg where the default would hide a dropped `true`. That is why its leg sets it to
    false.)
- **F4** (control). A request with no flags given → the item is `true`/`false`/`false`.
- **A1** (R5). Request in kg, approve with `baseUnit: 'pcs'`:
  - the item is in `pcs`;
  - the request row still says `kg`.
  - Mutants:
    - approve ignores the override → A1 red;
    - approve writes the override back onto the request → A1 red.
- **A2**. Request `sellableRetail: false`, approve with `sellableRetail: true` → the item's flag is `true`.
- **A3**. Approve with `baseUnit: ''` → refused (`items_base_unit_check`). The request is still `requested`, and no
  item exists.
  - ✎REV-11 **"Absent" means `undefined` only.** The domain falls back with `??`, never `||`. Only then can A3 be red.
    `approveItemRequestAction` passes `undefined` when the form has no `baseUnit` field, and passes `''` when the
    field was submitted blank. Mutant: `input.baseUnit || req.baseUnit` → A3 red, because the blank approves silently
    in the request's unit.

**Tests (web):**
- **W1**. `/items/{id}` for an item without history: a form with a `baseUnit` select whose selected option is the
  current unit, a "Change unit" button, and an `itemId` hidden input.
  - For an item with history: no `baseUnit` select, and R2's sentence shown.
  - Mutant: the page ignores `unitHistoryExists` → the second leg red.
- **W2**. `changeItemUnitAction`:
  - super-admin, no history → `ok` "Unit changed to pcs.";
  - with history → `error` = R2's sentence;
  - manager → the authorize sentence, and the unit is unchanged.
- **W3** (DEF-599, the form's path). `requestItemAction` with each checkbox state → the `item_requests` row's
  three columns match, one leg per flag. Mutant: the action omits one `flag()` → that leg red.
- **W4** (R5).
  - `/items` with a pending request in `pcs` with `sellableWholesale` true → its approve form has the unit select with
    `pcs` selected, and the wholesale checkbox checked.
  - `approveItemRequestAction` with `baseUnit=kg` and `sellableRetail=on` → the new item is `kg` and retail.
  - Mutant: the approve form omits the select → the first leg red.
- **W5**. The small print no longer says "a request carries only name, kind and unit".

**Smoke (9008):**
1. Request "Coke 1.5 test" in pcs, ticking "Sold à la carte". Approve it as super-admin, changing nothing. The item
   shows pcs and "Sold à la carte".
2. Change its unit to ml and back to pcs: two `ok` banners.
3. Record one supplier invoice line for it. The item page now shows the locked sentence and no form.
4. Sign in as a manager: Change unit is refused in the sentence.

Screenshots of 1–4, at 375px and in dark mode.

---

## Out of scope
- **N1. Restating an item's history in a new unit.** This is Q1. Not built until Ian answers.
- **N2. Editing name, code or kind on screen.** `updateItem` accepts them under `manage_items` with no screen and no
  audit. Q1(a)'s retire-and-recreate needs a rename (the name is unique, `items_org_name_key`). The orchestrator files
  it. If Ian picks Q1(a), it comes first.
- **N3. Auditing the flags edit** (`updateItemFlagsAction`) and store overrides. These are not unit-bearing and
  unaudited today. The orchestrator files it.
- **N4.** The merge refusal's sentence (`index.ts:619`) says *"Fix the unit on one of them first"*. With R2 that is
  possible only while one of them has no history. It is left as is, because rewording it waits on Q1.
- ✎REV-12 **N5.** `setCostBasisItem` does not require equal units between the item and its cost basis (REV-2). The
  orchestrator files it. Also on the register: REV-3's residual race, which is a stock writer that read the unit
  before a committed change.
- The register, the bible, the ROADMAP and the Open Questions page. The orchestrator handles these: it posts Q1 to the
  page (RULES §2, row 252).

## Done when
- S1–S3 are green. Each red is shown red on HEAD or against its named mutant before the build.
- Typecheck is clean, and the unit suite passes.
- The FULL integration suite passes on a fresh gate DB (0186). `npm run build` passes with the dev server stopped.
  Touched files are LF.
- Each slice's smoke is done on 9008 with screenshots.
- Builders touched only their BUILDER paths, and testers only their TESTER paths.
- The orchestrator, at wrap-up:
  - files DEF-598 and DEF-599, fixed with the hashes;
  - logs the 0125 parent-side gap as closed by 0186;
  - adds P0186a/b to the deploy gate;
  - posts Q1;
  - files N2 and N3.

## Questions only Ian can answer
**Q1 (T-378, priority: low, unless P0186b shows a real item stuck). An item that already has records can't change its
unit. Do you want a way to convert its history?**
- **Why:** after this task, a super-admin can change an item's unit freely until the item has stock, counts, invoices,
  recipes, prices or orders. After that, the unit is locked, because relabelling would re-read every record. 40 pcs
  would silently become 40 kg, and ₱25 per piece would become ₱25 per kilo.
- **Example:** "Chicken wings" was set up in **pcs**, but it is bought and counted by the **kilo**. It already has 3
  deliveries, 1 count and a POS map, all in pcs.
- **(a) Keep it locked (recommended).**
  - To fix one, a super-admin retires the item and makes a new one in the right unit. Past records stay in the old
    unit, as they were written. That is what Odoo and ERPNext do.
  - Needs a small rename screen first, because names must be unique (N2).
  - Cost: about half a day.
- **(b) Build a "restate".**
  - A super-admin enters a factor, for example 1 pc = 0.25 kg. In one audited step, every quantity for that item is
    multiplied by 0.25 and every cost per unit divided by 0.25, across about 21 tables: stock, counts, deliveries,
    invoices, recipes, orders, POS maps, thresholds and prices.
  - Posted peso totals and the journal do not change.
  - Cost: about a week, and every new table that stores quantities has to join it. ERPNext once had this tool and
    removed it.

## Ruling log
- 2026-10-06, planner: R1–R7.
  - 0186 is needed: the trigger, the shared history function, and the three request columns.
  - The merge path is not the way out (R3).
  - `approve_item` governs the unit; no new capability (R4).
  - ✎ Found while planning: the 0125 invariant 7 parent-side gap, closed by 0186; v1 shares the `kg` default.
