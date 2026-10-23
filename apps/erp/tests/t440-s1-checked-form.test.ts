/**
 * T-440 S1 (TESTER) - CheckedForm / EditableRecord / SubmitButton integration: the check-state reducer, the context, the
 * blocked submit, the reset watcher, and the two pilot forms. Spec: docs/tasks/440-live-field-checks.md section 3.3 and
 * tests T-S1-8, T-S1-10, T-S1-11, T-S1-13, T-S1-14 (+ the pilots). Audit A2, A4, A8. Q2 ruling: Save is TRULY `disabled`.
 *
 * Node, `react-dom/server`, no jsdom (A8 / O4: none is installed; real-DOM behaviour - Enter, focus, layout effects, a real
 * form.reset() - is the section 6 browser smoke, and this file says so wherever it stops short of it). `.ts`, not `.tsx`
 * (the unit include is `apps/**\/*.test.ts`, so a `.test.tsx` would never run).
 *
 * CONTRACT PINNED HERE (the spec names the pieces; the builder matches these names and shapes). Everything is exported from
 * `apps/erp/src/components/forms/index.ts` (implemented in CheckedForm.tsx / FieldCheck.tsx / EditableRecord.tsx):
 *   CHECKED_FORM_INITIAL = { values: {}, touched: {}, active: false }      - what the FIRST render holds (= the server render)
 *   checkedFormReducer(state, event) -> state, state = { values: Record<string,string>; touched: Record<string,true>; active }
 *     { type:'read', values }          re-read every control: values REPLACED (not merged), touched cleared, active true.
 *                                      Used on mount, on Edit, and on the form's `reset` (Cancel, registry close(), React 19's
 *                                      auto-reset after a successful action).
 *     { type:'input', name, value }    the user typed: that value is stored and that name is touched.
 *     { type:'touch', names }          a blocked submit: those names become touched.
 *     { type:'off' }                   locked: checks inactive (active false).
 *   checkContextValue(set, state) -> { active, blocked, summary, failing: string[], result(name), touched(name) }
 *     inactive: { active:false, blocked:false, summary:null, failing:[], result:()=>undefined, touched:()=>false } even if
 *     the stored values would fail. active: every rule of `set` is checked against state.values[name] ?? '' (absent = blank);
 *     failing = names in rule order; blocked = failing.length > 0;
 *     summary = null when nothing fails, else "Save is off until: <req1>[ <req2>][ and N more]" (first two requirements, then
 *     "and N more" for the rest; exactly "Save is off until: <req1>" when one fails). result(name) = checkField(rule, value).
 *   CheckContext                      - the React context (value: the object above, or null outside any checked form).
 *   onCheckedSubmit(event, ctx, effects) -> boolean   the submit handler's body. effects = { touch(names: string[]): void;
 *     focus(name: string): void }. When ctx.blocked: event.preventDefault(), effects.touch(ctx.failing),
 *     effects.focus(ctx.failing[0]), return true. Otherwise do nothing and return false.
 *   watchFormReset(target, reread, defer?) -> unsubscribe   adds a 'reset' listener to `target` (an EventTarget); on reset it
 *     calls `reread` through `defer` (default: one task later, because `reset` fires BEFORE the controls are restored).
 *     `defer` is (fn: () => void) => void.
 *   <CheckedForm rules action {...formProps}>   'use client'; renders the <form>; provides CheckContext; before the layout
 *     effect it provides the INACTIVE state, so its first render equals the server render and Save is enabled (no-JS safe).
 *   SubmitButton (components/feedback) and EditableRecordView's Save read CheckContext: disabled = pending || prop || blocked.
 *     EditableRecordView ALSO renders the status line: <CheckSummary active summary>: ONE persistent <p role="status" aria-live="polite"> (empty text when nothing blocks),
 *     rendered whenever it is editing and the context is active (audit a). EditableRecord gains `rules?: FieldRuleSet`.
 *
 * MUTANTS: aria-disabled instead of disabled; SubmitButton ignores the context; the guard sits on onClick only (no
 * preventDefault in the submit handler); checks active while locked; initial state computed from the rules alone (blocks a
 * no-JS submit); `reset` re-read only inside the Cancel click handler; the re-read done synchronously (before the controls are
 * restored); a status line that is not announced.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const formStatus = vi.hoisted(() => ({ pending: false }));
vi.mock('react-dom', async (orig) => ({
  ...(await orig<typeof import('react-dom')>()),
  useFormStatus: () => ({ pending: formStatus.pending, data: null, method: null, action: null }),
}));

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');
const forms = () => import('../src/components/forms');
const domain = () => import('../../../packages/domain/src/field-rules');
const submitButton = () => import('../src/components/feedback/SubmitButton');

type Result = { ok: true; value: string | null } | { ok: false; requirement: string; progress: string };
type Ctx = {
  active: boolean;
  blocked: boolean;
  summary: string | null;
  failing: string[];
  result(name: string): Result | undefined;
  touched(name: string): boolean;
};
type State = { values: Record<string, string>; touched: Record<string, true>; active: boolean };

async function oneSet() {
  const { defineFieldRules } = await domain();
  return (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => Record<string, { name: string }>)('t440.checked', {
    name: { label: 'The name', kind: 'text', min: 1, max: 40 },
    sss: { label: 'The SSS number', optional: true, kind: 'digits', min: 10, max: 10, strip: 'spaces-dashes' },
    note: { label: 'The note', optional: true, kind: 'text', max: 10 },
  });
}
async function fourRequired() {
  const { defineFieldRules } = await domain();
  const req = (label: string) => ({ label, kind: 'text', min: 1, max: 9 });
  return (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => Record<string, { name: string }>)('t440.four', {
    a: req('The first'), b: req('The second'), c: req('The third'), d: req('The fourth'),
  });
}
async function requirementOf(rule: unknown, raw: string): Promise<string> {
  const { checkField } = await domain();
  const r = (checkField as unknown as (r: unknown, v: string) => Result)(rule, raw);
  if (r.ok) throw new Error('expected a failing value');
  return r.requirement;
}
async function ctxFor(set: unknown, state: State): Promise<Ctx> {
  const { checkContextValue } = await forms();
  return (checkContextValue as unknown as (s: unknown, st: State) => Ctx)(set, state);
}
const ACTIVE = (values: Record<string, string>, touched: Record<string, true> = {}): State => ({ values, touched, active: true });
async function reduce(state: State, event: unknown): Promise<State> {
  const { checkedFormReducer } = await forms();
  return (checkedFormReducer as unknown as (s: State, e: unknown) => State)(state, event);
}
async function withContext(value: Ctx | null, child: ReactNode): Promise<string> {
  const { CheckContext } = (await forms()) as unknown as { CheckContext: React.Context<Ctx | null> };
  return renderToStaticMarkup(createElement(CheckContext.Provider, { value }, child));
}
const tokens = (html: string, tag: string) => {
  const m = new RegExp(`<${tag}\\b[^>]*>`).exec(html);
  return m ? m[0] : '';
};
const save = (html: string) => /<button\b[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? '';

describe('checkedFormReducer', () => {
  it('the first render state is inactive and empty (= what the server renders)', async () => {
    const { CHECKED_FORM_INITIAL } = await forms();
    expect(CHECKED_FORM_INITIAL).toEqual({ values: {}, touched: {}, active: false });
  });
  it('read: activates, REPLACES the values (an absent key is gone) and clears touched', async () => {
    const s = await reduce({ values: { a: '1', b: '2' }, touched: { a: true }, active: false }, { type: 'read', values: { a: 'x' } });
    expect(s).toEqual({ values: { a: 'x' }, touched: {}, active: true });
  });
  it('input: stores the value and touches exactly that name', async () => {
    const s = await reduce(ACTIVE({ a: '' }), { type: 'input', name: 'a', value: 'hi' });
    expect(s.values).toEqual({ a: 'hi' });
    expect(s.touched).toEqual({ a: true });
    expect(s.active).toBe(true);
  });
  it('touch: marks the named fields; off: deactivates', async () => {
    const t = await reduce(ACTIVE({}), { type: 'touch', names: ['a', 'b'] });
    expect(t.touched).toEqual({ a: true, b: true });
    expect((await reduce(ACTIVE({ a: '' }), { type: 'off' })).active).toBe(false);
  });
});

describe('checkContextValue', () => {
  it('inactive (first render, or LOCKED) never blocks, explains nothing and reports no result - even for values that would fail (T-S1-10; mutant: checks active while locked)', async () => {
    const set = await oneSet();
    for (const state of [{ values: {}, touched: {}, active: false }, await reduce(ACTIVE({ name: '' }), { type: 'off' })]) {
      const c = await ctxFor(set, state);
      expect(c.active).toBe(false);
      expect(c.blocked).toBe(false);
      expect(c.summary).toBeNull();
      expect(c.failing).toEqual([]);
      expect(c.result('name')).toBeUndefined();
      expect(c.touched('name')).toBe(false);
    }
  });
  it('active with a blank required field: blocked, failing names it, the summary is the spec sentence', async () => {
    const set = await oneSet();
    const c = await ctxFor(set, ACTIVE({}));
    expect(c.active).toBe(true);
    expect(c.blocked).toBe(true);
    expect(c.failing).toEqual(['name']);
    expect(c.summary).toBe(`Save is off until: ${await requirementOf(set.name, '')}`);
    const r = c.result('name');
    expect(r && !r.ok && r.progress).toBe('Required');
  });
  it('everything passing: not blocked, no summary; the optional blank and the stripped SSS pass', async () => {
    const set = await oneSet();
    const c = await ctxFor(set, ACTIVE({ name: 'Ana', sss: '12-3456789-0', note: '' }));
    expect(c.blocked).toBe(false);
    expect(c.summary).toBeNull();
    expect(c.failing).toEqual([]);
    expect(c.result('sss')).toEqual({ ok: true, value: '1234567890' });
  });
  it('failing is in rule order and the summary lists the first two requirements then "and N more"', async () => {
    const set = await fourRequired();
    const c = await ctxFor(set, ACTIVE({}));
    expect(c.failing).toEqual(['a', 'b', 'c', 'd']);
    const [r1, r2, r3, r4] = [await requirementOf(set.a, ''), await requirementOf(set.b, ''), await requirementOf(set.c, ''), await requirementOf(set.d, '')];
    expect(c.summary).toContain(r1);
    expect(c.summary).toContain(r2);
    expect(c.summary).not.toContain(r3);
    expect(c.summary).not.toContain(r4);
    expect(c.summary).toMatch(/^Save is off until:/);
    expect(c.summary).toMatch(/and 2 more/);
    const three = await ctxFor(set, ACTIVE({ d: 'x' }));
    expect(three.summary).toMatch(/and 1 more/);
    const two = await ctxFor(set, ACTIVE({ c: 'x', d: 'x' }));
    expect(two.summary).not.toMatch(/more/);
  });
  it('A5: the status line never repeats a typed value', async () => {
    const set = await oneSet();
    const c = await ctxFor(set, ACTIVE({ name: 'Ana', sss: '4815162342x' }));
    expect(c.blocked).toBe(true);
    expect(JSON.stringify([c.summary, c.result('sss')])).not.toContain('4815162342x');
  });
  it('touched(name) reflects the state', async () => {
    const set = await oneSet();
    const c = await ctxFor(set, ACTIVE({ name: '' }, { name: true }));
    expect(c.touched('name')).toBe(true);
    expect(c.touched('sss')).toBe(false);
  });
});

describe('T-S1-13 typed reopen (T-389), at the state level - no pilot can show it (A11); the real-DOM leg is the smoke', () => {
  it('the stored values are read, then the typed values arrive as input events: the typed (failing) value is checked and touched', async () => {
    const set = await oneSet();
    let s = await reduce({ values: {}, touched: {}, active: false }, { type: 'read', values: { name: 'Ana', note: 'ok' } });
    expect((await ctxFor(set, s)).blocked).toBe(false);
    s = await reduce(s, { type: 'input', name: 'name', value: '' }); // what applyTyped fires after writing the typed blank
    const c = await ctxFor(set, s);
    expect(c.blocked).toBe(true);
    expect(c.touched('name')).toBe(true);
    expect(c.summary).toContain(await requirementOf(set.name, ''));
  });
});

describe('T-S1-14 reset returns the state to the stored values (mutants: re-read only in the Cancel click handler; re-read synchronously)', () => {
  it('after typing, a re-read of the stored values is exactly the state a fresh Edit produces', async () => {
    let s = await reduce({ values: {}, touched: {}, active: false }, { type: 'read', values: { name: 'Ana' } });
    const fresh = s;
    s = await reduce(s, { type: 'input', name: 'name', value: '' });
    s = await reduce(s, { type: 'read', values: { name: 'Ana' } });
    expect(s).toEqual(fresh);
  });
  it('watchFormReset: any `reset` on the form re-reads (Cancel, close() and a bare form.reset() all dispatch this one event)', async () => {
    const { watchFormReset } = await forms();
    const watch = watchFormReset as unknown as (t: EventTarget, f: () => void, d?: (fn: () => void) => void) => () => void;
    const form = new EventTarget();
    let calls = 0;
    const stop = watch(form, () => (calls += 1), (fn) => fn());
    form.dispatchEvent(new Event('reset'));
    form.dispatchEvent(new Event('reset'));
    expect(calls).toBe(2);
    stop();
    form.dispatchEvent(new Event('reset'));
    expect(calls, 'unsubscribed').toBe(2);
  });
  it('the re-read is DEFERRED (reset fires before the controls are restored): not synchronous, done by the next task', async () => {
    const { watchFormReset } = await forms();
    const watch = watchFormReset as unknown as (t: EventTarget, f: () => void) => () => void;
    const form = new EventTarget();
    let calls = 0;
    watch(form, () => (calls += 1));
    form.dispatchEvent(new Event('reset'));
    expect(calls, 'not synchronously').toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls, 'one task later').toBe(1);
  });
  it('both components wire it through the form\'s reset event, not only a click handler', () => {
    expect(read('components/forms/CheckedForm.tsx')).toMatch(/watchFormReset\(/);
    expect(read('components/forms/EditableRecord.tsx')).toMatch(/watchFormReset\(/);
  });
});

describe('onCheckedSubmit (T-S1-8; mutant: the guard is on onClick only)', () => {
  const fakeEvent = () => {
    const e = { prevented: 0, preventDefault() { e.prevented += 1; } };
    return e;
  };
  it('blocked: preventDefault once, touch the failing names, focus the first, return true', async () => {
    const { onCheckedSubmit } = await forms();
    const set = await fourRequired();
    const c = await ctxFor(set, ACTIVE({ c: 'x' }));
    const e = fakeEvent();
    const touched: string[][] = [];
    const focused: string[] = [];
    const out = (onCheckedSubmit as unknown as (a: unknown, b: Ctx, c: unknown) => boolean)(e, c, {
      touch: (n: string[]) => touched.push(n),
      focus: (n: string) => focused.push(n),
    });
    expect(out).toBe(true);
    expect(e.prevented).toBe(1);
    expect(touched).toEqual([['a', 'b', 'd']]);
    expect(focused).toEqual(['a']);
  });
  it('not blocked, and inactive (no JS yet): the submit goes through untouched', async () => {
    const { onCheckedSubmit } = await forms();
    const set = await oneSet();
    for (const c of [await ctxFor(set, ACTIVE({ name: 'Ana' })), await ctxFor(set, { values: {}, touched: {}, active: false })]) {
      const e = fakeEvent();
      const out = (onCheckedSubmit as unknown as (a: unknown, b: Ctx, c: unknown) => boolean)(e, c, { touch: () => undefined, focus: () => undefined });
      expect(out).toBe(false);
      expect(e.prevented).toBe(0);
    }
  });
});

describe('SubmitButton under the context (T-S1-8; mutants: aria-disabled instead of disabled; ignores the context)', () => {
  async function blockedCtx() {
    return ctxFor(await oneSet(), ACTIVE({}));
  }
  async function okCtx() {
    return ctxFor(await oneSet(), ACTIVE({ name: 'Ana' }));
  }
  it('blocked: the submit button is truly `disabled` and not merely aria-disabled', async () => {
    const { SubmitButton } = await submitButton();
    formStatus.pending = false;
    const html = await withContext(await blockedCtx(), createElement(SubmitButton, { children: 'Save' }));
    const btn = save(html);
    expect(btn).toMatch(/\sdisabled=""/);
    expect(btn).not.toContain('aria-disabled');
  });
  it('passing: enabled; no provider at all: enabled (a stray form is unchanged)', async () => {
    const { SubmitButton } = await submitButton();
    formStatus.pending = false;
    expect(save(await withContext(await okCtx(), createElement(SubmitButton, { children: 'Save' })))).not.toMatch(/\sdisabled=""/);
    expect(save(await withContext(null, createElement(SubmitButton, { children: 'Save' })))).not.toMatch(/\sdisabled=""/);
  });
  it('pending ending does NOT re-enable a blocked Save: pending false + blocked is still disabled; pending true is disabled either way', async () => {
    const { SubmitButton } = await submitButton();
    for (const pending of [true, false]) {
      formStatus.pending = pending;
      expect(save(await withContext(await blockedCtx(), createElement(SubmitButton, { children: 'Save' })))).toMatch(/\sdisabled=""/);
    }
    formStatus.pending = true;
    expect(save(await withContext(await okCtx(), createElement(SubmitButton, { children: 'Save' })))).toMatch(/\sdisabled=""/);
    formStatus.pending = false;
  });
  it('the existing `disabled` prop still disables an unblocked button', async () => {
    const { SubmitButton } = await submitButton();
    formStatus.pending = false;
    expect(save(await withContext(await okCtx(), createElement(SubmitButton, { children: 'Save', disabled: true })))).toMatch(/\sdisabled=""/);
  });
  it('no source anywhere uses aria-disabled for this (Q2: truly disabled)', () => {
    for (const f of ['components/feedback/SubmitButton.tsx', 'components/forms/CheckedForm.tsx', 'components/forms/EditableRecord.tsx']) {
      expect(read(f), f).not.toContain('aria-disabled');
    }
  });
});

describe('EditableRecordView under the context (T-S1-8, T-S1-10)', () => {
  const baseProps = (over: Record<string, unknown> = {}) => ({
    action: () => undefined,
    label: 'government numbers',
    hidden: { id: 'r1' },
    typed: null,
    ...over,
  });
  async function view(mode: 'locked' | 'editing', ctx: Ctx | null, over: Record<string, unknown> = {}) {
    const { EditableRecordView } = await forms();
    return withContext(ctx, createElement(EditableRecordView as never, { ...baseProps(over), mode } as never, createElement('input', { name: 'name' })));
  }
  it('editing + blocked: Save is truly disabled and the aria-live status line carries the summary (Save\'s only explanation)', async () => {
    const c = await ctxFor(await oneSet(), ACTIVE({}));
    const html = await view('editing', c);
    expect(save(html)).toMatch(/\sdisabled=""/);
    expect(save(html)).not.toContain('aria-disabled');
    const status = tokens(html, 'p');
    expect(status).toMatch(/role="status"/);
    expect(status).toMatch(/aria-live="polite"/);
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    expect(html).toContain(esc(c.summary!));
    expect(html).toMatch(/Save is off until:/);
  });
  it('editing + the saveLabel "Save draft" is disabled the same way', async () => {
    const c = await ctxFor(await oneSet(), ACTIVE({}));
    expect(save(await view('editing', c, { saveLabel: 'Save draft' }))).toMatch(/\sdisabled=""/);
  });
  it('editing + passing: Save enabled; the status region STAYS in the DOM, empty (a live region must exist before it changes)', async () => {
    const c = await ctxFor(await oneSet(), ACTIVE({ name: 'Ana' }));
    const html = await view('editing', c);
    expect(save(html)).not.toMatch(/\sdisabled=""/);
    expect(html).toMatch(/<p\b[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/p>/);
    expect(html).not.toContain('Save is off');
  });
  it('editing + an INACTIVE context (the server render): no status region yet', async () => {
    const c = await ctxFor(await oneSet(), { values: {}, touched: {}, active: false });
    expect(await view('editing', c)).not.toContain('role="status"');
  });
  it('LOCKED: nothing is marked and no explanation shows, whatever the context says (row 289; mutant: checks active while locked)', async () => {
    const c = await ctxFor(await oneSet(), ACTIVE({}));
    const html = await view('locked', c);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('Save is off');
    expect(html).not.toMatch(/<button\b[^>]*\sdisabled=""/);
    expect(html).toContain('Edit government numbers');
  });
  it('the Save class list greys a disabled Save (pointer-events-none + opacity-40) and PRIMARY stays ONE string literal (touch-target census)', async () => {
    const c = await ctxFor(await oneSet(), ACTIVE({}));
    const cls = /class="([^"]*)"/.exec(save(await view('editing', c)))?.[1] ?? '';
    // T-448: the round icon Save greys at opacity-40 (was 50).
    expect(cls.split(/\s+/)).toEqual(expect.arrayContaining(['disabled:pointer-events-none', 'disabled:opacity-40']));
    const lit = /const PRIMARY =\s*'([^']*)'\s*;/.exec(read('components/forms/EditableRecord.tsx'));
    expect(lit, 'PRIMARY is a single quoted literal').not.toBeNull();
    expect(lit![1]).toMatch(/disabled:pointer-events-none/);
    expect(lit![1]).toMatch(/disabled:opacity-40/);
  });
});

describe('CheckSummary: the ONE persistent live region (audit a)', () => {
  // CONTRACT: CheckSummary({ active: boolean; summary: string | null }) is exported from forms/index.ts. Active: ALWAYS renders
  // <p role="status" aria-live="polite">{summary ?? ''}</p> (empty text when nothing is blocked), so a screen reader announces
  // every change of the text. Inactive (first render = server render, locked, outside a form): renders nothing. The per-field
  // helper lines are NOT live regions, so a keystroke is announced once.
  async function summary(props: { active: boolean; summary: string | null }) {
    const { CheckSummary } = (await forms()) as unknown as { CheckSummary: (p: typeof props) => ReactNode };
    return renderToStaticMarkup(createElement(CheckSummary as never, props as never));
  }
  it('active + nothing blocked: the element is there with no text', async () => {
    expect(await summary({ active: true, summary: null })).toMatch(/^<p\b[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/p>$/);
  });
  it('active + blocked: the same element carries the summary', async () => {
    const html = await summary({ active: true, summary: 'Save is off until: The name is required.' });
    expect(html).toMatch(/^<p\b[^>]*role="status"[^>]*aria-live="polite"[^>]*>Save is off until: The name is required\.<\/p>$/);
  });
  it('inactive: nothing at all (the server render has no status region)', async () => {
    expect(await summary({ active: false, summary: null })).toBe('');
    expect(await summary({ active: false, summary: 'x' })).toBe('');
  });
  it('CheckedForm.tsx and EditableRecord.tsx render <CheckSummary> unconditionally on active (no `blocked ? <p role=status`)', () => {
    for (const f of ['components/forms/CheckedForm.tsx', 'components/forms/EditableRecord.tsx']) {
      const s = read(f);
      expect(s, f).toMatch(/<CheckSummary\b/);
      expect(s, f).not.toMatch(/blocked\s*\?\s*\(\s*<p\b[^>]*role="status"/);
    }
  });
});

describe('T-S1-11 first render equals the server render (mutant: initial state computed from the rules alone)', () => {
  it('<CheckedForm> with a required rule and a blank field: the server markup has Save ENABLED (no JS = native attrs + server refusal) and no status line', async () => {
    const { CheckedForm } = await forms();
    const { SubmitButton } = await submitButton();
    formStatus.pending = false;
    const set = await oneSet();
    const html = renderToStaticMarkup(
      createElement(
        CheckedForm as never,
        { rules: set, action: () => undefined } as never,
        createElement('input', { name: 'name', defaultValue: '' }),
        createElement(SubmitButton, { children: 'Save' }),
      ),
    );
    expect(html).toMatch(/^<form\b/);
    expect(save(html)).not.toMatch(/\sdisabled=""/);
    expect(save(html)).not.toContain('aria-disabled');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('Save is off');
  });
  it('<EditableRecord rules> reopened EDITING by a typed view: still enabled, no status line, in the server markup', async () => {
    const { EditableRecord } = await forms();
    const set = await oneSet();
    const html = renderToStaticMarkup(
      createElement(
        EditableRecord as never,
        { ...{ action: () => undefined, label: 'x', hidden: { id: '1' } }, typed: { kind: 'typed', fields: { name: '' } }, rules: set } as never,
        createElement('input', { name: 'name', defaultValue: 'Ana' }),
      ),
    );
    expect(html).toContain('type="submit"');
    expect(save(html)).not.toMatch(/\sdisabled=""/);
    expect(html).not.toContain('role="status"');
  });
  it('<EditableRecord rules> locked (the default): no Save, no status, no marks', async () => {
    const { EditableRecord } = await forms();
    const set = await oneSet();
    const html = renderToStaticMarkup(
      createElement(
        EditableRecord as never,
        { action: () => undefined, label: 'x', hidden: { id: '1' }, typed: null, rules: set } as never,
        createElement('input', { name: 'name', defaultValue: '' }),
      ),
    );
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('role="status"');
    expect(html).toContain('Edit x');
  });
});

describe('source shape of the client pieces', () => {
  it('CheckedForm.tsx is a client component with the submit guard', () => {
    const s = read('components/forms/CheckedForm.tsx');
    expect(s).toMatch(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]use client['"]/);
    expect(s).toMatch(/onCheckedSubmit\(/);
    expect(s).toMatch(/onSubmit=/);
  });
  it('EditableRecord takes `rules`, SubmitButton reads the context, the index exports the new pieces', () => {
    expect(read('components/forms/EditableRecord.tsx')).toMatch(/\brules\??:/);
    expect(read('components/feedback/SubmitButton.tsx')).toMatch(/CheckContext|useCheck/);
    const idx = read('components/forms/index.ts');
    for (const n of ['CheckedForm', 'CheckContext', 'checkedFormReducer', 'checkContextValue', 'onCheckedSubmit', 'watchFormReset', 'FieldCheck', 'fieldCheckLine', 'planFieldAria', 'FieldCheckView', 'CHECKED_FORM_INITIAL']) {
      expect(idx, n).toContain(n);
    }
  });
});

describe('the two pilot forms (spec S1; A10)', () => {
  it('staff government IDs: EditableRecord rules=, one <Field rule=> and one {...nativeAttrs()} per number, no literal name/inputMode left', () => {
    const page = read('app/staff/[employmentId]/page.tsx');
    const at = page.indexOf('<EditableRecord action={setGovernmentIdsAction}');
    expect(at, 'the government-numbers EditableRecord is still there').toBeGreaterThan(-1);
    const region = page.slice(at, page.indexOf('</EditableRecord>', at));
    expect(region).toMatch(/\brules=\{/);
    expect((region.match(/\brule=\{/g) ?? []).length).toBe(4);
    expect((region.match(/\{\.\.\.nativeAttrs\(/g) ?? []).length).toBe(4);
    expect(region).not.toMatch(/\binputMode=/);
    expect(region).not.toMatch(/\bname="(sssNo|philhealthNo|pagibigNo|tin)"/);
  });
  it('supplier add form: a <CheckedForm rules=>, name + creditTermsDays through Field rule / nativeAttrs, no literal `required` or name left on them', () => {
    const page = read('app/ap/suppliers/page.tsx');
    const at = page.indexOf('Add a supplier');
    expect(at).toBeGreaterThan(-1);
    const region = page.slice(at, page.indexOf('</CheckedForm>', at));
    expect(region).toMatch(/<CheckedForm\b[^>]*\brules=\{/);
    expect(region).not.toMatch(/<form\b/);
    expect((region.match(/\brule=\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((region.match(/\{\.\.\.nativeAttrs\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(region).not.toMatch(/\bname="(name|creditTermsDays)"/);
    expect(region).not.toMatch(/\brequired\b/);
    expect(region).toMatch(/>\s*Save\s*</); // the label stays exactly Save (t384 G8)
  });
});
