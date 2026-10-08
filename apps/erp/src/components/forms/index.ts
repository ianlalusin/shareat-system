// T-384: client form components. Kept apart from `@/components/ui`, which stays server-safe.
export {
  EditableRecord,
  EditableRecordView,
  editableRecordReducer,
  createEditRegistry,
  runEditableAction,
  selectIsDirty,
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
} from './EditableRecord';
