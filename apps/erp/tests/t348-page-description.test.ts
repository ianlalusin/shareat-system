import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ⚠️ This file is `.ts`, not `.tsx` (the spec's own filename) — no literal JSX. Every element is
// built with `createElement`, matching the existing convention in this test directory (e.g.
// `t349-hold-own-right-page.test.ts` calls the real page function and renders its RETURNED
// element; no `.test.ts` file here writes `<Foo>` syntax directly).

/**
 * T-348 S1 (DEF-474) — the `PageDescription` component. `docs/tasks/348-def-440-two-column-page-width.md` §S1.
 *
 * ⛔ TESTER, not BUILDER. Every leg below is RED today because
 * `apps/erp/src/components/shell/PageDescription.tsx` does not exist yet (the right reason —
 * typecheck is red in this file only, by design, until the builder lands it).
 *
 * ⭐ STATIC vs SCREEN split (Ian's instruction on this draft): everything in this file is a STATIC
 * check — `renderToStaticMarkup` (no hooks lifecycle beyond the synchronous render pass), a pure
 * function, or a source-text scan. None of it can prove the INTERACTIVE behaviour: whether the
 * control actually shows only on real overflow at a given viewport width, whether a click really
 * flips `aria-expanded` and removes the clamp in a live DOM, whether `ResizeObserver` reinstates the
 * control on narrowing, whether focusing a hidden link really expands the paragraph, dark-mode
 * legibility, or the absence of a hydration warning. Those are the spec's own "Smoketest (tester,
 * 9008, after the builder)" list (§S1) and belong there, not here — see the smoketest report, not
 * this file, for R1's real-machine confirmation of the numbers R1 only checks arithmetically.
 */

const SRC = resolve(__dirname, '../src/components/shell/PageDescription.tsx');

// =================================================================================================
// R1 — exceedsLines(scrollHeight, lineHeightPx, lines = 3): STATIC (pure function).
// =================================================================================================

describe('R1 — exceedsLines: STATIC, a pure function', () => {
  it.each([
    [60, 20, false, 'exactly 3 lines, no overflow'],
    [61, 20, false, '≤1px rounding tolerance — was red today: module does not exist'],
    [62, 20, true, '1px past tolerance — overflows'],
    [200, 20, true, 'far past — overflows'],
    [59.5, 19.5, false, 'sub-pixel line height, still within 3 lines'],
  ] as const)('exceedsLines(%s, %s) -> %s (%s)', async (scrollHeight, lineHeightPx, expected, why) => {
    const { exceedsLines } = await import('../src/components/shell/PageDescription');
    expect(exceedsLines(scrollHeight, lineHeightPx), why).toBe(expected);
  });
});

// =================================================================================================
// R2 — server render is clamped, no control. STATIC (renderToStaticMarkup).
// =================================================================================================

describe('R2 — server render: one clamped <p>, no button — STATIC', () => {
  it('exactly one <p> carrying line-clamp-3/text-sm/text-neutral-600/dark:text-neutral-400, no max-w-, markup preserved, no <button — was red today: module does not exist', async () => {
    const { PageDescription } = await import('../src/components/shell/PageDescription');
    const html = renderToStaticMarkup(
      createElement(PageDescription, null, 'A'.repeat(180), createElement('strong', null, 'x'), 'B'.repeat(180)),
    );

    const pMatches = html.match(/<p\b[^>]*>/g) ?? [];
    expect(pMatches.length, `expected exactly one <p>, got: ${html}`).toBe(1);
    const pTag = pMatches[0]!;
    for (const cls of ['line-clamp-3', 'text-sm', 'text-neutral-600', 'dark:text-neutral-400']) {
      expect(pTag, `<p> tag was: ${pTag}`).toContain(cls);
    }
    expect(pTag).not.toContain('max-w-');
    expect(html).toContain('<strong>x</strong>');
    expect(html).not.toContain('<button');
  });

  it('positive control: the max-w- absence check would catch it if present (sanity on the check itself, not the component)', () => {
    expect('<p class="text-sm max-w-2xl">').toContain('max-w-');
  });

  it('positive control: the <button absence check would catch it if present', () => {
    expect('<p><button type="button">x</button></p>').toContain('<button');
  });
});

// =================================================================================================
// R3 — className="mt-1" (spacing only) reaches the <p>. STATIC (renderToStaticMarkup).
// =================================================================================================

describe('R3 — className is spacing-only and lands on the <p> — STATIC', () => {
  it('className="mt-1" appears on the rendered <p> — was red today: module does not exist', async () => {
    const { PageDescription } = await import('../src/components/shell/PageDescription');
    const html = renderToStaticMarkup(
      createElement(PageDescription, { className: 'mt-1', children: 'Some description' }),
    );
    const pTag = html.match(/<p\b[^>]*>/)?.[0] ?? '';
    expect(pTag, `<p> tag was: ${pTag}`).toContain('mt-1');
  });
});

// =================================================================================================
// R4 — PageHeader delegates to PageDescription; its text column is min-w-0 flex-1. STATIC.
// =================================================================================================

describe('R4 — PageHeader renders through PageDescription, text column is flex-1 — STATIC', () => {
  it('renderToStaticMarkup(<PageHeader title="T" description="D" />) contains line-clamp-3 and a flex-1 text column — was red today: a plain <p>, no flex-1', async () => {
    const { PageHeader } = await import('../src/components/shell/Page');
    const html = renderToStaticMarkup(createElement(PageHeader, { title: 'T', description: 'D' }));
    expect(html).toContain('line-clamp-3');
    // The text column is the div wrapping <h1>+description; item 7 makes it `min-w-0 flex-1`.
    const textColumnMatch = html.match(/<div[^>]*min-w-0[^>]*>/);
    expect(textColumnMatch, `html was: ${html}`).not.toBeNull();
    expect(textColumnMatch![0]).toContain('flex-1');
  });

  it('positive control: the flex-1 check correctly reports absent on the PRE-FIX shape (today\'s committed `<div className="min-w-0">`, no flex-1) — proves the check discriminates, not a tautology that would pass on either shape', () => {
    const preFixHtml = renderToStaticMarkup(
      createElement(
        'div',
        { className: 'flex flex-wrap items-start justify-between gap-x-4 gap-y-2' },
        createElement(
          'div',
          { className: 'min-w-0' },
          createElement('h1', { className: 'text-2xl font-semibold' }, 'T'),
          createElement('p', { className: 'mt-1 text-sm text-neutral-600 dark:text-neutral-400' }, 'D'),
        ),
      ),
    );
    const textColumnMatch = preFixHtml.match(/<div[^>]*min-w-0[^>]*>/);
    expect(textColumnMatch, `html was: ${preFixHtml}`).not.toBeNull();
    expect(textColumnMatch![0]).not.toContain('flex-1');
  });
});

// =================================================================================================
// R5 — code-only scan of PageDescription.tsx (comments stripped where noted). STATIC (source text).
// =================================================================================================

/** Copied from apps/erp/tests/ui-token-discipline.test.ts's own `stripComments` (not exported there)
 * — a real tokenizer (code/string/template/line-comment/block-comment), not a `//`-onward regex
 * eraser, so a token living only in a comment is correctly excluded and a token living inside a
 * string/template literal is correctly kept. */
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

describe('R5 — PageDescription.tsx source contains the required mechanics — STATIC', () => {
  it("'use client' is the literal first line of the RAW file (checked unstripped — Next.js requires the directive to be the file's actual first line; a stripped/collapsed check could pass a file where a leading comment defeats the directive in practice) — was red today: file does not exist", () => {
    const raw = readFileSync(SRC, 'utf8');
    const firstLine = raw.split(/\r?\n/, 1)[0]!.trim();
    expect(firstLine).toMatch(/^['"]use client['"];?$/);
  });

  it('contains aria-expanded, aria-controls, ResizeObserver, .disconnect(, min-h-11, min-w-11, focus-visible:, onFocus — comments stripped, so a token living only in a comment does not count', () => {
    const stripped = stripComments(readFileSync(SRC, 'utf8'));
    for (const token of [
      'aria-expanded',
      'aria-controls',
      'ResizeObserver',
      '.disconnect(',
      'min-h-11',
      'min-w-11',
      'focus-visible:',
      'onFocus',
    ]) {
      expect(stripped, `missing token: ${token}`).toContain(token);
    }
  });

  it('positive control: a token living only in a comment is correctly NOT counted (the exact trap §5/R5 exists to avoid)', () => {
    const stripped = stripComments('// aria-expanded mentioned here only\nexport function X() { return null; }');
    expect(stripped).not.toContain('aria-expanded');
  });
});

// =================================================================================================
// F3 (audit) — definition-side legs: the mechanics live IN the right function bodies, not merely
// "somewhere in the file" (R5 only proves the tokens exist anywhere). STATIC (source text, balanced-
// brace extraction on comment-stripped source, same tokenizer as R5's stripComments).
// =================================================================================================

/**
 * Extract a balanced `{ ... }` block starting at the first `{` at or after `fromIndex` in `source`.
 * `source` must already be comment-stripped (stripComments) so a `{`/`}` inside a comment cannot
 * throw off the depth count; this function additionally skips braces inside string/template
 * literals so an object-shaped string like `'{'` cannot either.
 */
function extractBalancedBlock(source: string, fromIndex: number): string {
  const start = source.indexOf('{', fromIndex);
  if (start === -1) throw new Error(`no opening brace found at/after index ${fromIndex}`);
  let depth = 0;
  let mode: 'code' | 'single' | 'double' | 'template' = 'code';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (mode !== 'code') {
      const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) mode = 'code';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      mode = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces — extraction ran off the end of the source');
}

describe('F3 (audit) — the effect body calls observer.observe(p); handleFocus\'s body sets expanded — STATIC', () => {
  it("the useIsomorphicLayoutEffect callback's OWN body (not just 'somewhere in the file') calls observer.observe(p)", () => {
    const stripped = stripComments(readFileSync(SRC, 'utf8'));
    const anchor = stripped.indexOf('useIsomorphicLayoutEffect(() =>');
    expect(anchor, `anchor 'useIsomorphicLayoutEffect(() =>' not found in source`).toBeGreaterThan(-1);
    const body = extractBalancedBlock(stripped, anchor);
    expect(body, `effect body was: ${body}`).toContain('observer.observe(p)');
  });

  it('positive control: a mutant effect body missing .observe( is correctly caught (sanity on the extraction+check, not the real file)', () => {
    const fakeSrc = stripComments(`
      useIsomorphicLayoutEffect(() => {
        const p = pRef.current;
        if (!p) return;
        const observer = new ResizeObserver(measure);
        return () => observer.disconnect();
      }, []);
    `);
    const anchor = fakeSrc.indexOf('useIsomorphicLayoutEffect(() =>');
    const body = extractBalancedBlock(fakeSrc, anchor);
    expect(body).not.toContain('observer.observe(p)');
  });

  it("the handleFocus arrow function's OWN body (not just 'somewhere in the file') sets expanded: true via setState", () => {
    const stripped = stripComments(readFileSync(SRC, 'utf8'));
    const anchor = stripped.indexOf('const handleFocus =');
    expect(anchor, `anchor 'const handleFocus =' not found in source`).toBeGreaterThan(-1);
    // handleFocus's parameter list has no braces (`(event: FocusEvent<HTMLParagraphElement>)`), so
    // the first `{` on/after the arrow `=>` is the function body's own opening brace, not a type.
    const arrowIndex = stripped.indexOf('=>', anchor);
    expect(arrowIndex, `'=>' not found after the handleFocus anchor`).toBeGreaterThan(-1);
    const body = extractBalancedBlock(stripped, arrowIndex);
    expect(body, `handleFocus body was: ${body}`).toMatch(/setState\(/);
    expect(body, `handleFocus body was: ${body}`).toContain('expanded: true');
  });

  it('positive control: a mutant handleFocus body that never sets expanded is correctly caught', () => {
    const fakeSrc = stripComments(`
      const handleFocus = (event: FocusEvent<HTMLParagraphElement>) => {
        if (expanded) return;
        const p = pRef.current;
        if (!p) return;
        console.log('focused but does nothing');
      };
    `);
    const anchor = fakeSrc.indexOf('const handleFocus =');
    const arrowIndex = fakeSrc.indexOf('=>', anchor);
    const body = extractBalancedBlock(fakeSrc, arrowIndex);
    expect(body).not.toContain('expanded: true');
  });
});

// =================================================================================================
// R6 — OPAQUE_COMPONENTS never lists 'PageDescription' (pins item 8). GREEN TODAY (real file, no
// dependency on the not-yet-existing component) — STATIC.
// =================================================================================================

describe("R6 (⛔ guard, green today and must stay green) — OPAQUE_COMPONENTS never contains 'PageDescription'", () => {
  it('touch-target-geometry.ts\'s source does not list PageDescription as opaque — adding it would turn 102 call sites into 102 UNRESOLVED (item 8)', () => {
    const geometrySrc = readFileSync(resolve(__dirname, 'touch-target-geometry.ts'), 'utf8');
    const setMatch = geometrySrc.match(/OPAQUE_COMPONENTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(setMatch, 'could not find OPAQUE_COMPONENTS literal — the check itself is broken').not.toBeNull();
    expect(setMatch![1]).not.toContain('PageDescription');
  });

  it('positive control: the check would catch it if someone added it (sanity on the check, not the file)', () => {
    const fakeSrc = "const OPAQUE_COMPONENTS = new Set(['TokenReveal', 'SidebarNav', 'PageDescription']);";
    const setMatch = fakeSrc.match(/OPAQUE_COMPONENTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(setMatch![1]).toContain('PageDescription');
  });
});
