# T-413: Production recipe admin (list, create, edit, retire)

**Status:** **DONE 2026-10-16, merged a879264 (PR #28).** Questions answered BY DEFAULT ONLY (recommended options built; Ian has not answered on the page yet). | Earlier: SPEC DRAFT 2026-10-15 (Opus planner). Not built. **No migration** (recommended option; every column exists
since T-176). ≈1.5 lane-days, two slices. **Sonnet lane** (stock consumption). **Blocks T-409's release:** once T-409
ships, a cook needs an active recipe, and no screen makes one. Two questions for Ian below; the recommended option is built.

## Goal

An admin keeps the business's batch recipes (sauces, marinades, prep batches) on one ERP screen: list them, add one,
change one, retire one, bring one back. Managers and staff see the list read-only. Bible §13 row 315: recipes are
Shareat standards, admin-only, never granted below admin; stores only suggest changes (suggestions are out of scope).

## Source

- T-409 (`docs/tasks/409-production-slice-pickers.md`, branch `lane/t409`): `createProductionDraft` derives a cook's
  inputs from the recipe (`deriveCookInputs`, T-176's `scaleRecipeToTarget`); `postProduction` refuses when stored
  inputs differ from the recipe scaled to the output (`cookPostRefusal`); `editPostedProduction` re-derives from the
  CURRENT recipe.
- Code read 2026-10-15: `packages/domain/src/production/index.ts:112` `createRecipe` (authorizes `manage_recipes`,
  T-403; no app caller, no audit row); no `editRecipe` / retire anywhere. `packages/db/schema/production.ts:56`
  (`production_recipes`: `name` unique per org on `lower(name)` across statuses, `output_quantity` (14,3) > 0,
  `status` active|inactive, `updated_at`; `production_recipe_lines`: item, quantity (14,3) > 0, free-text `unit`).
- Other readers of a recipe: v1 POS maps in `recipe` mode (`pos_item_maps.recipe_id`) and menu depletion rules
  (`menu_depletion_rules.recipe_id`), exploded by `pos/plan.ts` from ACTIVE recipes only
  (`posMappingRepo.getRecipesForExplosion`). `usage-pull.ts:539` already refuses finalizing a section whose recipe
  lines moved under it; `depletion-source.ts` `refuseWhilePlanned` is the pattern for refusing up front.
- Capability: `manage_recipes` exists (CAPABILITY-MATRIX row 90; org, super admin + admin only). Reused; no new one.

## Research (row 283: v1's goal, not its method)

**v1's method** (`ERP-rebuild/src/lib/actions/production-recipe.actions.ts:77-205`, `app/production-recipes/recipe-editor.tsx`):
admin-only upsert that overwrites the recipe in place; free-text yield unit ("servings" default); output item optional;
archive/restore flag; hard delete. **v1's goal:** one admin-owned standard per batch, editable as the kitchen learns.
**Where v1 misses it:** the yield unit is free text, so "5 servings" cannot scale stock; an in-place overwrite silently
changes any cook in flight; hard delete orphans history. **v2 beats it:** quantities only in base units (scalable by
construction), edits refused while something unfinished depends on the recipe (never silent), retire instead of delete,
every change in the activity log with before and after.

## Rulings (planner; binding unless Ian answers otherwise)

- **R1. Units (orchestrator ruling).** Output quantity is ALWAYS in the output item's base unit; each ingredient
  quantity in that ingredient's base unit. Bounds for both: `0 < qty <= 10,000`, at most 3 decimals (column (14,3)).
  Labels: "Output quantity, in <base unit>" and per line "Quantity, in <base unit>". The form sends no unit; the domain
  writes the item's `base_unit` on every line it saves. A caller-sent unit that differs from the base unit is refused
  (refused, not converted). Recipes already stored in another unit stay readable (cook converts, DEF-093); the edit form
  pre-fills such a line converted to the base unit with `convertUnit`, and refuses to open it in words if unconvertible.
- **R2. Shape guards (create and edit), all before the first write, each a plain sentence:** name required, trimmed,
  ≤ 80 chars, unique per org ignoring case (retired names stay taken; say so); output item exists in the org and is
  active (T-383 X10 sentence reused); 1 to 50 ingredient lines; each ingredient active and in the org; no ingredient
  twice; the output item is not also an ingredient.
- **R3. Versioning: edit in place, refused while anything unfinished depends on the recipe (Q1, recommended).**
  `editRecipe` replaces the header and lines in one transaction and refuses, naming the first case and counting the rest:
  - E1 any `draft` production record (any store) with this `recipe_id` ("Post or void the cook drafted at <store> on
    <date> (and N more) first: it was worked out from this recipe.");
  - E2 any store with a `planned` usage pull whose active v1 map or in-force depletion rule names this recipe
    (`refuseWhilePlanned`'s sentence, store and date);
  - E3 (T-409 seam) `editPostedProduction` on a cook first runs `cookPostRefusal` on the record's CURRENT unreversed
    lines; a mismatch means the recipe changed since posting: "The recipe '<name>' changed after this cook was posted.
    Void it and record it again." Void is unaffected (it reverses stored legs).
  Posted records keep their stored lines, so history never moves. The before/after lines live in the audit row.
- **R4. Retire / restore.** `retireRecipe` sets `inactive`; allowed with drafts open (T-409 loads a draft's recipe in any
  status). Refused while an active v1 map or an in-force or scheduled depletion rule names it (each pull would block),
  naming the first POS item or menu variant and the count. `restoreRecipe` sets `active`; refused if the output item or
  any ingredient is retired. No delete, ever (FKs are `restrict`).
- **R5. Audit (T-402 catalogue, `packages/db/src/audit/catalogue.ts`):** four entries `production.recipe_create`,
  `production.recipe_edit`, `production.recipe_retire`, `production.recipe_restore`; category `stock`, `normal`, scope
  `org`, entity `production_recipes`, owner `T-413`. `before`/`after` = `{ name, outputItemId, outputQuantity, lines:
  [{ itemId, quantity, unit }] }` (create: before null). Appended after the write, same transaction.
- **R6. Screens.** `/inventory/production/recipes` (list: name, makes "<qty> <base unit> of <item>", ingredient count,
  status, filter active/retired/all), `/new`, `/[id]` (view; edit form, retire/restore buttons only when the viewer holds
  `manage_recipes`, per T-403 R5). Read gate = the production page's existing read gate. A "Recipes" link on
  `/inventory/production`. Ingredient picker reuses the item picker T-409 uses, showing each item's base unit.

## Contract

| Function / file | Change |
|---|---|
| `createRecipe` | R1, R2, R5 (create entry). Input `lines[].unit` becomes optional (omitted → base unit) |
| `editRecipe(tx, actor, { recipeId, name, outputItemId, outputQuantity, lines })` | new; R1, R2, R3 E1/E2, R5 |
| `retireRecipe` / `restoreRecipe(tx, actor, { recipeId })` | new; R4, R5. All four authorize `manage_recipes` first |
| `editPostedProduction` (cook branch) | R3 E3: one call to the existing `cookPostRefusal` before re-deriving |
| `productionRepo` | `updateRecipe`, `replaceRecipeLines` (delete + insert, one tx), `setRecipeStatus`, `listDraftRecordsUsingRecipe`, `listRecipeDependents` (active maps + in-force/scheduled rules) |
| `catalogue.ts` | R5's four entries |
| `apps/erp/src/app/inventory/production/recipes/**` | R6 pages + `actions.ts` (thin; every rule in the domain) |

## Invariants (each with a named mutant)

1. Manager and staff are refused all four writes (`AuthorizationError`, `.capability = manage_recipes`); admin succeeds.
   *Mutant: editRecipe authorizes `manage_items`.*
2. Output `0`, `-1`, `10000.001`, blank, `abc` → refused; `10000` and `0.001` accepted. Same for a line. *Mutants: `<`
   for `<=`; cap dropped on lines.*
3. A line saved without a unit stores the item's base unit; a line sent as `g` for a `kg` item is refused, no row.
   *Mutant: unit passed through.*
4. Duplicate ingredient, output-as-ingredient, retired ingredient, 0 lines, 51 lines, a name that collides by case →
   each refused, no row, no audit row. *Mutant: each guard removed in turn.*
5. Edit with a draft cook on the recipe → refused naming store and date; recipe and lines unchanged. Void the draft →
   edit succeeds. *Mutant: E1 query filters `posted` instead of `draft`.*
6. Edit while a store whose map names the recipe has a planned pull → refused; a planned pull at a store that does not
   use it does not block. *Mutants: E2 removed; E2 ignores the store filter.*
7. Post a cook, edit the recipe, then `editPostedProduction` → refused with the E3 sentence; the posted lines and stock
   are unchanged; void still succeeds. *Mutant: E3 call removed (edit re-derives with the new ratios).*
8. Retire with an active map naming it → refused; with only a draft open → allowed, and the draft still posts.
   *Mutant: retire skips the dependents check.*
9. Each write appends exactly one audit row with the R5 action and before/after (exact JSON); a refused write appends
   none. *Mutant: append placed before the guards.*
10. A recipe from another org is invisible to list/get and refused for edit. *Mutant: `org_id` filter dropped.*
11. Screen: a manager sees the list and recipe detail with no edit, retire or new button; an admin sees them; the form
    label reads "Output quantity, in kg" for a kg item. *Mutant: buttons render without the capability check.*

## Slices

| Slice | What | TESTER writes (first, red) | BUILDER owns | Size |
|---|---|---|---|---|
| S1 | Domain + repo + audit: R1–R5, invariants 1–10 | `packages/domain/tests/integration/t413-s1-recipe-admin.test.ts`, `packages/domain/tests/unit/t413-recipe-shape.test.ts`, `packages/db/tests/t413-catalogue.test.ts` | `packages/domain/src/production/index.ts` (+ a new `recipes.ts` beside it if it helps size), `packages/db/src/repo/production.ts`, `packages/db/src/audit/catalogue.ts` | 1 day |
| S2 | Screens + actions: R6, invariant 11 | `apps/erp/tests/integration/t413-s2-recipe-screens.test.ts` | `apps/erp/src/app/inventory/production/recipes/**`, the link in `apps/erp/src/app/inventory/production/page.tsx`, `apps/erp/tests/action-link-sweep.test.ts` (register new actions) | 0.5 day |

S1 needs T-409 merged first (E3 calls `cookPostRefusal`). Existing T-176 / T-371 / T-403 fixtures that author a line in
a non-base unit are moved to the base unit and listed in the PR (fixture change, not a rule change).

## Out of scope

Recipe suggestions from stores (row 315 follow-up); steps, photos, description (Phase 7 cookbook); slab-slicing yields
(no standard, row 315); the usage-tolerance band (T-401 S5); loading v1's recipes (cutover ETL).

## Questions for Ian

- **Q1. Changing a recipe that a cook in progress uses.** (a, recommended) Refuse the change until those cooks are
  posted or voided; the screen names them. Small, no database change; cooks are same-day, recipe changes are rare.
  (b) Keep every version: a change makes version 2, unfinished cooks keep version 1. Never blocks the admin, but needs a
  database change and touches the POS usage pull. ≈+1 lane-day.
- **Q2. Retiring a recipe the POS usage still uses.** (a, recommended) Refuse until those POS items are re-mapped, so
  the daily usage never silently skips them. (b) Allow and warn; those items show as blocked in each pull until fixed.

## Done when

Invariants 1–11 green with each named mutant killed; full unit suite and the T-176, T-371, T-403, T-409 and T-401 S5
integration suites green; `typecheck` clean; the catalogue guard passes; CI green on the PR. Migration: none (if Ian
picks Q1 (b), the next free number at build time; 0198 is taken).
