# @shareat/domain Blueprint

## System Overview
The business-rules layer of Shareat System. It sits between the data layer (`@shareat/db`) and the front-ends (`apps/*`). It composes repository calls into business operations and owns the transactions. Authorization comes from `@shareat/auth`; money, dates and logging come from `@shareat/core`.

## Interface
- src: [README](./src/README.md) - all modules, grouped by area: books and money, sales and POS, stock and production, people, platform.
- tests: unit tests and an `integration/` suite. Not documented.

## Invariants
- Never imports from `apps/` (bible §8).
- Public surface is the barrel plus the subpaths in `package.json` `exports`.
- Postgres owns the truth; ledger writes go through `src/ledger`.

## Side Effects
- Reads and writes PostgreSQL through `@shareat/db`.
- Drives the Firestore mirror and storage bucket through `sync`, `scheduler` and `files`.

## Verification
- Run: `npm test` (from the repo root; vitest unit project). Integration: `npm run test:integration`.
