# src/components/settings contract

## Overview

Terminal setup and outbox/updates/X-slip settings sections.

## Interface

- [OutboxSection.tsx](./OutboxSection.tsx) — `OutboxSection`.
- [TerminalSection.tsx](./TerminalSection.tsx) — `TerminalSection`.

## Invariants

- Terminal setup uses claim/release helpers.
- Update links are gated on unsent sales; outbox exception lists retain manager-visible records.

## Side Effects

- Copies device identity, claims/releases terminals, reads outbox state, probes health and invokes X-slip printing.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (17096 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
