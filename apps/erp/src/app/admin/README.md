# admin

## Overview

Route namespace `/admin`. Organization, store, user and position-default administration.

Parent blueprint: [up one directory](../README.md).

## Interface

- [access-defaults](./access-defaults/README.md) — Position access defaults at `/admin/access-defaults`. Organization, store, user and position-default administration.
- [prerequisite-refusals](./prerequisite-refusals/README.md) — Prerequisite walls at `/admin/prerequisite-refusals`. Organization, store, user and position-default administration.
- [stores](./stores/README.md) — Stores at `/admin/stores`. Organization, store, user and position-default administration.
- [users](./users/README.md) — Users and roles at `/admin/users`. Organization, store, user and position-default administration.

## Invariants

- Child modules retain their own route, principal and input-validation boundaries; this parent adds navigation only.

## Side Effects

- No executable source in this directory. Runtime reads, mutations and browser behavior occur in the linked child modules.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.
