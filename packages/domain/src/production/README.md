# Production
## Overview
The production document and posting layer (T-176) plus recipe administration (T-413): draft, post, edit and void of slice/convert/cook runs. It consumes and creates FIFO stock layers and posts a balanced journal entry. Validation, unit conversion and recipe-shape rules are pure modules; `index.ts` calls them and never recomputes their arithmetic.

## Interface
- `index.ts`: `PROCESSING_LABOUR_ACCOUNT` (6100), `hasLiveSlicerPaymentCovering`, `createProductionDraft`, `scaleRecipeToTarget`, `postProduction`, `editPostedProduction`, `voidProduction`, types `DraftLineInput`, `CreateProductionDraftInput`, `ProductionDraftOutcome`, `ScaleRecipeInput`, `ScaleRecipeOutcome`, `PostEngineResult`, `PostEngineOutcome`, `ProductionPostOutcome`, `EditProductionInput`, `EditOutcome`, `VoidOutcome`; re-exports `recipes.ts`.
- `recipes.ts`: `createRecipe`, `editRecipe`, `retireRecipe`, `restoreRecipe`, types `RecipeLineInput`, `CreateRecipeInput`, `EditRecipeInput`, `RecipeOutcome`.
- `recipe-shape.ts`: `MAX_RECIPE_QUANTITY_THOUSANDTHS`, `MAX_RECIPE_NAME_LENGTH`, `MAX_RECIPE_LINES`, `recipeQuantityRefusal`, `validateRecipeShape`.
- `unit-conversion.ts`: `CONVERTIBLE_UNITS`, `divideRoundHalfUp`, `convertUnit`, `unitConversionFactor`, `isConvertibleUnit`.
- `validate.ts`: `PRODUCTION_QTY_EPS`, `validateSliceCategories`, `validateProductionLines`, `validateConvertLineage`, `computeValueIdentity`, plus input/result types.
- `cook-usage-view.ts`: `listCookUsageForDay`, `CookUsageLine`.

## Invariants
- Only posting moves stock; drafts move nothing. `authorize()` is `index.ts`'s job; pure math stays in `validate.ts` and `unit-conversion.ts`.
- Each leg's account comes from `INVENTORY_ACCOUNT_BY_ITEM_KIND` (shared with commissary transfers and usage); never hard-code an inventory account.
- `unit-conversion.ts` is the single conversion table (DEF-093): g<->kg and ml<->ltr only; any other pairing returns `null` and the caller must block. A blank unit is not an implicit match.
- Two tiers: HARD blocks refuse the post, SOFT warnings are stamped and let through; promoting a soft warning to hard needs a decision.
- `PRODUCTION_QTY_EPS` (0.010) is a scale tolerance, not the deleted float defence; do not remove it.
- Recipe writes are admin-only (`manage_recipes`), authorize first, quantities are in the item's base unit (0 < qty <= 10,000, 3 decimals), there is no delete (retire/restore), and one audit row is written per write.
- FIFO and ledger primitives (`consume`, `reverseConsumption`, `postEntry`, `reverseEntry`) are reused, never re-implemented.

## Side Effects
- Writes production records, stock layers/movements and recipe rows; posts and reverses journal entries.
- Appends audit rows for recipe writes.
- All functions take the caller's `Tx`; none opens its own transaction.
- `cook-usage-view.ts` is read-only (authorizes `record_stock_movement`).
- `recipe-shape.ts`, `unit-conversion.ts`, `validate.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
