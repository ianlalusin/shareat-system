# terminals

## Overview

Clock terminals at `/attendance/terminals`. Attendance review, adjudication, leave, provisioned clock terminals and sync-lane recovery.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/attendance/terminals`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `terminalsForStore`, `listStores`, `withOrgPrincipal`, `isReady`, `StoreOption`, `ClockTerminalRow`.
- [ProvisionForm.tsx](./ProvisionForm.tsx) — `ProvisionForm`.
- [RepairButton.tsx](./RepairButton.tsx) — `RepairButton`.
- [TokenReveal.tsx](./TokenReveal.tsx) — `TokenReveal`.
- [actions.ts](./actions.ts) — `ProvisionActionResult`, `provisionTerminalAction`, `MintTokenActionResult`, `mintTerminalTokenAction`, `revokeTerminalAction`.
- [page.tsx](./page.tsx) — `TerminalsPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `provisionTerminalAction`, `mintTerminalTokenAction`, `revokeTerminalAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createFirestoreTerminalDriver`, `mintTerminalToken`, `provisionTerminal`, `revokeTerminal`, `mintTerminalTokenAction`, `provisionTerminalAction`, `revokeTerminalAction`; persistence or external operations belong to those called services.
- Loads screen/report data through `listTerminals`, `listStores`, `loadDestructiveTarget`.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 6 local production/configuration files scanned; 23,818 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
