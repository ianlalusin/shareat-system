# Transaction principals and tenancy registry

## Overview

Transaction-scoped PostgreSQL principal setup, table-policy coverage and explicit same-org foreign-key exceptions.

## Interface

- [principal.ts](./principal.ts): includes `Principal`, `PrincipalSink`, `APP_ROLE`, `applyPrincipal`, `withPrincipal`, `withOrgPrincipal`, `withSystemOrgPrincipal`.
- [registry.ts](./registry.ts): includes `RlsScope`, `RlsEntry`, `RLS_REGISTRY`.
- [same-org-fk-exemptions.ts](./same-org-fk-exemptions.ts): includes `FkKind`, `OpenFkEntry`, `ByDesignEntry`, `CROSS_ORG_BY_DESIGN`, `ORG_LESS_TABLES`, `OPEN_DEF_491`, `NoFkReference`, `NO_FK_REFERENCES`.

## Invariants

- Role and tenant settings are transaction-local; never put request identity onto the lifetime of a pooled connection.
- withOrgPrincipal and withSystemOrgPrincipal apply an org-scoped app-role principal. Cross-org system operations use the separately named system connection path.
- Every table needs an RLS_REGISTRY entry; same-org exceptions must be explicit and match the live foreign-key census.

## Side Effects

- Principal helpers open transactions and set local role/context. Registry and exception declarations alone perform no I/O.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
