# Shared primitives

## Overview

Money, dates, logging, environment validation, image metadata stripping and text sanitization.

## Interface

- `@shareat/core` exports: `.` → `./src/index.ts`, `./money` → `./src/money.ts`, `./datetime` → `./src/datetime.ts`, `./logger` → `./src/logger.ts`, `./env` → `./src/env.ts`, `./exif` → `./src/exif.ts`, `./sentence` → `./src/sentence.ts`.
- [src](./src/README.md): Exact money and quantity arithmetic, Manila dates, validated environment access, structured logging and isolated image/text helpers.

## Invariants

- Use the explicit manifest subpaths for a narrow dependency boundary; the barrel includes logger and environment helpers.
- Money arithmetic is exact; business dates use the shared Manila timezone.

## Side Effects

- Effects depend on the selected module: pure transforms, current-time/randomness reads, configuration validation or logging.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
