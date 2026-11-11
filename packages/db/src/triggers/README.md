# Trigger mode registry

## Overview

The explicit expected firing mode for PostgreSQL business and immutability triggers.

## Interface

- [registry.ts](./registry.ts): includes `TriggerMode`, `TriggerEntry`, `TRIGGER_REGISTRY`.

## Invariants

- Classify every non-internal public trigger when adding it. Live census tests compare both presence and tgenabled mode with TRIGGER_REGISTRY.
- Immutability and other protected rules may require ALWAYS firing; follow each entry rather than changing modes wholesale.

## Side Effects

- The registry is data only. Migrations install/change triggers; integration checks inspect the live PostgreSQL catalogue.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
