# liabilities

## Overview

Liabilities at `/liabilities`. Liability charges, payments and ledger-derived unpaid obligations.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/liabilities`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `LiabilityListRow`, `listRegister`, `LiabilityDetail`, `getDetail`, `moneyAccounts`, `chargeableAccounts`, `today`, `CATEGORY_LABEL`, `SOURCE_LABEL`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `createLiabilityAction`, `chargeAction`, `payAction`, `reverseAction`, `retireAction`.
- [page.tsx](./page.tsx) — `LiabilitiesPage`.
- [[id]](./[id]/README.md) — Liability at `/liabilities/[id]`. Liability charges, payments and ledger-derived unpaid obligations.
- [unpaid](./unpaid/README.md) — Everything unpaid at `/liabilities/unpaid`. Liability charges, payments and ledger-derived unpaid obligations.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createLiabilityAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `chargeLiability`, `createLiability`, `payLiability`, `retireLiability`, `reverseLiabilityEntry`, `recordApproval`, `createLiabilityAction`; persistence or external operations belong to those called services.
- Repository calls: `liabilitiesRepo.listLiabilities`, `liabilitiesRepo.positionsByLiability`, `liabilitiesRepo.getById`, `liabilitiesRepo.positionOf`, `liabilitiesRepo.movementsFor`, `moneyAccountsRepo.listMoneyAccounts`, `moneyAccountsRepo.balanceOf`, `liabilitiesRepo.chargeableAccounts`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 18,009 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
