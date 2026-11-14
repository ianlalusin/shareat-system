# erp

## Overview

Next.js ERP workspace (@shareat/erp), with server-rendered back-office workflows and an independent offline clock kiosk. The workspace uses shared packages for domain rules, authorization, persistence and storage.

Parent blueprint: [up one directory](../README.md).

## Interface

- [next.config.js](./next.config.js) — workspace build/style configuration.
- [postcss.config.mjs](./postcss.config.mjs) — workspace build/style configuration.
- [tailwind.config.ts](./tailwind.config.ts) — workspace build/style configuration.
- [warm-neutral.ts](./warm-neutral.ts) — `WARM_NEUTRAL`.
- [src](./src/README.md) — Next.js runtime entry points and the app, component and library boundaries.

## Invariants

- Keep the direct module exports and child boundaries listed here separate; this grouping does not define an additional domain or authorization rule.
- ERP dev/start bind port 9008. Apps depend on shared packages and never import another app. PostgreSQL remains authoritative; the clock has the separate offline edge path.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; child contracts describe runtime effects.
- Next dev/start serves the ERP on 9008; build emits Next output. Stop the local dev server before a build. Builds are never run on either droplet.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 9,777 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
