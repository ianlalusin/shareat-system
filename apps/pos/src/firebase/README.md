# src/firebase contract

## Overview

Firebase initialization, React SDK providers, typed error events and non-blocking auth/document helpers.

## Interface

- [index.ts](./index.ts) — `initializeFirebase`, `getSdks`.
- [client-provider.tsx](./client-provider.tsx) — `FirebaseClientProvider`.
- [config.ts](./config.ts) — `firebaseConfig`.
- [error-emitter.ts](./error-emitter.ts) — `AppEvents`, `errorEmitter`.
- [errors.ts](./errors.ts) — `FirestorePermissionError`.
- [non-blocking-login.tsx](./non-blocking-login.tsx) — `initiateAnonymousSignIn`, `initiateEmailSignUp`, `initiateEmailSignIn`.
- [non-blocking-updates.tsx](./non-blocking-updates.tsx) — `setDocumentNonBlocking`, `addDocumentNonBlocking`, `updateDocumentNonBlocking`, `deleteDocumentNonBlocking`.
- [provider.tsx](./provider.tsx) — `FirebaseContextState`, `FirebaseServicesAndUser`, `UserHookResult`, `FirebaseContext`, `FirebaseProvider`, `useFirebase`, `useAuth`, `useFirestore`, `useFirebaseApp`, `useMemoFirebase`, `useUser`.
- [firestore](./firestore/README.md) — React hooks wrapping document and collection snapshots with loading/error state and document IDs.

## Invariants

- Non-blocking write helpers initiate SDK promises without awaiting completion; callers cannot treat their return as server confirmation.
- The barrel exposes initialization, providers and Firestore hooks; the emulator configuration is selected explicitly.

## Side Effects

- Initializes Firebase services, observes auth state and emits permission errors.
- Auth helpers start sign-in/sign-up; document helpers issue Firestore writes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 8 direct source files (18487 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
