# clock

## Overview

Handlers and helpers at `/clock`. Offline attendance kiosk using device-authenticated Firebase client SDK reads and queued punches.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/clock`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `ClockTerminalPage`.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.
- Offline clock dependencies use Firebase client SDK only: no Server Actions, `@shareat/db`, `@shareat/domain` or `next/headers` imports.

## Side Effects

- Invokes `signInWithCustomToken`, `writePunch`; persistence or external operations belong to those called services.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.
- Reads mirrored roster/configuration/credentials and appends attendance punch events through the Firebase edge lane; browser persistence and network acknowledgements are observable.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 13,701 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
