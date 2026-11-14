# Database runtime

## Overview

Lazy PostgreSQL clients, explicit transaction lanes, shared refusal primitives and the public repository barrel.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [client.ts](./client.ts): includes `getSql`, `getDb`, `Database`, `Tx`, `Executor`, `transaction`, `closeDb`, `getSystemSql`, `getSystemDb`, `systemTransaction`, `authTransaction`, `closeSystemDb`.
- [refusal.ts](./refusal.ts): includes `RefusalError`, `refuse`, `goneSentence`.
- [audit](./audit/README.md): Closed event catalogue, deterministic JSON encoding and secret redaction used by the audit repository.
- [cutover](./cutover/README.md): Explicit table lifecycle classification and the plan/apply machinery used by the operational cutover command.
- [pos-v1](./pos-v1/README.md): The boundary translation for legacy POS endpoint paths and misleading wire field names, plus test payload builders.
- [repo](./repo/README.md): SQL and row-level operations for the business modules.
- [rls](./rls/README.md): Transaction-scoped PostgreSQL principal setup, table-policy coverage and explicit same-org foreign-key exceptions.
- [triggers](./triggers/README.md): The explicit expected firing mode for PostgreSQL business and immutability triggers.

## Invariants

- Importing the client must not open a socket or read secrets: Next evaluates modules during builds.
- Keep PostgreSQL numeric values as strings. Services compose repositories under the intended principal.
- systemTransaction and authTransaction are exceptional, named connection lanes with restricted callers; do not replace normal org-scoped access with them.

## Side Effects

- First database use lazily opens pooled connections; transaction helpers commit or roll back their callbacks. closeDb and closeSystemDb release their pools.
- Repository namespaces exposed by index.ts perform database reads, writes and locks. Refusal helpers throw user-facing errors.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
