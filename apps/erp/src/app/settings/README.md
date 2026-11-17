# settings

## Overview

Settings at `/settings`. The one door to every business setting: a role-aware list of rows (hidden when you may not open one, "View only" when you may open but not change). Nine screens live under it: organisation, expense categories, business rules, attendance and payroll, POS link, POS tablet, sales channels, usage tolerance and the Wastage Monitor.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/settings`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `SettingsPage`.
- [attendance](./attendance/README.md) — Attendance & payroll settings at `/settings/attendance`. One attendance and payroll policy per store: shift hours, late policy, overtime, holiday pay, leave and the pay period.
- business-rules — Business rules at `/settings/business-rules` (no README of its own yet). The figures the system checks money against: payout tolerance, loan rounding, withholding and VAT rates.
- [expense-categories](./expense-categories/README.md) — Expense categories at `/settings/expense-categories`. Which account each expense category and subcategory posts to; a category with no account blocks posting.
- [organization](./organization/README.md) — Organisation at `/settings/organization`. The registered name, TIN and tax type the books are kept under; printed on documents.
- [pos-link](./pos-link/README.md) — POS link at `/settings/pos-link`. Which POS store each store sells under; a linked store takes its sales days from POS instead of typing them.
- [pos-tablet](./pos-tablet/README.md) — POS tablet at `/settings/pos-tablet`. Pair a store's counter tablet once (staff then sign in with Employee ID and PIN) and cut off a lost one.
- [sales-channels](./sales-channels/README.md) — Sales channels at `/settings/sales-channels`. Per sales channel (walk-in, Grab, Foodpanda): whether its money arrives that day or waits for the platform to pay.
- [usage-tolerance](./usage-tolerance/README.md) — Usage tolerance at `/settings/usage-tolerance`. How far recorded stock usage may differ from what the day's POS sales imply before a manager must give a reason.
- [wastage-monitor](./wastage-monitor/README.md) — Wastage Monitor at `/settings/wastage-monitor`. Who answers for a wasted or refunded order at each store when nobody else is named (charged to them after 15 days).

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; child contracts describe runtime effects.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 9,680 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
