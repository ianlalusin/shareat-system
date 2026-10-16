# T-411 — Whole-row click everywhere: one shared `RowLink`, a 30-file sweep, and a census

**Status:** **DONE 2026-10-16, merged a879264 (PR #28)** (RowLink on 30 tables; sweep 147 -> 116 FAIL). Questions answered BY DEFAULT ONLY (Ian has not answered on the page yet). | Earlier: SPEC 2026-10-15, Opus. Work list item 16 (`docs/plans/2026-10-14-ian-answers-worklist.md`), review item 13.
Generalises T-258 (`docs/tasks/258-def-244-tappable-rows.md`, the stretched-link technique, Ian 2026-09-10) and T-404's
`admin/stores` row. **No migration. No server change. Size M.** **Model: HAIKU workers, one file each** (S1 is one Haiku
worker with the code below pasted verbatim; S2 is up to 30 Haiku workers, one file each, run in parallel — they share no
file and no database). Orchestrator reviews the diff and runs the browser pass.

## Goal
A row that opens something opens it wherever you tap on the row, not only on the underlined word. One implementation
(in `components/ui/Table.tsx`), used by every such row, and a census test so a new table cannot quietly skip it.

## Counted 2026-10-15 (grep + a `<tr>…</tr>` scanner over `apps/erp/src`)
- **76 `.tsx` files** render a `<table>`/`<Table>` (plus `Table.tsx` itself). The work list's "~75" holds.
- **30 have rows that link somewhere** -> `ROW_LINK` (below). 2 already use the hand-rolled technique
  (`admin/stores/page.tsx`, `customers/[customerId]/page.tsx`) and `ap/suppliers/[id]/page.tsx` has one row of two;
  all three move onto the shared component so there is one implementation.
- **46 have no row destination** -> `NO_ROW_TARGET` (reports, editing grids, line items). Untouched by this task.

## S1 — the component and the census (one Haiku worker; tests first)
Add to `apps/erp/src/components/ui/Table.tsx` (keep: no `'use client'`, no hooks — `next/link` renders on the server)
and export all three from `components/ui/index.ts`:
```tsx
import Link from 'next/link';
import type { ComponentProps, HTMLAttributes } from 'react';
/** T-258/T-411: the ::after box covers the nearest `relative` ancestor — the LinkRow. The ONE copy of this class. */
export const ROW_LINK_STRETCH = "after:absolute after:inset-0 after:content-['']";
/** A row that is one tap target. `relative` is what the RowLink's ::after stretches to; h-11 = 44px minimum. */
export function LinkRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={join('relative h-11 hover:bg-canvas focus-within:bg-canvas', className)} {...rest} />;
}
/** The row's ONE link: a real anchor with an accessible name (T-258 point 4), stretched over the whole row. */
export function RowLink({ className, ...rest }: ComponentProps<typeof Link>) {
  return <Link className={join(`underline underline-offset-2 ${ROW_LINK_STRETCH}`, className)} {...rest} />;
}
/** Anything else in a linked row (a form, a second link, an input) sits ABOVE the stretched box. */
export function RowAction({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={join('relative z-10 inline-block', className)} {...rest} />;
}
```
Tests (write first, see them red, then add the code):
- **NEW** `apps/erp/tests/t411-row-link.test.ts` (unit, `renderToStaticMarkup` as `tests/filter-row.test.ts` does):
  `RowLink` renders an `<a>` with the `href`, its text, and every class in `ROW_LINK_STRETCH`; `LinkRow` renders `<tr`
  with `relative` and `h-11`; `RowAction` renders with `relative` and `z-10`; a caller `className` is appended, never
  replaces the base.
- **NEW** `apps/erp/tests/t411-row-link-census.test.ts` (static, no DB). Holds two literal lists, `ROW_LINK` and
  `NO_ROW_TARGET` (exactly the paths below, relative to `apps/erp/src`), and asserts:
  1. the set of `.tsx` files under `apps/erp/src` containing `<table` or `<Table ` (excluding `components/ui/Table.tsx`)
     **equals** `ROW_LINK ∪ NO_ROW_TARGET`; the two are disjoint; every listed path exists;
  2. for each `ROW_LINK` file: it imports `RowLink`; every data row (`<tr`/`<LinkRow` … its close, skipping header-only
     rows) whose body contains `href=` contains exactly one `<RowLink` and opens with `<LinkRow`; any other `href=`,
     `<form`, `<Button`, `<button`, `<input`, `<Input` in that row sits inside `<RowAction`;
     `ALLOWED_PLAIN_LINK_ROWS` = `{ 'app/admin/users/page.tsx': ['"/staff"'] }` (the empty-state row, not a record);
  3. for each `NO_ROW_TARGET` file: no data row contains `href=` (a new link there forces a reclassification);
  4. the string `after:inset-0` appears in no `.tsx` under `apps/erp/src` except `components/ui/Table.tsx`.
  The census starts **red** (rule 2 fails on all 30 files) — that is the point; S2 turns it green file by file.

## S2 — the sweep: one Haiku worker per file (paths under `apps/erp/src/app/`)
For each file: the linked `<tr>` -> `<LinkRow key=…>` (keep its `key` and any existing className); the row's main link
-> `<RowLink href=…>` (same href, same text); every other control in that row wrapped in `<RowAction>`; remove the old
hand-rolled `after:absolute after:inset-0 after:content-['']` and any `relative` on that `<tr>`. **Do not change hrefs,
text, columns, data or queries.** If a row has two record links, the one named in the table below is the RowLink and the
other goes in a RowAction. Run the census for your file only (`-t` filter) and `npm run typecheck`.

| # | File | Row(s) (line, destination) |
|---|---|---|
| 1 | `admin/stores/page.tsx` | :62 store (migrate T-404's hand-rolled link) |
| 2 | `admin/users/page.tsx` | :70 user (:59 is the empty-state `/staff` row — leave it) |
| 3 | `ap/invoices/[id]/page.tsx` | :285 line -> item; :331 linked expense |
| 4 | `ap/page.tsx` | :75 supplier |
| 5 | `ap/suppliers/[id]/page.tsx` | :272 expense; :325 invoice (migrate hand-rolled) |
| 6 | `ap/suppliers/page.tsx` | :104 supplier |
| 7 | `attendance/page.tsx` | :189 day |
| 8 | `cash-requests/page.tsx` | :96 request |
| 9 | `channel-settlements/page.tsx` | :336 "record" anchor link |
| 10 | `commissary/catalogue/page.tsx` | :119 branch filter link |
| 11 | `commissary/orders/page.tsx` | :133 order |
| 12 | `customers/[customerId]/page.tsx` | :266-270 charges (migrate); :394 collections — entry is the RowLink, the receipt-file link and the void form go in RowAction (T-258's own resolution) |
| 13 | `customers/page.tsx` | :78 customer; the row's form -> RowAction |
| 14 | `expenses/page.tsx` | :114 expense |
| 15 | `fixed-assets/page.tsx` | :210 asset |
| 16 | `inventory/counts/page.tsx` | :137 count |
| 17 | `inventory/deliveries/[id]/page.tsx` | :132 line -> item; the row's input -> RowAction |
| 18 | `inventory/deliveries/page.tsx` | :109 delivery |
| 19 | `inventory/production/page.tsx` | :140 production |
| 20 | `inventory/usage/[id]/page.tsx` | :68 line -> item |
| 21 | `inventory/usage/page.tsx` | :115 usage |
| 22 | `items/page.tsx` | :201 item |
| 23 | `liabilities/page.tsx` | :93 liability |
| 24 | `loans/page.tsx` | :71 loan |
| 25 | `owners/page.tsx` | :103 owner |
| 26 | `prepaid/page.tsx` | :133 prepaid item |
| 27 | `sales-days/page.tsx` | :126 sales day |
| 28 | `trade/orders/[id]/page.tsx` | :165 line -> item; the row's control -> RowAction |
| 29 | `trade/orders/page.tsx` | :93 order |
| 30 | `wastage/page.tsx` | :243 and :275 wastage record |

Line numbers are as of `76ba502`; a worker re-finds the row by its href if lines moved.

## `NO_ROW_TARGET` — 46 files, not touched (census list, paths under `apps/erp/src/`)
Reports (9): `components/reports/{ApAging,ArAging,BalanceSheet,CashFlow,IncomeStatement,JournalLines,SalesRollup,StoreComparison,TrialBalance}Table.tsx`.
Editing grids / rows are forms (21): `app/admin/access-defaults/grid.tsx`, `app/attendance/lane/page.tsx`,
`app/attendance/terminals/page.tsx`, `app/inventory/counts/[id]/page.tsx`, `app/inventory/locations/page.tsx`,
`app/inventory/low-stock/page.tsx`, `app/inventory/pos-usage/page.tsx`, `app/inventory/returns/page.tsx`,
`app/inventory/transfers/page.tsx`, `app/liabilities/[id]/page.tsx`, `app/loans/[id]/page.tsx`,
`app/menu/usage-source/page.tsx`, `app/money-accounts/page.tsx`, `app/money-transfers/page.tsx`, `app/payroll/page.tsx`,
`app/prepaid/[id]/page.tsx`, `app/remittance/page.tsx`, `app/sales-days/SalesDayForm.tsx`,
`app/settings/expense-categories/page.tsx`, `app/statutory-discounts/page.tsx`, `app/trade/returns/page.tsx`.
Read-only detail lines with nowhere to go (16): `app/admin/prerequisite-refusals/page.tsx`,
`app/customers/price-lists/[id]/page.tsx`, `app/cutover/count/sheet/page.tsx`, `app/expenses/[id]/page.tsx`,
`app/findings/scorecard/page.tsx`, `app/fixed-assets/[id]/page.tsx`, `app/inventory/page.tsx`,
`app/inventory/pos-map/page.tsx`, `app/inventory/production/[id]/page.tsx`, `app/items/[id]/page.tsx`,
`app/menu/items/[id]/page.tsx`, `app/owners/[id]/page.tsx`, `app/payroll/thirteenth-month/page.tsx`,
`app/sales-days/[id]/page.tsx`, `app/settings/pos-link/page.tsx`, `app/till/page.tsx`.
**Not decided here:** whether some of these lists *should* gain a detail screen (e.g. money transfers, returns). That is
new screens, not this sweep.

## Invariants and mutants (each must turn a test red, then be reverted)
- **I1** one stretch implementation. **M1** delete `after:inset-0` from `ROW_LINK_STRETCH` -> t411-row-link red.
  **M2** paste `after:absolute after:inset-0` into `ap/page.tsx` -> census rule 4 red.
- **I2** the row is the containing block. **M3** drop `relative` from `LinkRow` -> unit red.
- **I3** second controls stay clickable. **M4** drop `z-10` from `RowAction` -> unit red. **M5** unwrap the void form in
  `customers/[customerId]` from its RowAction -> census rule 2 red.
- **I4** every linked row uses it. **M6** revert `loans/page.tsx`'s row to a plain `<Link>` -> census rule 2 red.
- **I5** a new table must be classified. **M7** add a scratch `app/zz/page.tsx` with a `<table>` -> census rule 1 red.
- **I6** an unclassified link in a no-target table is caught. **M8** add an `href` row to `till/page.tsx` -> rule 3 red.

## Checks the builder must also run (do not loosen any baseline; report a change, do not re-pin it)
`apps/erp/tests/action-link-sweep.test.ts` and the touch-target sweep (`touch-target-geometry.ts`,
`touch-target-baseline.json`): RowLink is a new link shape; if either flags it, report it with the output.

## Done when
`npm run typecheck` clean; `npx vitest run apps/erp/tests/t411-row-link.test.ts apps/erp/tests/t411-row-link-census.test.ts
apps/erp/tests/action-link-sweep.test.ts` green; `npm test` green; M1-M8 shown red then reverted. **Browser pass by the
orchestrator** (T-258 method): at 390 and 1280, on `/loans`, `/expenses`, `/customers/[id]`, `/ap/suppliers/[id]`, probe
the centre and the boundary between every consecutive pair of rows (scroll into view first — `elementFromPoint` is
viewport-relative); no probe returns a neighbour's link; every linked row ≥44px; Tab reaches each row link with a
visible focus; the void button on a customers collection row still voids, not navigates. Screenshots attached.

## Out of scope
New detail screens; the 46 `NO_ROW_TARGET` files; card lists that are not `<table>`s; any query, href or copy change.
