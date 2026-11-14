# Shared core primitives

## Overview

Exact money and quantity arithmetic, Manila dates, validated environment access, structured logging and isolated image/text helpers.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [datetime.ts](./datetime.ts): includes `BUSINESS_TIMEZONE`, `BusinessDate`, `toBusinessDate`, `parseBusinessDate`, `businessDayRange`, `addDays`, `formatBusinessDateTime`.
- [env.ts](./env.ts): includes `ServerEnv`, `env`.
- [exif.ts](./exif.ts): includes `StripResult`, `stripJpegMetadata`, `stripImageMetadata`.
- [logger.ts](./logger.ts): includes `logger`, `childLogger`, `newCorrelationId`, `jobResult`.
- [money.ts](./money.ts): includes `Decimal`, `Money`, `Quantity`, `decimal`, `compareDecimal`, `money`, `ZERO`, `toCentavos`, `fromCentavos`, `add`, `subtract`, `negate`.
- [sentence.ts](./sentence.ts): includes `UUID_SHAPE`, `screenSentence`.

## Invariants

- Money uses branded decimal strings and integer centavos for arithmetic; database numerics must not round-trip through JavaScript floats.
- Asia/Manila is defined by BUSINESS_TIMEZONE. Business dates are explicit values, not the host machine calendar.
- The main index re-exports money, datetime, logger and env; exif and sentence have their own manifest subpaths.
- env() validates required server configuration on first access; browser callers use the explicit public configuration API.

## Side Effects

- Money, sentence and metadata transforms operate on supplied values; date helpers may use the current time when omitted.
- Environment helpers inspect process configuration. Logger calls emit structured output; correlation ids use randomness.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
