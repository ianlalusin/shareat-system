# src/app/signup contract

## Overview

Account creation followed by required staff details.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/signup`; `SignupPage`.

## Invariants

- The newly created user is retained for profile completion; the details modal blocks outside/escape dismissal.

## Side Effects

- Creates a Firebase Auth user and staff profile, then navigates to pending approval.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (10912 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
