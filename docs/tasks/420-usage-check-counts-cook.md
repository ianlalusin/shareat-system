# T-420 — The daily usage check counts ingredients already used by posted recipe cooking

**Status:** spec written 2026-10-16, not started. Opus spec. **Depends on T-419** (merged first: it adds the cook repo
query and the "Used in cooking" section this task builds on). Touches the **T-401 S6** check (`docs/tasks/401-erp-menu-catalog-master.md`
§S6, rulings A1-A12) and **T-409** cooking (`409-production-slice-pickers.md`).
**Source:** Ian, 16 Oct (answer to T-419 Q2): counting cooked ingredients in the usage check is a separate task.
**Model: SONNET** (money-adjacent stock logic: not Haiku). **No migration.** **No capability added.** Size M.

## Goal, in plain words
A menu item mapped to a recipe makes the usage check expect the **raw** ingredients (the pull's `recipe` section explodes
it). If the kitchen cooked those ingredients as a batch, the pork left stock through the **cooking record**, so the usage
sheet holds less pork and the check calls it a gap. Worse, the pull draft is pre-filled at the expected pork: if nobody
lowers it, the 14:00 auto-post takes that pork out **a second time**. After T-420 the check counts **posted** cooking as
already used: no false gap, and the auto-post never takes cooked pork again. Draft cooking never counts (Ian, 16 Oct).

## Where things stand (verified at `ea49036`)
- Live check, store-wide: `usageVariancesFor` (`packages/domain/src/stock/usage-tolerance.ts:140`) judges the day's
  recorded total (`usageActualsForDay`, `packages/db/src/repo/stock-usage.ts:314`) against the plan.
- Snapshot check, per record (A4): `snapshotVariancesFor` (`usage-tolerance.ts:199`) judges a pull draft's own lines
  against its own snapshot (`pos_usage_pull_lines.draft_expected_qty`). Pre-fill and snapshot are set by A5
  (`packages/domain/src/pos/usage-pull.ts:~412`): plan less what other usage records hold.
- Three judges use those two functions: the post gate `checkUsageTolerance` (`usage-tolerance.ts:227`), the 14:00 sweep
  `autoPostOne` (`usage-auto-post.ts:93` snapshot step, `:114` live step), and month close `usageCloseRefusal`
  (`usage-check-report.ts:20`). **Changing the two functions once changes all three judges the same way.**
- Live data (§1.2d step 3): DEF-173: v1 never ran a cook (zero `productionRuns`). This matters from the day v2 kitchens
  cook from recipes; the orchestrator counts posted v2 cook records per store before deploy and reports the number.

## Rulings (planner)
- **C1. Only POSTED cooks count.** `kind = 'cook'`, `status = 'posted'`, `direction = 'out'`, `reversed_at is null`,
  same store, `produced_on` = the usage day. Draft and void cooks count nowhere.
- **C2. Live check (store-wide):** an item is judged on **recorded + cooked** against expected, cooked = the whole store's
  posted cook inputs of that item and day. `UsageVariance` gains `cooked: string`; **`actual` keeps meaning "recorded by
  staff"** (the screen's "Recorded" column and T-419 case 11 unchanged).
- **C3. Snapshot check (one pull draft):** cooked = posted cook inputs **in that record's own room** (`production_records.location_id
  = stock_usage_records.location_id`). Room scope is the no-double-count rule: one pull writes one draft per room (A2),
  so a cook is credited to at most one pull draft. A cook in a room with no pull draft for the item is seen only by C2.
- **C4. The snapshot is never changed** (A4 stands; no migration). Cooking is credited when the record is **judged**,
  because a posted cook is a stock fact, not a plan. Pre-fill is unchanged (Question 1).
- **C5. Auto-post targets** (A3 "back to expected" becomes "back to expected less cooking"): snapshot step
  target = max(0, snapshot - roomCooked); live step wanted = max(0, expected - others - storeCooked).
- **C6. Month close** judges with the same functions, read at close time: voiding a cook after the usage posted can make
  a line out of band (close blocks until a reason); a cook posted after the usage posted shows recorded + cooked above
  expected (close blocks until a reason). Both surface stock taken twice instead of hiding it.
- **C7. Refusal wording** when cooked > 0: *"Pork: 0.2 recorded + 0.5 used in cooking against 0.7 expected for <day>
  (more than 10% apart)."* Unchanged when cooked is 0.
- **Naming** (GLOSSARY grepped: no usage/cook entry clashes): `cooked`, `cookedByItemForDay`. Never `actual*` for cook figures.

## Files
**BUILDER (source only):** `packages/db/src/repo/production.ts` — NEW `cookedByItemForDay(tx, storeId, producedOn,
{ locationId?, itemIds? })` -> `Map<itemId, text>`, one `sum(...)::text` query, no floats ·
`packages/db/src/repo/stock-usage.ts` — `MonthUsageRecordRow` gains `locationId` (select only) ·
`packages/domain/src/stock/usage-tolerance.ts` — C2, C3 (`snapshotVariancesFor` takes the record `{ id, orgId, storeId,
usedOn, locationId }`), C7 · `packages/domain/src/stock/usage-auto-post.ts` — C5 · `packages/domain/src/stock/usage-check-report.ts`
— pass the record · `packages/domain/src/stock/usage-records.ts` — only if the record passed at `:291` lacks `locationId` ·
`apps/erp/src/app/inventory/usage/page.tsx` — band table gains a "Used in cooking" column (`v.cooked`, blank when 0).

**TESTER (tests only):** NEW `packages/domain/tests/integration/t420-usage-check-cook.test.ts` (cases 1-12) ·
NEW `apps/erp/tests/t420-usage-cook-column.test.ts` (case 13) · EDIT `packages/domain/tests/integration/t419-cook-usage-view.test.ts`
case 7, posted leg only: the verdict now changes; the draft leg stays as written · EDIT any `t401-s6-*` fixture that
builds a `UsageVariance` literal (add `cooked: '0'`); no assertion in them may change.

**DO NOT TOUCH:** `packages/domain/src/pos/usage-pull.ts` (A5 pre-fill: Question 1), the production post/edit/void code in
`packages/domain/src/production/index.ts`, `pos_usage_pull_lines` writes, `packages/auth/**`.

## Acceptance cases (real Postgres; each names the mutant it kills)
Fixture: store A, room K (kitchen), room B (bar); recipe "Adobo base" (pork 0.500 kg -> 1 kg); a POS item mapped to it,
so the day-D plan expects pork 0.700 kg in K; tolerance 10%.
1. Live: staff record pork 0.200 on a manual draft; posted cook in K uses 0.500 -> `usageVariancesFor(A, D)` pork:
   `actual '0.200'`, `cooked '0.500'`, `withinBand true`. *Kills: cook not added to the verdict.*
2. Same with the cook a **draft** -> `cooked '0'`, `withinBand false`; the auto-post sweep result and every
   `stock_usage_lines` row identical with and without the draft. *Kills: drafts counted (C1).*
3. A voided cook, and a posted cook edited 0.500 -> 0.300 -> credit 0 and 0.300. *Kills: void counted; reversed lines summed.*
4. The cook's output item, a cook at store B, a cook on D-1, a posted slice and convert of pork -> none credited.
   *Kills: `direction='in'`; dropping the store, date or `kind='cook'` filter.*
5. Snapshot: pull draft in K, pork snapshot 0.700, staff lower the line to 0.200, cook 0.500 in K -> manager post with no
   reason succeeds, no `stock.usage_tolerance_verified` row. *Kills: snapshot path not crediting.*
6. Room scope: pull drafts in K and B both hold pork (snapshot 0.350 each); one cook 0.350 in K -> K judged with it, B
   judged without it. *Kills: store-wide credit in the snapshot path (one cook credited to two drafts).*
7. ⭐ **No second stock-out at 14:00.** Pull draft in K untouched at pork 0.700, cook 0.500 posted in K -> auto-post posts
   pork **0.200**; pork on-hand fell 0.700 in total that day (0.500 cook + 0.200 usage), never 1.200; the audit row
   lists the line as adjusted 0.700 -> 0.200. *Kills: C5 snapshot target ignoring cooking.*
8. Cook 0.900 > snapshot 0.700 -> auto-post writes no pork line (target 0), never a negative quantity. *Kills: missing floor.*
9. Live step of auto-post: an item staff typed onto the pull draft (not in its snapshot), cooked 0.300 of 0.700 expected
   -> posted at 0.400 less other records' holdings. *Kills: C5 live step not subtracting store cooking.*
10. Month close: manager-posted usage 0.200 + posted cook 0.500 -> `usageCloseRefusal` null; void the cook -> refusal
    names "outside the tolerance". *Kills: close not crediting; credit cached across the void.*
11. Month close, late cook: usage 0.700 posted (in band), then a cook 0.500 posted -> refusal (1.200 against 0.700); a
    reason on file clears it. *Kills: cooking capped at the shortfall, hiding a real double stock-out.*
12. Post-gate refusal with cooked > 0 reads "recorded + 0.5 used in cooking against"; with cooked 0 the sentence is
    byte-for-byte today's. *Kills: wording dropped, or changed for the no-cook case.*
13. Render: band table shows "Used in cooking" `0.5` for pork and "Recorded" `0.2`. *Kills: cooked merged into Recorded.*

Each mutant shown red, then reverted; grep the final diff for leftovers. ⚠️ This changes month-close
behaviour, so the gate is the **full** suite on a fresh gate DB, not only these files.

## Done when
`npm run typecheck` clean · cases 1-13 green · `t401-s6-*`, `t419-*`, `production.test.ts` green · full suite + CI PR
green (row 296) · screenshot of `/inventory/usage?date=<a day with a posted cook>` at 390 and 1280 · orchestrator adds a
bible row (Opus, at wrap-up): "posted cooking counts as used in the usage check; drafts never".

## Questions for Ian (plain language)
1. **Should the morning pre-fill already subtract cooking?** Today the usage sheet is pre-filled with the full expected
   pork, even if the kitchen cooked some of it. (a) Leave it — recommended for now: the check and the 14:00 auto-post
   already handle it, and the new "Used in cooking" column shows staff what to lower. (b) Subtract cooking in the
   pre-fill too — nicer for staff, but needs a database change to keep the history honest (a follow-up task).
2. **Cooking ahead.** If the kitchen cooks 10 kg in the morning and sells 8 kg's worth, the check flags pork as 25%
   over, because the 2 kg left over sits as cooked "Adobo base". That flag is correct, but noisy if the kitchen always
   cooks ahead. Recommended: watch it for two weeks after go-live; if it is noisy, map those menu items to the cooked
   item instead of the recipe, so sales take from the cooked batch.

## Ian's answers (16 Oct)
- The morning usage sheet does NOT subtract cooking yet; the check and the 14:00 auto-post handle it.
- Over-cooking flags: watch for two weeks after go-live; if noisy, point those menu items at the cooked dish.
