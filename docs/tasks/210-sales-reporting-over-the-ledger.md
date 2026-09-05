# T-210 — sales reporting over the ledger

Status: **done — 2026-09-05.** Gates: typecheck clean · unit 1012/1014 (1 pre-existing skip + 1
pre-existing, already-diagnosed red — DEF-170, unrelated attendance golden-corpus divergences) ·
full integration suite 90 files / 2293 tests, green (two prior runs each hit one isolated,
unrelated, transient failure under real system memory pressure from 3 concurrent sessions on this
machine — `stock-layers.test.ts` hook-timeout and a duplicate-key from an interrupted truncate —
both confirmed non-regressions by isolated re-run before a third full run came back fully clean) ·
`npm run build` exit 0 (dev server stopped first; one build attempt hit a stale
`apps/erp/.next/lock` left by an earlier memory-pressure-killed attempt — removed after confirming
no live process held it) · live-smoketested on 9008: sales rollup reconciled exactly on real
Malvar data (₱17,000.00 across the ledger/channel/mode groupings, sourced three independent ways)
· POS reconciliation's `not_configured` state rendered cleanly with no crash (`POS_API_URL`/
`POS_API_KEY` are unset in this dev environment, as expected).
Depends on: T-123 (sales day, shipped), T-209 (reporting infrastructure, shipped).
Per `docs/plans/phase-6-reporting-and-dashboards.md` §4.1 and the Wave-1 slice table.

## 1. Scope, revised after reading the current T-123 build

The phase-6 plan named three deliverables. Reading the actual shipped code (not the plan's
description of what would exist) found the second one **already built**:

| # | Plan's ask | Finding |
|---|---|---|
| 1 | Period roll-ups — day/month/store/channel/sales-mode | Not built. **This task's real work.** |
| 2 | The sales-day register — which days exist, which have posted, per store | **Already shipped.** `apps/erp/src/app/sales-days/page.tsx` lists every day, its status, source (POS/manual), and surfaces the create-block ("X is still open... a newer day cannot be created until it is done"). Nothing to add. |
| 3 | POS-day ↔ ledger reconciliation | Not built. **This task's other real work.** |

So T-210 is two deliverables, not three, and #2 is recorded here so nobody re-plans it.

## 2. ⛔ The finding that shapes the roll-up design: CHANNEL is not a journal_lines dimension

`packages/domain/src/sales-days/routing.ts` posts the revenue side as a plain credit split —
`4100` (unli) / `4150` (à la carte) — with **no party, no channel**. The channel dimension exists
on the ledger **only for non-remitted channels**, as the `1220` receivable's `partyType='channel'`
(routing.ts:220-227) — a Foodpanda/Grab receivable, not a Walk-in sale. A cash/walk-in sale's
revenue line is channel-blind by construction.

**Consequence: "revenue by channel" cannot be produced by a `GROUP BY` over `journal_lines`
alone** — the phase-6 plan's literal instruction ("over `journal_lines`, which is the only place
they can now come from") is right in spirit (never count unposted revenue) but the dimension the
plan asks for genuinely is not on the ledger rows.

**Resolution, verified before writing the query:** `sales_days.status = 'verified'` is an *exact*
proxy for "posted and still standing" — `voidSalesDay` (verify.ts:155-208) always flips status to
`voided` in the same transaction that reverses the journal entry (`markVoided`, never leaving a
`verified` row whose entry was later reversed). So a channel/mode breakdown sourced from
`sales_days`/`sales_day_channels` **filtered to `status = 'verified'`** carries the same posted-
only guarantee a `journal_lines` query would, without inventing a party dimension the ledger does
not have. The **day/month/store totals** still come from `journal_lines` directly (source_type
`'sale'`, accounts `4100`/`4150`) — the same figures the income statement's revenue lines already
tie to, and the report's own regression proves the channel/mode breakdown SUMS to that ledger
total, so a silent mismatch between the two sourcing paths cannot hide.

## 3. Scope

- `packages/db/src/repo/reports.ts` — new `getSalesByPeriod(ex, {orgId, storeId?, fromDate,
  toDate, groupBy: 'day'|'month'|'store'})` (journal_lines, `source_type='sale'`, accounts
  `4100`/`4150`) and `getSalesByChannelAndMode(ex, {orgId, storeId?, fromDate, toDate})`
  (`sales_days`/`sales_day_channels`, `status='verified'`, joined for channel name/remittance
  flag). Both read-only, matching this file's existing pattern.
- `packages/domain/src/reports/sales-rollup.ts` — new `getSalesRollup`, combining both repo calls
  into one result with the cross-check described above.
- `apps/erp/src/app/reports/sales-rollup/page.tsx` — new screen: period totals (day/month/store,
  selectable), channel breakdown, mode breakdown, the reconciliation indicator, CSV export
  (reusing `toCsv`/`CsvExportLink` — T-209c's shared path, proving it generalises to a third
  task).
- **POS-day reconciliation:**
  - `packages/domain/src/pos/sales-pull.ts` — new `fetchPosSalesLive`, mirroring
    `usage-pull.ts`'s `fetchPosSoldItemsLive` exactly: `GET {POS_API_URL}/api/external/sales`,
    same `x-api-key` auth, same "throws a named error when unconfigured" contract, same
    injectable-function shape for testing (`FetchPosSnapshot`-style type alias).
  - `packages/domain/src/reports/pos-day-reconciliation.ts` — new `getPosDayReconciliation(fetch,
    {orgId, storeId, businessDate})`: calls the injected fetcher, reads Shareat System's own
    `sales_days` row for that store+date (`salesDaysRepo.findByBusinessDate`, already exists), and
    returns both sides plus a diff. **Never throws on "POS not configured" or "POS unreachable"**
    — those are first-class result states (`posStatus: 'not_configured' | 'unreachable' |
    'not_found' | 'ok'`), because `POS_API_URL`/`POS_API_KEY` are declared optional in
    `@shareat/core/env` (T-177's own comment: *"nothing calls it outside this one feature, and
    demanding it blocks local dev on a credential most work does not touch"*) — the same is true
    here, and a report screen that 500s when an optional integration is unconfigured is worse than
    one that says so.
  - `apps/erp/src/app/reports/pos-reconciliation/page.tsx` — new screen: store + date picker, POS
    figures beside Shareat System's own sales-day figures, a match/mismatch indicator, and the
    graceful not-configured/unreachable states rendered as informational, not as errors.
- `apps/erp/src/components/nav.tsx` — `Reports → Sales rollup`, `Reports → POS reconciliation`.

## 4. Contract

```ts
getSalesRollup(ex, { orgId, storeId?, fromDate, toDate, groupBy }): Promise<{
  periods: { period: string; storeId: string | null; total: Money }[];   // day/month/store buckets
  ledgerTotal: Money;                          // Σ periods — must equal the channel/mode totals below
  channels: { channelId: string; channelName: string; isRemittedDaily: boolean; total: Money }[];
  channelTotal: Money;
  modes: { mode: 'unli' | 'ala_carte'; total: Money }[];
  modeTotal: Money;
  /** channelTotal === ledgerTotal === modeTotal, to the centavo — three independent groupings of
   *  the same recognised revenue, asserted to agree. */
  reconciles: boolean;
  basis: { orgId; storeId; fromDate; toDate; groupBy };
}>

getPosDayReconciliation(fetchPosSales, { orgId, storeId, businessDate }): Promise<{
  pos: { status: 'ok'; totalSales: Money; totalSessions: number } |
       { status: 'not_found' | 'not_configured' | 'unreachable'; message: string };
  ledger: { exists: true; status: SalesDayStatus; totalSales: Money; posSourced: boolean } |
          { exists: false };
  /** Only meaningful when both sides are 'ok'/exists — null otherwise, never a misleading zero. */
  delta: Money | null;
  matches: boolean | null;
}>
```

## 5. Invariants

Bible §16.1 invariant 6 pattern, restated for a third dimension pair (T-209b did party-vs-control,
T-209c did operating-activity-vs-cash-change): **two independently-sourced totals for the same
recognised revenue must agree, and the report renders the check, not just the numbers.** Phase-6
plan §2.1 (one query per figure) — the day/month/store totals never re-derive what the income
statement already computes for the same range; this task adds a *breakdown*, not a second
definition of revenue.

## 6. Tests

- `packages/domain/tests/integration/sales-rollup.test.ts` — posts two verified sales days across
  two stores with a channel mix (one remitted, one not), asserts: `reconciles === true`;
  day/month/store totals sum correctly; the channel breakdown's non-remitted row matches its 1220
  receivable amount; an unverified (open/submitted) day contributes to NEITHER the ledger total
  NOR the channel breakdown (proving the `status='verified'` filter actually excludes it, not just
  that it happens to sum right).
- `packages/domain/tests/integration/pos-day-reconciliation.test.ts` — with an injected fake
  fetcher: POS `found` + a matching/mismatching Shareat System sales day (`matches` true/false,
  `delta` computed correctly); POS `found: false` → `not_found`; a fetcher that throws the
  "not configured" error → `posStatus: 'not_configured'`, no crash; a fetcher that rejects (network
  error) → `'unreachable'`; no Shareat System sales day exists for that store/date → `ledger:
  {exists: false}`, screen still renders the POS side alone.

## Out of scope

- Actually calling a live POS in CI or in this dev environment — `POS_API_URL`/`POS_API_KEY` are
  unset here (confirmed in `.env.local`), matching T-177's own live-pull, which is equally
  untestable against a real POS locally. The live path is exercised by the graceful-failure tests
  above; the domain logic once POS responds is proven by the injected-fetcher tests.
- Building an actual POS→sales-day AUTO-IMPORT (creating/updating a `sales_days` row from the pull
  automatically) — T-123 already has `posSourced` as a flag a creator sets; wiring a real pull
  INTO `sales_days/new`'s form is a UX change to an already-shipped, tested flow and is a follow-up
  if Ian wants it, not silently bundled into a reporting task.
- A dashboard tile for any of this — T-211, which will call these same functions.

## Done when

- [x] `getSalesByPeriod`/`getSalesByChannelAndMode` written; `getSalesRollup` written and tested,
  including the "unverified day contributes to neither total" regression.
- [x] `fetchPosSalesLive` written (mirrors `fetchPosSoldItemsLive`); `getPosDayReconciliation`
  written and tested against an injected fetcher, including all four graceful non-`ok` states.
- [x] `/reports/sales-rollup` and `/reports/pos-reconciliation` render; CSV export on the rollup
  screen.
- [x] typecheck clean · unit tests pass · full integration suite green · `npm run build` exit 0
  (dev server stopped first) · smoketested live on 9008 (POS reconciliation screen's
  not-configured state is the one that's actually exercisable here).
- [x] `docs/ROADMAP.html` and `docs/plans/phase-6-reporting-and-dashboards.md` updated.
- [x] Nav entries added.
