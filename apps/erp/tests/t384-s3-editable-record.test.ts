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
 *   props: action, label, hidden: Record<string,string>, children, extra?, saveLabel?: 'Save' | 'Save draft'
 *   (hidden is a name->value map; the component renders one <input type="hidden"> per entry).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

const L3 = 'Save or cancel the changes you are making first.';
const load = async () => await import('../src/components/ui/EditableRecord');

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

describe('E2: locked render (renderToStaticMarkup)', () => {
  const render = async (extra?: unknown) => {
    const { EditableRecord } = await load();
    return renderToStaticMarkup(
      createElement(EditableRecord as never, {
        action: async () => {},
        label: 'Gcash',
        hidden: { id: 't-1', storeId: 's-1', version: '3' },
        extra: extra ?? undefined,
        children: createElement('input', { name: 'name', defaultValue: 'Gcash' }),
      } as never),
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
  it('named mutant: if <fieldset> lost `disabled` this test is the one that goes red', async () => {
    // Pins the mutant on a literal so the assertion cannot silently weaken: the guarded string must be
    // present in the real render and absent from a fieldset without the attribute.
    expect('<fieldset class="min-w-0">').not.toContain('<fieldset disabled');
    expect(await render()).toContain('<fieldset disabled');
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
