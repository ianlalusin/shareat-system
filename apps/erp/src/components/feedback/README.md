# feedback

## Overview

Pending submission controls, toast delivery and count-up feedback with reduced-motion behavior.

Parent blueprint: [up one directory](../README.md).

## Interface

- [CountUp.tsx](./CountUp.tsx) — `CountUp`.
- [SubmitButton.tsx](./SubmitButton.tsx) — `SubmitButtonProps`, `SubmitButton`.
- [Toaster.tsx](./Toaster.tsx) — `ToasterProps`, `Toaster`.
- [count-up.ts](./count-up.ts) — `easeOutCubic`, `initialDisplay`, `countUpValue`.
- [submit-button-state.ts](./submit-button-state.ts) — `SubmitButtonStateInput`, `SubmitButtonState`, `DEFAULT_PENDING_LABEL`, `submitButtonState`.
- [toast-dedupe.ts](./toast-dedupe.ts) — `TOAST_SEEN_KEY`, `TOAST_MS`, `STAMP_MS`, `SeenStore`, `shouldShow`, `markShown`, `stampAnimation`.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Invokes `submitButtonState`; persistence or external operations belong to those called services.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 6 local production/configuration files scanned; 12,022 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
