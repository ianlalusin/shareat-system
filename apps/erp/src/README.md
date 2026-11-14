# src

## Overview

Next.js runtime entry points and the app, component and library boundaries.

Parent blueprint: [up one directory](../README.md).

## Interface

- [instrumentation.ts](./instrumentation.ts) — `register`.
- [proxy.ts](./proxy.ts) — `proxy`, `config`.
- [app](./app/README.md) — App Router pages, route handlers and server-action adapters for the ERP. Root layout and recovery boundaries wrap the signed-in dashboard and module screens.
- [components](./components/README.md) — Shared ERP presentation controls and module-independent form, shell, report, money and upload components.
- [generated](./generated/README.md) — Build revision constant consumed by health and shell surfaces.
- [lib](./lib/README.md) — ERP request/session, safe feedback, authorization, formatting and server-loader utilities.

## Invariants

- Keep the direct module exports and child boundaries listed here separate; this grouping does not define an additional domain or authorization rule.
- `proxy` matcher is confined to `/clock` and its descendants; kiosk marking is a request header passed to server components. Storage registration runs only for the Node runtime.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; child contracts describe runtime effects.
- `register` installs the Firebase storage driver when configured and logs driver selection. `proxy` stamps kiosk requests before the shell renders.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 3,812 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
