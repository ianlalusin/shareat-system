# components

## Overview

Shared ERP presentation controls and module-independent form, shell, report, money and upload components.

Parent blueprint: [up one directory](../README.md).

## Interface

- [ClosedMonthOverride.tsx](./ClosedMonthOverride.tsx) — `ClosedMonthOption`, `ClosedMonthOverride`.
- [FilterRow.tsx](./FilterRow.tsx) — `FilterRowProps`, `FilterRow`.
- [SignaturePad.tsx](./SignaturePad.tsx) — `SignaturePad`.
- [action-link.ts](./action-link.ts) — `ACTION_LINK`.
- [nav.tsx](./nav.tsx) — `GROUPS`.
- [scheduler-status.tsx](./scheduler-status.tsx) — `SchedulerStatus`.
- [signature-pad-export.ts](./signature-pad-export.ts) — `BlobCanvas`, `exportSignaturePng`, `signatureFormData`.
- [two-way-picker.tsx](./two-way-picker.tsx) — `PickerOption`, `TwoWayPicker`.
- [dashboard](./dashboard/README.md) — Dashboard sales charts, key figures, comparison ranges and textual chart legends.
- [feedback](./feedback/README.md) — Pending submission controls, toast delivery and count-up feedback with reduced-motion behavior.
- [forms](./forms/README.md) — Checked forms, per-field feedback and editable-record state transitions.
- [money](./money/README.md) — Money-line controls and issue visibility driven by shared domain money-line rules.
- [reports](./reports/README.md) — Financial statement tables, reconciliation indicators, filters and account drill links.
- [shell](./shell/README.md) — Session-aware ERP shell, sidebar, top bar, page primitives and phone table adaptation.
- [ui](./ui/README.md) — Shared UI primitives, status vocabulary, dialogs, form layout and responsive workspaces.
- [upload](./upload/README.md) — Photo/document selection, compression, byte-progress uploads and guarded evidence viewing.

## Invariants

- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Repository calls: `schedulerRepo.lastRunFor`, `schedulerRepo.unfinishedRuns`. These execute through the surrounding transaction context.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 8 local production/configuration files scanned; 39,194 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
