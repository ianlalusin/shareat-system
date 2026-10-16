# T-409: Slicing takes only a meat slab and makes only sliced meat; cooking always runs from a recipe

**Status:** **DONE 2026-10-16, merged a879264 (PR #28).** Questions answered BY DEFAULT ONLY (recommended options built; Ian has not answered on the decisions page yet). | Earlier: SPEC DRAFT 2026-10-15 (Opus planner). Not built. **No migration.** ≈1.5 lane-days, two slices.
**Sonnet lane** (posts stock and GL). Two questions for Ian below; the recommended option is built.

## Goal

On the production screen a slicing run can only pick a meat slab as its input and sliced meat as its output, and the
server refuses anything else (hard rule, not a warning). A cooking run starts from a recipe: the cook picks the recipe
and says how much was made; the ingredients are worked out from the recipe, so they are exact and cannot be mistyped.

## Source

- Worklist `docs/plans/2026-10-14-ian-answers-worklist.md` #4; review `docs/feedback/2026-10-14-ian-feedback-review.md`
  item 19, gaps (1) and (2). Bible §13 row 326 (convert stays the same-slab re-cut; slice pay is #15, not here).
- `docs/tasks/176-production-and-prep-conversion.md` §8 invariant 3 ("SOFT ... never promoted to blocks without a
  decision"): **this spec is that decision for the slice category rule only** (worklist #4 says "hard"). §10.4's
  lineage-mismatch warning (trimmings pooling across primals) **stays soft**.
- Code read 2026-10-15: `apps/erp/src/app/inventory/production/page.tsx` (one form, `kind` select, every item in both
  pickers, recipes loaded by `lib.ts` and never shown); `.../production/actions.ts:51` `saveProductionDraftAction`
  (never sends `recipeId`); `packages/domain/src/production/index.ts:185` `createProductionDraft` (stores `recipeId`,
  checks nothing about it), `:247` `scaleRecipeToTarget` (built in T-176, **called by nothing**), the shared post/edit
  preparation (~340-400) that passes `category: item.kind` into `validateProductionLines`;
  `packages/domain/src/production/validate.ts:88` `validateProductionLines`; `packages/db/src/repo/production.ts`
  (`getRecipe`, `listRecipeLines`, `getItemsForProduction`); item kinds `packages/db/schema/items.ts:49`.

## Research (row 283)

**v1's method.** One production screen; slice pickers list everything; cook (`production-recipe.actions.ts`) scales a
recipe but never converts units (DEF-093, a 1000× error class).
**v1's goal.** Slicing turns slabs into pieces; cooking consumes exactly what the recipe says.
**Where v2 misses it today.** The pickers allow any item, and the cook form never sends a recipe, so "exact ingredients"
is not enforced anywhere; `scaleRecipeToTarget` (the DEF-093 fix) is dead code.
**v2 design that beats it.** Filter the pickers AND refuse on the server (a filtered picker alone is bypassable,
§2 rule 7). Derive cook inputs on the server from the recipe via `scaleRecipeToTarget`, so there is no typed input
line that could disagree with the recipe.

## Rulings (planner)

- **R1. Slice category is HARD.** In `validateProductionLines`, for `kind = 'slice'`: every input `category` must be
  `meat_slab` and every output `meat_sliced`; else refuse with a sentence naming the item, e.g. *"Slicing takes a meat
  slab. 'Pork Belly Sliced' is sliced meat; use Convert to re-cut it."* Lives in the shared validator, so draft save,
  post and `editPostedProduction` all refuse. `createProductionDraft` resolves the items once (`resolveItems`) for
  `slice` so the refusal comes at save, not later at post.
- **R2. Cook needs a recipe.** `createProductionDraft` for `cook`: `recipeId` required, recipe `active`, same org.
  Exactly one output line, its item = the recipe's `output_item_id`, quantity typed in that item's base unit.
  Caller inputs must be empty (refused otherwise); inputs are derived by `scaleRecipeToTarget` (lines in each
  ingredient's base unit) and stored as the draft's input lines.
- **R3. Exactness at post and edit.** The shared preparation, for `cook`, re-derives the scaled inputs from the record's
  recipe and output and refuses if the stored inputs differ (item set or quantity). `editPostedProduction` on a cook
  record takes the new output quantity and derives inputs the same way (caller inputs refused). A cook record with
  null `recipe_id` (written before this task) is refused at post and edit: *"This cook record has no recipe. Void it and
  record it again from a recipe."*
- **R4. Screen: one form per kind, chosen by a `?kind=slice|cook|convert` tab** (server-rendered, no client JS).
  Slice: inputs list `meat_slab` only, outputs `meat_sliced` only. Convert: both lists `meat_sliced` only (its lineage
  rule already refuses the rest). Cook: recipe select (active recipes, name and output item), output quantity with the
  output item's unit shown, room, date, labour; no input rows. No recipe exists → a sentence saying an admin must add one
  (recipes are admin-only, T-403).
- **R5. Quantities stay decimal strings through `@shareat/core`** quantity helpers; no float.

## Invariants (each with a named mutant)

1. Slice with a `raw_material` input → refused at draft save; no record row. *Mutant: R1 input leg removed.*
2. Slice with a `meat_slab` output → refused. *Mutant: R1 output leg removed.*
3. A slice draft written directly (repo) with a non-meat input is refused at post and at `editPostedProduction`.
   *Mutant: rule only in `createProductionDraft`.*
4. Slice slab → sliced still posts; a lineage mismatch still posts with its soft warning. *Mutant: warning promoted.*
5. Cook without `recipeId`, with an inactive recipe, with another org's recipe → each refused. *Mutant: each check.*
6. Cook output item ≠ recipe output → refused; caller-sent inputs → refused. *Mutants: each check dropped.*
7. Recipe 2 kg out from 500 g + 1.5 kg; cook 4 kg → stored inputs exactly 1.000 kg and 3.000 kg in base units.
   *Mutants: inputs unscaled; unit not converted (500 g stored as 500 kg).*
8. Stored inputs tampered (repo) → post refused. *Mutant: R3 re-derivation skipped.*
9. Old cook record with null recipe → post refused with the R3 sentence. *Mutant: null recipe passes.*
10. Page: `?kind=slice` input select contains only slab items, output only sliced; `?kind=cook` has no input rows and
    the action sends `recipeId`. *Mutants: unfiltered list; recipeId not sent.*

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size |
|---|---|---|---|---|
| **S1** | Domain R1-R3 | `packages/domain/tests/unit/t409-slice-category.test.ts` (validator, 1-2, 4); `packages/domain/tests/integration/t409-s1-production-rules.test.ts` (3, 5-9) | `packages/domain/src/production/validate.ts` (`validateProductionLines`), `packages/domain/src/production/index.ts` (`createProductionDraft`, the shared post/edit preparation, `editPostedProduction`) | 1.0 |
| **S2** | Screen + action R4 | `apps/erp/tests/integration/t409-s2-production-form.test.ts` (10) | `apps/erp/src/app/inventory/production/page.tsx`, `.../actions.ts` (`saveProductionDraftAction`), `.../lib.ts` (item lists by kind) | 0.5 |

Existing production tests whose slice fixtures use non-meat items (`production.test.ts`, `t369-s4a-stock-closed-month`,
`t371-production-nan`, `t383-retired-item-usable`, `unit/production-validate.test.ts`) get their fixture items' `kind`
corrected, not their assertions; each edit named in the hand-back.

## Out of scope

- Slice paid/unpaid, who sliced, piece rate (worklist #15, row 326; needs a migration).
- Whether cook ingredients must also appear on the usage screen (Q2; they leave stock through production movements today).
- A database CHECK `kind <> 'cook' or recipe_id is not null` (needs a migration; old rows may break it; R3 covers it).
- Editing recipes, or a UI for editing posted records (none exists today).

## Done when

S1-S2 merged; invariants 1-10 green with each mutant shown red once; typecheck, lint, unit and every production
integration test green.

## Risks

- **Real items with the wrong kind.** If a trimmings item is `raw_material`, R1 blocks a slice the kitchen does every
  day. Before deploy the orchestrator runs a read-only count on production: posted slice records in the last 90 days
  whose input is not `meat_slab` or output not `meat_sliced`, with item names. Non-zero → Ian fixes the item kinds first.
- **Open cook drafts with no recipe** become unpostable (R3). Same pre-deploy count; they are voided and re-entered.
- **T-176's HARD "output exceeds input" rule** may refuse a recipe whose output outweighs its ingredients (water added).
  Unchanged by this task; if it bites, it is a separate decision.

## Questions for Ian (the recommended option is built)

- **Q1. Slicing with a non-meat item: block it, or warn and let it through?** (a) Block, as the worklist says.
  (b) Keep the warning only. **Recommended (a)**, after the pre-deploy count shows no real item is mis-labelled.
- **Q2. Should cooked ingredients also show on the usage screen?** (a) No: they already leave stock as production,
  and showing them twice invites double counting. (b) Yes, as a read-only "used in cooking" section (separate task).
  **Recommended (a)** for this task.
