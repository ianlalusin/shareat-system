# T-419 — Ingredients used by recipe cooking also show on the daily usage screen, labelled "from recipe"

**Status:** spec written 2026-10-16, not started; **Ian's answers folded in 16 Oct** (drafts shown, marked "draft"; counting
in the check moved to **T-420**). Opus spec. Reopens **T-409 Q2** (`docs/tasks/409-production-slice-pickers.md:113`) and
touches the **T-401 S6** usage screen (`docs/tasks/401-erp-menu-catalog-master.md`, rulings A1-A12).
**Source:** bible row 348 (Ian, 16 Oct): recipe-cook ingredients ALSO appear on the daily usage screen, *"just label so
it's understood it's from recipe."* T-409 shipped Q2 option (a), "not shown".
**Model: SONNET.** **No migration.** **No capability added.** Size S. **T-420 depends on this task.**

## Goal, in plain words
When the kitchen cooks a batch from a recipe, the raw ingredients leave stock through the **cooking record**, not
through a usage sheet. Today the usage screen does not mention them, so a manager reading "what did we use yesterday"
sees only half the picture. After T-419 the screen shows a read-only list: *"Used in cooking on <date>"*, each line
labelled with the recipe it came from. **Cooking still in draft shows too, clearly marked "Draft — not posted yet"**
(Ian, 16 Oct), so the manager sees cooking someone started but has not posted.

**It is display only.** Only a **posted** cook ever moved stock. Nothing on the usage screen creates, edits or posts
stock for these lines. In T-419 nothing that judges or posts usage counts them; T-420 later lets the check count
**posted** cooking only. **A draft cook never enters any check, any auto-post, or any stock figure**, here or later.

## Where the data comes from (verified at `21b5603`)
- A cook is a `production_records` row, `kind = 'cook'`, `recipe_id` set (T-409 R2), `store_id`, `location_id`,
  `produced_on` (date), `status` in `draft | posted | void`. Drafts hold their lines in the same lines table.
- Its ingredients are `production_record_lines` with **`direction = 'out'`** (consumed). ⚠️ `'in'` is the OUTPUT
  (`packages/domain/src/production/index.ts:173` writes outputs as `'in'`). Getting this backwards shows the cooked dish
  as an ingredient — case 2 guards it.
- An edit-in-place leaves old lines with `reversed_at` set; only lines with **`reversed_at is null`** are current.
- **Shown:** `status in ('draft','posted')`. **Never shown:** `void`.
- The usage checks read only `stock_usage_records/lines`: `usageActualsForDay` (`packages/db/src/repo/stock-usage.ts:314`),
  `usageVariancesFor` / `snapshotVariancesFor` (`usage-tolerance.ts`), auto-post (`usage-auto-post.ts`), month close
  (`usage-check-report.ts`). None of them reads `production_*` today. **T-419 keeps it that way.**

## Design
1. **Repo** `packages/db/src/repo/production.ts`: NEW `listCookInputsForDay(tx, storeId, producedOn)` -> rows
   `{ recordId, status, recipeId, recipeName, itemId, itemCode, itemName, quantity, unit, locationId }`, from cook records
   of that store and date with `status in ('draft','posted')`, `direction = 'out'`, `reversed_at is null`, ordered posted
   first, then recipe name, then item name. One query (join recipes and items), no N+1.
2. **Domain** NEW `packages/domain/src/production/cook-usage-view.ts`: `listCookUsageForDay(tx, actor, { storeId, date })`
   — `authorize(tx, actor, 'record_stock_movement', { storeId })` (same gate as `listUsageVariances`), then the repo call;
   each row carries `isDraft: boolean`. Export from `packages/domain/src/index.ts`. Read only; no writes.
3. **Screen** `apps/erp/src/app/inventory/usage/lib.ts`: `usageQueueData` also returns `cooked` for the same `date`.
   `page.tsx`: a section **after** "Usage check for {date}", heading **"Used in cooking on {date}"**, table
   Item · Quantity · From · Status. "From" reads **"Recipe: <recipe name>"** and links to `/inventory/production/<recordId>`.
   Status reads **"Posted"**, or a warning badge **"Draft — not posted yet"** with the quantity in muted text. Under the
   heading: *"Taken from stock when the cooking was posted. Drafts have not taken anything yet. Shown for the full
   picture; not posted again from here."* Empty state: *"No cooking from a recipe was recorded for this date."*
   No inputs, buttons or forms in this section.
4. **Naming** (GLOSSARY checked: no entry for usage / cook / production; none clashes): `cooked`, `CookUsageLine`,
   `isDraft`, `listCookInputsForDay`, `listCookUsageForDay`. Do not name anything `actual*` or `usage*Lines` — those
   words mean the staff-recorded figures in S6.

## Files
**BUILDER (source only):** `packages/db/src/repo/production.ts` (one new function) ·
NEW `packages/domain/src/production/cook-usage-view.ts` · `packages/domain/src/index.ts` (one export line) ·
`apps/erp/src/app/inventory/usage/lib.ts` · `apps/erp/src/app/inventory/usage/page.tsx`.

**TESTER (tests only):** NEW `packages/domain/tests/integration/t419-cook-usage-view.test.ts` (cases 1-8) ·
NEW `apps/erp/tests/t419-usage-cook-section.test.ts` (cases 9-11, render with the lib mocked) ·
EDIT `apps/erp/tests/t343-s6c-screen-labels.test.ts` — its `usageQueueData` mock (line ~398) returns `cooked: []`.

**DO NOT TOUCH:** `packages/domain/src/stock/usage-tolerance.ts`, `usage-auto-post.ts`, `usage-check-report.ts`,
`usage-records.ts`, `usage-post-core.ts`, `packages/db/src/repo/stock-usage.ts`, the production post/edit/void code in
`packages/domain/src/production/index.ts`. If the builder believes one must change, stop and report: that is T-420's
job. Lane T-416's files (`packages/auth/**`) are unrelated.

## Acceptance cases (real Postgres; each names the mutant it kills)
1. Recipe "Adobo base" (500 g pork + 100 g soy -> 0.6 kg). Post a cook of 0.6 kg at store A on D -> `listCookUsageForDay(A, D)`
   returns exactly pork 0.500 kg and soy 0.100 kg, each `recipeName = 'Adobo base'`, `isDraft = false`. *Kills: dropping the recipe join.*
2. The cooked output item is **not** in the list. *Kills: `direction = 'in'` instead of `'out'`.*
3. A **draft** cook on D is listed with `isDraft = true`; a **voided** cook on D is not listed. *Kills: posted-only
   filter (drafts dropped); dropping the void exclusion; `isDraft` hard-coded false.*
4. A posted cook edited from 1 kg to 2 kg -> listed once at the new quantities (1.000 kg pork). *Kills: dropping
   `reversed_at is null` (old and new lines both shown).*
5. A posted **slice** and a posted **convert** on D -> not listed. *Kills: dropping `kind = 'cook'`.*
6. A cook at store B, and a cook at store A on D-1 -> not listed for (A, D). *Kills: dropping the store or the date filter.*
7. **A draft moves nothing and counts nowhere.** With a draft cook of pork on D: pork on-hand unchanged; no stock
   movement row for it; `usageActualsForDay(A, D)` and `usageVariancesFor(A, D)` identical with and without the draft;
   the auto-post sweep for D creates no `stock_usage_lines` row from it; `usageCloseRefusal` gives the same answer.
   With the cook **posted**: on-hand drops 0.500 kg once; the same checks unchanged in T-419 (T-420 changes the verdict
   for posted cooks only and edits this case's posted leg). *Kills: summing cook inputs into `usageActualsForDay`;
   writing cook lines as usage lines; a draft moving stock.*
8. An actor without `record_stock_movement` at store A -> refused. *Kills: removing the `authorize` call.*
9. Render: with `cooked` holding a posted and a draft line, the page shows heading "Used in cooking on <date>", each
   row's "Recipe: <name>" linking to `/inventory/production/<id>`, and the "Drafts have not taken anything yet" sentence.
   *Kills: dropping the label, the link or the sentence.*
10. Render: the draft row shows "Draft — not posted yet"; the posted row shows "Posted" and not the draft text.
    *Kills: the badge on every row, or on none.*
11. Render: the section contains no `<form>`, `<input>` or `<button>`; the band table's "Recorded" column still shows
    only `variances[].actual`. *Kills: an editable cook row; cook quantities merged into "Recorded".*

Each mutant shown red, then reverted; grep the final diff for leftovers.

## Done when
`npm run typecheck` clean · cases 1-11 green · `t401-s6-*` and `production.test.ts` green unedited · CI PR green
(row 296) · screenshot of `/inventory/usage?date=<a day with a posted and a draft cook>` at 390 and 1280 (the table
scrolls inside its box on a phone, like the band table). Orchestrator marks T-409 Q2 as answered (b) by row 348.

## Ian's answers (16 Oct) — binding
1. **Draft cooking shows, clearly marked "draft"** (not the planner's recommended "posted only"). Only posted cooks ever
   move stock; drafts never enter any check or auto-post (case 7).
2. **Counting cooked ingredients in the usage check** is a separate task: **T-420** (`420-usage-check-counts-cook.md`).
