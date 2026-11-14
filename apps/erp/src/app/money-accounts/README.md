# money-accounts

## Overview

Money accounts at `/money-accounts`. Money-account creation, naming and retirement with custody/instrument labels.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/money-accounts`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `MoneyAccountRow`, `listAll`, `CUSTODIAN_LABEL`, `INSTRUMENT_LABEL`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `createMoneyAccountAction`, `retireMoneyAccountAction`, `renameMoneyAccountAction`.
- [page.tsx](./page.tsx) — `MoneyAccountsPage`.
- [typed-forms.ts](./typed-forms.ts) — `MONEY_ACCOUNT_RENAME`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `renameMoneyAccountAction`, `retireMoneyAccountAction`, `createMoneyAccountAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createMoneyAccount`, `retireMoneyAccount`, `createMoneyAccountAction`, `retireMoneyAccountAction`; persistence or external operations belong to those called services.
- Repository calls: `moneyAccountsRepo.listMoneyAccounts`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 18,267 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
