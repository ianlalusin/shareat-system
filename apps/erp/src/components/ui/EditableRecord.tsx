'use client';
/**
 * EditableRecord - T-384 S3a (Amendment A0, L1-L3, L6, L7).
 *
 * An existing record is shown LOCKED (`<fieldset disabled>`, one Edit button). Edit unlocks only this record
 * and shows Save + Cancel. Cancel restores the stored values (form.reset()) and locks it again. Only one
 * record on a page is in edit mode at a time (module-level registry). The record's `version` rides in
 * `hidden` so Save carries it (L6). The server action is passed through unchanged (L7).
 *
 * The behaviour is a plain reducer plus a plain registry so it is unit-tested in node, without jsdom.
 */
import { useEffect, useReducer, useRef, type ReactNode } from 'react';

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
      for (const o of Array.from(el.options)) if (o.selected !== o.defaultSelected) return true;
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

const BTN =
  'inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';
const PRIMARY = `${BTN} border border-transparent bg-brand text-white hover:bg-brand-hover`;
const SECONDARY = `${BTN} border border-surface-border bg-surface text-ink`;

export function EditableRecord({
  action,
  label,
  hidden,
  children,
  extra,
  saveLabel = 'Save',
}: EditableRecordProps) {
  const [state, dispatch] = useReducer(editableRecordReducer, EDITABLE_RECORD_INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const id = hidden.id ?? label;
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

  const onEdit = () => {
    if (registry.requestEdit(id).allowed) dispatch({ type: 'edit' });
  };
  const onCancel = () => {
    formRef.current?.reset();
    dispatch({ type: 'cancel' });
  };
  const run = async (fd: FormData) => {
    await action(fd);
    dispatch({ type: 'saved' });
  };

  return (
    <>
      <form action={run} ref={formRef}>
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
          {state.message ? (
            <span role="alert" className="text-sm text-danger">
              {state.message}
            </span>
          ) : null}
        </div>
      </form>
      {editing ? extra : null}
    </>
  );
}
