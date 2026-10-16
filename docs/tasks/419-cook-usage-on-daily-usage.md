# T-419 — Ingredients used by recipe cooking also show on the daily usage screen, labelled "from recipe"

**Status:** spec written 2026-10-16, not started. Opus spec. Reopens **T-409 Q2** (`docs/tasks/409-production-slice-pickers.md:113`)
and touches the **T-401 S6** usage screen (`docs/tasks/401-erp-menu-catalog-master.md`, rulings A1-A12).
**Source:** bible row 348 (Ian, 16 Oct): recipe-cook ingredients ALSO appear on the daily usage screen, *"just label so
it's understood it's from recipe."* T-409 shipped Q2 option (a), "not shown".
**Model: SONNET.** **No migration.** **No capability added.** Size S.

## Goal, in plain words
When the kitchen cooks a batch from a recipe, the raw ingredients leave stock through the **cooking record**, not
through a usage sheet. Today the usage screen does not mention them, so a manager reading "what did we use yesterday"
sees only half the picture. After T-419 the screen shows a second, read-only list: *"Used in cooking on <date>"*, each
line labelled with the recipe it came from.

**It is display only.** The cook already took the stock out when it was posted. Nothing on the usage screen creates,
edits or posts stock for these lines, and nothing that judges or posts usage counts them.

## Where the data comes from (verified at `21b5603`)
- A cook is a `production_records` row, `kind = 'cook'`, `recipe_id` set (T-409 R2), `store_id`, `produced_on` (date).
- Its ingredients are `production_record_lines` with **`direction = 'out'`** (consumed). ⚠️ `'in'` is the OUTPUT
  (`packages/domain/src/production/index.ts:173` writes outputs as `'in'`). Getting this backwards shows the cooked dish
  as an ingredient — case 2 guards it.
- An edit-in-place leaves old lines with `reversed_at` set; only lines with **`reversed_at is null`** are current.
- Only records with **`status = 'posted'`** moved stock. Drafts and voids are not shown (Question 1).
- The usage checks read only `stock_usage_records/lines`: `usageActualsForDay` (`packages/db/src/repo/stock-usage.ts:314`),
  `usageVariancesFor` / `snapshotVariancesFor` (`usage-tolerance.ts`), auto-post (`usage-auto-post.ts`), month close
  (`usage-check-report.ts`). None of them reads `production_*` today. **T-419 keeps it that way** — that is the whole
  double-counting guard: cook lines never enter a usage table and never enter those functions.

## Design
1. **Repo** `packages/db/src/repo/production.ts`: NEW `listCookInputsForDay(tx, storeId, producedOn)` -> rows
   `{ recordId, recipeId, recipeName, itemId, itemCode, itemName, quantity, unit, locationId }`, from posted cook records
   of that store and date, `direction = 'out'`, `reversed_at is null`, ordered by recipe name then item name. One query
   (join recipes and items), no N+1.
2. **Domain** NEW `packages/domain/src/production/cook-usage-view.ts`: `listCookUsageForDay(tx, actor, { storeId, date })`
   — `authorize(tx, actor, 'record_stock_movement', { storeId })` (the same gate as `listUsageVariances`: whoever may read
   the usage screen may read this), then the repo call. Export from `packages/domain/src/index.ts`. Read only; no writes.
3. **Screen** `apps/erp/src/app/inventory/usage/lib.ts`: `usageQueueData` also returns `cooked` from
   `listCookUsageForDay` for the same `date`. `page.tsx`: a new section **after** "Usage check for {date}", heading
   **"Used in cooking on {date}"**, a table Item · Quantity · From. "From" reads **"Recipe: <recipe name>"** and links to
   the cooking record (`/inventory/production/<recordId>`). One sentence under the heading: *"Taken from stock when the
   cooking was posted. Shown here for the full picture; not counted in the usage check and not posted again."* Empty
   state: *"No cooking from a recipe was posted for this date."* No inputs, no buttons, no form in this section.
4. **Naming** (GLOSSARY checked: no entry for usage / cook / production; none clashes): `cooked`, `CookUsageLine`,
   `listCookInputsForDay`, `listCookUsageForDay`. Do not name anything `actual*` or `usage*Lines` — those words mean the
   staff-recorded figures in S6.

## Files
**BUILDER (source only):** `packages/db/src/repo/production.ts` (one new function) ·
NEW `packages/domain/src/production/cook-usage-view.ts` · `packages/domain/src/index.ts` (one export line) ·
`apps/erp/src/app/inventory/usage/lib.ts` · `apps/erp/src/app/inventory/usage/page.tsx`.

**TESTER (tests only):** NEW `packages/domain/tests/integration/t419-cook-usage-view.test.ts` (cases 1-8) ·
NEW `apps/erp/tests/t419-usage-cook-section.test.ts` (cases 9-10, render with the lib mocked) ·
EDIT `apps/erp/tests/t343-s6c-screen-labels.test.ts` — its `usageQueueData` mock (line ~398) returns `cooked: []`.

**DO NOT TOUCH:** `packages/domain/src/stock/usage-tolerance.ts`, `usage-auto-post.ts`, `usage-check-report.ts`,
`usage-records.ts`, `usage-post-core.ts`, `packages/db/src/repo/stock-usage.ts`, the production post/edit/void code in
`packages/domain/src/production/index.ts`. If the builder believes one must change, stop and report: that means cook lines
are leaking into the usage logic, which this spec forbids. Lane T-416's files (`packages/auth/**`) are unrelated.

## Acceptance cases (real Postgres; each names the mutant it kills)
1. Recipe "Adobo base" (500 g pork + 100 ml soy -> 1 kg). Post a cook of 1 kg at store A on D -> `listCookUsageForDay(A, D)`
   returns exactly pork 0.500 kg and soy 0.100 L, each with `recipeName = 'Adobo base'`. *Kills: dropping the recipe join.*
2. The cooked output item is **not** in the list. *Kills: `direction = 'in'` instead of `'out'`.*
3. A **draft** cook and a **voided** cook on D -> not listed. *Kills: dropping the `status = 'posted'` filter.*
4. A posted cook edited from 1 kg to 2 kg -> listed once at the new quantities (1.000 kg pork). *Kills: dropping
   `reversed_at is null` (old and new lines both shown).*
5. A posted **slice** and a posted **convert** on D -> not listed. *Kills: dropping `kind = 'cook'`.*
6. A cook at store B, and a cook at store A on D-1 -> not listed for (A, D). *Kills: dropping the store or the date filter.*
7. **No double counting.** With the cook from case 1 posted and the pork item covered by a POS plan for (A, D):
   `usageVariancesFor(A, D)` returns the same `actual` for pork before and after the cook; `usageActualsForDay` unchanged;
   running the auto-post sweep for D posts no line for the cook and creates no `stock_usage_lines` row; the pork
   on-hand drops by 0.500 kg once (the cook), not twice; `usageCloseRefusal` for the month gives the same answer before and
   after the cook. *Kills: summing cook inputs into `usageActualsForDay`, or writing cook lines as usage lines.*
8. An actor without `record_stock_movement` at store A -> refused. *Kills: removing the `authorize` call.*
9. Render: with `cooked` holding two lines, the page shows heading "Used in cooking on <date>", each row's "Recipe:
   <name>" linking to `/inventory/production/<id>`, and the not-counted sentence. *Kills: dropping the label or link.*
10. Render: the "Used in cooking" section contains no `<form>`, `<input>` or `<button>`; the band table's "Recorded"
    column still shows only `variances[].actual`. *Kills: an editable cook row; cook quantities merged into "Recorded".*

Each mutant shown red, then reverted; grep the final diff for leftovers.

## Done when
`npm run typecheck` clean · cases 1-10 green · `t401-s6-*` and `production.test.ts` green unedited · CI PR green
(row 296) · screenshot of `/inventory/usage?date=<a day with a cook>` at 390 and 1280 (the table scrolls inside its box on
a phone, like the band table). Orchestrator marks T-409 Q2 as answered (b) by row 348.

## Questions for Ian (plain language)
1. **Unposted cooking.** Should a cooking sheet that is still a draft show too, marked "not posted yet"? Recommended:
   no — only cooking that already took stock out, so the list matches the stock. Built as "posted only" until answered.
2. **Should cooking count in the usage check?** If a menu item's plan expects raw pork, and the kitchen used that pork
   by cooking instead of on a usage sheet, the check can say "outside 10%" even though the pork was used. (a) Leave the
   check alone — recommended for now; the label tells the manager why. (b) Count cooked ingredients as "recorded" in the
   check — a separate task, because it changes what blocks month close.
