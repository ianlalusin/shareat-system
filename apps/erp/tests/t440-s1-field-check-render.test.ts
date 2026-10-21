/**
 * T-440 S1 (TESTER) - the per-field helper line: `Field rule=`, `FieldCheck`, and the pure DOM-plan function. Spec:
 * docs/tasks/440-live-field-checks.md section 3.3 item 3 and test T-S1-9 (+ the kit classes). Audit A8: node, `react-dom/server`,
 * NO jsdom (O4) - the layout effect that finds the control and sets aria-describedby / aria-invalid is proven by the pure plan
 * below plus the section 6 browser smoke, and this file says so.
 *
 * CONTRACT PINNED HERE (the builder matches; everything exported from `components/forms/index.ts`; `Field` from `@/components/ui`):
 *   fieldCheckLine(rule, result, touched) -> { kind: 'muted' | 'failing' | 'passing'; text: string }
 *     result = checkField(...) for the current value, or undefined (checks inactive). Not touched, or no result -> 'muted':
 *     the rule's requirement before typing - starts "Required" for a required rule, names the length ("10 digits") for the
 *     SSS rule. Touched and failing -> 'failing', text = the rule's `progress`. Touched and passing -> 'passing', text "Good".
 *   FieldCheckView({ id, line }) -> <p id={id}> (NOT a live region: CheckSummary is the one announcer) holding an aria-hidden <svg> icon AND the text (never
 *     colour alone). Failing is danger-toned, passing success-toned, muted neither.
 *   planFieldAria(current, helperId, failing) where current = { describedby: string | null; invalid: string | null;
 *     ownInvalid: boolean } -> { describedby: string; invalid: 'true' | null; ownInvalid: boolean }
 *     describedby APPENDS helperId to the existing ids (never replaces, never duplicates). failing -> invalid "true"; stops
 *     failing -> removed ONLY if we set it (ownInvalid): a server-rendered aria-invalid (Input's `invalid` channel) is never cleared.
 *   <FieldCheck rule> reads CheckContext and renders NOTHING outside a context or while it is inactive (first render, locked).
 *   <Field label rule={...}> with a rule renders a wrapper <div> holding the existing <label> and, OUTSIDE the label, the
 *     FieldCheck line. A Field with NO rule renders exactly what it rendered before: a bare <label>.
 *
 * MUTANTS: describedby replaced instead of appended; colour-only pass (no "Good" text); helper text inside the <label> (becomes
 * part of the control's accessible name); aria-invalid always on / cleared when the server set it; a line shown outside a context.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');
const forms = () => import('../src/components/forms');
const ui = () => import('../src/components/ui');
const domain = () => import('../../../packages/domain/src/field-rules');

type Result = { ok: true; value: string | null } | { ok: false; requirement: string; progress: string };
type Line = { kind: 'muted' | 'failing' | 'passing'; text: string };
type Rule = Record<string, unknown> & { name: string };

async function rules() {
  const { defineFieldRules } = await domain();
  return (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => Record<string, Rule>)('t440.field', {
    name: { label: 'The name', kind: 'text', min: 1, max: 40 },
    sss: { label: 'The SSS number', optional: true, kind: 'digits', min: 10, max: 10, strip: 'spaces-dashes' },
  });
}
async function res(rule: Rule, raw: string): Promise<Result> {
  const { checkField } = await domain();
  return (checkField as unknown as (r: Rule, v: string) => Result)(rule, raw);
}
async function line(rule: Rule, raw: string | undefined, touched: boolean): Promise<Line> {
  const { fieldCheckLine } = await forms();
  return (fieldCheckLine as unknown as (r: Rule, x: Result | undefined, t: boolean) => Line)(rule, raw === undefined ? undefined : await res(rule, raw), touched);
}

describe('fieldCheckLine (T-S1-9: the passing line says "Good" in TEXT)', () => {
  it('untouched = a muted requirement, even when the stored value would pass or fail', async () => {
    const set = await rules();
    const a = await line(set.name!, '', false);
    expect(a.kind).toBe('muted');
    expect(a.text).toMatch(/^Required/);
    const b = await line(set.sss!, '', false);
    expect(b.kind).toBe('muted');
    expect(b.text).toMatch(/10 digits/);
    expect(b.text).not.toMatch(/Good/);
    expect((await line(set.name!, 'Ana', false)).kind).toBe('muted');
  });
  it('no result (checks inactive) is muted too', async () => {
    const set = await rules();
    expect((await line(set.name!, undefined, true)).kind).toBe('muted');
  });
  it('touched and failing = the rule\'s progress words', async () => {
    const set = await rules();
    expect(await line(set.sss!, '123456789', true)).toEqual({ kind: 'failing', text: '1 more digit needed' });
    expect(await line(set.name!, '', true)).toEqual({ kind: 'failing', text: 'Required' });
    expect(await line(set.sss!, '12345abcde', true)).toEqual({ kind: 'failing', text: 'Digits only' });
  });
  it('touched and passing = the word "Good" (mutant: colour-only pass)', async () => {
    const set = await rules();
    expect(await line(set.sss!, '12-3456789-0', true)).toEqual({ kind: 'passing', text: 'Good' });
    expect(await line(set.name!, 'Ana', true)).toEqual({ kind: 'passing', text: 'Good' });
  });
});

describe('FieldCheckView', () => {
  async function view(l: Line, id = 'h-1') {
    const { FieldCheckView } = await forms();
    return renderToStaticMarkup(createElement(FieldCheckView as never, { id, line: l } as never));
  }
  // CONTRACT (T-440 S1 audit): ONE announcer. The "Save is off until..." summary (CheckSummary) is the persistent live region;
  // the per-field helper is plain text wired by aria-describedby, so a keystroke is announced once, not twice.
  it('has the given id and is NOT itself a live region (the summary is the one announcer)', async () => {
    const html = await view({ kind: 'passing', text: 'Good' });
    expect(html).toMatch(/^<p\b/);
    expect(html).toContain('id="h-1"');
    expect(html).not.toContain('aria-live');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
  it('passing: the text "Good" AND an aria-hidden icon (not colour alone), success-toned', async () => {
    const html = await view({ kind: 'passing', text: 'Good' });
    expect(html).toMatch(/>\s*Good\s*</);
    expect(html).toMatch(/<svg\b[^>]*aria-hidden="true"/);
    expect(html).toContain('text-success');
    expect(html).not.toContain('text-danger');
  });
  it('failing: the progress words AND an icon, danger-toned', async () => {
    const html = await view({ kind: 'failing', text: '3 more digits needed' });
    expect(html).toContain('3 more digits needed');
    expect(html).toMatch(/<svg\b[^>]*aria-hidden="true"/);
    expect(html).toContain('text-danger');
    expect(html).not.toContain('Good');
  });
  it('muted: the requirement text, neither tone, no "Good"', async () => {
    const html = await view({ kind: 'muted', text: 'Required - 10 digits' });
    expect(html).toContain('Required - 10 digits');
    expect(html).not.toContain('text-danger');
    expect(html).not.toContain('text-success');
    expect(html).not.toContain('Good');
  });
});

describe('planFieldAria - what the layout effect writes onto the control (T-S1-9; mutant: replace describedby)', () => {
  type Plan = { describedby: string; invalid: 'true' | null; ownInvalid: boolean };
  const plan = async (cur: { describedby: string | null; invalid: string | null; ownInvalid: boolean }, id: string, failing: boolean) => {
    const { planFieldAria } = await forms();
    return (planFieldAria as unknown as (c: typeof cur, i: string, f: boolean) => Plan)(cur, id, failing);
  };
  const none = { describedby: null, invalid: null, ownInvalid: false };

  it('no existing ids: describedby is the helper id', async () => {
    expect((await plan(none, 'h1', false)).describedby).toBe('h1');
    expect((await plan({ ...none, describedby: '' }, 'h1', false)).describedby).toBe('h1');
  });
  it('existing ids are KEPT and the helper appended; never duplicated on a re-run', async () => {
    const once = await plan({ ...none, describedby: 'hint-1 hint-2' }, 'h1', false);
    expect(once.describedby).toBe('hint-1 hint-2 h1');
    const twice = await plan({ ...none, describedby: once.describedby }, 'h1', false);
    expect(twice.describedby).toBe('hint-1 hint-2 h1');
  });
  it('failing sets aria-invalid="true" and remembers it was us', async () => {
    expect(await plan(none, 'h1', true)).toEqual({ describedby: 'h1', invalid: 'true', ownInvalid: true });
  });
  it('no longer failing removes the invalid mark WE set', async () => {
    expect(await plan({ describedby: 'h1', invalid: 'true', ownInvalid: true }, 'h1', false)).toEqual({ describedby: 'h1', invalid: null, ownInvalid: false });
  });
  it('a server-rendered aria-invalid (Input\'s `invalid` channel) is never cleared, failing or not', async () => {
    const server = { describedby: null, invalid: 'true', ownInvalid: false };
    expect((await plan(server, 'h1', false)).invalid).toBe('true');
    const f = await plan(server, 'h1', true);
    expect(f.invalid).toBe('true');
    expect(f.ownInvalid, 'we did not set it, so we must not claim it').toBe(false);
    expect((await plan({ ...server, describedby: 'h1' }, 'h1', false)).invalid).toBe('true');
  });
  it('untouched-or-passing and no mark: stays unmarked (aria-invalid only when touched AND failing)', async () => {
    expect((await plan(none, 'h1', false)).invalid).toBeNull();
  });
});

describe('Field / FieldCheck render (SSR)', () => {
  async function renderField(rule: Rule | undefined, ctx: unknown | 'none') {
    const { Field } = await ui();
    const { CheckContext } = (await forms()) as unknown as { CheckContext: React.Context<unknown> };
    const el = createElement(
      Field as never,
      { label: 'The name', ...(rule ? { rule } : {}) } as never,
      createElement('input', { name: 'name' }),
    );
    return renderToStaticMarkup(ctx === 'none' ? el : createElement(CheckContext.Provider, { value: ctx }, el));
  }
  async function context(state: { values: Record<string, string>; touched: Record<string, true>; active: boolean }) {
    const { checkContextValue } = await forms();
    return (checkContextValue as unknown as (s: unknown, st: unknown) => unknown)(await rules(), state);
  }
  const labelInner = (html: string) => /<label\b[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? '';

  it('a Field with NO rule is exactly what it was: a bare <label>, no live region', async () => {
    const html = await renderField(undefined, 'none');
    expect(html).toMatch(/^<label\b/);
    expect(html).not.toContain('aria-live');
  });
  it('a ruled Field is a wrapper <div> around the <label>', async () => {
    const set = await rules();
    const html = await renderField(set.name!, await context({ values: { name: '' }, touched: {}, active: true }));
    expect(html).toMatch(/^<div\b/);
    expect(html).toContain('<label');
  });
  it('outside any context, or while inactive (first render, locked), a ruled Field draws no line (a stray form cannot lie)', async () => {
    const set = await rules();
    expect(await renderField(set.name!, 'none')).not.toContain('aria-live');
    expect(await renderField(set.name!, null)).not.toContain('aria-live');
    expect(await renderField(set.name!, await context({ values: { name: '' }, touched: {}, active: false }))).not.toContain('aria-live');
  });
  it('active + untouched: a muted requirement line sits OUTSIDE the <label> (mutant: text inside the label)', async () => {
    const set = await rules();
    const html = await renderField(set.name!, await context({ values: { name: '' }, touched: {}, active: true }));
    expect(html).not.toContain('aria-live');
    expect(labelInner(html)).not.toMatch(/Required/);
    expect(html).toMatch(/<\/label>\s*<p\b[^>]*>[\s\S]*Required/);
    expect(html).toMatch(/<p\b[^>]*\sid="[^"]+"/);
  });
  it('active + touched + passing: "Good" with an icon, outside the label', async () => {
    const set = await rules();
    const html = await renderField(set.name!, await context({ values: { name: 'Ana' }, touched: { name: true }, active: true }));
    expect(html).toMatch(/>\s*Good\s*</);
    expect(html).toMatch(/<svg\b/);
    expect(labelInner(html)).not.toContain('Good');
  });
  it('active + touched + failing: the progress words, outside the label', async () => {
    const set = await rules();
    const html = await renderField(set.name!, await context({ values: { name: '' }, touched: { name: true }, active: true }));
    expect(html).toContain('Required');
    expect(labelInner(html)).not.toContain('Required');
    expect(html).not.toContain('Good');
  });
});

describe('release: taking the helper id back off the control keeps the control other ids (audit d)', () => {
  type Rel = { describedby: string | null; clearInvalid: boolean };
  const release = async (cur: { describedby: string | null; invalid: string | null; ownInvalid: boolean }, id: string) => {
    const { planFieldRelease } = (await forms()) as unknown as {
      planFieldRelease: (c: typeof cur, i: string) => Rel;
    };
    return planFieldRelease(cur, id);
  };
  it('"sss-help other h1" minus h1 is "sss-help other" (split on whitespace, order kept)', async () => {
    expect((await release({ describedby: 'sss-help other h1', invalid: null, ownInvalid: false }, 'h1')).describedby).toBe('sss-help other');
    expect((await release({ describedby: 'h1 sss-help  other', invalid: null, ownInvalid: false }, 'h1')).describedby).toBe('sss-help other');
  });
  it('only our id: describedby is null (the attribute is removed); an id that merely CONTAINS ours is untouched', async () => {
    expect((await release({ describedby: 'h1', invalid: null, ownInvalid: false }, 'h1')).describedby).toBeNull();
    expect((await release({ describedby: 'h10 xh1', invalid: null, ownInvalid: false }, 'h1')).describedby).toBe('h10 xh1');
    expect((await release({ describedby: null, invalid: null, ownInvalid: false }, 'h1')).describedby).toBeNull();
  });
  it('aria-invalid is cleared ONLY when we set it', async () => {
    expect((await release({ describedby: 'h1', invalid: 'true', ownInvalid: true }, 'h1')).clearInvalid).toBe(true);
    expect((await release({ describedby: 'h1', invalid: 'true', ownInvalid: false }, 'h1')).clearInvalid).toBe(false);
  });
  it('FieldCheck.tsx release() goes through planFieldRelease (no second inline copy of the rule)', () => {
    const s = read('components/forms/FieldCheck.tsx');
    expect(s).toMatch(/planFieldRelease\(/);
  });
});

describe('the kit controls draw the failing border from ARIA (one fact, not two): aria-[invalid=true]:border-danger', () => {
  it.each(['Input', 'Select', 'Textarea'])('%s.tsx BASE_CLASSES is still ONE string literal and carries the ARIA-driven border', (name) => {
    const src = read(`components/ui/${name}.tsx`);
    const lit = /const BASE_CLASSES = '([^']*)';/.exec(src);
    expect(lit, `${name}: BASE_CLASSES is a single quoted literal (touch-target census)`).not.toBeNull();
    expect(lit![1]).toContain('aria-[invalid=true]:border-danger');
  });
});
