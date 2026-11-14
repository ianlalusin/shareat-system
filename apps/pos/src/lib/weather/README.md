# src/lib/weather contract

## Overview

Weather icon metadata, night-hour classification and calendar-specific icon variants.

## Interface

- [icons.ts](./icons.ts) — `WeatherIconMeta`, `isNightHour`, `getWeatherIcon`, `getWeatherOptions`, `getCalendarWeatherIcon`.

## Invariants

- Sunny weather gets the night override when requested.
- Icon/palette decisions are deterministic for the supplied condition and night flag.

## Side Effects

- Returns icon metadata; no weather API or logging writes occur here.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (2662 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
