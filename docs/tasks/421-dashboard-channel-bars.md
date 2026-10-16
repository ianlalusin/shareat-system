# T-421 — Dashboard sales chart: one bar per day, split and colour-coded by sales channel

**Status:** DONE 2026-10-16 (merged to main). Opus spec. Builds on T-387 S5 (the dashboard) and `ea49036` (smooth line).
**Source:** Ian, 16 Oct: *"I want to see the bars per sales channel on the same graph, color coded."*
**Model: SONNET** (reports touch money totals: not Haiku). **No migration.** **No capability added** (the dashboard's
existing report scope gates it). Size S-M.

## Goal, in plain words
Under the sales line on the dashboard, each day gets one bar. The bar is split into coloured blocks, one per sales channel
(walk-in, Grab, Foodpanda, ...). Each channel has the **same colour as in the "where the orders came from" donut**, and a
legend names them. The top of each bar is that day's total, so it touches the line: the line says *how much*, the bar says
*from where*.

## Stacked, not grouped — decided
Stacked: one bar per day = that day's total, blocks inside it per channel. Grouped (a cluster of thin bars per day) turns
31 days x 4 channels into 124 slivers on a phone and no longer lines up with the line. **Stacked.**

## Where the numbers come from (verified at `ea49036`)
- The line: `salesNow.periods` from `getSalesRollup(tx, { groupBy: 'day' })` (`packages/domain/src/reports/sales-rollup.ts:58`)
  -> `reportsRepo.getSalesByPeriod` (`packages/db/src/repo/reports.ts:319`): the **ledger** (4100+4150, `source_type='sale'`)
  per `je.entry_date`. Built into `points` in `apps/erp/src/app/page.tsx:123-140`.
- The donut: `salesNow.channels` from `reportsRepo.getSalesByChannelAndMode` (`reports.ts:376`): `sales_day_channels` of
  **verified** sales days, ordered by channel name, plus one synthetic **"POS corrections"** line (`channelId null`, may be
  **negative**) from correction journal entries. Colour = `seriesColor(index in salesNow.channels)`
  (`apps/erp/src/components/dashboard/chart-colors.ts`, used in `ChannelDonut.tsx:20`). The ledger has no channel
  dimension; the domain proves the two agree only as a range total (`reconciles`).
- Glossary traps (read `docs/GLOSSARY.md` §`dineInSales`, §`takeOutSales`): never build bars from `sales_days.dine_in_sales`
  / `take_out_sales` (package-only and a residual). Bars come **only** from `sales_day_channels` + corrections, the same
  source as the donut. Never label a block "dine-in" or "take-out" unless that is the channel's own name.

## Design
1. **Repo** `reports.ts`: NEW `getSalesByDayAndChannel(ex, { orgId, storeId?, fromDate, toDate })` -> rows
   `{ day: 'YYYY-MM-DD', channelId: string | null, channelName, total: string }`. Same filters as `getSalesByChannelAndMode`,
   grouped by `sales_days.business_date` and channel; plus corrections grouped by **`je.entry_date`** (a correction posts on
   its own date, `sales-days/correction.ts:102`, and the line counts it on that date) as `channelId null`, "POS corrections".
   Totals `numeric(14,2)::text`; SQL only here.
2. **Domain** `sales-rollup.ts`: `SalesRollupInput` gains optional `channelDays?: boolean` (honoured only with
   `groupBy: 'day'`). Result gains `channelDays: SalesChannelDay[]` (`{ day, total: Money, channels: { channelId, channelName,
   total: Money }[] }`) and `unreconciledDays: string[]`: every day where the blocks' `add(...)` differs from that day's
   ledger period total by any centavo. Money arithmetic only, never `Number` sums.
3. **Page** `page.tsx`: pass `channelDays: true` on the `salesNow` call only. Build ONE colour map from `salesNow.channels`:
   key `channelId ?? 'pos-corrections'` -> `seriesColor(i)`; give it to both the donut rows and the bars (`ChannelDonut`
   takes an optional `color` per row and uses it before `seriesColor(i)`). Days in `unreconciledDays` get **no bar** and a
   one-line note under the chart: *"The channel split does not match the ledger on <days>; those bars are hidden."*
4. **Chart** `SalesLine.tsx`: optional `bars?: { segments: { key; name; value; color }[] }[]` aligned with `points`, and
   `legend?: { key; name; color }[]`. Bars drawn **before** the line paths (line on top), same y scale as the line.
   When `bars` is given, line and bars both use band centres `x = (i + 0.5) * W / n` so the end bars are not cut in half.
   Bar width 60% of the band. A negative "POS corrections" block is drawn hatched over the top of the stack, so the
   solid top equals the day's net total. The previous-range dashed line gets **no** bars. Each block has a `<title>`
   ("Mon 12 Oct · Grab · ₱1,234"). Legend: a `<ul>` below the chart, swatch + name, `flex-wrap`, same order as the donut.
   `aria-label` becomes *"Sales per day, <range>, against <previous>; bars split by channel: Walk-in, Grab, Foodpanda"*.
   Reduced motion: bars static (any grow-in lives in the existing no-preference block in `globals.css`).

## Files
**BUILDER (source only):** `packages/db/src/repo/reports.ts` (one new function) · `packages/domain/src/reports/sales-rollup.ts` ·
`apps/erp/src/app/page.tsx` · `apps/erp/src/components/dashboard/SalesLine.tsx` · `apps/erp/src/components/dashboard/ChannelDonut.tsx`
(optional `color` only) · `apps/erp/src/app/globals.css` (only if bars animate).

**TESTER (tests only):** NEW `packages/domain/tests/integration/t421-sales-channel-days.test.ts` (cases 1-6) ·
NEW `apps/erp/tests/t421-sales-channel-bars.test.ts` (cases 7-12, render) · EDIT `apps/erp/tests/t387-s5-dashboard-page.test.ts`
(its `getSalesRollup` mock returns `channelDays: []`, `unreconciledDays: []`).

## The invariant (stated, then tested)
**For every day D of the range: the sum of D's channel blocks equals D's ledger sales total (the line's value), to the
centavo. For every channel C: the sum of C's blocks over the range equals C's donut total.**

## Acceptance cases (real Postgres for 1-6; each names the mutant it kills)
Fixture: store A, channels Walk-in and Grab (remitted), Foodpanda (not remitted); day D1 verified (Walk-in 1,000.10 +
Grab 200.20), D2 a FEED day with Foodpanda 300.30, D3 voided, D4 no sales; a POS correction of -50.00 on D1's sales
posted with entry date D2; store B with sales on D1.
1. Invariant, per day: D1 blocks 1,200.30 = ledger D1; D2 = 300.30 - 50.00 = ledger D2; D3 and D4 have no blocks and
   ledger 0. Exact `Money` equality. *Kills: summing with `Number` (0.10 + 0.20 drift); dropping the corrections.*
2. The correction sits on **D2** (its entry date), not D1. *Kills: grouping corrections by the corrected day's business date.*
3. The voided D3 contributes nothing. *Kills: dropping `status = 'verified'`.*
4. Store-scoped (A) excludes store B; org-wide includes it, and the invariant still holds. *Kills: dropping the store filter.*
5. Invariant, per channel: each channel's blocks over the range = its `salesNow.channels` total. *Kills: a channel
   grouped by name instead of id (two channels with one name merge).*
6. A day whose ledger total is changed directly (fixture-only journal line) appears in `unreconciledDays`; others do not.
   *Kills: `unreconciledDays` always empty.*
7. Render: 3 days x 2 channels -> 3 stacks; each stack's block heights sum to the line point's height for that day
   (same y). *Kills: grouped bars; a different y scale for bars.*
8. Colours: a day where only Grab sold draws Grab in the **donut's** Grab colour, not the first palette colour.
   *Kills: colour by index within the day instead of the shared map.*
9. Legend lists every channel once, in donut order, with visible names; `aria-label` names every channel.
   *Kills: legend missing; colour as the only cue.*
10. A negative "POS corrections" block renders hatched and the solid top equals the net total. *Kills: negative height.*
11. Days in `unreconciledDays` draw no stack and the "does not match the ledger" sentence shows. *Kills: drawing a bar
    that disagrees with the line.*
12. No `bars` prop -> the chart renders exactly as today (snapshot of the current path `d`). *Kills: changing the line
    for callers that pass no bars.*

Each mutant shown red, then reverted; grep the final diff for leftovers.

## Done when
`npm run typecheck` clean · cases 1-12 green · `sales-rollup.test.ts`, `t375-s4-platform`, `t375-s6-correction`, `t387-*`
green · CI PR green (row 296) · screenshots of `/` (7-day and 31-day ranges) at 390 and 1280, light and dark: legend
wraps, no sideways page scroll, bars line up under the line.

## Questions for Ian (plain language)
1. **More than six channels.** The palette has six colours; a seventh channel would reuse the first colour (the donut
   already does). (a) Leave it — recommended: today there are fewer than six. (b) Add more colours (small follow-up).

## Ian's answers (16 Oct)
- Six colours; a 7th channel reuses one (as the donut does). Accepted.

## Redesign (Ian, 16 Oct, after seeing the bars)
Bars dropped as too crowded. The chart is now: a THICK neon gross-sales line (gradient, glow, glowing peak dot) plus one THIN smooth line per channel in the donut colours (POS corrections dashed), drawn under it; the previous-period dashed line is fainter when channel lines show. One legend row: Gross sales, previous period, then the channels. The hover card lists each channel's amount for that day. Days in `unreconciledDays` break the channel lines and the note reads "The channel split does not match the ledger on <days>; those channel lines break there." The data layer (channelDays, unreconciledDays, the to-the-centavo invariant) is unchanged. Cases 7-11 are rewritten for lines.
