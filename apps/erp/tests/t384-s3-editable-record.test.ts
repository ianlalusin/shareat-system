/**
 * T-384 S3a - EditableRecord: the lock-and-edit component (Amendment A0, L1-L3, L6). Spec:
 * docs/tasks/384-pos-link-tenders-and-width.md, S3a tests E1-E3. Node environment, no jsdom (I5).
 *
 * The component does not exist on HEAD, so every test imports it lazily: each leg fails on its own
 * with "Cannot find module ... EditableRecord" instead of the whole file collapsing at collection.
 *
 * CONTRACT PINNED HERE (the spec names the events but not their shapes; the builder matches this):
 *   editableRecordReducer(state, event) -> state
 *   state  = { mode: 'locked' | 'editing'; message: string | null }   initial { mode: 'locked', message: null }
 *   event  = { type: 'edit' | 'cancel' | 'saved' | 'otherDirty' }
 *   otherDirty is delivered to the record that holds unsaved changes when a different record asks to edit;
 *   that record stays open and shows the L3 sentence by its own buttons. A locked record ignores it.
 *   PAGE-LEVEL REGISTRY (L3), exported from the same module:
 *   createEditRegistry() -> { register(entry): () => void; requestEdit(id): { allowed: boolean; message?: string; blockedBy?: string } }
 *   entry = { id: string; isDirty(): boolean; close(): void }. A record registers when it ENTERS edit mode and
 *   the returned function unregisters it (cancel / saved). The component keeps one module-level instance.
 *   AUDIT-ROUND EXPORTS (the builder adds these; the tests below fail until it does):
 *   runEditableAction(action, formData, dispatch): Promise<void>  - awaits the action; dispatches {type:'saved'}
 *     ONLY on success. A throw, or a returned error result ({ ok: false } or a truthy `error`), must NOT lock
 *     the record (the user's edits stay on screen); a throw is rethrown or swallowed, either is accepted.
 *   selectIsDirty(options: {selected:boolean; defaultSelected:boolean}[], multiple: boolean): boolean
 *     - a single <select> with no defaultSelected option has its FIRST option as the browser default.
 *   EditableRecordView(props & { mode: 'locked'|'editing'; message?: string|null; onEdit?; onCancel?;
 *     formRef?; editRef? }) - the presentational tree, rendered with no hooks, so editing is reachable in SSR.
 *   The registry key is per INSTANCE (useId), never hidden.id / label (two records may share both).
 *   props: action, label, hidden: Record<string,string>, children, extra?, saveLabel?: 'Save' | 'Save draft'
 *   (hidden is a name->value map; the component renders one <input type="hidden"> per entry).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

const L3 = 'Save or cancel the changes you are making first.';
const load = async () => await import('../src/components/forms/EditableRecord');

type S = { mode: 'locked' | 'editing'; message: string | null };
const LOCKED: S = { mode: 'locked', message: null };
const EDITING: S = { mode: 'editing', message: null };

describe('E1: editableRecordReducer', () => {
  it('locked --edit--> editing', async () => {
    const { editableRecordReducer } = await load();
    expect(editableRecordReducer(LOCKED, { type: 'edit' })).toEqual({ mode: 'editing', message: null });
  });
  it('editing --cancel--> locked, message cleared', async () => {
    const { editableRecordReducer } = await load();
    expect(editableRecordReducer({ mode: 'editing', message: L3 }, { type: 'cancel' })).toEqual(LOCKED);
  });
  it('editing --saved--> locked', async () => {
    const { editableRecordReducer } = await load();
    expect(editableRecordReducer(EDITING, { type: 'saved' })).toEqual(LOCKED);
  });
  it('an editing record told otherDirty stays open and carries the L3 sentence', async () => {
    const { editableRecordReducer } = await load();
    expect(editableRecordReducer(EDITING, { type: 'otherDirty' })).toEqual({ mode: 'editing', message: L3 });
  });
  it('a locked record ignores otherDirty (stays locked, no sentence)', async () => {
    const { editableRecordReducer } = await load();
    expect(editableRecordReducer(LOCKED, { type: 'otherDirty' })).toEqual(LOCKED);
  });
  it('the sentence is cleared again by the next edit / cancel / saved', async () => {
    const { editableRecordReducer } = await load();
    const withMsg: S = { mode: 'editing', message: L3 };
    expect(editableRecordReducer(withMsg, { type: 'saved' }).message).toBeNull();
    expect(editableRecordReducer(withMsg, { type: 'cancel' }).message).toBeNull();
  });
  it('edit while already editing is a no-op (no second open, no sentence)', async () => {
    const { editableRecordReducer } = await load();
    expect(editableRecordReducer(EDITING, { type: 'edit' })).toEqual(EDITING);
  });
});

/**
 * Server-render under a console spy. React 18 (what vitest resolves) warns "Invalid value for prop `action`" for
 * a function action; that is a test-environment artefact, so it is dropped. ANY other console.error fails the test
 * so a real warning is never hidden behind the known one.
 */
function quietly<T>(fn: () => T): T {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const out = fn();
    const real = spy.mock.calls.filter((c) => !String(c[0]).includes('Invalid value for prop'));
    expect(real).toEqual([]);
    return out;
  } finally {
    spy.mockRestore();
  }
}

describe('E2: locked render (renderToStaticMarkup)', () => {
  const render = async (extra?: unknown) => {
    const { EditableRecord } = await load();
    return quietly(() =>
      renderToStaticMarkup(
        createElement(EditableRecord as never, {
          action: async () => {},
          label: 'Gcash',
          hidden: { id: 't-1', storeId: 's-1', version: '3' },
          extra: extra ?? undefined,
          children: createElement('input', { name: 'name', defaultValue: 'Gcash' }),
        } as never),
      ),
    );
  };

  it('wraps the fields in a <fieldset disabled', async () => {
    expect(await render()).toContain('<fieldset disabled');
  });
  it('has an Edit button with aria-label="Edit Gcash", type="button"', async () => {
    const html = await render();
    expect(html).toContain('aria-label="Edit Gcash"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*Edit\s*<\/button>|<button[^>]*>\s*Edit\s*<\/button>/);
  });
  it('has no type="submit" and no Save button while locked', async () => {
    const html = await render();
    expect(html).not.toContain('type="submit"');
    expect(html).not.toMatch(/>\s*Save\s*</);
  });
  it('renders every hidden input (id, storeId, version) even while locked', async () => {
    const html = await render();
    for (const [name, value] of [['id', 't-1'], ['storeId', 's-1'], ['version', '3']]) {
      expect(html).toMatch(new RegExp(`<input[^>]*type="hidden"[^>]*name="${name}"[^>]*value="${value}"|<input[^>]*name="${name}"[^>]*type="hidden"[^>]*value="${value}"|<input[^>]*value="${value}"[^>]*name="${name}"[^>]*type="hidden"`));
    }
  });
  it('does not render `extra` while locked', async () => {
    const html = await render(createElement('button', { type: 'submit' }, 'RETIRE-MARKER'));
    expect(html).not.toContain('RETIRE-MARKER');
  });
});

describe('E3: saveLabel is a type union', () => {
  it('"Update" does not compile; "Save" and "Save draft" do', async () => {
    const { EditableRecord } = await load();
    type P = Parameters<typeof EditableRecord>[0];
    expectTypeOf<P['saveLabel']>().toEqualTypeOf<'Save' | 'Save draft' | undefined>();
    const base = { action: async () => {}, label: 'x', hidden: {}, children: null } as unknown as P;
    // @ts-expect-error - "Update" is not an accepted saveLabel (L4 / E3)
    const bad: P = { ...base, saveLabel: 'Update' };
    const ok1: P = { ...base, saveLabel: 'Save' };
    const ok2: P = { ...base, saveLabel: 'Save draft' };
    expect([bad, ok1, ok2]).toHaveLength(3);
  });
});

describe('E1b: the page-level registry (one record in edit mode at a time, L3)', () => {
  const entry = (id: string, dirty: boolean) => {
    const calls = { closed: 0 };
    return { id, isDirty: () => dirty, close: () => void calls.closed++, calls };
  };
  it('an empty registry allows any edit', async () => {
    const { createEditRegistry } = await load();
    expect(createEditRegistry().requestEdit('b')).toEqual({ allowed: true });
  });
  it('another record open with changes: refused with the L3 sentence, blockedBy names it, it stays open', async () => {
    const { createEditRegistry } = await load();
    const r = createEditRegistry();
    const a = entry('a', true);
    r.register(a);
    expect(r.requestEdit('b')).toEqual({ allowed: false, message: L3, blockedBy: 'a' });
    expect(a.calls.closed).toBe(0);
  });
  it('another record open and clean: it is told to close and the edit is allowed', async () => {
    const { createEditRegistry } = await load();
    const r = createEditRegistry();
    const a = entry('a', false);
    r.register(a);
    expect(r.requestEdit('b')).toEqual({ allowed: true });
    expect(a.calls.closed).toBe(1);
  });
  it('a record never blocks itself, and unregistering frees the slot', async () => {
    const { createEditRegistry } = await load();
    const r = createEditRegistry();
    const a = entry('a', true);
    const off = r.register(a);
    expect(r.requestEdit('a')).toEqual({ allowed: true });
    off();
    expect(r.requestEdit('b')).toEqual({ allowed: true });
  });
});

describe('E4: run() locks only on success (audit A1)', () => {
  const fd = new FormData();
  it('a resolved action dispatches saved', async () => {
    const { runEditableAction } = await load();
    const dispatch = vi.fn();
    await runEditableAction(async () => {}, fd, dispatch);
    expect(dispatch).toHaveBeenCalledWith({ type: 'saved' });
  });
  it('a THROWING action does not dispatch saved', async () => {
    const { runEditableAction } = await load();
    const dispatch = vi.fn();
    await runEditableAction(async () => { throw new Error('refused'); }, fd, dispatch).catch(() => {});
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('an action returning { ok: false } or { error } does not dispatch saved', async () => {
    const { runEditableAction } = await load();
    for (const result of [{ ok: false }, { error: 'No.' }]) {
      const dispatch = vi.fn();
      await runEditableAction((async () => result) as never, fd, dispatch).catch(() => {});
      expect(dispatch, JSON.stringify(result)).not.toHaveBeenCalled();
    }
  });
});

describe('E5: selectIsDirty (audit A2)', () => {
  const o = (selected: boolean, defaultSelected = false) => ({ selected, defaultSelected });
  it('an untouched single select with no defaultSelected (browser picks the first option) is NOT dirty', async () => {
    const { selectIsDirty } = await load();
    expect(selectIsDirty([o(true), o(false), o(false)], false)).toBe(false);
  });
  it('moving a no-default single select off its first option IS dirty', async () => {
    const { selectIsDirty } = await load();
    expect(selectIsDirty([o(false), o(true), o(false)], false)).toBe(true);
  });
  it('a single select left on its defaultSelected option is not dirty; moved off it is', async () => {
    const { selectIsDirty } = await load();
    expect(selectIsDirty([o(false), o(true, true)], false)).toBe(false);
    expect(selectIsDirty([o(true), o(false, true)], false)).toBe(true);
  });
  it('a multiple select is dirty when any option differs from its default', async () => {
    const { selectIsDirty } = await load();
    expect(selectIsDirty([o(false), o(false)], true)).toBe(false);
    expect(selectIsDirty([o(true), o(false)], true)).toBe(true);
  });
});

describe('E6: the editing render (audit B6), through EditableRecordView', () => {
  const view = async (mode: 'locked' | 'editing') => {
    const { EditableRecordView } = await load();
    return quietly(() =>
      renderToStaticMarkup(
        createElement(EditableRecordView as never, {
          mode,
          action: async () => {},
          label: 'Gcash',
          hidden: { id: 't-1', version: '3' },
          extra: createElement('button', { type: 'submit' }, 'RETIRE-MARKER'),
          saveLabel: 'Save',
          children: createElement('input', { name: 'name', defaultValue: 'Gcash' }),
        } as never),
      ),
    );
  };
  it('editing: the fieldset is enabled, Save (submit) and Cancel (button) are present, Edit is gone', async () => {
    const html = await view('editing');
    expect(html).toContain('<fieldset');
    expect(html).not.toContain('<fieldset disabled');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*Cancel\s*<\/button>/);
    expect(html).not.toContain('aria-label="Edit Gcash"');
  });
  it('editing: extra is rendered; locked: it is not', async () => {
    expect(await view('editing')).toContain('RETIRE-MARKER');
    expect(await view('locked')).not.toContain('RETIRE-MARKER');
  });
  it('the version hidden input is present in editing AND sits outside (before) the fieldset', async () => {
    for (const mode of ['editing', 'locked'] as const) {
      const html = await view(mode);
      const v = html.search(/<input[^>]*name="version"/);
      expect(v, mode).toBeGreaterThanOrEqual(0);
      expect(v, mode).toBeLessThan(html.indexOf('<fieldset'));
    }
  });
  it('mutant pair: locked has `<fieldset disabled`, editing does not', async () => {
    expect(await view('locked')).toContain('<fieldset disabled');
    expect(await view('editing')).not.toContain('<fieldset disabled');
  });
});

describe('E7: the registry key is per instance (audit A4)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'src', 'components', 'forms', 'EditableRecord.tsx'), 'utf8');
  it('derives the key from useId(), not from hidden.id or the label', () => {
    expect(src).toMatch(/useId\(\)/);
    expect(src).not.toMatch(/hidden\.id\s*\?\?/);
    expect(src).not.toMatch(/const id = [^;]*label/);
  });
  it('two entries with identical display data but different instance keys still block each other', async () => {
    const { createEditRegistry } = await load();
    const r = createEditRegistry();
    r.register({ id: 'inst-1', isDirty: () => true, close() {} });
    expect(r.requestEdit('inst-2')).toMatchObject({ allowed: false, blockedBy: 'inst-1' });
  });
});
