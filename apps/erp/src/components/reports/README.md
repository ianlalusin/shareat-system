# reports

## Overview

Financial statement tables, reconciliation indicators, filters and account drill links.

Parent blueprint: [up one directory](../README.md).

## Interface

- [AccountDrillLink.tsx](./AccountDrillLink.tsx) — `AccountDrillLink`.
- [AgingFilters.tsx](./AgingFilters.tsx) — `FilterOption`, `AgingFilters`.
- [ApAgingTable.tsx](./ApAgingTable.tsx) — `ApAgingTableRow`, `ApAgingReconciliationIndicator`, `ApAgingTotals`, `ApAgingTable`.
- [ArAgingTable.tsx](./ArAgingTable.tsx) — `ArAgingTableRow`, `ArAgingTotals`, `ArAgingReconciliationIndicator`, `ArAgingTable`.
- [BalanceSheetFilters.tsx](./BalanceSheetFilters.tsx) — `FilterOption`, `BalanceSheetFilters`.
- [BalanceSheetTable.tsx](./BalanceSheetTable.tsx) — `BalanceSheetTableLine`, `BalanceSheetTieIndicator`, `BalanceSheetTable`.
- [CashFlowTable.tsx](./CashFlowTable.tsx) — `CashFlowTableLine`, `CashFlowReconciliationIndicator`, `CashFlowTable`.
- [CsvExportLink.tsx](./CsvExportLink.tsx) — `CsvExportLink`.
- [EmptyState.tsx](./EmptyState.tsx) — `EmptyState`.
- [IncomeStatementTable.tsx](./IncomeStatementTable.tsx) — `IncomeStatementTableLine`, `IncomeStatementTable`.
- [JournalLinesTable.tsx](./JournalLinesTable.tsx) — `JournalLineRow`, `JournalLinesTable`.
- [PosReconciliationCard.tsx](./PosReconciliationCard.tsx) — `PosSideView`, `LedgerSideView`, `PosReconciliationCard`.
- [ReportBasis.tsx](./ReportBasis.tsx) — `ReportBasis`.
- [ReportFilters.tsx](./ReportFilters.tsx) — `FilterOption`, `ReportFilters`.
- [SalesRollupTable.tsx](./SalesRollupTable.tsx) — `SalesPeriodRow`, `SalesChannelRow`, `SalesModeRow`, `SalesReconciliationIndicator`, `SalesPeriodTable`, `SalesChannelTable`, `SalesModeTable`.

## Invariants

- Preserve the declared input/output types; domain rules and authorization remain with the callers and shared packages.
- Report tables render supplied rows and reconciliation values; the enclosing report route owns authorization and queries. Drill links carry the report filters.

## Side Effects

- No direct persistence/network operation appears in the scanned local source; rendering/pure transformation is the local boundary, with submitted callbacks owned by callers.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 15 local production/configuration files scanned; 50,000 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
