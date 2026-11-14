# Reference data seeds

## Overview

Declared chart of accounts and expense categories plus functions that insert their missing rows for an organization.

## Interface

- [chart-of-accounts.ts](./chart-of-accounts.ts): includes `AccountType`, `NormalBalance`, `SeedAccountStatus`, `ChartOfAccountsSeedAccount`, `CHART_OF_ACCOUNTS`.
- [expense-categories.ts](./expense-categories.ts): includes `ExpenseCategoryGroup`, `ExpenseCategorySeed`, `EXPENSE_CATEGORY_SEED`, `SeedExpenseCategoriesResult`, `seedExpenseCategories`.

## Invariants

- Account nature is declared in the seed, not inferred from a code prefix.
- Expense-category seed values intentionally mirror the ETL crosswalk without importing @shareat/etl, which would create a dependency cycle.
- seedExpenseCategories uses ON CONFLICT DO NOTHING against the normalized category key; reseeding must not overwrite later explicit edits.

## Side Effects

- Seed arrays are data. Seed functions execute INSERT statements on the supplied PostgreSQL client/transaction and report counts.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
