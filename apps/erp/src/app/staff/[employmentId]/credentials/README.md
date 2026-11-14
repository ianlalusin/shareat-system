# credentials

## Overview

Credentials at `/staff/[employmentId]/credentials`. Store-scoped staff roster, hiring, employment details and credential enrollment.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/staff/[employmentId]/credentials`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `enrolCardAction`, `enrolFingerprintAction`, `revokeCredentialAction`.
- [page.tsx](./page.tsx) — `CredentialsPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `revokeCredentialAction`, `enrolCardAction`, `enrolFingerprintAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `enrolCard`, `enrolFingerprint`, `revokeCredential`, `enrolCardAction`, `enrolFingerprintAction`, `revokeCredentialAction`; persistence or external operations belong to those called services.
- Repository calls: `employmentRepo.getEmployment`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 13,480 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
