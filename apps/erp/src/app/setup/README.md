# setup

## Overview

Set up Shareat System at `/setup`. First-organization bootstrap from a verified setup identity.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/setup`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `systemIsAlreadySetUp`, `SetupView`, `setupView`, `setupFailureRedirect`.
- [SubmitButton.tsx](./SubmitButton.tsx) — `SubmitButton`.
- [actions.ts](./actions.ts) — `createFirstRunAction`.
- [page.tsx](./page.tsx) — `SetupPage`.

## Invariants

- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `createFirstRunAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `bootstrapOrganization`, `signInWithFirebase`, `setSessionCookie`, `createFirstRunAction`; persistence or external operations belong to those called services.
- Repository calls: `organizationsRepo.anyOrganizationExists`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 22,107 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
