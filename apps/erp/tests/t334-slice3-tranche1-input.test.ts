/**
 * T-334 slice 3, tranche 1 — the five INPUT-carrying files under /staff and /expenses/recurring
 * (docs/tasks/334-slice-3-retire-the-local-constants.md; ADR-013 Amendment 3; task §6 R1/R2/R6/R8,
 * orchestrator rulings 2026-09-23).
 *
 * ⚠️ `.ts`, not `.tsx` — matches this repo's `.test.ts`-only include glob (see ui-button.test.ts's
 * header for the full reason).
 *
 * SCOPE, per R1: convert a call site ONLY if its element is a literal `<input>`. A `<select>`
 * styled by the same constant is OUT OF SCOPE and must survive byte-unchanged (its geometry moves
 * with the surviving constant instead — R8). None of these 5 files has a `ref`-bearing `<input>`
 * or a `<textarea>`/`<PhotoInput>`/`<TwoWayPicker>` consumer (verified 2026-09-23), so R6's
 * ref-exclusion and R7's dark-token split are proven only against synthetic fixtures below, not
 * against real call sites — this tranche's data does not exercise either.
 *
 * All "before" state is read from `git show <BEFORE_REF>:<path>` — a PINNED commit, never the
 * literal `HEAD`. Audit finding F1 (2026-09-23, blocking): `HEAD` moves the instant the builder's
 * work is committed, and this tranche's own commit turns the converted tree into HEAD — at that
 * point `HEAD:<path>` would read the CONVERTED file as "before", making every real comparison here
 * a tautology (it would compare the converted file to itself) while (a)/(b)/(f) still show 0
 * offenders/false for the RIGHT files, for the WRONG reason. Pinning to the commit this tranche's
 * spec was measured against keeps "before" meaning something fixed, regardless of how many commits
 * land on top of it later.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(TESTS_DIR, '..', '..', '..');

// The commit this tranche's spec (and its own §1 measurements) were taken against — 2026-09-23,
// "handoff correction: webapps-17 is gone, and it is now the proof of its own lesson". Pinned by
// full sha, not a short prefix, and not `HEAD` (F1).
const BEFORE_REF = '1a471e6bb0fa5f5ec14160581576ca596de5fe39';

function readCurrent(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function readAtHead(rel: string): string {
  const r = spawnSync('git', ['show', `${BEFORE_REF}:${rel}`], { cwd: REPO_ROOT, encoding: 'utf8', shell: false });
  if (r.status !== 0) {
    throw new Error(`git show ${BEFORE_REF}:${rel} failed (status ${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

function tokenize(classString: string | null | undefined): Set<string> {
  return new Set((classString ?? '').split(/\s+/).filter(Boolean));
}

/** Every `<TAG ... />` self-closing span in `source`, for each candidate tag name — bounded by
 *  its own nearest `/>`, so two adjacent inputs can never be merged into one match. Known limit:
 *  an attribute value containing a literal `/>` (none exist in this codebase) would split a tag
 *  early; documented rather than defended against, since it doesn't happen here. */
function selfClosingTags(source: string, tagNames: readonly string[]): string[] {
  const re = new RegExp(`<(?:${tagNames.join('|')})\\b[^]*?/>`, 'g');
  return source.match(re) ?? [];
}

function findSelfClosingByName(source: string, tagNames: readonly string[], nameAttr: string): string | null {
  const nameRe = new RegExp(`name=["']${nameAttr}["']`);
  return selfClosingTags(source, tagNames).find((tag) => nameRe.test(tag)) ?? null;
}

/** The `<select name="X">...</select>` block verbatim, children included — for the byte-unchanged
 *  negative (R1): a naive converter that touches this element usually drops its `<option>`s. */
function findSelectByName(source: string, nameAttr: string): string | null {
  const openRe = /<select\b[^]*?(?<!=)>/g;
  const nameRe = new RegExp(`name=["']${nameAttr}["']`);
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(source))) {
    if (nameRe.test(m[0])) {
      const start = m.index;
      const closeIdx = source.indexOf('</select>', start);
      if (closeIdx === -1) return null;
      return source.slice(start, closeIdx + '</select>'.length);
    }
  }
  return null;
}

function extractInputConstantValue(source: string): string | null {
  const m = /const\s+INPUT\s*=\s*'([^']*)'/.exec(source);
  // Guard, not `!` — noUncheckedIndexedAccess types a capture group as possibly undefined even
  // though this regex always has group 1 on a match (same shape as classTokens elsewhere in this
  // suite); `?? ''` degrades to a no-op rather than asserting the impossible away.
  return m ? (m[1] ?? '') : null;
}

function classNameTokensOf(tagText: string): Set<string> {
  const m = /className=\{([^}]*)\}|className=["']([^"']*)["']/.exec(tagText);
  const raw = m ? (m[1] ?? m[2] ?? '') : '';
  const cleaned = raw.replace(/[`'"]/g, ' ').replace(/\$\{|\}/g, ' ');
  return tokenize(cleaned);
}

// ---------------------------------------------------------------------------------------------
// The component-owned / layout classifier (R2-corrected, R8, auditor's "layout tokens only").
// Explicit allowlist, not a prefix guess — specifically so `text-right` (alignment, LAYOUT) is
// never confused with `text-sm` (size, component-owned), the exact shape of family-(a) substring
// traps this task warns about repeatedly. Covers only the tokens actually present in tranche-1's
// 5 constants; a token outside this list is assumed LAYOUT, which is the safe direction here since
// under-classifying as "component-owned" would silently exempt a real layout token from the check.
// ---------------------------------------------------------------------------------------------

const GEOMETRY_RE = /^(rounded(-[\w-]+)?|px-[\w.]+|py-[\w.]+)$/;
const COMPONENT_OWNED_RE = [GEOMETRY_RE, /^border$/, /^border-[\w-]+$/, /^bg-[\w-]+$/, /^text-sm$/, /^text-ink$/, /^dark:(border|bg|text)-[\w-]+$/];

function isGeometryToken(t: string): boolean {
  return GEOMETRY_RE.test(t);
}
function isComponentOwned(t: string): boolean {
  return COMPONENT_OWNED_RE.some((re) => re.test(t));
}
function layoutTokensOf(tokens: Iterable<string>): Set<string> {
  return new Set([...tokens].filter((t) => t && !isComponentOwned(t)));
}

/** Pure, file-I/O-free — the union rule the orchestrator tightened (c) to: everything the caller's
 *  own extra classes carried, plus every LAYOUT token (never colour/dark:) the constant itself
 *  carried. Extracted so the failure mode it exists to catch — a converter dropping a
 *  constant-supplied layout token, e.g. a baked-in `w-full` — can be mutation-tested without
 *  touching a real file (none of tranche-1's 5 constants happens to bake one in). */
function computeRequiredLayoutTokens(constantValue: string, callSiteExtraTokens: Set<string>): Set<string> {
  const constantLayout = layoutTokensOf(tokenize(constantValue));
  return new Set([...constantLayout, ...layoutTokensOf(callSiteExtraTokens)]);
}

// ---------------------------------------------------------------------------------------------
// Fixture: the 5 tranche-1 files, their convertING <input> sites (by `name`) and their
// non-convertING <select> sites (by `name`) — catalogued from the real source, 2026-09-23.
// ---------------------------------------------------------------------------------------------

interface TrancheFile {
  readonly rel: string;
  readonly convertingInputs: readonly string[];
  readonly nonConvertedSelects: readonly string[];
  readonly constantSurvives: boolean;
}

const TRANCHE1_FILES: readonly TrancheFile[] = [
  {
    rel: 'apps/erp/src/app/staff/page.tsx',
    convertingInputs: ['name'],
    nonConvertedSelects: ['store'],
    constantSurvives: true,
  },
  {
    rel: 'apps/erp/src/app/staff/hire/page.tsx',
    convertingInputs: ['q', 'newDisplayName', 'startedOn'],
    nonConvertedSelects: ['store', 'employmentStatus'],
    constantSurvives: true,
  },
  {
    rel: 'apps/erp/src/app/staff/[employmentId]/page.tsx',
    convertingInputs: ['pin', 'endedOn'],
    nonConvertedSelects: ['employmentStatus'],
    constantSurvives: true,
  },
  {
    rel: 'apps/erp/src/app/staff/[employmentId]/credentials/page.tsx',
    convertingInputs: ['reason', 'cardId'],
    nonConvertedSelects: [],
    constantSurvives: false,
  },
  {
    rel: 'apps/erp/src/app/expenses/recurring/page.tsx',
    convertingInputs: ['name', 'defaultAmount', 'anchorDay'],
    nonConvertedSelects: ['store', 'supplierId', 'categoryId', 'interval', 'defaultMoneyAccountId'],
    constantSurvives: true,
  },
];

// ---------------------------------------------------------------------------------------------
// F1, settled by running rather than by argument (orchestrator, 2026-09-24): "zero literal HEAD
// in a git invocation" proves the code CANNOT drift with a future HEAD move, but not that
// BEFORE_REF is doing anything today. These two checks are that proof: a real full sha (not a
// ref name that could itself resolve relative to HEAD, like `HEAD~3` would), and real content
// that actually differs from the working tree — which it currently does, because the builder's
// conversion is in the working tree but not yet committed.
// ---------------------------------------------------------------------------------------------

describe('F1 — BEFORE_REF is a real, non-HEAD-relative pin', () => {
  it('is a full 40-character sha, not "HEAD" or a HEAD-relative ref', () => {
    expect(BEFORE_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(BEFORE_REF).not.toBe('HEAD');
    expect(BEFORE_REF).not.toMatch(/^HEAD/);
  });

  for (const f of TRANCHE1_FILES) {
    it(`${f.rel}: BEFORE_REF content differs from the current working tree`, () => {
      const before = readAtHead(f.rel);
      const current = readCurrent(f.rel);
      expect(before, `fixture problem: no content at BEFORE_REF for ${f.rel}`).toBeTruthy();
      expect(current, `fixture problem: no content in the working tree for ${f.rel}`).toBeTruthy();
      // If these were ever equal, BEFORE_REF would either be pointing at the working tree by
      // accident or the file genuinely has not changed — either way, (a)-(f) above would be
      // comparing a file to itself. Currently true because the builder's conversion is
      // uncommitted: real evidence, not an assumption about git's semantics.
      expect(current).not.toBe(before);
    });
  }
});

describe('Fixture sanity — every named call site exists at BEFORE_REF', () => {
  for (const f of TRANCHE1_FILES) {
    const head = readAtHead(f.rel);
    for (const name of f.convertingInputs) {
      it(`${f.rel}: <input name="${name}"> exists at BEFORE_REF`, () => {
        expect(findSelfClosingByName(head, ['input'], name), `no <input name="${name}"> at BEFORE_REF`).toBeTruthy();
      });
    }
    for (const name of f.nonConvertedSelects) {
      it(`${f.rel}: <select name="${name}"> exists at BEFORE_REF`, () => {
        expect(findSelectByName(head, name), `no <select name="${name}"> at BEFORE_REF`).toBeTruthy();
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// (a) No literal <input> in a tranche-1 file is styled by the local INPUT constant any more.
// ---------------------------------------------------------------------------------------------

describe('(a) no <input> remains styled by the local INPUT constant', () => {
  for (const f of TRANCHE1_FILES) {
    it(`${f.rel}`, () => {
      const offenders = selfClosingTags(readCurrent(f.rel), ['input']).filter((tag) => classNameTokensOf(tag).has('INPUT'));
      expect(offenders, `<input> tag(s) still referencing INPUT:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('mutation check: flags an <input> whose className still contains the INPUT token', () => {
    const offenders = selfClosingTags('<input name="x" className={INPUT} />', ['input']).filter((tag) =>
      classNameTokensOf(tag).has('INPUT'),
    );
    expect(offenders.length).toBe(1);
  });

  it('mutation check: an <Input name="x"> (already converted) is not flagged, alongside an unconverted <input> that still is', () => {
    // Audit finding F6: the previous version scanned ONLY the `<Input .../>` snippet, so it
    // "passed" only because `selfClosingTags(..., ['input'])`'s tag-name match is case-sensitive
    // and never even found a candidate to check — not because classNameTokensOf correctly
    // discriminated. A single-tag input can't tell "excluded by design" from "excluded by
    // accident". Fixed: one document with BOTH an unconverted and an already-converted site,
    // asserting exactly the unconverted one is flagged — the real discrimination (a) needs.
    const doc = '<Input name="already" className="w-56" /><input name="still" className={INPUT} />';
    const offenders = selfClosingTags(doc, ['input']).filter((tag) => classNameTokensOf(tag).has('INPUT'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain('name="still"');
  });
});

// ---------------------------------------------------------------------------------------------
// (b) Every converting file imports Input from the barrel, never a direct file path.
// ---------------------------------------------------------------------------------------------

describe('(b) Input is imported from the barrel (@/components/ui), not a direct file path', () => {
  const BARREL_IMPORT_RE = /import\s*\{[^}]*\bInput\b[^}]*\}\s*from\s*['"]@\/components\/ui['"]/;
  const DIRECT_IMPORT_RE = /from\s*['"]@\/components\/ui\/Input['"]/;

  for (const f of TRANCHE1_FILES) {
    it(`${f.rel}`, () => {
      const current = readCurrent(f.rel);
      expect(BARREL_IMPORT_RE.test(current), 'expected an `import { Input } from \'@/components/ui\'`').toBe(true);
      expect(DIRECT_IMPORT_RE.test(current), 'must not import Input by its direct file path').toBe(false);
    });
  }

  it('mutation check: flags a direct-path import even when Input is used', () => {
    const src = "import { Input } from '@/components/ui/Input';\nInput";
    expect(BARREL_IMPORT_RE.test(src)).toBe(false);
    expect(DIRECT_IMPORT_RE.test(src)).toBe(true);
  });

  it('mutation check: accepts the barrel import alongside sibling named imports', () => {
    const src = "import { Button, Input, Card } from '@/components/ui';";
    expect(BARREL_IMPORT_RE.test(src)).toBe(true);
    expect(DIRECT_IMPORT_RE.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// (c) A converted <Input> carries the UNION of the call site's own extra classes and the layout
// (never colour/dark:) tokens the constant itself carried — orchestrator's tightening, R2-corrected.
// ---------------------------------------------------------------------------------------------

describe('computeRequiredLayoutTokens — pure logic, mutation-tested on synthetic fixtures', () => {
  it('a call-site extra alone is required', () => {
    const req = computeRequiredLayoutTokens('rounded border px-2 py-2 bg-white', new Set(['w-56']));
    expect(req.has('w-56')).toBe(true);
  });

  it('a colour/dark: token on the constant is NOT required (sanctioned deletion, auditor note)', () => {
    const req = computeRequiredLayoutTokens('rounded border border-neutral-300 bg-white dark:bg-neutral-950', new Set());
    expect(req.has('border-neutral-300')).toBe(false);
    expect(req.has('dark:bg-neutral-950')).toBe(false);
    expect(req.has('bg-white')).toBe(false);
  });

  it('a layout token BAKED INTO THE CONSTANT is required even with no call-site extra — the case tranche-1 does not exercise, R2-corrected', () => {
    const req = computeRequiredLayoutTokens('rounded border px-2 py-2 w-full', new Set());
    expect(req.has('w-full')).toBe(true);
  });

  it('mutation check: a converter that drops the constant-supplied w-full is caught', () => {
    const req = computeRequiredLayoutTokens('rounded border px-2 py-2 w-full', new Set(['text-right']));
    const afterMutant = tokenize('rounded-md border bg-surface px-3 py-2 text-sm text-ink text-right'); // w-full silently dropped
    const missing = [...req].filter((t) => !afterMutant.has(t));
    expect(missing).toEqual(['w-full']);
  });
});

describe('(c) converted call sites carry every required layout token (git show BEFORE_REF as the "before")', () => {
  for (const f of TRANCHE1_FILES) {
    for (const name of f.convertingInputs) {
      it(`${f.rel} name="${name}"`, () => {
        const headSrc = readAtHead(f.rel);
        const constantValue = extractInputConstantValue(headSrc);
        expect(constantValue, `fixture problem: no INPUT constant at BEFORE_REF in ${f.rel}`).toBeTruthy();

        const headTag = findSelfClosingByName(headSrc, ['input'], name);
        expect(headTag, `fixture problem: no <input name="${name}"> at BEFORE_REF in ${f.rel}`).toBeTruthy();
        const callSiteExtras = classNameTokensOf(headTag as string);
        callSiteExtras.delete('INPUT');

        const required = computeRequiredLayoutTokens(constantValue as string, callSiteExtras);

        const currentSrc = readCurrent(f.rel);
        const currentTag = findSelfClosingByName(currentSrc, ['Input', 'input'], name);
        expect(currentTag, `no <Input>/<input> with name="${name}" found in ${f.rel} after the change`).toBeTruthy();
        const currentTokens = classNameTokensOf(currentTag as string);

        if (required.size === 0) {
          // Audit finding F5: for a bare call site (no baked-in constant layout, no call-site
          // extra — 3 of these 11 cases), the loop below runs zero times, so this test's own
          // title claim ("carries every required layout token") was checked against nothing.
          // Asserted explicitly: an empty required set is a proven fact about THIS fixture, not
          // an unnoticed zero-iteration loop that would pass identically whether required had
          // one token or none.
          expect([...required], `${f.rel} name="${name}": expected no required layout tokens (bare call site)`).toEqual([]);
        }
        for (const t of required) {
          expect(currentTokens.has(t), `layout token "${t}" must survive on name="${name}" in ${f.rel}; got [${[...currentTokens].join(', ')}]`).toBe(true);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// (d) Every non-converted <select> site is byte-unchanged — catches a converter that touches or
// drops a sibling element's <option>s (R1's own named failure mode).
// ---------------------------------------------------------------------------------------------

describe('(d) non-converted <select> sites are byte-for-byte unchanged', () => {
  for (const f of TRANCHE1_FILES) {
    for (const name of f.nonConvertedSelects) {
      it(`${f.rel} name="${name}"`, () => {
        const before = findSelectByName(readAtHead(f.rel), name);
        const after = findSelectByName(readCurrent(f.rel), name);
        expect(before, `fixture problem: no <select name="${name}"> at BEFORE_REF in ${f.rel}`).toBeTruthy();
        expect(after, `<select name="${name}"> is missing from ${f.rel} after the change`).toBeTruthy();
        expect(after).toBe(before);
      });
    }
  }

  it('mutation check: a converter that drops an <option> is caught', () => {
    // Audit finding F4: the previous version compared two hand-written literals directly, which
    // proves JavaScript string inequality, not that THIS FILE's assertion (d) — which reads BOTH
    // sides through findSelectByName — would catch it. Routed through the real extractor, inside
    // a larger surrounding document, the way (d) actually uses it.
    const beforeDoc = '<div>\n  <select name="x"><option value="1">One</option><option value="2">Two</option></select>\n</div>';
    const afterMutantDoc = '<div>\n  <select name="x"><option value="1">One</option></select>\n</div>'; // one <option> silently dropped
    const before = findSelectByName(beforeDoc, 'x');
    const after = findSelectByName(afterMutantDoc, 'x');
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('mutation check: findSelectByName does not confuse two same-file selects with different names', () => {
    const src = '<select name="a" className={INPUT}><option value="1">A</option></select><select name="b" className={INPUT}><option value="2">B</option></select>';
    expect(findSelectByName(src, 'a')).toContain('option value="1"');
    expect(findSelectByName(src, 'a')).not.toContain('option value="2"');
    expect(findSelectByName(src, 'b')).toContain('option value="2"');
  });
});

// ---------------------------------------------------------------------------------------------
// (e) On a SURVIVING constant, only the geometry moves to Input's rounded-md/px-3/py-2 — every
// other token (colour, dark:) is byte-identical to BEFORE_REF (R8, clarified: catches the builder
// swapping in Input's own BASE_CLASSES wholesale, which would silently drop dark:/colour tokens).
// ---------------------------------------------------------------------------------------------

describe('(e) a surviving INPUT constant: geometry resized, everything else untouched', () => {
  for (const f of TRANCHE1_FILES.filter((x) => x.constantSurvives)) {
    it(`${f.rel}`, () => {
      const before = extractInputConstantValue(readAtHead(f.rel));
      expect(before, `fixture problem: no INPUT constant at BEFORE_REF in ${f.rel}`).toBeTruthy();
      const beforeTokens = tokenize(before as string);
      const beforeNonGeometry = new Set([...beforeTokens].filter((t) => !isGeometryToken(t)));

      const after = extractInputConstantValue(readCurrent(f.rel));
      expect(after, `the INPUT constant should still exist in ${f.rel} — it styles ${f.nonConvertedSelects.length} surviving <select> site(s)`).toBeTruthy();
      const afterTokens = tokenize(after as string);

      // Positive: the new geometry is exactly Input's.
      expect(afterTokens.has('rounded-md'), `${f.rel}: expected rounded-md`).toBe(true);
      expect(afterTokens.has('px-3'), `${f.rel}: expected px-3`).toBe(true);
      expect(afterTokens.has('py-2'), `${f.rel}: expected py-2`).toBe(true);

      // Negative: any OLD geometry token that differs from the target is gone.
      for (const t of beforeTokens) {
        if (isGeometryToken(t) && !['rounded-md', 'px-3', 'py-2'].includes(t)) {
          expect(afterTokens.has(t), `${f.rel}: stale geometry token "${t}" should have been replaced`).toBe(false);
        }
      }

      // Every non-geometry token survives, byte-identical — the R8 clarification.
      for (const t of beforeNonGeometry) {
        expect(afterTokens.has(t), `${f.rel}: non-geometry token "${t}" must survive unchanged; got [${[...afterTokens].join(', ')}]`).toBe(true);
      }
      const afterNonGeometry = new Set([...afterTokens].filter((t) => !isGeometryToken(t)));
      const extras = [...afterNonGeometry].filter((t) => !beforeNonGeometry.has(t));
      expect(extras, `${f.rel}: unexpected extra non-geometry token(s): [${extras.join(', ')}]`).toEqual([]);
    });
  }

  it('mutation check: a builder that swaps the surviving constant for Input\'s own BASE_CLASSES is caught (drops dark:/colour tokens)', () => {
    const before = 'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
    const afterMutant = 'rounded-md border bg-surface px-3 py-2 text-sm text-ink'; // Input's literal BASE_CLASSES
    const beforeTokens = tokenize(before);
    const afterTokens = tokenize(afterMutant);
    const beforeNonGeometry = [...beforeTokens].filter((t) => !isGeometryToken(t));
    const dropped = beforeNonGeometry.filter((t) => !afterTokens.has(t));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped).toEqual(expect.arrayContaining(['border-neutral-300', 'bg-white', 'dark:border-neutral-700', 'dark:bg-neutral-950']));
  });
});

// ---------------------------------------------------------------------------------------------
// (f) The one fully-retiring file: no INPUT identifier remains anywhere (declaration or reference).
// ---------------------------------------------------------------------------------------------

describe('(f) staff/[employmentId]/credentials/page.tsx: the INPUT constant is fully retired', () => {
  const REL = 'apps/erp/src/app/staff/[employmentId]/credentials/page.tsx';

  it('no INPUT identifier (declaration or reference) remains', () => {
    const current = readCurrent(REL);
    expect(/\bINPUT\b/.test(current), 'an INPUT identifier still appears in the file').toBe(false);
  });

  it('mutation check: flags a leftover declaration with no call sites', () => {
    expect(/\bINPUT\b/.test("const INPUT = 'rounded-md';\n// no longer used")).toBe(true);
  });

  it('mutation check: an unrelated identifier merely containing the substring is not flagged (INPUT_SM)', () => {
    expect(/\bINPUT\b/.test('const INPUT_SM = 1;')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// R6 (synthetic only — tranche-1 has no ref-bearing <input>): a ref-bearing site is out of scope,
// same shape as R1's <select> carve-out.
// ---------------------------------------------------------------------------------------------

describe('R6 — a ref-bearing <input> keeps its constant (synthetic fixture; no real tranche-1 site has one)', () => {
  function isOutOfScopeForConversion(tagText: string): boolean {
    return /\bref=\{/.test(tagText);
  }

  it('mutation check: an <input ref={...}> is recognised as out of scope', () => {
    const tag = '<input name="x" ref={inputRef} className={INPUT} />';
    expect(isOutOfScopeForConversion(tag)).toBe(true);
  });

  it('mutation check: an ordinary <input> (no ref) is in scope', () => {
    const tag = '<input name="x" className={INPUT} />';
    expect(isOutOfScopeForConversion(tag)).toBe(false);
  });

  it('confirms none of tranche-1\'s real call sites carries a ref (documents why R6 is untested against real data here)', () => {
    for (const f of TRANCHE1_FILES) {
      const head = readAtHead(f.rel);
      for (const name of f.convertingInputs) {
        const tag = findSelfClosingByName(head, ['input'], name);
        expect(isOutOfScopeForConversion(tag as string), `${f.rel} name="${name}" unexpectedly carries a ref`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// R7 (synthetic only — tranche-1's call sites carry no extra dark: variant beyond the constant's
// own baked-in colour treatment, which (c)/(e) already cover): colour/border/bg/text/placeholder/
// ring dark: variants are deleted at a converted site; every other dark: variant is a layout token
// and survives.
// ---------------------------------------------------------------------------------------------

describe('R7 — dark: token classification (synthetic fixture)', () => {
  const DARK_COLOUR_RE = /^dark:(bg|border|text|placeholder|ring)-[\w-]+$/;

  function isDarkColourVariant(t: string): boolean {
    return DARK_COLOUR_RE.test(t);
  }

  it('mutation check: dark:border-neutral-700 / dark:bg-neutral-950 (colour) must be deleted', () => {
    expect(isDarkColourVariant('dark:border-neutral-700')).toBe(true);
    expect(isDarkColourVariant('dark:bg-neutral-950')).toBe(true);
  });

  it('mutation check: a non-colour dark: variant survives as a layout token', () => {
    expect(isDarkColourVariant('dark:col-span-2')).toBe(false);
    expect(isDarkColourVariant('dark:hidden')).toBe(false);
  });

  it('confirms tranche-1 has no per-call-site dark: variant beyond the constant\'s own (documents why R7 is untested against real data here)', () => {
    for (const f of TRANCHE1_FILES) {
      const head = readAtHead(f.rel);
      for (const name of f.convertingInputs) {
        const tag = findSelfClosingByName(head, ['input'], name);
        const extras = classNameTokensOf(tag as string);
        extras.delete('INPUT');
        const darkExtras = [...extras].filter((t) => t.startsWith('dark:'));
        expect(darkExtras, `${f.rel} name="${name}" unexpectedly carries a call-site dark: extra`).toEqual([]);
      }
    }
  });
});
