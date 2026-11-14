# settings

## Overview

Settings at `/settings`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/settings`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `SettingsPage`.
- [attendance](./attendance/README.md) — Attendance & payroll settings at `/settings/attendance`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [expense-categories](./expense-categories/README.md) — Expense categories at `/settings/expense-categories`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [organization](./organization/README.md) — Organisation at `/settings/organization`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [pos-link](./pos-link/README.md) — POS link at `/settings/pos-link`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [pos-tablet](./pos-tablet/README.md) — POS tablet at `/settings/pos-tablet`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [sales-channels](./sales-channels/README.md) — Sales channels at `/settings/sales-channels`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [usage-tolerance](./usage-tolerance/README.md) — Usage tolerance at `/settings/usage-tolerance`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.
- [wastage-monitor](./wastage-monitor/README.md) — Wastage Monitor at `/settings/wastage-monitor`. Configuration screens for organization, attendance, POS links, sales channels and monitoring.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; child contracts describe runtime effects.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 9,680 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
