/**
 * Token discipline — T-334 slice 2's guards 7-10 across all three component sources
 * (docs/tasks/334-slice-2-component-contract.md §4, §9 R2-R4).
 *
 * ⚠️ `.ts`, not `.tsx` — see `ui-button.test.ts`'s header for the full reason. This file has no
 * JSX and needs none: guards 7-10 are static checks over the component SOURCE TEXT (comments
 * stripped first, per §4's own warning), not over rendered output.
 *
 * ⛔ Each real-source check below currently PASSES against the three stubs — a stub with no
 * content has nothing to violate, so this is not expected to be red the way the behaviour cases in
 * `ui-button.test.ts` / `ui-input.test.ts` / `ui-card.test.ts` are. What proves these guards are
 * not vacuous is the paired "mutation check" beside each one: a synthetic source string built to
 * violate the rule, asserted to be caught — the process §4 itself names as mandatory ("MUTATION-
 * TEST every guard you write: break the thing on purpose, watch the test fail, put it back"),
 * done here against synthetic fixtures rather than the real files.
 *
 * ⭐ Corrected 2026-09-23 (T-334 slice 3, R5 — open audit item 1 from 2026-09-22): "the real files"
 * above means EDITING `Button.tsx` / `Input.tsx` / `Card.tsx` themselves, which stay the builder's
 * alone. It does NOT mean importing or adopting them — slice 3's entire job is wiring these three
 * files into 65 callers via `@/components/ui`, and a cold-starting slice-3 author reading the old
 * "out of scope (do-not-touch list — the builder's)" wording here could misread it as a
 * prohibition on the very thing the slice exists to do. Mutation fixtures stay synthetic either
 * way; only the framing changed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'components',
  'ui',
);
// Audit item 3: was a hardcoded three-name list. Slice 3 adds files to this directory, and a new
// component carrying a forbidden token would pass every guard silently while these test titles
// still claimed to cover "the component sources". Glob it instead.
const COMPONENT_FILES = readdirSync(COMPONENTS_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => path.join(COMPONENTS_DIR, f));

describe('Guard source list', () => {
  // ⭐ The failure mode being fixed, reintroduced one level up: a glob matching nothing makes
  // every guard below pass vacuously — nothing to violate is not the same as nothing violating.
  it('the component-sources glob is non-empty', () => {
    expect(COMPONENT_FILES.length).toBeGreaterThan(0);
  });
});

/** Strips `/* ... *\/` block comments (which also covers JSX `{/* ... *\/}` comments) and `// ...`
 *  line comments — a real scan respecting string/template boundaries, not a blind regex. §4's own
 *  trap, reproduced yesterday in this task: a guard satisfied by the prose describing it, because
 *  the only match in the file was a comment. The mirror-image trap (audit finding, item 2): a
 *  regex-only `//.*$` strips everything after the FIRST `//` on a line unconditionally, including
 *  one living inside a string — `xmlns="http://www.w3.org/2000/svg" className="bg-red-600"` would
 *  lose `className="bg-red-600"` too, hiding a real violation. A stripper that doesn't know it's
 *  inside a string is not a comment stripper, it's a `//`-onward eraser. */
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

    // mode === 'code'
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

// ---------------------------------------------------------------------------------------------
// Guard 7 — token discipline: no raw hex, no stock Tailwind hue utility (§4.7, §9 R2)
// ---------------------------------------------------------------------------------------------

const TAILWIND_DEFAULT_HUES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia',
  'pink', 'rose',
] as const;

const FORBIDDEN_HUE_RE = new RegExp(`\\b(?:${TAILWIND_DEFAULT_HUES.join('|')})-\\d{2,3}\\b`);
const HEX_LITERAL_RE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/;

function findForbiddenColorToken(source: string): string | null {
  const stripped = stripComments(source);
  return stripped.match(FORBIDDEN_HUE_RE)?.[0] ?? stripped.match(HEX_LITERAL_RE)?.[0] ?? null;
}

describe('Guard 7 — no raw hex, no stock Tailwind hue utility (§4.7, §9 R2)', () => {
  it('none of the three component sources contains a forbidden hue or hex literal', () => {
    for (const file of COMPONENT_FILES) {
      expect(findForbiddenColorToken(readFileSync(file, 'utf8')), file).toBeNull();
    }
  });

  it('mutation check: flags a forbidden hue utility', () => {
    expect(findForbiddenColorToken('<div className="bg-red-600 p-2" />')).toBe('red-600');
  });

  it('mutation check: flags a raw hex literal', () => {
    expect(findForbiddenColorToken('const c = "#d40909";')).toBe('#d40909');
  });

  it('mutation check: a forbidden token living only in a comment is NOT flagged once stripped — the exact trap named in §4', () => {
    expect(
      findForbiddenColorToken('// never use bg-red-600 here\nexport function X() { return null; }'),
    ).toBeNull();
  });

  it('mutation check: text-white is allowlisted per §9 R1 and does not trip the guard', () => {
    expect(findForbiddenColorToken('<button className="bg-brand text-white" />')).toBeNull();
  });

  it('mutation check: black/transparent/current/inherit are out of this guard\'s reach, accepted per §9 R2', () => {
    expect(
      findForbiddenColorToken(
        '<div className="bg-black border-transparent text-current fill-inherit" />',
      ),
    ).toBeNull();
  });

  it('stripComments removes block, line and JSX comments', () => {
    const src = [
      '/* header with bg-red-600 */',
      '{/* jsx comment with bg-amber-500 */}',
      'const x = 1; // trailing bg-slate-200',
    ].join('\n');
    const stripped = stripComments(src);
    expect(stripped).not.toContain('bg-red-600');
    expect(stripped).not.toContain('bg-amber-500');
    expect(stripped).not.toContain('bg-slate-200');
  });

  it('mutation check (audit item 2, missing direction): a forbidden token after "//" INSIDE A STRING survives stripping and is flagged — the http:// shape', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg" className="bg-red-600" />';
    expect(findForbiddenColorToken(src)).toBe('red-600');
  });

  it('stripComments does not treat "//" inside a string/attribute value as a comment start', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg" className="bg-red-600" />';
    const stripped = stripComments(src);
    expect(stripped).toContain('http://www.w3.org/2000/svg');
    expect(stripped).toContain('bg-red-600');
  });
});

// ---------------------------------------------------------------------------------------------
// Guard 8 — --warning never carries text (§4.8)
// ---------------------------------------------------------------------------------------------

const WARNING_TEXT_RE = /\btext-warning\b/;

function findWarningTextToken(source: string): string | null {
  return stripComments(source).match(WARNING_TEXT_RE)?.[0] ?? null;
}

describe('Guard 8 — --warning never carries text (§4.8)', () => {
  it('none of the three component sources emits text-warning', () => {
    for (const file of COMPONENT_FILES) {
      expect(findWarningTextToken(readFileSync(file, 'utf8')), file).toBeNull();
    }
  });

  it('mutation check: flags text-warning', () => {
    expect(findWarningTextToken('<span className="text-warning">Pending</span>')).toBe(
      'text-warning',
    );
  });

  it('mutation check: bg-warning (the permitted surface use) does not trip this guard', () => {
    expect(findWarningTextToken('<div className="bg-warning" />')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Guard 9 — danger is never filled (§4.9)
// ---------------------------------------------------------------------------------------------

const DANGER_FILL_RE = /\bbg-danger(?!-)\b/;

function findDangerFillToken(source: string): string | null {
  return stripComments(source).match(DANGER_FILL_RE)?.[0] ?? null;
}

describe('Guard 9 — danger is never filled (§4.9)', () => {
  it('none of the three component sources emits bg-danger as a solid fill', () => {
    for (const file of COMPONENT_FILES) {
      expect(findDangerFillToken(readFileSync(file, 'utf8')), file).toBeNull();
    }
  });

  it('mutation check: flags a literal bg-danger fill', () => {
    expect(findDangerFillToken('<button className="bg-danger text-white" />')).toBe('bg-danger');
  });

  it('mutation check: bg-danger-surface (permitted) does not trip this guard — token, not substring', () => {
    expect(findDangerFillToken('<div className="bg-danger-surface" />')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Guard 10 — no 'use client', no hooks (§9 R4, new)
// ---------------------------------------------------------------------------------------------

// Audit item 4: was an enumerated six-name list, narrower than R4's actual rule ("none uses a
// React hook"). useCallback, useId, useTransition and every other current or future hook were
// invisible to it. React's own convention IS the rule — any `useXxx(` call, whatever it's called
// or wherever it's imported from — so match the naming convention/call shape instead of a name list.
const HOOK_CALL_RE = /\buse[A-Z]\w*\s*\(/;

function findClientDirectiveOrHook(source: string): string | null {
  const stripped = stripComments(source);
  if (/['"]use client['"]/.test(stripped)) return "'use client'";
  const hookMatch = stripped.match(HOOK_CALL_RE);
  return hookMatch ? hookMatch[0].replace(/\s*\($/, '') : null;
}

describe('Guard 10 — no \'use client\', no hooks (§9 R4)', () => {
  it('none of the three component sources carries the client directive or a forbidden hook', () => {
    for (const file of COMPONENT_FILES) {
      expect(findClientDirectiveOrHook(readFileSync(file, 'utf8')), file).toBeNull();
    }
  });

  it("mutation check: flags 'use client'", () => {
    expect(findClientDirectiveOrHook("'use client';\nexport function Button() {}")).toBe(
      "'use client'",
    );
  });

  it('mutation check: flags a call to an imported hook', () => {
    expect(findClientDirectiveOrHook("import { useState } from 'react';\nuseState(0);")).toBe(
      'useState',
    );
  });

  it('mutation check (audit item 4, widened form): flags a hook OUTSIDE the old six-name list — useCallback', () => {
    expect(findClientDirectiveOrHook('const f = useCallback(() => {}, []);')).toBe('useCallback');
  });

  it('mutation check (audit item 4, widened form): flags useId, one more the old list missed', () => {
    expect(findClientDirectiveOrHook('const id = useId();')).toBe('useId');
  });

  it('mutation check: a namespace-qualified hook call is still caught — React.useState(', () => {
    expect(findClientDirectiveOrHook('const [s] = React.useState(0);')).toBe('useState');
  });

  it('mutation check: an identifier that merely starts with "use" does not trip the guard', () => {
    expect(findClientDirectiveOrHook('const useful = true;')).toBeNull();
  });

  it('mutation check: referencing a hook without calling it (e.g. passing it around) does not trip the guard', () => {
    expect(findClientDirectiveOrHook('const ref = useState;')).toBeNull();
  });
});
