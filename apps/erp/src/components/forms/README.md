# forms

## Overview

Checked forms, per-field feedback and editable-record state transitions.

Parent blueprint: [up one directory](../README.md).

## Interface

- [index.ts](./index.ts) — `CheckedForm`, `CheckedFormProps`, `FieldCheck`, `FieldCheckView`, `CheckContext`, `CheckSummary`, `CHECKED_FORM_INITIAL`, `checkedFormReducer`, `checkContextValue`, `onCheckedSubmit`, `watchFormReset`, `fieldCheckLine`, `planFieldAria`, `planFieldRelease`, `CheckedFormState`, `CheckedFormEvent`, `CheckCtx`, `FieldCheckLine`, `AriaCurrent`, `AriaPlan`, `EditableRecord`, `EditableRecordView`, `editableRecordReducer`, `createEditRegistry`, `runEditableAction`, `selectIsDirty`, `planApply`, `changedNames`, `editableRecordInitialState`, `TYPED_DROPPED_MESSAGE`, `notAppliedMessage`, `EDITABLE_RECORD_INITIAL`, `OTHER_DIRTY_MESSAGE`, `EditableRecordProps`, `EditableRecordViewProps`, `EditableRecordState`, `EditableRecordEvent`, `EditRegistryEntry`, `EditRequestResult`, `ChangeControl`, `ApplyControl`, `ApplyAssignment`.
- [CheckSummary.tsx](./CheckSummary.tsx) — `CheckSummary`.
- [CheckedForm.tsx](./CheckedForm.tsx) — `CheckedFormProps`, `CheckedForm`.
- [EditableRecord.tsx](./EditableRecord.tsx) — `OTHER_DIRTY_MESSAGE`, `TYPED_DROPPED_MESSAGE`, `EditableRecordState`, `EditableRecordEvent`, `EDITABLE_RECORD_INITIAL`, `editableRecordInitialState`, `notAppliedMessage`, `editableRecordReducer`, `EditRegistryEntry`, `EditRequestResult`, `createEditRegistry`, `selectIsDirty`, `runEditableAction`, `ChangeControl`, `changedNames`, `ApplyControl`, `ApplyAssignment`, `planApply`.
- [FieldCheck.tsx](./FieldCheck.tsx) — `FieldCheckView`, `FieldCheck`.
- [check-dom.ts](./check-dom.ts) — `readRuledValues`, `ruledTarget`, `focusControl`, `syncForeignSubmits`.
- [check-state.ts](./check-state.ts) — `CheckedFormState`, `CHECKED_FORM_INITIAL`, `CheckedFormEvent`, `checkedFormReducer`, `CheckCtx`, `checkContextValue`, `onCheckedSubmit`, `watchFormReset`, `FieldCheckLine`, `fieldCheckLine`, `AriaCurrent`, `AriaPlan`, `planFieldAria`, `ReleasePlan`, `planFieldRelease`.
- [context.ts](./context.ts) — `CheckContext`.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.
- Live field checks and editable state aid the user; server validation remains authoritative. Preserve persistent live-region feedback and lock/unlock transitions.

## Side Effects

- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 8 local production/configuration files scanned; 35,439 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
