/**
 * T-334 slice 3 — no component in components/ui hardcodes the dark-mode danger red (ADR-013
 * Amendment 5): "Components keep using text-danger / border-danger / bg-danger-surface, and the
 * theme swaps the value. Do not copy #f87171 into a component or a dark: utility." — orchestrator
 * ruling 2026-09-23, in response to the tester's Q2.
 *
 * A new file rather than an addition to `ui-token-discipline.test.ts`'s guards 7-10: this tester's
 * edit scope on that file is the header/comments only (R5), not new guards. Duplicates that file's
 * COMPONENT_FILES glob and stripComments exactly, matching this test suite's own convention of
 * file-local helpers rather than a shared module (see ui-button.test.ts / ui-input.test.ts, which
 * each carry their own copy of the CSS-token-parsing helpers for the same reason).
 *
 * ⚠️ `.ts`, not `.tsx` — no JSX here; this is a static scan over the component SOURCE TEXT.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'ui');
const COMPONENT_FILES = readdirSync(COMPONENTS_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => path.join(COMPONENTS_DIR, f));

/** Identical to ui-token-discipline.test.ts's stripComments — see that file's header for the full
 *  reasoning (a real scan respecting string/template boundaries, not a blind `//`-onward regex). */
function stripComments(source: string): string {
  let result = '';
  let i = 0;
  let mode: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' = 'code';

  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);

    if (mode === 'line-comment') {
      if (c === '\n') {
        result += c;
        mode = 'code';
      }
      i += 1;
      continue;
    }
    if (mode === 'block-comment') {
      if (two === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (c === '\\') {
        result += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      result += c;
      if (c === quote) mode = 'code';
      i += 1;
      continue;
    }

    if (two === '//') {
      mode = 'line-comment';
      i += 2;
      continue;
    }
    if (two === '/*') {
      mode = 'block-comment';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      mode = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
      result += c;
      i += 1;
      continue;
    }
    result += c;
    i += 1;
  }
  return result;
}

const DARK_DANGER_UTILITY_RE = /\bdark:[\w-]*danger[\w-]*\b/;
const RULED_DARK_RED_HEX_RE = /#f87171\b/i;

function findHardcodedDarkDanger(source: string): string | null {
  const stripped = stripComments(source);
  return stripped.match(DARK_DANGER_UTILITY_RE)?.[0] ?? stripped.match(RULED_DARK_RED_HEX_RE)?.[0] ?? null;
}

describe('Guard source list', () => {
  it('the component-sources glob is non-empty', () => {
    expect(COMPONENT_FILES.length).toBeGreaterThan(0);
  });
});

describe('No component hardcodes a dark:*-danger utility or the literal #f87171 (ADR-013 Amendment 5)', () => {
  it('none of the component sources hardcodes a dark-danger utility or the ruled hex', () => {
    for (const file of COMPONENT_FILES) {
      expect(findHardcodedDarkDanger(readFileSync(file, 'utf8')), file).toBeNull();
    }
  });

  it('mutation check: flags a dark:text-danger utility', () => {
    expect(findHardcodedDarkDanger('<span className="dark:text-danger">Delete</span>')).toBe('dark:text-danger');
  });

  it('mutation check: flags a dark:border-danger utility', () => {
    expect(findHardcodedDarkDanger('<button className="dark:border-danger" />')).toBe('dark:border-danger');
  });

  it('mutation check: flags the ruled hex copied directly into a component', () => {
    expect(findHardcodedDarkDanger("const DARK_DANGER = '#f87171';")).toBe('#f87171');
  });

  it('mutation check: a token living only in a comment is NOT flagged once stripped — the same trap ui-token-discipline.test.ts names', () => {
    expect(
      findHardcodedDarkDanger('// never hardcode dark:text-danger or #f87171 here\nexport function X() { return null; }'),
    ).toBeNull();
  });

  it('mutation check: plain text-danger / border-danger / bg-danger-surface (the sanctioned, theme-swapped tokens) do not trip this guard', () => {
    expect(findHardcodedDarkDanger('<button className="border-danger text-danger" />')).toBeNull();
    expect(findHardcodedDarkDanger('<div className="bg-danger-surface" />')).toBeNull();
  });

  it('mutation check: an unrelated dark: utility does not trip this guard', () => {
    expect(findHardcodedDarkDanger('<div className="dark:bg-neutral-950 dark:border-neutral-700" />')).toBeNull();
  });
});
