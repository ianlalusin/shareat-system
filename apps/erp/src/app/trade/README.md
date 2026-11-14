# trade

## Overview

Route namespace `/trade`. Wholesale order fulfilment, delivery receipt printing and customer returns.

Parent blueprint: [up one directory](../README.md).

## Interface

- [orders](./orders/README.md) — Trade orders at `/trade/orders`. Wholesale order fulfilment, delivery receipt printing and customer returns.
- [returns](./returns/README.md) — Customer returns at `/trade/returns`. Wholesale order fulfilment, delivery receipt printing and customer returns.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
