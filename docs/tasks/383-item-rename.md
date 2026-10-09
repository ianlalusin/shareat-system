# T-383: rename an item and retire it, so a wrong-unit item can be replaced under its own name

**Status:** S1 DONE 2026-10-08 (rename, super-admin only; live via PR #1, e2451ad; rebuilt on EditableRecord). **S2 not started; RE-SPECIFIED by Amendment B2 (2026-10-09) as S2a (retire/restore/readout) then S2b (a retired item stays usable for consume/move, refused in words for order/receive/price/map/new recipe). B2 supersedes the "## S2" section and the S2 row of the parallel plan. Still no migration.** SPEC 2026-10-08 (Opus planner), written at `1301c8a`.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** **none.** Everything needed exists: `items.status` already admits `inactive` (0050:40), the unique
indexes are what they must be, and `audit_log` has its writer. If Ian picks Q2(b), that option alone needs **0188**.
**Source:** T-378 N2 and Q1(a); bible §13 row 287 (Ian, 2026-10-07: retire-and-recreate, never restate). Ian approved
T-383 on 2026-10-08.
**Defects:** none fixed by number. One v1 finding for the register (§Research 3); the orchestrator files it.

## Goal
- A super-admin can fix a wrong unit on an item that already has records, without SQL: rename the old item, add the
  replacement in the right unit under the old name and code, then retire the old one. Every past record stays exactly
  as it was written, in the unit it was written in (row 287).
- A rename and a retire each leave one `audit_log` row naming the before and the after.
- A retire can be undone (Restore), because the only other undo is SQL.
- Before retiring, the page says what still points at the item (stock on hand, live POS maps, live recipes), so
  nothing is stranded without someone seeing it.

## Research, evaluate, propose (bible row 283; skill invoked before planning)
1. **Verdict.** Build it, small: two domain functions, two actions, two sections on the item page. No migration.
   Kind editing is NOT in scope (§Out of scope N1), and that is a deliberate narrowing of T-378 N2.
2. **The stated reason holds, and is stronger than stated.**
   - `items_org_name_key` is `UNIQUE (org_id, lower(name))` over **every status** (0047:97). Retiring alone does not
     free the name. A retired "Coke 1.5" still owns "coke 1.5".
   - `items_org_code_key` is `UNIQUE (org_id, code)` over every status (0047:94). ⭐ **The code is taken too**, which
     T-378 N2 did not say. A replacement under the same code needs the old item's code changed. So the rename covers
     name AND code.
   - `updateItem` (`packages/domain/src/items/index.ts:83-110`) accepts `code`/`name`/`kind` under `manage_items`, has
     **no caller that passes them** (its only app caller, `updateItemFlagsAction` `actions.ts:127-142`, passes the
     three flags), and writes **no audit row**.
   - `deactivateItem` (`index.ts:144-151`) exists under `manage_items`, writes no audit row, and has **no caller**. Its
     EXEMPT row (`tests/unit/domain-actions-have-callers.test.ts:157-159`) says so: *"an item can be created and never
     retired."*
3. **v1 (ERP-rebuild), read at source.**
   - `src/app/inventory/items/page.tsx:134` edit dialog: name is a free text field; `:397` an active Switch per row.
   - `src/lib/actions/item.actions.ts`: upsert writes `configAuditLog` with the NEW name only (`:101-108`), so the old
     name is lost; `toggleItemActiveAction` (`:118-143`) is manager/admin, store-scoped, reversible, and **writes no
     audit**.
   - **GOAL behind it:** fix a typo or a misleading name, and stop an item being picked without destroying its
     history. **v1's method:** free rename by any manager; a reversible on/off switch.
   - ⚠️ **v1 finding (row 164, `reported`, for the orchestrator to file in DEFECTS-REGISTER A-D):** `upsertItemAction`
     sets `isActive: true` on every save (`item.actions.ts:87`), so editing a deactivated item silently reactivates
     it. v2 does not copy this: rename never touches `status` (test R8).
4. **Industry (pattern only, from product knowledge, not re-read at source this pass).**
   - **Odoo:** a product's name is freely editable (identity is the id, history keeps the id); "Archive" sets
     `active = False`, hides it from selection, keeps every move; "Unarchive" restores it.
   - **ERPNext:** `item_name` is editable; `item_code` (the primary key) is changed through "Rename"; a "Disabled"
     flag blocks new transactions and keeps history. Neither product rewrites history on rename or disable.
   - Both match this spec: rename = relabel the id, retire = hide from new use, restore = undo.
5. **Open source.** Nothing to adopt; this is two updates and two forms.
6. **Effort against use.**
   - **Effort:** S1 (rename) about 2-3 hours; S2 (retire/restore + readout) about 2-3 hours. About half a day, as
     estimated in T-378 Q1(a).
   - **Use:** every wrong-unit item with history (Coke 1.5 is the known one; P0186b lists the rest), every typo in an
     item name, and every item the business stops buying. Today all three need SQL.
   - **If never built:** row 287's ruling has no way to be carried out, and a wrong-unit item stays wrong forever.
7. **Scope.** In scope below. Omissions are in §Out of scope with reasons.

## Census, verified at source
- **Status values:** `ITEM_STATUSES = ['active','inactive','merged']` (`packages/db/schema/items.ts:84`), CHECK
  `items_status_check` (0050:40). `items_merged_shape_check` (0050:45-46): `status = 'merged'` iff
  `merged_into_id IS NOT NULL`. So a merged item set to `inactive` is refused by the DB (raw constraint error today).
- **What `inactive` already does (no change needed):**
  - Hidden from new use: `validateInvoiceLines` (`items/index.ts:302`), `declareSupplierItem` (`:473`), commissary
    catalogue/orders/fulfilment (`commissary/catalogue.ts:202,310,319`, `orders.ts:289`, `fulfilment.ts:193`),
    customers (`customers/index.ts:186`), trade (`trade/index.ts:237`), prepaid (`prepaid/index.ts:238,413`).
  - Hidden from pickers: deliveries, POS map, production (new), usage, commissary catalogue, price lists
    (`listItems(..., { includeInactive: false })` in each `apps/erp/src/app/**/lib.ts`).
  - ⭐ **Still countable:** the count sheet reads `includeInactive: true` (`inventory/counts/lib.ts:122-129`) and
    `onHandByStore` lists every non-zero balance regardless of status (`repo/stock-ledger.ts:143-163`). Stock left on
    a retired item is not lost; it shows on the next count.
  - ⚠️ **Not stopped:** an `active` POS map (`pos_item_maps.item_id`, `status`) keeps depleting a retired item through
    the usage pull, and an `active` recipe keeps consuming it. That is why the readout (R5) exists.
  - The `/items` list already shows `(inactive)` beside a non-active item (`apps/erp/src/app/items/page.tsx:198-199`).
- **Triggers on `items`:** `items_block_slab_recategorise_trg` (kind), `items_base_unit_fixed` (`OF base_unit`),
  `items_check_parent_slab_unit_trg` (unit/parent) (`packages/db/src/triggers/registry.ts:368-383`). None fires on a
  name, code or status change.
- **Code is display-only:** no repo or domain function looks an item up by `code` (grep of `packages/domain/src`,
  `packages/db/src/repo`, `packages/etl/src`: joins for display only). Changing it reinterprets nothing.
- **Duplicate sentences today:** `errorMessage` in `apps/erp/src/app/items/actions.ts:56-66` maps
  `items_org_name_key` and `items_org_code_key` by regex. `CONSTRAINT_MESSAGES`
  (`apps/erp/src/lib/constraint-messages.ts`) has 39 keys at HEAD and none for `items_name_not_blank_check` /
  `items_code_not_blank_check` (0047 CHECKs; `schema/items.ts:153-154`).
- **Capability:** `approve_item` is super-admin alone (`docs/decisions/CAPABILITY-MATRIX.md:110`); `manage_items` is
  super-admin/admin/manager (`:111`). Row 287 names a **super-admin** as the one who retires.

## Rulings (planner)
- **R1. Rename covers name and code, one audited path, `approve_item`.** (Who: Q1, built to its recommendation.)
  - New `renameItem(tx, actor, { itemId, name, code }): Promise<{ changed: boolean }>` in
    `packages/domain/src/items/index.ts`:
    - `authorize(trx, actor, 'approve_item', {})` first;
    - read the item (`gone(..., 'item')` if absent);
    - `name`/`code` are trimmed. **A blank is passed to the DB as blank**, never replaced by the old value; the CHECKs
      refuse it (RULES §6 item 3) and R4 gives the sentence;
    - unchanged when `name === item.name && code === item.code` (exact, case-SENSITIVE: "coke 1.5" -> "Coke 1.5" is a
      real change and the unique index does not conflict with the row itself) -> `{ changed: false }`, nothing
      written;
    - else `itemsRepo.updateItem(trx, orgId, itemId, { name, code })`, then `auditLogRepo.append` with
      `{ action: 'rename_item', entity: 'items', entityId, before: { name, code }, after: { name, code }, source: 'web' }`
      AFTER the UPDATE, so a refused rename writes no audit row.
  - Any status may be renamed (active, inactive, merged): the name is a label, and a merged or retired item may be
    exactly the one holding the name someone needs.
  - `status` is never written by a rename (v1's reactivation bug, §Research 3).
- **R2. `updateItem` stops admitting `name` and `code`.** Same shape as T-378 R4 did for `baseUnit`
  (`index.ts:99-103`): if `'name' in values || 'code' in values`, `throw refuse(S, S)` with
  **S = "Rename an item with Rename on the item's page."**; both keys leave its `values` type. `kind`, `notes` and the
  flags stay (N1). No app caller passes name/code today, so nothing breaks.
- **R3. Retire and restore: one function, `approve_item`, audited, reversible.**
  - Replace `deactivateItem` with `setItemStatus(tx, actor, { itemId, status: 'active' | 'inactive' }):
    Promise<{ changed: boolean }>`. Delete `deactivateItem` (no caller, no test besides the EXEMPT row).
    - `authorize(trx, actor, 'approve_item', {})` first;
    - read the item (`gone` if absent);
    - `item.status === 'merged'` -> `throw refuse(S, S)`, **S = "This item was merged into another, so it cannot be
      retired or restored."** (the DB's `items_merged_shape_check` backs it; the domain check exists only for the
      sentence, the 0122 convention);
    - `item.status === input.status` -> `{ changed: false }`, nothing written;
    - else update `status`, then append `{ action: input.status === 'inactive' ? 'retire_item' : 'restore_item',
      entity: 'items', entityId, before: { status }, after: { status }, source: 'web' }`.
  - **Retire is NOT gated on history.** An item with records is exactly the one row 287 retires.
  - **Retire is NOT gated on stock, maps or recipes** (Q2, built to its recommendation (a)): R5 shows them.
  - Why `approve_item`, not `manage_items` as `deactivateItem` had: retiring removes an identity from every store's
    pickers at once, row 287 says a super-admin does it, and it is the bar that created the identity. The
    `deactivateItem` gate was never reachable (no caller), so tightening it removes nothing anyone used.
- **R4. Sentences.**
  - `CONSTRAINT_MESSAGES` gains two keys (39 -> 41 at HEAD; if another lane moved the count, +2 from that):
    - `items_name_not_blank_check`: **"Give the item a name people will recognise."**
    - `items_code_not_blank_check`: **"Give the item a code."**
  - `actions.ts` `errorMessage`: the two duplicate sentences gain the way out, because the create form is where the
    retire-and-recreate flow hits the wall:
    - name: **"An item with that name already exists — names are one per organisation, ignoring case. To reuse the
      name, rename the existing item on its page first."**
    - code: **"That item code is already in use. To reuse it, change the existing item's code on its page first."**
  - `AuthorizationError` from `renameItem` or `setItemStatus` -> **"Only a super-admin can rename, retire or restore an
    item."** (the T-378 S4-R2 pattern, `actions.ts:213-216`); every other error through `errorMessage(err)`.
  - No sentence carries an id or an item name (they travel in `?error=`).
- **R5. The retire readout (advisory, Q2(a)).** New repo read `itemsRepo.retireReadout(tx, orgId, itemId)` in
  `packages/db/src/repo/items.ts`:
  - `onHand`: `[{ storeName, quantity }]`, from `stock_movements` grouped by `store_id` with `HAVING sum(quantity) <> 0`,
    joined to `stores` for the name, ordered by name;
  - `activePosMaps`: `count(*)` of `pos_item_maps` with `item_id = $item and status = 'active'`;
  - `activeRecipes`: `count(DISTINCT r.id)` of `production_recipes r` with `status = 'active'` and either
    `r.output_item_id = $item` or a `production_recipe_lines` row with `item_id = $item`.
  - Filtered by `org_id` in each leg (tenancy layered, §15.11; RLS backs it). It is a courtesy display, not a rule; no
    domain code branches on it.
  - Loader in `apps/erp/src/app/items/lib.ts` under `withOrgPrincipal`, read only when the item is `active`.
- **R6. The item page (`apps/erp/src/app/items/[id]/page.tsx`).** Gate drawn with the existing
  `mayChangeUnit` probe (`:66-74`, `authorize(tx, actor, 'approve_item', {})`); rename it `isSuperAdmin` or reuse it as
  is, builder's choice, one probe for all three sections. Presentation only; the domain is the enforcement.
  - **Section "Name and code"**, above "Measured in":
    - may: a form (`renameItemAction`) with `name` (text, `required`, `defaultValue={item.name}`), `code` (text,
      `required`, `defaultValue={item.code}`), hidden `itemId`, button **"Rename"**, and the line *"Past records keep
      pointing at this item and show its new name. To replace an item measured in the wrong unit: rename this one
      (for example add "(old)"), add the replacement with the old name, then retire this one."*
    - may not: *"Only a super-admin can rename, retire or restore an item."*, no form.
  - **Section "Retire"**, last on the page (before the price history), drawn only for a super-admin and never for a
    `merged` item:
    - `active`: the readout as plain lines, each only when non-zero: *"Still holds stock at: {store} ({qty}
      {baseUnit}), …. It stays on count sheets until counted out."*; *"{n} live POS map(s) still use it. Point them at
      the replacement first, or sales keep using up this item."*; *"{n} live recipe(s) still use it."*. Then a form
      (`setItemStatusAction`, hidden `itemId`, hidden `status=inactive`) with button **"Retire"** and the line
      *"Retiring keeps every record. It can no longer be picked on new deliveries, invoices, orders, recipes or POS
      maps. You can restore it."*
    - `inactive`: *"Retired."* and a form (hidden `status=active`) with button **"Restore"**.
  - Banners from the actions: rename -> ok **"Renamed."** / **"Nothing to change."**; retire -> ok **"Retired. Its
    records stay."**; restore -> ok **"Restored."**; already in that state -> ok **"No change: it already is."**
- **R7. `CAPABILITY-MATRIX.md`**: the `approve_item` row's note gains *"T-383: also renames an item (name, code) and
  retires or restores it."* No new row, no new capability.

## Parallel plan
| Slice | Files (BUILDER) | Shared state | Order |
|---|---|---|---|
| S1 rename | `packages/domain/src/items/index.ts` (`renameItem`; `updateItem` R2), `apps/erp/src/app/items/actions.ts` (`renameItemAction`; `errorMessage` R4), `apps/erp/src/app/items/[id]/page.tsx` (Name and code section), `apps/erp/src/lib/constraint-messages.ts` (two keys), `docs/decisions/CAPABILITY-MATRIX.md` (R7) | constraint-message count guards; action-link census | first |
| S2 retire | `packages/domain/src/items/index.ts` (`setItemStatus`, delete `deactivateItem`), `packages/db/src/repo/items.ts` (`retireReadout`), `apps/erp/src/app/items/lib.ts` (loader), `apps/erp/src/app/items/actions.ts` (`setItemStatusAction`), `apps/erp/src/app/items/[id]/page.tsx` (Retire section) | action-link census; EXEMPT list | after S1 (same files) |

`packages/domain/src/index.ts` needs no edit: it has `export * from './items'` (`:39`). No slice touches the bible,
`POSTING-PATTERNS.md`, `classification.ts`, `rls/registry.ts`, `triggers/registry.ts` or any migration.

**TESTER paths (disjoint from BUILDER):**
- New `packages/domain/tests/integration/t383-item-rename-retire.test.ts` (fixture from
  `packages/domain/tests/integration/items.test.ts:62-105`, super-admin/admin/manager actors; history via
  `invoiceWithLines`, `:117`).
- New `apps/erp/tests/integration/t383-item-rename-retire-web.test.ts` (harness from
  `apps/erp/tests/integration/t378-s4-unit-form-gate.test.ts`: `RedirectSignal`, `ACTOR_HOLDER`, `renderToStaticMarkup`).
- Edit `apps/erp/tests/constraint-messages.test.ts:173-177` and
  `apps/erp/tests/integration/constraint-message-lookup-mechanism.test.ts:132-136` (39 -> 41, dated comment).
- Edit `apps/erp/tests/integration/constraint-message-lookup.test.ts`: provoke both new keys for real (its `:527`
  guard demands it).
- Edit `apps/erp/tests/t343-s7-wrapper-refusals.test.ts:756` (the name-duplicate sentence, R4).
- Edit `tests/unit/domain-actions-have-callers.test.ts:157-159`: delete the `deactivateItem` EXEMPT row (S2; the
  stale-exemption guard at `:248-263` goes red until it is deleted, and the orphan guard goes red if `setItemStatus`
  or `renameItem` has no app caller).
- Edit `apps/erp/tests/action-link-sweep.test.ts` (census count, `:371`) and `touch-target-baseline.json` only as the
  census run requires, with a dated comment naming the new controls (S1: two inputs + Rename; S2: Retire/Restore).

## Invariants
- I1. No migration, no data surgery, no money moves. A rename or retire rewrites no row but the item's own.
- I2. Past records are never restated (row 287). Nothing here touches `base_unit` or any referencing table.
- I3. `authorize()` is first in every new domain function; no new capability.
- I4. One audited path each: name/code only through `renameItem`, status only through `setItemStatus` (and
  `mergeItemInto`, unchanged).
- I5. The readout is advisory; no code decides anything from it.
- I6. Refusal sentences carry no ids or names.

---

## S1: rename
**Tests (domain, `t383-item-rename-retire.test.ts`):**
- **R1** (red on HEAD: no `renameItem`). Super-admin renames "Coke 1.5"/`COKE15` to "Coke 1.5 (old)"/`COKE15-OLD`:
  the row has both; result `{ changed: true }`; exactly one `audit_log` row, `action` `rename_item`, `entity` `items`,
  `before` `{"name":"Coke 1.5","code":"COKE15"}`, `after` the new pair, `actor_person_id` the super-admin, `source`
  `web`. Mutants: drop the append -> red; swap before/after -> red.
- **R2** (the ✗ legs, CAPABILITY-MATRIX). Admin and manager -> `AuthorizationError`; row unchanged; no audit row.
  Mutant: `authorize(..., 'manage_items')` -> red.
- **R3** (the point of the task, row 287). Item "Coke 1.5"/`COKE15` in `kg` with one invoice line (history).
  - Control leg: `createItem` "coke 1.5"/`COKE15` in `pcs` -> refused (`items_org_name_key`).
  - Rename the old one as R1, then `createItem` "Coke 1.5"/`COKE15` in `pcs` -> succeeds; the old item is still `kg`
    and its invoice line still points at it.
  - Red on HEAD (no `renameItem`).
- **R4.** Rename to another item's name in different case -> refused with `items_org_name_key`; unchanged; no audit.
  Same for another item's code (`items_org_code_key`).
- **R5.** Name `'   '` -> refused, `errorMessage(err)` (via `apps/erp/src/lib/constraint-messages.ts`) = R4's name
  sentence; code `''` -> the code sentence. Unchanged, no audit. Mutant: `name || item.name` -> red (a silent no-op).
- **R6.** Same name and code -> `{ changed: false }`, no audit. **R6b:** "coke 1.5" -> "Coke 1.5" (case only) ->
  `{ changed: true }`, one audit row. Mutants: append unconditionally -> R6 red; compare lower-cased -> R6b red.
- **R7.** `updateItem(tx, manager, id, { name: 'x' } as never)` and `{ code: 'x' }` -> refused with R2's sentence;
  unchanged. Control: the flags edit still works (`items.test.ts:947` stays green). Mutant: pass through -> red.
- **R8.** Rename an `inactive` item -> still `inactive` afterwards (v1's reactivation bug). Mutant: the rename writes
  `status: 'active'` -> red.

**Tests (web, `t383-item-rename-retire-web.test.ts`):**
- **W1.** `/items/{id}` as super-admin: a form with `name` and `code` inputs whose values are the item's, `required`
  on both, an `itemId` hidden input, a "Rename" button. As manager: no `name` input, and R6's sentence. Mutant: drop the
  gate -> the manager leg red.
- **W2.** `renameItemAction`: super-admin -> ok "Renamed."; duplicate name -> error = R4's new name sentence; manager ->
  error = "Only a super-admin can rename, retire or restore an item." and the name unchanged. Mutant: drop the
  `AuthorizationError` mapping -> red (generic approve_item sentence).
- **W3.** `createItemAction` with a taken name -> error = R4's new name sentence (the flow's discoverability).
- Constraint lookup: both new keys provoked for real (blank name, blank code on `items`).

**Smoke (9008, `docs/SMOKETEST.md`):** as super-admin open an item; rename it with "(old)"; the banner says
"Renamed."; the header shows the new name and code; `/items` shows the new name. Rename with a blank name (remove
`required` in devtools): the red banner shows the sentence. Sign in as a manager: the sentence, no form. Screenshots at
375px and in dark mode.

---

## S2: retire, restore, readout
**Tests (domain):**
- **S1** (red on HEAD: no `setItemStatus`). Super-admin retires an active item with history: `status` `inactive`,
  `{ changed: true }`, one audit row `retire_item`, `before` `{"status":"active"}`, `after` `{"status":"inactive"}`.
  The effect, proven: `validateInvoiceLines` now refuses it (existing rule, `index.ts:302`), and
  `itemsRepo.listItems(tx, orgId, { includeInactive: false })` omits it. Mutant: drop the append -> red.
- **S2.** Restore -> `active`, audit `restore_item`. Mutant: one action name for both -> red.
- **S3** (✗ legs). Admin and manager, both directions -> `AuthorizationError`; unchanged; no audit. Mutant:
  `'manage_items'` -> red.
- **S4.** A `merged` item -> refused with R3's sentence; still `merged`; no audit. Mutant: drop the domain check ->
  red (the DB's `items_merged_shape_check` fires instead, and the sentence differs).
- **S5.** Retire an already-`inactive` item -> `{ changed: false }`, no audit.
- **S6** (readout). Item with +5 at store A, +3 then -3 at store B, one `active` and one `retired` POS map, one
  `active` recipe using it as a line: `onHand` = `[{ storeName: A, quantity: '5.000' }]` (format as the column
  returns it), `activePosMaps` = 1, `activeRecipes` = 1. A second org's rows for an item of the same name are not
  counted. Mutants: drop `HAVING <> 0` -> store B appears; drop the map `status` filter -> 2; drop the org filter ->
  red.
- **S7.** `deactivateItem` is gone (the EXEMPT row deleted; the stale-exemption guard green).

**Tests (web):**
- **W4.** Super-admin on an active item with stock at one store and one live POS map: the Retire section shows the
  store line and the POS-map line, and a "Retire" button with hidden `status=inactive`. On an inactive item: "Retired."
  and a "Restore" button. On a merged item: no Retire section. Manager: no Retire section. Mutant: render the readout
  without the `HAVING` filter -> red; drop the gate -> manager leg red.
- **W5.** `setItemStatusAction` retire -> ok "Retired. Its records stay."; restore -> ok "Restored."; manager -> R4's
  authorization sentence.

**Smoke (9008), the whole row 287 flow:**
1. Pick (or make) an item with one supplier invoice line, so its unit is locked ("Measured in" shows the locked
   sentence).
2. Rename it to "<name> (old)" and change its code.
3. On `/items`, add the replacement under the old name and code, in the other unit. It is accepted.
4. Back on the old item: the Retire section lists what still uses it. Retire it. `/items` shows it as `(inactive)`;
   it is gone from the deliveries item picker.
5. Restore it, then retire it again: two banners.
6. As a manager: neither section offers a form.

Screenshots of 1-6 at 375px and in dark mode.

## Out of scope
- **N1. Editing `kind` on screen.** Not needed for row 287, and kind carries database rules with no sentences yet
  (`items_block_slab_recategorise_trg`, the `meat_sliced` parent CHECK, 0125). `updateItem` still admits it under
  `manage_items` with no caller and no audit. The orchestrator files it as a follow-up.
- **N2. Moving stock, POS maps or recipes from the old item to the replacement.** Done with the existing screens
  (a count, the POS map screen, the recipe screen). The readout tells the super-admin what is left. A one-click
  "replace with" is a later task if the readout shows it is needed.
- **N3. A similarity warning on rename.** The super-admin is the duplicate control (row for `approve_item`), and the
  exact-duplicate case is refused by the index.
- **N4. Auditing the flags edit** (T-378 N3) stays where it was filed.
- **N5.** The register (the v1 finding in §Research 3), the bible row recording Q1/Q2's answers, the ROADMAP and the
  Open Questions page are the orchestrator's.

## Done when
- S1-S2 green; each red shown red on HEAD or against its named mutant before the build.
- Typecheck clean; unit suite green (the EXEMPT and census guards included).
- Integration: the two new files plus the touched guards green; the FULL suite before the push (no migration, but
  `updateItem`'s type narrows and `deactivateItem` is deleted, so other callers are proven by the full run, RULES §2).
- `npm run build` passes with the dev server stopped. Touched files are LF.
- Both smokes done on 9008 with screenshots.
- Builders touched only BUILDER paths, testers only TESTER paths.

## Questions only Ian can answer
**Q1 (T-383, priority: medium, blocks nothing: built to (a)). Who may rename an item?**
- **Why:** a name is what everyone searches and picks by. Today no screen can rename, and the hidden code path lets a
  manager do it with no record.
- **Example:** a manager renames "Pork belly" to "Pork belly slab". Every past invoice now shows the new name.
- **(a) Super-admin only, like adding an item (recommended).** One person guards the item list against duplicates;
  the request queue's similarity check is skipped by a rename, so the same person should decide. Typos wait for a
  super-admin.
- **(b) Managers and admins too** (the bar the hidden code path has today). Faster typo fixes; the audit row still
  says who did what.
- Changing (a) to (b) later is one line and one test.

**Q2 (T-383, priority: low, built to (a)). Retiring an item that still has stock on hand.**
- **Why:** after retiring, the item can no longer be received, used or produced, only counted. Stock left on it stays
  in the inventory value until a count zeroes it.
- **Example:** "Coke 1.5 (old)" still shows 24 at Lipa when it is retired.
- **(a) Warn and allow (recommended).** The page lists the stores holding stock, the live POS maps and the live
  recipes before the button. The next count catches the stock, because count sheets include retired items. No
  migration.
- **(b) Refuse until it is counted out**, like a stock room that holds stock cannot be deactivated (0122). Stricter,
  but needs migration 0188 (a trigger, so the full suite on a fresh DB) and about half a day more; and a POS map still
  using the item would keep pushing the balance off zero.

## Ruling log
- 2026-10-08, planner: R1-R7. No migration. Code is in scope (it is unique too); kind is not (N1). Retire is
  reversible and audited. `deactivateItem` is replaced, not wired. One v1 finding for the register.

## Amendment B1 — Ian's answers (2026-10-08, orchestrator)
- **Q1 = a.** Rename (name and code) is super-admin only (`approve_item`). One name for the entire business: names and codes stay unique org-wide, retired items included (unchanged).
- **Q2 = a, with Ian's addition: "warning then allow until fully utilized".** Retiring an item that still has stock WARNS (stores holding stock, live POS maps, recipes) and then allows it. A retired item with stock on hand stays usable for everything that CONSUMES or MOVES existing stock — POS usage/recipes depletion, wastage, transfers, counts — until its on-hand reaches zero everywhere. It can no longer be ordered, received or given a new price/map. Tests must cover both halves (consumption still works after retire; a new purchase/receipt of a retired item is refused in words). If any consume/move path today refuses inactive items, that path is in scope and named in the slice report.

## Amendment B2 — S2 reconciled with B1 and T-386 (2026-10-09, Opus planner)
Supersedes the "## S2: retire, restore, readout" section and the S2 row of §Parallel plan. S1, R1-R7 and the
invariants stand except where a line below changes them. Census taken at `ec6f3f7`. **No migration** (0190 stays free):
`items.status` already admits `inactive`, `audit_log.action` is free text (`rename_item` shipped without one), and no
trigger reads item status.

### B2.1 What changed since S2 was written
- **T-386 is live (rows 294, 296).** Codes are `CHWN-001` shaped, allocated from the name, and a number is **never
  given out again** (`items_code_never_reused`, 0189). A rename **keeps** the code unless the adopt tick is set (T-386
  R8). So the §Goal's "add the replacement ... under the old name and code" is now impossible and wrong. **Corrected
  Goal line:** *rename the old item (its code stays, e.g. "Coke 1.5 (old)" keeps `CK15-001`), add the replacement
  under the old name in the right unit (it gets the next number for its stem, `CK15-002`; `-001` is never reused),
  then retire the old one.* Retire never touches the code. Nothing in S2 frees or reuses a code.
- **B1 (row 290).** A retired item WARNS then ALLOWS, and stays usable for consume/move until its stock is used up.
  The original R6 line "It can no longer be picked on new deliveries, invoices, orders, recipes or POS maps" is
  replaced (B2.4).

### B2.2 The rule (planner ruling)
- **"Retired" is the screen word for `items.status = 'inactive'`.** No new status, no new column.
- **CONSUME/MOVE never branches on item status in the domain**: retired or active, the same code runs, as it does
  today. The "until fully utilized" boundary is drawn where people pick items: a consume/move picker offers a
  retired item **only while its on-hand at that store is above zero** (`listUsableItems`, B2.5). Once it is zero it
  drops out of the pickers; counts keep listing it (they already read every status).
- **Why not refuse consumption at zero in the domain:** (1) transfers already cannot move more than is on hand
  (`stock/transfers.ts:70-74`), so the move path is already zero-bounded; (2) a manual usage or wastage of a retired
  item at zero is exactly the "found two more in the back" case a count fixes, and refusing it records nothing;
  (3) refusing a POS pull line would leave real sales unrecorded in stock (see Q3). A status check on 10 consume
  paths is 10 places to be wrong; a picker rule is one query.
- **ORDER / RECEIVE / PRICE / MAP / NEW RECIPE refuse a retired (or merged) item, in words**, through one sentence
  builder (B2.5). Paths that already refuse with a plain sentence keep their sentence.
- **Receiving a supplier delivery drafted before the retire is refused too** (Ian: "can no longer be ... received";
  the supplier invoice for it is already refused by `validateInvoiceLines`, so allowing the receipt would leave a
  receipt no invoice can match). Commissary deliveries (`kind = 'commissary'`) are a MOVE and are not refused.
- **Production output of a retired item is left as today** (a warning, `production/validate.ts:152`): the post engine
  is shared with editing a posted record (`editPostedProduction`), and a refusal there would block correcting
  history. The output picker keeps hiding retired items, so a new run cannot pick one on screen.

### B2.3 Census (static, grep at `ec6f3f7`; it only NOMINATES: every row marked "test" is proven by a test in S2b)
**CONSUME / MOVE: must accept a retired item (10 paths; none reads item status in the domain today):**
| # | Path | file:line | Today | S2b |
|---|---|---|---|---|
| C1 | Usage record | `packages/domain/src/stock/usage-records.ts:134` `saveUsageDraft`, `:260` `postUsage` | no status read; picker `apps/erp/src/app/inventory/usage/lib.ts:35` hides retired | picker -> `listUsableItems`; test |
| C2 | Wastage (a usage record with a wastage `reasonCode`, `isWastageReason`) | same functions, `usage-records.ts:151` | same | same screen; test |
| C3 | Transfer | `stock/transfers.ts:85` `transferNow`, `:182` `dispatch`, `:233` `receiveTransfer` | no status read; on-hand guard `:70-74`; picker `apps/erp/src/app/inventory/transfers/page.tsx:47-51` hides retired | picker -> `listUsableItems`; test |
| C4 | Count | `stock/count-workflow.ts:186` `commitCount` | no status read; sheet `inventory/counts/lib.ts:129` reads `includeInactive: true` | none; test |
| C5 | POS usage pull, direct map | `pos/usage-pull.ts:180` `buildPlan`, `:317` `finalizeSections`; `pos/plan.ts` | no item status read; only recipe status (`usage-pull.ts:65`, `plan.ts:208`); no on-hand check, so it can go below zero like any item | none; test |
| C6 | POS usage pull, recipe map (recipe depletion) | same; recipe lines from `posMappingRepo.getRecipesForExplosion` | same | none; test |
| C7 | Production input | `production/index.ts:335-345` -> `production/validate.ts:121` | warning only, posts; picker `inventory/production/lib.ts:32` hides retired | inputs picker -> `listUsableItems`; test |
| C8 | Supplier return of an earlier delivery line | `stock/supplier-returns.ts:81` `recordReturn` | no status read | none; test |
| C9 | Branch order filled after the retire (line added before) | `commissary/fulfilment.ts:138` `fulfilLine`, `:303` `dispatchBranchOrder`; `trade/index.ts:841` `receiveTradeOrder` | no status read | none; test |
| C10 | Customer return of an earlier sale | `trade/returns.ts:169` `recordCustomerReturn` | no status read | none; test |

**ORDER / RECEIVE / PRICE / MAP / NEW RECIPE: must refuse in words (13 paths):**
| # | Path | file:line | Today | S2b |
|---|---|---|---|---|
| X1 | Supplier invoice line (buy/receive) | `items/index.ts:369` `validateInvoiceLines` | refuses with a raw `Error` (engineer text, item name) | sentence; test |
| X2 | Declare a supplier for an item | `items/index.ts:540` `declareSupplierItem` | raw `Error` | sentence; test |
| X3 | Branch order line | `commissary/orders.ts:289` `buildBranchLine` | raw `Error` | sentence; test |
| X4 | Commissary proposes a line | `commissary/fulfilment.ts:193` `proposeLine` | raw `Error` | sentence; test |
| X5 | Trade order line | `trade/index.ts:237` `createTradeOrder` | raw `Error` | sentence; test |
| X6 | Supplier delivery drafted | `deliveries/documents.ts:121` `createDeliveryDocument` | **admits it** (picker `inventory/deliveries/lib.ts:49` hides only) | NEW refusal; test |
| X7 | Supplier delivery received | `deliveries/documents.ts:299` `receiveDeliveryDocument` | **admits it** | NEW refusal unless `delivery.kind = 'commissary'`; test |
| X8 | Item price | `items/index.ts:909` `setItemPricing` | **admits it** | NEW refusal; test |
| X9 | POS map | `pos/item-map.ts:41` `upsertPosItemMap` | **admits it** (picker `inventory/pos-map/lib.ts:23` hides only) | NEW refusal (B2.5); test |
| X10 | New recipe | `production/index.ts:111` `createRecipe` | **admits it** | NEW refusal; test |
| X11 | Customer price-list rate | `customers/index.ts:186` `setPrice` | refuses in words | unchanged; test |
| X12 | Commissary offering | `commissary/catalogue.ts:202` `upsertOffering` | refuses in words | unchanged; test |
| X13 | Commissary item map | `commissary/catalogue.ts:310,319` `upsertMap` | refuses in words | unchanged; test |

**Neutral (reads status, is not a use; unchanged, no test):** low-stock and its findings (`repo/low-stock.ts:59,80`,
`repo/findings.ts:1151,1211`: no reorder nag for a retired item, correct), cutover opening gaps (`repo/cutover.ts:86`),
`findSimilarItems` (`repo/items.ts:552`), recode (`items/recode.ts:22`), commissary catalogue SQL
(`repo/commissary.ts:190`), prepaid (`prepaid/index.ts:238,413` read `prepaid_items`, a different table), production
output (B2.2), `setStoreSellability` (`items/index.ts:837`: no read; harmless because X5 refuses the order). Pickers
already hiding retired items on order/receive/price/map screens stay as they are: deliveries, POS map, commissary
catalogue, trade orders, price lists (`customers/price-lists/[id]/page.tsx:32`), AP (`ap/lib.ts:164`), commissary
orders (`commissary/orders/lib.ts:183`), production outputs.

**What a POS import does when a live map points at a retired item (C5/C6):** the pull plans and posts the depletion
against the retired item at the map's location exactly as for an active item, and keeps doing so below zero (there
is no on-hand check in `plan.ts` or `usage-pull.ts`). Only a retired **recipe** blocks a line (`plan.ts:208`). The
retired item's page shows the live maps (B2.4) so someone re-points them; Q3 asks whether to block instead.

### B2.4 S2a: retire, restore, readout (the original S2, corrected)
**BUILDER paths:** `packages/domain/src/items/index.ts` (`setItemStatus` per R3; delete `deactivateItem` `:211`),
`packages/db/src/repo/items.ts` (`retireReadout` per R5), `apps/erp/src/app/items/lib.ts` (loader),
`apps/erp/src/app/items/actions.ts` (`setItemStatusAction`; the rename authorization sentence `:246`),
`apps/erp/src/app/items/[id]/page.tsx` (Retire section; the may-not sentence `:142`).
**TESTER paths:** `packages/domain/tests/integration/t383-item-rename-retire.test.ts`,
`apps/erp/tests/integration/t383-item-rename-retire-web.test.ts`, `tests/unit/domain-actions-have-callers.test.ts`
(delete the `deactivateItem` EXEMPT row `:157-159`), `apps/erp/tests/action-link-sweep.test.ts` and
`touch-target-baseline.json` (census, dated comment naming Retire/Restore).

Changes to R3-R6 (everything else in them stands):
- **Sentence.** The authorization sentence becomes R4's **"Only a super-admin can rename, retire or restore an
  item."** in `actions.ts` (rename, retire, restore) and on the page (`[id]/page.tsx:142`). S1 shipped
  "Only a super-admin can rename an item." because managers could still reach `deactivateItem`; S2a removes that.
- **Readout read for `active` AND `inactive`** (never `merged`). R5 unchanged otherwise.
- **Retire section, `active`:** the readout lines as R6, the POS-map line now: *"{n} live POS map(s) still use it.
  Point them at the replacement, or sales keep using up this item, even below zero."* The line under the button:
  *"Retiring keeps every record. It can no longer be ordered, received, priced, mapped to a POS item or put on a new
  recipe. Stock already on hand can still be used, wasted, moved and counted until it runs out. You can restore it."*
- **Retire section, `inactive`:** *"Retired."*, then the readout lines (stock line ends *"It can still be used,
  wasted, moved and counted until it runs out."*), then the Restore form.
- Audit actions exactly `retire_item` / `restore_item`, entity `items`, before/after `{ status }`, source `web`.

**Tests, domain:** S1-S7 of the original section stand, with S1's effect leg reduced to
`itemsRepo.listItems(tx, orgId, { includeInactive: false })` omits it (the invoice-line sentence moves to S2b X1).
**Tests, web:** W4 and W5 stand; add **W4b** an `inactive` item with +5 at store A shows "Retired.", the store line
with "until it runs out", and the Restore button; **W5b** a manager's rename now gets the combined sentence (update
`NOT_SUPER_ADMIN` `:56`). Mutant: the loader reads the readout only when `active` -> W4b red.

### B2.5 S2b: a retired item stays usable; the rest refuse in words
**Domain contract (BUILDER):**
- New `packages/domain/src/items/not-active.ts`, imported directly by each caller (not via `../items`, to avoid an
  import cycle with `commissary/catalogue.ts`):
  ```ts
  export function notActiveItemSentence(status: string, what: string, where?: string): string {
    const lead = where ? `${where}: this item` : 'This item';
    return status === 'merged'
      ? `${lead} was merged into another, so it cannot be ${what}. Use the item it was merged into.`
      : `${lead} is retired, so it cannot be ${what}. Use its replacement, or ask a super-admin to restore it.`;
  }
  ```
  No id, no item name (I6). Throwing paths use `throw refuse(<their existing raw text>, notActiveItemSentence(...))`;
  outcome-returning paths return `{ ok: false, reason: notActiveItemSentence(...) }`. The test is
  `item.status !== 'active'` everywhere (so merged is refused too).
- Per path (`what`, `where`):
  - X1 `validateInvoiceLines`: `'bought or received'`, `` `Line ${i + 1}` ``.
  - X2 `declareSupplierItem`: `'bought from a supplier'`, none.
  - X3 `buildBranchLine`: `'ordered'`, none. X4 `proposeLine`: `'added to an order'`, none.
  - X5 `createTradeOrder`: `'ordered'`, `` `Line ${n}` `` (its existing `n`).
  - X6 `createDeliveryDocument`: after the per-line parse loop, read each line's item (`itemsRepo.getItemById`);
    absent -> leave to the FK as today; not active -> `'received'`, `` `Line ${n}` ``.
  - X7 `receiveDeliveryDocument`: after the draft check, when `delivery.kind !== 'commissary'`, each line's item not
    active -> `'received'`, `` `Line ${line.lineNo}` ``. Nothing written before the refusal.
  - X8 `setItemPricing`: after the item read, `'given a new price'`, none.
  - X9 `upsertPosItemMap`, `mode = 'direct'`: read the item; not active -> refuse with `'mapped to a POS item'`, none,
    **unless** the map being written already points at that same item (the `editMapId` target via
    `posMappingRepo.getMapById`, else `posMappingRepo.getActiveMapByKey`), so a quantity edit on an existing map to a
    retired item still saves. Recipe and no-stock maps unchanged.
  - X10 `createRecipe`: read output and line items with `productionRepo.getItemsForProduction`; output not active ->
    `'put on a new recipe'`, `'The output'`; a line not active -> same `what`, `` `Ingredient line ${i + 1}` ``.
    Checked before `insertRecipe`.
  - X11-X13 untouched.
- New repo read `itemsRepo.listUsableItems(tx, orgId, storeId): Promise<ItemRow[]>` in
  `packages/db/src/repo/items.ts`: `status = 'active'`, plus `status = 'inactive'` items whose
  `sum(stock_movements.quantity)` for that `store_id` is **> 0**; filtered by `org_id`; ordered by name; same columns
  as `listItems`.
- Pickers: `inventory/usage/lib.ts:35` and `inventory/transfers/page.tsx:47-51` use `listUsableItems` for the current
  store; `inventory/production/lib.ts` adds `inputItems` from `listUsableItems` and `production/page.tsx:132` passes
  it to the Inputs rows (Outputs keep `items`, active only). A retired option is labelled `"{name} (retired)"`.

**BUILDER paths:** `packages/domain/src/items/not-active.ts` (new), `packages/domain/src/items/index.ts`,
`packages/domain/src/deliveries/documents.ts`, `packages/domain/src/commissary/orders.ts`,
`packages/domain/src/commissary/fulfilment.ts`, `packages/domain/src/trade/index.ts`,
`packages/domain/src/pos/item-map.ts`, `packages/domain/src/production/index.ts`, `packages/db/src/repo/items.ts`,
`apps/erp/src/app/inventory/usage/lib.ts`, `apps/erp/src/app/inventory/transfers/page.tsx`,
`apps/erp/src/app/inventory/production/lib.ts`, `apps/erp/src/app/inventory/production/page.tsx`.
**TESTER paths (disjoint):** new `packages/domain/tests/integration/t383-retired-item-usable.test.ts`, new
`apps/erp/tests/integration/t383-retired-item-pickers-web.test.ts`. Fixtures are borrowed (copied, not imported
across files) from `usage-records.test.ts`, `stock-transfers.test.ts`, `count-workflow.test.ts`,
`pos-usage-pull.test.ts`, `production.test.ts`, `supplier-returns.test.ts`, `branch-orders.test.ts`,
`customer-returns.test.ts`. Retire with `setItemStatus` (S2a); every stock-bearing item gets its stock **before** the
retire.

**Tests, domain (`t383-retired-item-usable.test.ts`):**
- **C1-C10 (the consume half; each red if a status check is added to that path).** For each: an item with stock at
  store A (and, for C9/C10, a line or sale made while active), retired, then the path runs and succeeds, and the
  `stock_movements` row lands on the retired item. C1 usage 2 of 5 -> on-hand 3. C2 the same with a wastage
  `reasonCode`. C3 `transferNow` 1 between two locations of A. C4 count it to 0 -> committed, on-hand 0. C5 a direct
  map's pull finalised -> the retired item depleted; C5b with on-hand already 0 -> it goes below zero (documents Q3's
  built answer). C6 a recipe map whose ingredient is retired -> depleted. C7 `postProduction` with the retired item
  as input -> posted (a warning is allowed). C8 `recordReturn` of its earlier delivery line. C9 an order line
  accepted while active, item retired, then `fulfilLine` + `dispatchBranchOrder` + `receiveTradeOrder` succeed.
  C10 `recordCustomerReturn` of a sale made while active.
- **X1-X13 (the refuse half).** Each refused with exactly its `notActiveItemSentence` (X11-X13: their existing
  sentence) and nothing written (row counts before/after). X1 also with a `merged` item -> the merged sentence.
  X7: a draft supplier delivery made while active, item retired, receive -> refused; control leg: a commissary
  delivery of a retired item receives. X9 control leg: editing the quantity of an existing direct map to the retired
  item -> ok. Each also has an active-item control leg that succeeds. Mutants: drop each new check -> its leg red;
  `=== 'inactive'` instead of `!== 'active'` -> the X1 merged leg red; X9 without the same-item exception -> the
  control leg red; X7 without the commissary exception -> the control leg red.
- **L1 `listUsableItems`.** At store A: active, no stock -> listed; retired +5 -> listed; retired +3 then -3 -> not;
  retired -2 -> not; merged with stock -> not; another org's retired item with stock -> not. At store B the +5 item
  -> not. Mutants: `<> 0` instead of `> 0` -> the -2 leg red; drop the store filter -> the store-B leg red; drop the
  org filter -> red.

**Tests, web (`t383-retired-item-pickers-web.test.ts`):** **W6** `usageScreenData(orgId, storeA).items` contains
"{name} (retired)"; for store B it does not. **W7** the transfers page for store A renders that option; for B not.
**W8** `productionScreenData`: `inputItems` has it, `items` does not. Mutant: the usage loader back on
`listItems(..., { includeInactive: false })` -> W6 red.

**Smoke (9008), extends the original S2 smoke:** step 3 now: the replacement is accepted under the old name and the
code field suggests the next number (`...-002`), never the old item's code. After step 4 (retire with stock): on the
usage screen for that store the old item shows "(retired)" and a usage of it posts; it is absent from the deliveries
and POS-map pickers; count it to zero, and it leaves the usage picker. Screenshots at 375px and in dark mode.

### B2.6 Order, size, done-when
- **S2a then S2b** (shared files: `items/index.ts`, `repo/items.ts`). Tester first in each.
- **Size:** S2a about 2-3 hours as before. S2b about 1 day (tester most of it: 10 consume legs on borrowed fixtures,
  13 refusal legs, L1). Builder for S2b about 3 hours.
- Done-when as §Done when, plus: the full suite in CI on the PR (S2b narrows behaviour in 8 domain modules, so other
  callers are proven by the full run, RULES §2), and the slice report names every census row with the test that
  proves it, and any row the test showed to be wrong.

### B2.7 Question only Ian can answer
**Q3 (T-383, priority: low, blocks nothing: built to (a)). A live POS map still points at a retired item whose stock
has run out.**
- **Why:** the POS keeps selling the menu item; the pull keeps using up the retired stock item.
- **Example:** "Coke 1.5 (old)" is retired at 0 at Lipa; the POS item "Coke" still maps to it; tonight's pull takes
  it to -12.
- **(a) Keep depleting, below zero, like any item today (recommended).** Sales are always recorded in stock; the
  retired item's page lists the live map; the next count corrects it; re-pointing the map is one edit.
- **(b) Block that pull line once the retired item is at zero at that store**, so the day cannot be finalised until
  someone re-points the map. Stricter, but a forgotten map stops a store's day close; about half a day more.
