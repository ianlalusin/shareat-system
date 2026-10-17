// T-384: client form components. Kept apart from `@/components/ui`, which stays server-safe.
// T-440: live field checks (CheckedForm, FieldCheck, the check context and its pure logic).
export { CheckedForm } from './CheckedForm';
export type { CheckedFormProps } from './CheckedForm';
export { FieldCheck, FieldCheckView } from './FieldCheck';
export { CheckContext } from './context';
export { CheckSummary } from './CheckSummary';
export {
  CHECKED_FORM_INITIAL,
  checkedFormReducer,
  checkContextValue,
  onCheckedSubmit,
  watchFormReset,
  fieldCheckLine,
  planFieldAria,
  planFieldRelease,
} from './check-state';
export type { CheckedFormState, CheckedFormEvent, CheckCtx, FieldCheckLine, AriaCurrent, AriaPlan } from './check-state';
export {
  EditableRecord,
  EditableRecordView,
  editableRecordReducer,
  createEditRegistry,
  runEditableAction,
  selectIsDirty,
  planApply,
  changedNames,
  editableRecordInitialState,
  TYPED_DROPPED_MESSAGE,
  notAppliedMessage,
  EDITABLE_RECORD_INITIAL,
  OTHER_DIRTY_MESSAGE,
} from './EditableRecord';
export type {
  EditableRecordProps,
  EditableRecordViewProps,
  EditableRecordState,
  EditableRecordEvent,
  EditRegistryEntry,
  EditRequestResult,
  ChangeControl,
  ApplyControl,
  ApplyAssignment,
} from './EditableRecord';
