# recipes

## Overview

Recipes at `/inventory/production/recipes`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/production/recipes`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `RECIPES_PATH`, `MANAGE_RECIPES`, `RecipeItemOption`, `fmtQty`, `isUuid`, `canManageRecipes`, `recipeItemOptions`, `RecipeListRow`, `recipeList`, `RecipeDetailLine`, `RecipeDetail`, `recipeDetail`, `withOrgPrincipal`.
- [actions.ts](./actions.ts) — `createRecipeAction`, `editRecipeAction`, `retireRecipeAction`, `restoreRecipeAction`.
- [page.tsx](./page.tsx) — `RecipesPage`.
- [recipe-form.tsx](./recipe-form.tsx) — `FormLine`, `RecipeFields`.
- [[id]](./[id]/README.md) — Recipe at `/inventory/production/recipes/[id]`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [new](./new/README.md) — New recipe at `/inventory/production/recipes/new`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `createRecipe`, `restoreRecipe`, `retireRecipe`; persistence or external operations belong to those called services.
- Repository calls: `itemsRepo.listItems`, `productionRepo.listRecipes`, `productionRepo.getItemsForProduction`, `productionRepo.listRecipeLines`, `productionRepo.getRecipe`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 16,116 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
