import { describe, expect, it } from 'vitest';
import { findingsForSource } from './no-typed-values-in-urls';

/**
 * T-380 guard hole: G1a must see a query built by hand in a `redirectWithFlash` path (concatenation or template),
 * not only in `redirect()`. Red before the analyzer change: `redirectWithFlash` paths were never inspected.
 */
const wrap = (call: string) => `
  import { redirectWithFlash } from '@/lib/flash';
  export async function act(v: string) {
    return await ${call};
  }`;
const rules = (call: string) => findingsForSource(wrap(call), 'app/x/actions.ts').map((f) => f.rule);

describe('G1a - redirectWithFlash path builds no query', () => {
  it("a `+` concatenation ('/path?x=' + v) is flagged", () => {
    expect(rules("redirectWithFlash('/path?x=' + v, {}, { ok: 'a' })")).toEqual(['G1a']);
  });
  it('a concatenation with no literal ? is flagged too', () => {
    expect(rules("redirectWithFlash('/path/' + v, {}, { ok: 'a' })")).toEqual(['G1a']);
  });
  it('a template with ? in its static text is flagged', () => {
    expect(rules('redirectWithFlash(`/path?x=${v}`, {}, { ok: "a" })')).toEqual(['G1a']);
  });
  it('a template with & after a dynamic part is flagged', () => {
    expect(rules('redirectWithFlash(`/path/${v}&y=1`, {}, { ok: "a" })')).toEqual(['G1a']);
  });
  it('control: a fixed nav-only path, and a template with only a path id, stay clean', () => {
    expect(rules("redirectWithFlash('/path', { store: v }, { ok: 'a' })")).toEqual([]);
    expect(rules('redirectWithFlash(`/path/${v}`, {}, { ok: "a" })')).toEqual([]);
  });
});
