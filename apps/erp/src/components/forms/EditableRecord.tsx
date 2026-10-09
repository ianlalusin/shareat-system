'use client';
/**
 * EditableRecord - T-384 S3a (Amendment A0, L1-L3, L6, L7), T-389 (DEF-617).
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
 * T-389: after a refused Save the page passes `typed={typedFor(sp, DEF, record.id)}`. The record then starts in edit mode
 * and, before paint, writes the user's typing into the controls by name. The page still draws the STORED values as the
 * defaults, so Cancel and the unsaved-changes test work unchanged. On Save the form also sends `__changed` (the names
 * the user touched) so a refusal carries only those.
 *
 * The behaviour is a plain reducer plus a plain registry so it is unit-tested in node, without jsdom.
 */
import { useEffect, useId, useLayoutEffect, useReducer, useRef, type Ref, type ReactNode } from 'react';
import type { TypedView } from '@/lib/keep-typing';

export const OTHER_DIRTY_MESSAGE = 'Save or cancel the changes you are making first.';
/** T-389 R3: the typing was too big to keep (lib/flash.ts), so the record stays locked and says why. */
export const TYPED_DROPPED_MESSAGE =
  'What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again.';

export type EditableRecordState = { mode: 'locked' | 'editing'; message: string | null };
export type EditableRecordEvent =
  | { type: 'edit' | 'cancel' | 'saved' | 'otherDirty' }
  /** A fresh typed view arrived for a record that was already on the page (the page re-rendered in place). */
  | { type: 'reopen'; view: TypedView }
  /** Part of the typing could not be put back (a select lost the option): say which fields. */
  | { type: 'notApplied'; names: string[] };

export const EDITABLE_RECORD_INITIAL: EditableRecordState = { mode: 'locked', message: null };

/** T-389: the state a record starts in. `typed` reopens it editing (with the hint, if any); `dropped` keeps it locked with the notice. */
export function editableRecordInitialState(typed?: TypedView | null): EditableRecordState {
  if (!typed) return EDITABLE_RECORD_INITIAL;
  if (typed.kind === 'typed') return { mode: 'editing', message: typed.hint ?? null };
  return { mode: 'locked', message: TYPED_DROPPED_MESSAGE };
}

/** T-389 R3: some typed values had no place to go (the option was retired meanwhile). Never silently dropped. */
export function notAppliedMessage(labels: readonly string[]): string {
  return `Some of what you typed could not be put back: ${labels.join(', ')}. Check those fields.`;
}

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
    case 'reopen':
      return editableRecordInitialState(event.view);
    case 'notApplied':
      return state.mode === 'editing' && event.names.length > 0
        ? { mode: 'editing', message: [state.message, notAppliedMessage(event.names)].filter(Boolean).join(' ') }
        : state;
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

/**
 * Awaits the action and locks (dispatches saved) ONLY on success; a throw or an error result keeps edit mode.
 * With `changed` (T-389 R5) the action also receives `__changed`, the comma-separated names whose control differs from
 * its default, so a refused save carries only what the user touched. No list at all (no JavaScript) sends no key.
 */
export async function runEditableAction(
  action: (formData: FormData) => unknown,
  formData: FormData,
  dispatch: (event: EditableRecordEvent) => void,
  changed?: readonly string[],
): Promise<void> {
  if (changed !== undefined) formData.set('__changed', changed.join(','));
  const result = (await action(formData)) as { ok?: boolean; error?: unknown } | null | undefined;
  if (result && typeof result === 'object' && (result.ok === false || result.error)) return;
  dispatch({ type: 'saved' });
}

/** A form control as plain data, so what changed and what to apply are testable in node. */
export interface ChangeControl {
  name: string;
  type: string;
  value: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  multiple?: boolean;
  options?: ReadonlyArray<{ selected: boolean; defaultSelected: boolean }>;
}

/**
 * The names whose control differs from its rendered default (the same test the one-open-record registry uses).
 * Unique, in order of first appearance; a checkbox or radio group counts once, as changed if any member changed.
 */
export function changedNames(controls: ReadonlyArray<ChangeControl>): string[] {
  const out: string[] = [];
  for (const c of controls) {
    if (!c.name || c.type === 'hidden' || c.type === 'button' || c.type === 'submit') continue;
    let dirty: boolean;
    if (c.type === 'checkbox' || c.type === 'radio') dirty = c.checked !== c.defaultChecked;
    else if (c.type.startsWith('select')) dirty = selectIsDirty(c.options ?? [], c.multiple === true || c.type === 'select-multiple');
    else dirty = c.value !== c.defaultValue;
    if (dirty && !out.includes(c.name)) out.push(c.name);
  }
  return out;
}

export interface ApplyControl {
  name: string;
  type: string;
  value: string;
  /** The option values of a select. */
  options?: ReadonlyArray<string>;
}
export type ApplyAssignment = { control: number } & ({ value: string } | { checked: boolean } | { selected: string[] });

/**
 * R3: what to write into the form so it shows the user's typing. `control` indexes `controls`. A name that is not in
 * `fields` keeps its stored value (the user did not change it). A select with no option for the typed value (the
 * account was retired meanwhile) is left alone and reported in `notApplied`.
 */
export function planApply(
  controls: ReadonlyArray<ApplyControl>,
  fields: Record<string, string | string[]>,
): { assignments: ApplyAssignment[]; notApplied: string[] } {
  const assignments: ApplyAssignment[] = [];
  const notApplied: string[] = [];
  for (const [name, raw] of Object.entries(fields)) {
    const values = Array.isArray(raw) ? raw : [raw];
    let position = 0;
    let missed = false;
    controls.forEach((c, i) => {
      if (c.name !== name) return;
      if (c.type === 'checkbox' || c.type === 'radio') {
        assignments.push({ control: i, checked: values.includes(c.value) });
      } else if (c.type === 'select-multiple') {
        const selected = values.filter((v) => c.options === undefined || c.options.includes(v));
        if (selected.length === 0 && values.length > 0) missed = true;
        else assignments.push({ control: i, selected });
      } else if (c.type === 'select-one') {
        const v = values[0] ?? '';
        if (c.options !== undefined && !c.options.includes(v)) missed = true;
        else assignments.push({ control: i, value: v });
      } else {
        assignments.push({ control: i, value: values[position] ?? values[0] ?? '' });
        position += 1;
      }
    });
    if (missed) notApplied.push(name);
  }
  return { assignments, notApplied };
}

type DomControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** The named, user-editable controls of a form (hidden inputs, buttons and files excluded). */
function domControls(form: HTMLFormElement): DomControl[] {
  const out: DomControl[] = [];
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (!el.name || el.type === 'hidden' || el.type === 'button' || el.type === 'submit' || el.type === 'reset' || el.type === 'image' || el.type === 'file') continue;
      out.push(el);
    } else if ((el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.name) out.push(el);
  }
  return out;
}

function changeDescriptor(el: DomControl): ChangeControl {
  if (el instanceof HTMLSelectElement) {
    return { name: el.name, type: el.type, value: el.value, multiple: el.multiple, options: Array.from(el.options) };
  }
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    return { name: el.name, type: el.type, value: el.value, checked: el.checked, defaultChecked: el.defaultChecked };
  }
  return { name: el.name, type: el.type, value: el.value, defaultValue: el.defaultValue };
}

function formChangedNames(form: HTMLFormElement | null): string[] {
  return form ? changedNames(domControls(form).map(changeDescriptor)) : [];
}

/** Dirty = some control's value differs from its rendered default. */
function formIsDirty(form: HTMLFormElement | null): boolean {
  return formChangedNames(form).length > 0;
}

function fire(el: Element) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Writes the typing into the form's controls through the native setters, so a client field listening for input sees it. */
function applyTyped(form: HTMLFormElement, fields: Record<string, string | string[]>): string[] {
  const els = domControls(form);
  const plan = planApply(
    els.map((el) => ({
      name: el.name,
      type: el.type,
      value: el.value,
      ...(el instanceof HTMLSelectElement ? { options: Array.from(el.options).map((o) => o.value) } : {}),
    })),
    fields,
  );
  for (const a of plan.assignments) {
    const el = els[a.control];
    if (!el) continue;
    if ('checked' in a && el instanceof HTMLInputElement) {
      if (el.checked !== a.checked) {
        el.checked = a.checked;
        fire(el);
      }
    } else if ('selected' in a && el instanceof HTMLSelectElement) {
      const want = new Set(a.selected);
      for (const o of Array.from(el.options)) o.selected = want.has(o.value);
      fire(el);
    } else if ('value' in a) {
      const proto =
        el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, a.value);
      else el.value = a.value;
      fire(el);
    }
  }
  // The field labels (else the names) of what could not be put back.
  return plan.notApplied.map((name) => {
    const el = els.find((e) => e.name === name);
    return el?.labels?.[0]?.firstElementChild?.textContent?.trim() || el?.getAttribute('aria-label') || name;
  });
}

/** `useLayoutEffect` warns when a component renders on the server; the effect is browser-only, so use `useEffect` there. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  /**
   * T-389 / DEF-617: `typedFor(sp, DEF, record.id)`. After a refused Save the record reopens in edit mode holding what
   * the user typed, applied in the browser before paint. The page keeps drawing the STORED values as every
   * `defaultValue`, so Cancel (`form.reset()`) brings them back. A `dropped` view keeps the record locked and says the
   * typing was too long to keep.
   */
  typed?: TypedView | null;
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
  const [state, dispatch] = useReducer(editableRecordReducer, props.typed, editableRecordInitialState);
  const formRef = useRef<HTMLFormElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const seenView = useRef<string | null | undefined>(undefined);
  const id = useId();
  const editing = state.mode === 'editing';

  // R3: put the typing into the controls before paint. The first view is already in the initial state. A LATER, different
  // view (the page re-rendered in place instead of remounting) also reopens or relocks the record.
  useIsomorphicLayoutEffect(() => {
    const view = props.typed ?? null;
    const key = view ? JSON.stringify(view) : null;
    const first = seenView.current === undefined;
    if (key === seenView.current) return;
    seenView.current = key;
    if (!view) return;
    if (!first) dispatch({ type: 'reopen', view });
    if (view.kind === 'typed' && formRef.current) {
      const labels = applyTyped(formRef.current, view.fields);
      if (labels.length > 0) dispatch({ type: 'notApplied', names: labels });
    }
  }, [props.typed]);

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
      action={(fd: FormData) => runEditableAction(props.action, fd, dispatch, formChangedNames(formRef.current))}
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
