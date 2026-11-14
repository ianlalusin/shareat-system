# invoices

## Overview

Route namespace `/ap/invoices`. Supplier register, supplier invoice verification and accounts-payable payments.

Parent blueprint: [up one directory](../README.md).

## Interface

- [[id]](./[id]/README.md) — Supplier invoice at `/ap/invoices/[id]`. Supplier register, supplier invoice verification and accounts-payable payments.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
