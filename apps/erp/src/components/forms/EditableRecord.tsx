'use client';
/**
 * EditableRecord - T-384 S3a (Amendment A0, L1-L3, L6, L7).
 *
 * An existing record is shown LOCKED (`<fieldset disabled>`, one Edit button). Edit unlocks only this record
 * and shows Save + Cancel. Cancel restores the stored values (form.reset()) and locks it again. Only one
 * record on a page is in edit mode at a time (module-level registry). The record's `version` rides in
 * `hidden` so Save carries it (L6). The server action is passed through unchanged (L7).
 *
 * ONLY UNCONTROLLED FIELDS: Cancel uses form.reset(), which restores uncontrolled fields (defaultValue /
 * defaultChecked / defaultSelected) only. A child holding React state (value + onChange, useState) is NOT
 * restored, so S3b adopters must use uncontrolled fields inside EditableRecord.
 *
 * The behaviour is a plain reducer plus a plain registry so it is unit-tested in node, without jsdom.
 */
import { useEffect, useId, useReducer, useRef, type Ref, type ReactNode } from 'react';

export const OTHER_DIRTY_MESSAGE = 'Save or cancel the changes you are making first.';

export type EditableRecordState = { mode: 'locked' | 'editing'; message: string | null };
export type EditableRecordEvent = { type: 'edit' | 'cancel' | 'saved' | 'otherDirty' };

export const EDITABLE_RECORD_INITIAL: EditableRecordState = { mode: 'locked', message: null };

export function editableRecordReducer(
  state: EditableRecordState,
  event: EditableRecordEvent,
): EditableRecordState {
  switch (event.type) {
    case 'edit':
      return state.mode === 'editing' ? state : { mode: 'editing', message: null };
    case 'cancel':
    case 'saved':
      return { mode: 'locked', message: null };
    case 'otherDirty':
      return state.mode === 'editing' ? { mode: 'editing', message: OTHER_DIRTY_MESSAGE } : state;
  }
}

export interface EditRegistryEntry {
  id: string;
  isDirty(): boolean;
  close(): void;
  /** Called on the open record that refused another record's Edit, so it can show the sentence. */
  notify?(): void;
}

export interface EditRequestResult {
  allowed: boolean;
  message?: string;
  blockedBy?: string;
}

export function createEditRegistry() {
  const entries = new Map<string, EditRegistryEntry>();
  return {
    register(entry: EditRegistryEntry): () => void {
      entries.set(entry.id, entry);
      return () => {
        if (entries.get(entry.id) === entry) entries.delete(entry.id);
      };
    },
    requestEdit(id: string): EditRequestResult {
      const others = [...entries.values()].filter((e) => e.id !== id);
      const dirty = others.find((e) => e.isDirty());
      if (dirty) {
        dirty.notify?.();
        return { allowed: false, message: OTHER_DIRTY_MESSAGE, blockedBy: dirty.id };
      }
      for (const e of others) e.close();
      return { allowed: true };
    },
  };
}

const registry = createEditRegistry();

/** Compares a select with what form.reset() restores: a single select with no defaultSelected falls back to its first option. */
export function selectIsDirty(
  options: ReadonlyArray<{ selected: boolean; defaultSelected: boolean }>,
  multiple: boolean,
): boolean {
  if (multiple) return options.some((o) => o.selected !== o.defaultSelected);
  const d = options.findIndex((o) => o.defaultSelected);
  const expected = d >= 0 ? d : 0;
  const actual = options.findIndex((o) => o.selected);
  return options.length > 0 && actual !== expected;
}

/** Awaits the action and locks (dispatches saved) ONLY on success; a throw or an error result keeps edit mode. */
export async function runEditableAction(
  action: (formData: FormData) => unknown,
  formData: FormData,
  dispatch: (event: EditableRecordEvent) => void,
): Promise<void> {
  const result = (await action(formData)) as { ok?: boolean; error?: unknown } | null | undefined;
  if (result && typeof result === 'object' && (result.ok === false || result.error)) return;
  dispatch({ type: 'saved' });
}

/** Dirty = some control's value differs from its rendered default. */
function formIsDirty(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'hidden' || el.type === 'button' || el.type === 'submit') continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked) return true;
      } else if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLSelectElement) {
      if (selectIsDirty(Array.from(el.options), el.multiple)) return true;
    }
  }
  return false;
}

export interface EditableRecordProps {
  action: (formData: FormData) => void | Promise<void>;
  /** The record's name, for the Edit button's aria-label ("Edit Gcash"). */
  label: string;
  /** Hidden inputs: id, storeId, version. */
  hidden: Record<string, string>;
  children: ReactNode;
  /** Command buttons shown only in edit mode, each its own form (for example Retire). */
  extra?: ReactNode;
  saveLabel?: 'Save' | 'Save draft';
}

export interface EditableRecordViewProps extends EditableRecordProps {
  mode: 'locked' | 'editing';
  message?: string | null;
  onEdit?: () => void;
  onCancel?: () => void;
  formRef?: Ref<HTMLFormElement>;
  editRef?: Ref<HTMLButtonElement>;
}

// Single string literals (no template or `+`): the touch-target census resolves only literal initializers.
const PRIMARY =
  'inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium border border-transparent bg-brand text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
const SECONDARY =
  'inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium border border-surface-border bg-surface text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/** The presentational tree: no hooks, so the editing state is reachable in server render tests. */
export function EditableRecordView({
  mode,
  message,
  onEdit,
  onCancel,
  formRef,
  editRef,
  action,
  label,
  hidden,
  children,
  extra,
  saveLabel = 'Save',
}: EditableRecordViewProps) {
  const editing = mode === 'editing';
  return (
    <>
      <form action={action} ref={formRef}>
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <fieldset disabled={!editing} className="min-w-0">
          {children}
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button type="submit" className={PRIMARY}>
                {saveLabel}
              </button>
              <button type="button" className={SECONDARY} onClick={onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" ref={editRef} className={SECONDARY} aria-label={`Edit ${label}`} onClick={onEdit}>
              Edit
            </button>
          )}
          {message ? (
            <span role="alert" className="text-sm text-danger">
              {message}
            </span>
          ) : null}
        </div>
      </form>
      {editing ? extra : null}
    </>
  );
}

export function EditableRecord(props: EditableRecordProps) {
  const [state, dispatch] = useReducer(editableRecordReducer, EDITABLE_RECORD_INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const id = useId();
  const editing = state.mode === 'editing';

  useEffect(() => {
    if (!editing) return;
    return registry.register({
      id,
      isDirty: () => formIsDirty(formRef.current),
      close: () => {
        formRef.current?.reset();
        dispatch({ type: 'cancel' });
      },
      notify: () => dispatch({ type: 'otherDirty' }),
    });
  }, [editing, id]);

  useEffect(() => {
    if (editing) {
      formRef.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea')?.focus();
    } else if (wasEditing.current) {
      editRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  return (
    <EditableRecordView
      {...props}
      mode={state.mode}
      message={state.message}
      formRef={formRef}
      editRef={editRef}
      action={(fd: FormData) => runEditableAction(props.action, fd, dispatch)}
      onEdit={() => {
        if (registry.requestEdit(id).allowed) dispatch({ type: 'edit' });
      }}
      onCancel={() => {
        formRef.current?.reset();
        dispatch({ type: 'cancel' });
      }}
    />
  );
}
