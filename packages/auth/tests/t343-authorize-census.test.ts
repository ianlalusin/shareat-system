/**
 * T-343 S2 — T5: source census of `authorize.ts`. docs/tasks/343-def-417-human-readable-refusals.md
 * §S2: "zero `throw new Error(`; every `new AuthorizationError(` passes a refusal-text call."
 *
 * A static read of the source, not a behavioural test — mirrors the discipline
 * `packages/auth/tests/errors-leaf.test.ts` already uses for import-graph census work in this same
 * package. `throw new AuthorizationError(msg, capability)` (today's two-argument shape, 7 sites) is
 * the thing this file exists to catch converting away from — every site must gain a THIRD argument,
 * and that argument must be a call to one of the seven `refusal-text.ts` functions, not a bare
 * string.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const authorizeSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'authorize.ts'), 'utf8');

/** Strips comments the same way `errors-leaf.test.ts` does, so a mention inside a doc comment never
 *  counts as a real throw or a real call. */
function codeOnly(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const REFUSAL_TEXT_FUNCTIONS = [
  'noActiveRole',
  'roleMayNot',
  'notAssignedToStore',
  'storeNotInOrg',
  'otherOrg',
  'storeRequired',
  'closePeriodNeedsWholeOrg',
];

describe('T5 — authorize.ts throws zero raw Errors; every AuthorizationError carries a refusal-text call', () => {
  const code = codeOnly(authorizeSrc);

  it('zero `throw new Error(` sites', () => {
    const rawThrows = code.match(/throw new Error\(/g) ?? [];
    expect(rawThrows).toEqual([]);
  });

  it('every `new AuthorizationError(` call passes a THIRD argument — never the bare two-arg shape', () => {
    // Matches the whole call up to its closing paren is unsafe for a multi-line, nested-paren call,
    // so this counts commas at depth 1 inside each `new AuthorizationError(...)` invocation instead
    // of trying to regex the full argument list.
    const sites: string[] = [];
    const re = /new AuthorizationError\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      let argCount = 1; // at least one arg once we see any non-whitespace before the close
      let sawContent = false;
      let topLevelCommas = 0;
      for (; i < code.length && depth > 0; i++) {
        const ch = code[i];
        if (ch === undefined) break; // guard: i < code.length above already makes this unreachable
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 1) topLevelCommas++;
        if (!/\s/.test(ch)) sawContent = true;
      }
      argCount = sawContent ? topLevelCommas + 1 : 0;
      sites.push(code.slice(m.index, i));
      expect(argCount, `site: ${code.slice(m.index, Math.min(i, m.index + 120))}`).toBeGreaterThanOrEqual(3);
    }
    expect(sites.length, 'sanity: authorize.ts must still construct AuthorizationError somewhere').toBeGreaterThan(0);
  });

  it('every `new AuthorizationError(` call\'s third argument is a refusal-text function call, not a bare string', () => {
    const re = /new AuthorizationError\(/g;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(code))) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') depth--;
      }
      const argsText = code.slice(start, i - 1);
      const usesRefusalFn = REFUSAL_TEXT_FUNCTIONS.some((fn) => argsText.includes(`${fn}(`));
      expect(usesRefusalFn, `args: ${argsText}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
