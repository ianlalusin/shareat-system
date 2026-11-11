# apps/customer/src/components

## Overview

Reusable diner presentation and session-aware app frame.

## Interface

- app-shell.tsx exports DemoBanner, NoticeStrip, TabBar, AppShell and RequireSession.
- ui.tsx exports Button, Card, Stars, PageTitle and ErrorLine.

## Invariants

- RequireSession waits for provider readiness before displaying a join-table refusal.
- Interactive buttons use at least 44px targets; Stars exposes an accessible radio group.

## Side Effects

- Components render browser UI, navigate via Next links, and invoke callbacks to dismiss notices or change ratings; they do not implement the data source.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
