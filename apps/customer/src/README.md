# apps/customer/src

## Overview

Customer application source grouped into routes, presentation, a data boundary and browser helpers.

## Interface

- Route components consume CustomerData through provider hooks; types and fixture implementation are owned by data/.
- [app](./app/README.md) — App Router layout and PIN-based table join screen.
- [components](./components/README.md) — Reusable diner presentation and session-aware app frame.
- [data](./data/README.md) — CustomerData contract, diner-facing types, in-memory fixture and React context.
- [lib](./lib/README.md) — Cart operations, Money display, request ids and live data loading.

## Invariants

- Screens use provider hooks instead of importing fixture implementation directly.
- Money values use shared Money strings; order submissions contain item ids and quantities.

## Side Effects

- Rendering and browser storage/subscriptions are implemented by the child modules; this grouping has no executable entry point.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
