# T-383: rename an item and retire it, so a wrong-unit item can be replaced under its own name

**Status:** SPEC 2026-10-08 (Opus planner). Written at HEAD `1301c8a`.
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
