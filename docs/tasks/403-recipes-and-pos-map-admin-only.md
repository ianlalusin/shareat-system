# T-403: Recipes and the v1 POS mapping are admin-only

**Status:** SPEC 2026-10-13 (orchestrator). Ian, 2026-10-13: "only admin can edit recipe", then "go with recommendation":
the rule covers production recipes and the v1 POS item mapping (`manage_pos_map`) as well as the T-401 menu recipes.

## Goal
Only super admin and admin may create or change a recipe, meaning anything that decides how much stock a sale
or a batch consumes. Store managers keep posting, voiding and drafting as today; they lose only the recipe edit.

## Today
- Production recipes: `createRecipe` (`packages/domain/src/production/index.ts:112-113`) authorizes
  `manage_items`, which managers hold. Grep for every other recipe write (edit, deactivate, lines) and list it.
- The v1 POS mapping: `packages/domain/src/pos/item-map.ts:43` authorizes `manage_pos_map` (store-scoped,
  Manager+, `packages/auth/src/capabilities.ts` T-177 block).

## Contract
1. New capability `manage_recipes` (org-scoped; super admin ✅, admin ✅, manager ✗, staff ✗), area as for
   production. Every production-recipe write authorizes `manage_recipes` instead of `manage_items`.
   `manage_items` itself is unchanged.
2. `manage_pos_map` becomes super admin and admin only (manager ✗). It keeps its store scope.
   The staff-open "request a mapping" capability (T-177 invariant 7) is unchanged, so staff can still flag an
   unmappable item mid-pull. An admin then maps it.
3. `docs/decisions/CAPABILITY-MATRIX.md` gets the new row and the changed cells.
4. The v1 mapping is a temporary bridge. A note in the T-177 task doc says each store's mappings are deleted
   once that store is on POS v2. No deletion is built here.

## Invariants (tester writes red first; one named mutant each)
- R1: a manager is refused every production-recipe write with `AuthorizationError` (`.capability`
  = `manage_recipes`); an admin succeeds. Mutant: the write still authorizes `manage_items`.
- R2: a manager is refused `manage_pos_map` at their own store; an admin succeeds. Mutant: the manager cell stays ✅.
- R3: staff can still request a mapping. Mutant: the request path is gated by `manage_pos_map`.
- R4: the capability matrix and `capabilities.ts` agree (the existing matrix guard test passes with the new rows).
- R5: no screen offers a recipe or mapping edit control to a manager (server-side refusal is the real guard;
  the screen must not show a button that always fails). Mutant: the button renders for a manager.

## Paths
- TESTER: `packages/domain/tests/integration/t403-*.test.ts`, `packages/auth/tests/t403-*.test.ts`,
  `apps/erp/tests/**/t403-*.test.ts(x)`.
- BUILDER: `packages/auth/src/capabilities.ts`, `packages/domain/src/production/index.ts` (authorize lines
  only), `packages/domain/src/pos/item-map.ts` (only if needed), the recipe and mapping screens'
  capability checks under `apps/erp/src/app/**`, `docs/decisions/CAPABILITY-MATRIX.md`,
  `docs/tasks/177-*.md` (the bridge note).

## Out of scope
- Deleting mappings per store (it happens at each store's POS v2 move).
- The T-401 menu depletion rule, which is already admin-only in T-401's spec.

## Done when
R1-R5 are green, the full unit suite and the T-176/T-177/T-388 integration suites stay green, and CI is green on the PR.
Size: S (0.5 lane-day). No migration.
