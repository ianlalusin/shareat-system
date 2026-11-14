# channel-settlements

## Overview

Channel settlements at `/channel-settlements`. Sales-channel payout previews, deductions, destination accounts and settlement recording.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/channel-settlements`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `LoanOption`, `DestinationOption`, `listChannels`, `listWaitingDays`, `listRecentSettlements`, `listActiveLoans`, `listDestinationAccounts`, `peso`, `withOrgPrincipal`.
- [SettlementForm.tsx](./SettlementForm.tsx) — `ChannelChoice`, `DayChoice`, `LoanChoice`, `PreviewShape`, `SettlementForm`.
- [actions.ts](./actions.ts) — `PreviewRequest`, `PreviewResponse`, `previewSettlementAction`, `recordSettlementAction`, `voidSettlementAction`, `setPayoutDestinationAction`.
- [page.tsx](./page.tsx) — `ChannelSettlementsPage`.
- [typed-forms.ts](./typed-forms.ts) — `PAYOUT_DESTINATION_EDIT`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `recordSettlementAction`, `setPayoutDestinationAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `recordSettlementAction`, `recordChannelSettlement`, `setChannelPayoutDestination`, `voidChannelSettlement`, `recordApproval`, `setPayoutDestinationAction`, `voidSettlementAction`; persistence or external operations belong to those called services.
- Repository calls: `channelSettlementsRepo.listSettlementChannels`, `channelSettlementsRepo.listSettleableChannelDays`, `channelSettlementsRepo.listSettlements`, `loansRepo.listLoans`, `loansRepo.positionsByLoan`, `moneyAccountsRepo.listMoneyAccounts`, `auditLogRepo.latestForEntity`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 5 local production/configuration files scanned; 41,564 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
