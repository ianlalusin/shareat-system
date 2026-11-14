# shell

## Overview

Session-aware ERP shell, sidebar, top bar, page primitives and phone table adaptation.

Parent blueprint: [up one directory](../README.md).

## Interface

- [AppShell.tsx](./AppShell.tsx) — `AppShell`.
- [DetailLayout.tsx](./DetailLayout.tsx) — `DetailLayoutProps`, `DetailLayout`.
- [Page.tsx](./Page.tsx) — `PageDensity`, `PageProps`, `Page`, `PageHeaderProps`, `PageHeader`.
- [PageDescription.tsx](./PageDescription.tsx) — `exceedsLines`, `PageDescriptionProps`, `PageDescription`.
- [PhoneTableCards.tsx](./PhoneTableCards.tsx) — `PhoneTableCards`.
- [ScreenState.tsx](./ScreenState.tsx) — `ScreenState`.
- [Sidebar.tsx](./Sidebar.tsx) — `useSidebarContext`, `SidebarProvider`, `Sidebar`.
- [SidebarNav.tsx](./SidebarNav.tsx) — `SidebarNav`.
- [TopBar.tsx](./TopBar.tsx) — module implementation.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `signOutAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Uses Next request cookies; helper-specific reads/writes are in the linked implementation.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 9 local production/configuration files scanned; 50,000 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
