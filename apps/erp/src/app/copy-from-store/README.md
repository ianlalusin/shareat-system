# copy-from-store

## Overview

The shared "Copy from another store" window (T-611): copies a store's menu hours, store prices (with option prices) or kitchen stations and routes onto other stores of the same organisation. No route of its own; `/menu/hours`, `/menu/prices` and `/kitchen` draw the button for an administrator.

## Interface

- [CopyFromStoreDialog.tsx](./CopyFromStoreDialog.tsx) — `CopyFromStoreDialog` (client): source, target checkboxes, Replace option, server-computed preview, administrator PIN confirm (Tier P).
- [actions.ts](./actions.ts) — `previewCopyAction` (read-only), `copyFromStoreAction` (PIN, then one transaction per target).
- [lib.ts](./lib.ts) — `copyStoreChoices`, `copyChoicesFor`.

## Invariants

- The browser sends ids and choices only; the plan, the gate (administrator, edit right at each target, same organisation) and the PIN check are the server's.
- Writes go through `copySettingsToStore` (domain), which calls the existing menu writers; additive unless Replace; history is never edited and nothing is withdrawn.
- One `settings.copied` audit row per target, in that target's transaction.

## Verification

`packages/domain/tests/integration/t611-s1-copy-hours-prices.test.ts`, `apps/erp/tests/t412-destructive-census.test.ts`.
