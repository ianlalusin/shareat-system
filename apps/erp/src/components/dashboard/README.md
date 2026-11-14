# dashboard

## Overview

Dashboard sales charts, key figures, comparison ranges and textual chart legends.

Parent blueprint: [up one directory](../README.md).

## Interface

- [ChannelDonut.tsx](./ChannelDonut.tsx) — `ChannelDonut`.
- [HeroNumber.tsx](./HeroNumber.tsx) — `HeroNumber`.
- [MetricStrip.tsx](./MetricStrip.tsx) — `MetricStrip`.
- [OutlineCount.tsx](./OutlineCount.tsx) — `OutlineCount`.
- [RangeForm.tsx](./RangeForm.tsx) — `DashboardStoreOption`, `RangeForm`.
- [RightNowBand.tsx](./RightNowBand.tsx) — `RightNowBand`.
- [SalesHover.tsx](./SalesHover.tsx) — `SalesHoverPoint`, `SalesHover`.
- [SalesLine.tsx](./SalesLine.tsx) — `SalesLinePoint`, `SalesChannelLine`, `SalesLegendItem`, `SalesLine`.
- [StoreBars.tsx](./StoreBars.tsx) — `StoreBars`.
- [chart-colors.ts](./chart-colors.ts) — `SERIES_COLORS`, `seriesColor`.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; rendering/pure transformation is the local boundary, with submitted callbacks owned by callers.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 10 local production/configuration files scanned; 25,869 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
