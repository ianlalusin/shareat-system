# commissary

## Overview

Route namespace `/commissary`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.

Parent blueprint: [up one directory](../README.md).

## Interface

- [catalogue](./catalogue/README.md) — Commissary catalogue at `/commissary/catalogue`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.
- [discrepancies](./discrepancies/README.md) — Transit discrepancies at `/commissary/discrepancies`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.
- [orders](./orders/README.md) — Branch orders at `/commissary/orders`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
