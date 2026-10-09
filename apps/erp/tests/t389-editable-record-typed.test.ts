/**
 * T-389 S1 - K4: EditableRecord reopens a refused record with the user's typing (R3, R5). Node environment, no jsdom,
 * the way `t384-s3-editable-record.test.ts` does it. Spec: docs/tasks/389-refused-save-keeps-typing.md.
 *
 * Red on HEAD: EditableRecord has no `typed` prop, and `planApply`, `changedNames`, `editableRecordInitialState` and
 * `TYPED_DROPPED_MESSAGE` do not exist. Every test imports the module lazily so each leg fails by name.
 *
 * CONTRACT PINNED HERE (the spec names planApply, changedNames and "the reducer starts in editing"; the builder
 * matches the shapes below). All are exported from `components/forms/EditableRecord.tsx`:
 *
 *   TypedView (from lib/keep-typing)   = { kind: 'typed'; fields: Record<string, string | string[]>; hint?: string } | { kind: 'dropped' }
 *     SPEC GAP, pinned: the spec puts a per-field "not kept" hint on `def.notKeptHint` (R4) but never says how it
 *     reaches the record. Pinned: `defineTypedForm({ ..., notKeptHint })`, `typedFor` returns it as `view.hint`, and the
 *     record shows it in its role="alert" slot when it reopens from `typed`.
 *   TYPED_DROPPED_MESSAGE              = the R3 sentence, exactly.
 *   editableRecordInitialState(typed?: TypedView | null): EditableRecordState
 *       none/null -> EDITABLE_RECORD_INITIAL; typed -> { mode: 'editing', message: hint ?? null };
 *       dropped -> { mode: 'locked', message: TYPED_DROPPED_MESSAGE }.
 *   planApply(controls, fields) -> { assignments, notApplied }
 *       controls: ReadonlyArray<{ name: string; type: string; value: string; options?: ReadonlyArray<string> }>
 *                 `type` is the DOM type string: 'text' | 'textarea' | 'number' | 'date' | 'checkbox' | 'radio' |
 *                 'select-one' | 'select-multiple'. `options` is the option VALUES of a select.
 *       assignments: Array<{ control: number } & ({ value: string } | { checked: boolean } | { selected: string[] })>
 *                 `control` is the index into `controls`. text-like and single select -> { value };
 *                 checkbox and radio (every control with that name) -> { checked }; multiple select -> { selected }.
 *       notApplied: names for which nothing could be applied (a select with no option matching, R3).
 *   changedNames(controls) -> string[]   (unique, in order of first appearance)
 *       controls: ReadonlyArray<{ name: string; type: string; value: string; defaultValue?: string; checked?: boolean;
 *                 defaultChecked?: boolean; multiple?: boolean; options?: ReadonlyArray<{ selected: boolean; defaultSelected: boolean }> }>
 *       The same test as formIsDirty; hidden / button / submit / nameless controls are skipped.
 *   runEditableAction(action, formData, dispatch, changed?: readonly string[])
 *       with `changed`, the action receives a FormData that also carries `__changed` = changed.join(',').
 *   EditableRecord/EditableRecordView accept `typed?: TypedView | null`.
 *   Builder note: React 18 warns "useLayoutEffect does nothing on the server" in renderToStaticMarkup; the layout
 *   effect that applies `typed` must be SSR-safe (an isomorphic layout effect), or the quietly() guard below fails.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

const load = async () => await import('../src/components/forms/EditableRecord');
const SENTENCE = 'What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again.';

type Fields = Record<string, string | string[]>;
type Assignment = { control: number; value?: string; checked?: boolean; selected?: string[] };
type Plan = { assignments: Assignment[]; notApplied: string[] };
type Mod = {
  planApply(controls: ReadonlyArray<{ name: string; type: string; value: string; options?: ReadonlyArray<string> }>, fields: Fields): Plan;
  changedNames(controls: ReadonlyArray<Record<string, unknown>>): string[];
  editableRecordInitialState(typed?: unknown): { mode: string; message: string | null };
  TYPED_DROPPED_MESSAGE: string;
  EDITABLE_RECORD_INITIAL: { mode: string; message: string | null };
  runEditableAction(a: (fd: FormData) => unknown, fd: FormData, d: (e: unknown) => void, changed?: readonly string[]): Promise<void>;
};
const mod = async () => (await load()) as unknown as Mod;
const byControl = (a: Assignment[]) => [...a].sort((x, y) => x.control - y.control);

describe('K4 planApply: what gets written into the form (R3)', () => {
  it('text, textarea, number and date controls get { value }; names not in fields are left alone', async () => {
    const { planApply } = await mod();
    const controls = [
      { name: 'name', type: 'text', value: 'Old Co' },
      { name: 'notes', type: 'textarea', value: 'old' },
      { name: 'creditTermsDays', type: 'number', value: '30' },
      { name: 'openedOn', type: 'date', value: '2026-01-01' },
      { name: 'untouched', type: 'text', value: 'keep me' },
    ];
    const plan = planApply(controls, { name: 'Typed Co', notes: 'a\nb', creditTermsDays: '', openedOn: '2026-10-10' });
    expect(byControl(plan.assignments)).toEqual([
      { control: 0, value: 'Typed Co' },
      { control: 1, value: 'a\nb' },
      { control: 2, value: '' },
      { control: 3, value: '2026-10-10' },
    ]);
    expect(plan.notApplied).toEqual([]);
    // Mutant: also assign untouched names (blank them) -> the toEqual is red.
  });

  it('a mistyped amount comes back exactly as typed', async () => {
    const { planApply } = await mod();
    expect(byControl(planApply([{ name: 'amount', type: 'text', value: '1000.00' }], { amount: '1,0OO' }).assignments)).toEqual([{ control: 0, value: '1,0OO' }]);
  });

  it('a single select with the typed value among its options -> { value }', async () => {
    const { planApply } = await mod();
    const plan = planApply([{ name: 'kind', type: 'select-one', value: 'cash', options: ['cash', 'wallet'] }], { kind: 'wallet' });
    expect(plan.assignments).toEqual([{ control: 0, value: 'wallet' }]);
    expect(plan.notApplied).toEqual([]);
  });

  it('a single select with NO matching option (the account was retired meanwhile) is skipped and counted as not applied', async () => {
    const { planApply } = await mod();
    const plan = planApply([{ name: 'moneyAccountId', type: 'select-one', value: 'a1', options: ['', 'a1', 'a2'] }], { moneyAccountId: 'gone-id' });
    expect(plan.assignments).toEqual([]);
    expect(plan.notApplied).toEqual(['moneyAccountId']);
    // Mutant: assign the value anyway (the select goes blank) -> assignments is non-empty, red.
  });

  it('a multiple select -> { selected } with only the options that exist', async () => {
    const { planApply } = await mod();
    const ctl = [{ name: 'tags', type: 'select-multiple', value: '', options: ['a', 'b', 'c'] }];
    expect(planApply(ctl, { tags: ['a', 'c', 'zzz'] }).assignments).toEqual([{ control: 0, selected: ['a', 'c'] }]);
    expect(planApply(ctl, { tags: 'b' }).assignments).toEqual([{ control: 0, selected: ['b'] }]);
  });

  it('a lone checkbox: present -> checked, an empty array (unticked) -> unchecked', async () => {
    const { planApply } = await mod();
    const ctl = [{ name: 'issuesOfficialReceipt', type: 'checkbox', value: 'on' }];
    expect(planApply(ctl, { issuesOfficialReceipt: 'on' }).assignments).toEqual([{ control: 0, checked: true }]);
    expect(planApply(ctl, { issuesOfficialReceipt: [] }).assignments).toEqual([{ control: 0, checked: false }]);
    // Mutant: only ever set checked = true -> the second line is red (the box would reopen ticked).
  });

  it('a checkbox GROUP: every control with the name is set, ticked exactly those whose value is in the list', async () => {
    const { planApply } = await mod();
    const ctl = [
      { name: 'positionIds', type: 'checkbox', value: 'p1' },
      { name: 'positionIds', type: 'checkbox', value: 'p2' },
      { name: 'positionIds', type: 'checkbox', value: 'p3' },
      { name: 'other', type: 'text', value: 'x' },
    ];
    expect(byControl(planApply(ctl, { positionIds: ['p3', 'p1'] }).assignments)).toEqual([
      { control: 0, checked: true },
      { control: 1, checked: false },
      { control: 2, checked: true },
    ]);
    expect(byControl(planApply(ctl, { positionIds: 'p2' }).assignments)).toEqual([
      { control: 0, checked: false },
      { control: 1, checked: true },
      { control: 2, checked: false },
    ]);
    // Mutant: apply the group to the first control only -> red.
  });

  it('a radio group: only the one whose value matches is checked, the rest unchecked', async () => {
    const { planApply } = await mod();
    const ctl = ['a', 'b', 'c'].map((v) => ({ name: 'primaryPositionId', type: 'radio', value: v }));
    expect(byControl(planApply(ctl, { primaryPositionId: 'b' }).assignments)).toEqual([
      { control: 0, checked: false },
      { control: 1, checked: true },
      { control: 2, checked: false },
    ]);
  });

  it('a field name with no control on the page assigns nothing and does not throw', async () => {
    const { planApply } = await mod();
    expect(planApply([{ name: 'name', type: 'text', value: '' }], { ghost: 'x' }).assignments).toEqual([]);
  });
});

describe('K4 changedNames: the __changed list (R5)', () => {
  const c = (o: Record<string, unknown>) => ({ type: 'text', value: '', defaultValue: '', ...o });

  it('a text control whose value differs from its default is changed; equal is not', async () => {
    const { changedNames } = await mod();
    expect(changedNames([c({ name: 'a', value: 'x', defaultValue: 'x' }), c({ name: 'b', value: 'y', defaultValue: 'z' })])).toEqual(['b']);
  });

  it('hidden, submit, button and nameless controls are never listed', async () => {
    const { changedNames } = await mod();
    expect(
      changedNames([
        c({ name: 'version', type: 'hidden', value: '9', defaultValue: '1' }),
        c({ name: 'go', type: 'submit', value: 'a', defaultValue: 'b' }),
        c({ name: 'x', type: 'button', value: 'a', defaultValue: 'b' }),
        c({ name: '', value: 'a', defaultValue: 'b' }),
        c({ name: 'real', value: 'a', defaultValue: 'b' }),
      ]),
    ).toEqual(['real']);
  });

  it('a checkbox group counts as changed if ANY member changed, and is listed once', async () => {
    const { changedNames } = await mod();
    const box = (value: string, checked: boolean, defaultChecked: boolean) => c({ name: 'positionIds', type: 'checkbox', value, checked, defaultChecked });
    expect(changedNames([box('p1', true, true), box('p2', false, false)])).toEqual([]);
    expect(changedNames([box('p1', true, true), box('p2', true, false), box('p3', false, true)])).toEqual(['positionIds']);
    // Mutant: list one entry per changed member -> ['positionIds', 'positionIds'], red.
  });

  it('a single select is dirty by selectIsDirty: an untouched one with no defaultSelected (first option) is not changed', async () => {
    const { changedNames } = await mod();
    const sel = (name: string, picked: number, def: number | null) =>
      c({
        name,
        type: 'select-one',
        options: [0, 1, 2].map((i) => ({ selected: i === picked, defaultSelected: def === i })),
        multiple: false,
      });
    expect(changedNames([sel('kind', 0, null), sel('terms', 1, null), sel('status', 1, 1), sel('vat', 0, 2)])).toEqual(['terms', 'vat']);
  });

  it('order is the order of first appearance in the form', async () => {
    const { changedNames } = await mod();
    expect(changedNames([c({ name: 'z', value: '1' }), c({ name: 'a', value: '1' }), c({ name: 'm', value: '1' })])).toEqual(['z', 'a', 'm']);
  });
});

describe('K4 runEditableAction: __changed rides with the submit', () => {
  it('with `changed`, the action receives __changed as a comma-separated list; the original fields are intact', async () => {
    const { runEditableAction } = await mod();
    let seen: FormData | null = null;
    const fd = new FormData();
    fd.set('name', 'Typed');
    await runEditableAction(async (f) => void (seen = f), fd, vi.fn(), ['name', 'notes']);
    expect(seen!.get('__changed')).toBe('name,notes');
    expect(seen!.get('name')).toBe('Typed');
    // Mutant: do not append it -> red.
  });
  it('an empty list is sent as an empty string (nothing changed); with no list at all the key is absent (no-JavaScript parity)', async () => {
    const { runEditableAction } = await mod();
    let a: FormData | null = null;
    await runEditableAction(async (f) => void (a = f), new FormData(), vi.fn(), []);
    expect(a!.get('__changed')).toBe('');
    let b: FormData | null = null;
    await runEditableAction(async (f) => void (b = f), new FormData(), vi.fn());
    expect(b!.has('__changed')).toBe(false);
  });
  it('locking behaviour is unchanged: a resolved action still dispatches saved; a refusal does not', async () => {
    const { runEditableAction } = await mod();
    const ok = vi.fn();
    await runEditableAction(async () => {}, new FormData(), ok, ['x']);
    expect(ok).toHaveBeenCalledWith({ type: 'saved' });
    const no = vi.fn();
    await runEditableAction((async () => ({ ok: false })) as never, new FormData(), no, ['x']);
    expect(no).not.toHaveBeenCalled();
  });
});

describe('K4 the initial state', () => {
  it('no typed (undefined or null): locked, no message - unchanged', async () => {
    const { editableRecordInitialState, EDITABLE_RECORD_INITIAL } = await mod();
    expect(editableRecordInitialState(undefined)).toEqual(EDITABLE_RECORD_INITIAL);
    expect(editableRecordInitialState(null)).toEqual(EDITABLE_RECORD_INITIAL);
  });
  it('typed: the record starts EDITING', async () => {
    const { editableRecordInitialState } = await mod();
    expect(editableRecordInitialState({ kind: 'typed', fields: { name: 'x' } })).toEqual({ mode: 'editing', message: null });
    // Mutant: init ignores typed -> mode 'locked', red.
  });
  it('typed with a hint: starts editing and carries the hint as the message', async () => {
    const { editableRecordInitialState } = await mod();
    const hint = 'The account number is not kept after a refused save. Check it before saving.';
    expect(editableRecordInitialState({ kind: 'typed', fields: {}, hint })).toEqual({ mode: 'editing', message: hint });
  });
  it('dropped: the record stays LOCKED and carries the R3 sentence, word for word', async () => {
    const { editableRecordInitialState, TYPED_DROPPED_MESSAGE } = await mod();
    expect(TYPED_DROPPED_MESSAGE).toBe(SENTENCE);
    expect(editableRecordInitialState({ kind: 'dropped' })).toEqual({ mode: 'locked', message: SENTENCE });
  });
});

/** Server-render under a console spy: the known React 18 `action` function warning is dropped, ANY other error fails. */
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

describe('K4 the render (renderToStaticMarkup through the real EditableRecord)', () => {
  const render = async (typed: unknown) => {
    const { EditableRecord } = await load();
    return quietly(() =>
      renderToStaticMarkup(
        createElement(EditableRecord as never, {
          action: async () => {},
          label: 'Gcash',
          hidden: { id: 't-1', version: '3' },
          ...(typed === undefined ? {} : { typed }),
          extra: createElement('button', { type: 'submit' }, 'RETIRE-MARKER'),
          children: createElement('input', { name: 'name', defaultValue: 'Gcash' }),
        } as never),
      ),
    );
  };

  it('typed: no `fieldset disabled`, Save and Cancel showing, Edit gone, extra shown; the STORED value is still what is drawn', async () => {
    const html = await render({ kind: 'typed', fields: { name: 'Typed Name Zed' } });
    expect(html).toContain('<fieldset');
    expect(html).not.toContain('<fieldset disabled');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(html).toMatch(/>\s*Cancel\s*</);
    expect(html).not.toContain('aria-label="Edit Gcash"');
    expect(html).toContain('RETIRE-MARKER');
    expect(html, 'the page draws stored values; the typing is applied in the browser (R3)').toContain('value="Gcash"');
    expect(html, 'a typed value is never drawn by the server').not.toContain('Typed Name Zed');
    // Mutant: init ignores typed -> `fieldset disabled`, red. Draw the typed value into the markup -> the last line is red.
  });

  it('typed with a hint: the hint is in the role="alert" slot', async () => {
    const hint = 'The account number is not kept after a refused save. Check it before saving.';
    const html = await render({ kind: 'typed', fields: { name: 'x' }, hint });
    expect(html).toMatch(/role="alert"[^>]*>[^<]*The account number is not kept after a refused save\. Check it before saving\./);
  });

  it('dropped: stays locked, shows the R3 sentence in the alert slot and an Edit button, no Save', async () => {
    const html = await render({ kind: 'dropped' });
    expect(html).toContain('<fieldset disabled');
    expect(html).toContain('aria-label="Edit Gcash"');
    expect(html).not.toMatch(/type="submit"/);
    expect(html).toContain(`role="alert"`);
    expect(html).toContain(SENTENCE);
    expect(html).not.toContain('RETIRE-MARKER');
  });

  it('no typed prop, and typed={null}: locked, no alert (the old behaviour, a control that is green on HEAD)', async () => {
    for (const typed of [undefined, null]) {
      const html = await render(typed);
      expect(html).toContain('<fieldset disabled');
      expect(html).not.toContain('role="alert"');
    }
  });
});

describe('K4 the prop type', () => {
  it('`typed` accepts a typed view, a dropped view, null and undefined; any other kind does not compile', async () => {
    const { EditableRecord } = await load();
    type P = Parameters<typeof EditableRecord>[0];
    const base = { action: async () => {}, label: 'x', hidden: {}, children: null } as unknown as P;
    const a: P = { ...base, typed: { kind: 'typed', fields: { a: 'b', c: ['d'] } } };
    const b: P = { ...base, typed: { kind: 'dropped' } };
    const c: P = { ...base, typed: null };
    const d: P = { ...base };
    // @ts-expect-error - only 'typed' and 'dropped' are views (R2)
    const e: P = { ...base, typed: { kind: 'bogus' } };
    expect([a, b, c, d, e]).toHaveLength(5);
    expectTypeOf<P>().toHaveProperty('typed');
  });
});

describe('T-389 audit: what could not be put back is shown', () => {
  // CONTRACT PINNED: export notAppliedMessage(names: readonly string[]): string, and a reducer event
  // { type: 'notApplied', names } that puts that message in the alert slot of an EDITING record (a locked one ignores it;
  // an empty list changes nothing). The component dispatches it with planApply's `notApplied`.
  it('notAppliedMessage names the fields, in the ruled sentence', async () => {
    const m = (await load()) as unknown as { notAppliedMessage(n: readonly string[]): string };
    expect(m.notAppliedMessage(['moneyAccountId'])).toBe('Some of what you typed could not be put back: moneyAccountId. Check those fields.');
    expect(m.notAppliedMessage(['kind', 'moneyAccountId'])).toBe('Some of what you typed could not be put back: kind, moneyAccountId. Check those fields.');
  });
  it('the reducer shows it on an editing record only, and an empty list changes nothing', async () => {
    const { editableRecordReducer } = await load();
    const r = editableRecordReducer as unknown as (s: unknown, e: unknown) => { mode: string; message: string | null };
    const editing = { mode: 'editing', message: null };
    expect(r(editing, { type: 'notApplied', names: ['kind'] })).toEqual({ mode: 'editing', message: 'Some of what you typed could not be put back: kind. Check those fields.' });
    expect(r(editing, { type: 'notApplied', names: [] })).toEqual(editing);
    expect(r({ mode: 'locked', message: null }, { type: 'notApplied', names: ['kind'] })).toEqual({ mode: 'locked', message: null });
    // Mutant: no 'notApplied' case -> the reducer returns undefined, red.
  });
});
