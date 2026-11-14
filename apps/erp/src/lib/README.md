# lib

## Overview

ERP request/session, safe feedback, authorization, formatting and server-loader utilities.

Parent blueprint: [up one directory](../README.md).

## Interface

- [account-label.ts](./account-label.ts) — `UNKNOWN_ACCOUNT`, `MONEY_ACCOUNT_CODES`, `ACCOUNT_WORDS`, `accountLabel`, `accountCodeAndName`.
- [constraint-messages.ts](./constraint-messages.ts) — `CONSTRAINT_MESSAGES`, `parseConstraintName`, `resolveConstraintName`.
- [csv.ts](./csv.ts) — `toCsv`, `csvResponse`.
- [destructive.ts](./destructive.ts) — `loadDestructiveTarget`, `authorizeOrgLevel`, `ApprovalFacts`, `recordApproval`, `assertApprovalStillRight`, `retypeRefusalError`.
- [error-shape.ts](./error-shape.ts) — `hasStringCode`, `looksLikeADump`, `UUID_SHAPE`, `containsIdentifier`, `isPresentable`.
- [firebase-auth-admin.ts](./firebase-auth-admin.ts) — `VerifiedFirebaseIdentity`, `verifyFirebaseIdToken`.
- [flash-toast.ts](./flash-toast.ts) — `readToastFlash`.
- [flash.ts](./flash.ts) — `flashCookieName`, `FLASH_KEYS`, `FlashKey`, `STAMP_WORDS`, `StampWord`, `KEEP_KEYS`, `KeepKey`, `NavKey`, `Nav`, `TypedFlash`, `TypedDropped`, `Flash`, `FlashFields`, `FlashPayload`.
- [money-lines](./money-lines/README.md) — Server preparation of wallet and open-float payloads for the shared money-lines control.
- [terminal](./terminal/README.md) — Browser-only Firebase initialization and the attendance mirror/inbox lane.
- [session.ts](./session.ts) — `setSessionCookie`, `clearSessionCookie`, `setPosTabletCookie`, `readPosTabletToken`, `clearPosTabletCookie`, `readSessionToken`, `currentSession`, `requireSession`, `requireActor`, `SetupIdentity`, `SETUP_IDENTITY_TTL_MS` (targeted follow-up inspection).

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Session cookies are httpOnly, SameSite=lax, path=/ and secure in production. `currentSession` resolves identity through the auth transaction and treats absent/expired sessions as unauthenticated. `requireSession` redirects to sign-in.

## Side Effects

- Repository calls: `destructiveTargetsRepo.targetOf`, `auditLogRepo.append`. These execute through the surrounding transaction context.
- Uses Next request cookies; helper-specific reads/writes are in the linked implementation.
- Returns a downloadable CSV HTTP response using the same scoped report data.
- Session helpers read/write/delete cookies, resolve signed-in Actors through shared auth and redirect unauthenticated requests. The setup identity cookie carries verified identity for first-run bootstrap; it is not a session.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 8 local production/configuration files scanned; 50,000 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.

The session helper received an additional targeted 200-line read after the initial 50,000-byte directory scan; this directory exceeded that scouting budget.
