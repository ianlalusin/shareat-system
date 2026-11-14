# Shared authentication

## Overview

Session/actor resolution, capability gates, role/grant administration, credential helpers and POS approval checks.

## Interface

- `@shareat/auth` exports: `.` → `./src/index.ts`, `./errors` → `./src/errors.ts`.
- [src](./src/README.md): Server identity resolution, capability decisions and approval checks, with a separate dependency-light error entry.

## Invariants

- The main entry reaches server database-backed code; ./errors is a separate lightweight error-class entry.
- Authorization combines role, store scope and grants. UI permission probes do not replace authorize gates.

## Side Effects

- Identity/permission/approval calls read and mutate PostgreSQL, emit security events and use cryptographic operations.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
