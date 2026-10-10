/**
 * T-387 S3 — Select, Textarea, Checkbox (components/ui/{Select,Textarea,Checkbox}.tsx).
 *
 * Decisions pinned (the tester's, flagged in the hand-back):
 *  - Select's class-token set is EXACTLY Input's, valid and invalid (same geometry, same focus idiom).
 *  - Textarea carries every Input token except `min-h-11`, and some `min-h-*` of its own (a textarea is taller).
 *  - Checkbox renders `<label class="... min-h-11 ..."><input type="checkbox">label text</label>`: the 44px hit target
 *    is the label wrapper (the native box stays small, which the census files under "intrinsic checkbox/radio box").
 *  - All three own `aria-invalid` outright, exactly as Input does: `invalid` is the one channel, a caller's own
 *    `aria-invalid` never wins, and the attribute is omitted (not "false") when valid.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/ui/Input';
import { Select } from '../src/components/ui/Select';
import { Textarea } from '../src/components/ui/Textarea';
import { Checkbox } from '../src/components/ui/Checkbox';

const classesOf = (html: string, tag: string): string[] => {
  const m = new RegExp(`<${tag}\\b[^>]*?class="([^"]*)"`).exec(html);
  return (m?.[1] ?? '').split(/\s+/).filter(Boolean);
};
const sorted = (a: string[]) => [...a].sort();
const R = (c: unknown, p: Record<string, unknown>, kids?: unknown) =>
  renderToStaticMarkup(createElement(c as never, p as never, kids as never));

const inputValid = classesOf(R(Input, { name: 'x' }), 'input');
const inputInvalid = classesOf(R(Input, { name: 'x', invalid: true }), 'input');

describe('Input is the reference (sanity)', () => {
  it('Input still has the 44px field geometry', () => {
    for (const t of ['rounded-[10px]', 'bg-field', 'min-h-11', 'border-field-border']) expect(inputValid).toContain(t);
  });
});

describe('Select', () => {
  const opts = [createElement('option', { key: 'a', value: 'a' }, 'Alpha')];
  it('is a native <select> with its options', () => {
    const html = R(Select, { name: 'k' }, opts);
    expect(html).toMatch(/^<select\b/);
    expect(html).toContain('<option value="a">Alpha</option>');
  });
  it('has exactly Input\'s class tokens when valid, and exactly Input\'s invalid tokens when invalid', () => {
    expect(sorted(classesOf(R(Select, { name: 'k' }, opts), 'select'))).toEqual(sorted(inputValid));
    expect(sorted(classesOf(R(Select, { name: 'k', invalid: true }, opts), 'select'))).toEqual(sorted(inputInvalid));
  });
  it('invalid: aria-invalid="true" AND a 2px danger border; valid: neither', () => {
    const bad = R(Select, { name: 'k', invalid: true }, opts);
    expect(bad).toContain('aria-invalid="true"');
    expect(classesOf(bad, 'select')).toEqual(expect.arrayContaining(['border-2', 'border-danger']));
    const ok = R(Select, { name: 'k' }, opts);
    expect(ok).not.toContain('aria-invalid');
    expect(classesOf(ok, 'select')).not.toContain('border-danger');
  });
  it('NEGATIVE: a caller aria-invalid cannot detach the ARIA state from the border (both directions)', () => {
    expect(R(Select, { name: 'k', 'aria-invalid': 'true' }, opts)).not.toContain('aria-invalid');
    expect(R(Select, { name: 'k', invalid: true, 'aria-invalid': 'false' }, opts)).toContain('aria-invalid="true"');
  });
  it('appends a caller className and passes name/required/defaultValue through', () => {
    const html = R(Select, { name: 'k', className: 'w-full', required: true }, opts);
    expect(classesOf(html, 'select')).toContain('w-full');
    expect(html).toContain('name="k"');
    expect(html).toMatch(/\brequired(=""|\b)/);
  });
});

describe('Textarea', () => {
  it('is a native <textarea> and keeps its text', () => {
    const html = R(Textarea, { name: 'n', defaultValue: 'hello' });
    expect(html).toMatch(/^<textarea\b/);
    expect(html).toContain('hello</textarea>');
  });
  it('carries every Input token except min-h-11, plus a min-h-* of its own', () => {
    const t = classesOf(R(Textarea, { name: 'n' }), 'textarea');
    for (const c of inputValid.filter((x) => x !== 'min-h-11')) expect(t, c).toContain(c);
    expect(t.some((c) => /^min-h-/.test(c))).toBe(true);
  });
  it('invalid: aria-invalid="true" and the same invalid swap as Input (border-2 border-danger, no field-border)', () => {
    const bad = R(Textarea, { name: 'n', invalid: true });
    expect(bad).toContain('aria-invalid="true"');
    const c = classesOf(bad, 'textarea');
    expect(c).toEqual(expect.arrayContaining(['border-2', 'border-danger']));
    expect(c).not.toContain('border-field-border');
    expect(R(Textarea, { name: 'n' })).not.toContain('aria-invalid');
  });
  it('NEGATIVE: a caller aria-invalid cannot win', () => {
    expect(R(Textarea, { name: 'n', 'aria-invalid': 'true' })).not.toContain('aria-invalid');
    expect(R(Textarea, { name: 'n', invalid: true, 'aria-invalid': 'false' })).toContain('aria-invalid="true"');
  });
});

describe('Checkbox', () => {
  it('renders a label wrapper with a 44px hit target around a native checkbox and the label text', () => {
    const html = R(Checkbox, { name: 'agree', label: 'I agree' });
    expect(html).toMatch(/^<label\b/);
    expect(classesOf(html, 'label')).toContain('min-h-11');
    expect(html).toMatch(/<input\b[^>]*type="checkbox"/);
    expect(html).toContain('I agree');
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf('I agree'));
  });
  it('passes name, value and defaultChecked to the input', () => {
    const html = R(Checkbox, { name: 'agree', value: 'yes', defaultChecked: true, label: 'x' });
    expect(html).toContain('name="agree"');
    expect(html).toContain('value="yes"');
    expect(html).toMatch(/\bchecked(=""|\b)/);
  });
  it('invalid: the input gets aria-invalid="true" and a danger token; valid has neither', () => {
    const bad = R(Checkbox, { name: 'a', label: 'x', invalid: true });
    expect(bad).toMatch(/<input\b[^>]*aria-invalid="true"/);
    expect(classesOf(bad, 'input').some((c) => /danger/.test(c))).toBe(true);
    const ok = R(Checkbox, { name: 'a', label: 'x' });
    expect(ok).not.toContain('aria-invalid');
    expect(classesOf(ok, 'input').some((c) => /danger/.test(c))).toBe(false);
  });
  it('NEGATIVE: a caller aria-invalid cannot win', () => {
    expect(R(Checkbox, { name: 'a', label: 'x', 'aria-invalid': 'true' })).not.toContain('aria-invalid');
    expect(R(Checkbox, { name: 'a', label: 'x', invalid: true, 'aria-invalid': 'false' })).toContain('aria-invalid="true"');
  });
  it('disabled reads as disabled: the whole label goes muted with a not-allowed cursor (S3 audit finding 3)', () => {
    // The label is the 44px hit target, so the disabled cue belongs on it, keyed on the input it wraps.
    const label = classesOf(R(Checkbox, { name: 'a', label: 'x', disabled: true }), 'label');
    expect(label).toContain('has-[:disabled]:text-muted');
    expect(label).toContain('has-[:disabled]:cursor-not-allowed');
  });
  it('escapes the label', () => {
    expect(R(Checkbox, { name: 'a', label: '<i>x</i>' })).not.toContain('<i>x</i>');
  });
});
