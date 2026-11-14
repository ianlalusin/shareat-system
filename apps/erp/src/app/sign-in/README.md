# sign-in

## Overview

Handlers and helpers at `/sign-in`. Email/Firebase, provisioned terminal and paired-tablet sign-in and session lifecycle.

Parent blueprint: [up one directory](../README.md).

## Interface

- [lib.ts](./lib.ts) — `NOT_LINKED_MESSAGE`, `safeNext`, `VerifiedSignInOutcome`, `resolveVerifiedSignIn`.
- [EmailSignInForm.tsx](./EmailSignInForm.tsx) — `EmailSignInForm`.
- [ForgetDeadPairing.tsx](./ForgetDeadPairing.tsx) — `ForgetDeadPairing`.
- [TabletSignInForm.tsx](./TabletSignInForm.tsx) — `TabletSignInForm`.
- [TerminalSignInForm.tsx](./TerminalSignInForm.tsx) — `firebaseSignInMessage`, `TerminalSignInForm`.
- [actions.ts](./actions.ts) — `verifyTerminalAction`, `signInWithTerminalPinAction`, `signInWithTabletPinAction`, `forgetDeadPosTabletAction`, `signInWithEmailAction`, `signOutAction`.
- [firebase-client.ts](./firebase-client.ts) — `signInFirebase`.

## Invariants

- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `signInWithTabletPinAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `signInWithFirebase`, `signInWithEmailAndPassword`, `signInWithEmailAction`, `signInFirebase`, `signInWithTabletPinAction`, `signInWithTerminalPinAction`, `signInWithPin`, `signOut`, `signInOnPairedTablet`, `setSessionCookie`, `setSetupIdentityCookie`, `setPosTabletCookie`; persistence or external operations belong to those called services.
- Repository calls: `organizationsRepo.anyOrganizationExists`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 7 local production/configuration files scanned; 50,000 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
