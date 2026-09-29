/**
 * T-348 S3 (DEF-440), Amendment A3 (2026-09-30) — the eight two-column pages' MAIN return
 * switches `<Page density="form">` to `density="table">`; content unchanged (fields stretch).
 * A3 supersedes S3 items 1-2 and drops P3 (the W3 grid leg): no `lg:grid-cols-2` assertion here.
 * The three named early-return branches (a heading + one-line message, no form content) are
 * exempt and stay "form" (P2).
 *
 * Auditor pass (2026-09-30), folded in before RED went GREEN:
 * - Comments stripped before scanning (`codeOnly`, mirrored from tests/unit/page-container.test.ts:73
 *   — not exported from a .test.ts, so mirrored rather than imported). DetailLayout.tsx:10's OWN
 *   docstring literally reads `Goes INSIDE <Page density="table">`; an unstripped scan would let a
 *   comment like that mask a regressed main return as a false green.
 * - `<Page` matched across line breaks, not per-line — admin/prerequisite-refusals/page.tsx:22-23
 *   already writes `density` on the line after `<Page`, and a builder reformat of any of the eight
 *   could do the same, silently blinding a per-line regex.
 * - P2 no longer pins line numbers (this spec's own history: 39/41 in the original S3 text,
 *   corrected to 40/42 in Amendment A3) — it asserts by POSITION (first occurrence = the guard
 *   clause) instead, so the next line shift can't desync it.
 * - P0 is a literal string fixture, not a live page, so it never depends on any file staying as it
 *   is today; it exercises the comment-strip and multi-line match together.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', 'src', 'app');

/**
 * Mirrors tests/unit/page-container.test.ts:73's `codeOnly` (not exported from that .test.ts, so
 * mirrored here rather than imported). CRLF-normalised, `/* *\/` and `//` stripped, so a density
 * spelt out in a doc comment (DetailLayout.tsx:10) can never be read as a real `<Page>` site.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Every `<Page density="...">` open tag, in source order, on comment-stripped text. Matched with
 * `[\s\S]*?` between `<Page` and `density=` (not line by line) so a wrapped tag — `<Page` and
 * `density="..."` on different lines — is still found.
 */
function findPageDensities(source: string): string[] {
  const clean = codeOnly(source);
  const re = /<Page[\s\S]*?density="(\w+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out.push(m[1]!);
  return out;
}

function densitiesOf(rel: string): string[] {
  return findPageDensities(readFileSync(resolve(appRoot, rel), 'utf8'));
}

// main return's <Page> = the LAST one in source order: the early-return guard clauses in this
// codebase always precede the page's real content (verified at source for all three below).
function mainDensity(rel: string): string {
  const hits = densitiesOf(rel);
  if (hits.length === 0) throw new Error(`${rel}: no <Page density=...> found`);
  return hits[hits.length - 1]!;
}

// Task doc §S3 item 1 / Amendment A3 item 1 — the eight pages.
const EIGHT = [
  'admin/stores/[id]/page.tsx',
  'admin/users/[personId]/page.tsx',
  'cutover/opening/page.tsx',
  'expenses/new/page.tsx',
  'fixed-assets/new/page.tsx',
  'settings/attendance/page.tsx',
  'settings/page.tsx',
  'staff/hire/page.tsx',
] as const;

// The three of the eight with an early-return guard clause (Amendment A3 item 1) — named, not
// pinned by line: a scan keyed on the FIRST <Page density=...> in the file survives the next line
// shift, which is exactly what happened to this spec's own 39/41 -> 40/42 correction.
const TWO_WRAPPER_FILES = [
  'admin/stores/[id]/page.tsx',
  'settings/attendance/page.tsx',
  'staff/hire/page.tsx',
] as const;

describe('T-348 S3 (DEF-440) — P0 positive control (literal fixture, no live page)', () => {
  it('reads "form" off an early return and "table" off a wrapped main return; a comment decoy contributes nothing', () => {
    const fixture = `
      export default function Page() {
        // a decoy: this text must never be read as a real occurrence
        // <Page density="table">
        if (!ready) {
          return (
            <Page density="form" className="space-y-4">
              <h1>Guard</h1>
            </Page>
          );
        }
        return (
          <Page
            density="table"
          >
            <h1>Real</h1>
          </Page>
        );
      }
    `;
    // Mutant proof: without codeOnly stripping the `//` line, this fixture's decoy is itself a
    // complete, single-line `<Page density="table">` and the regex would report it as a THIRD,
    // leading hit (['table', 'form', 'table']) — failing this exact assertion.
    expect(findPageDensities(fixture)).toEqual(['form', 'table']);
  });
});

describe('T-348 S3 (DEF-440) — P1: each of the eight\'s main return uses density="table"', () => {
  it.each(EIGHT)('%s', (rel) => {
    // Mutant proof: a main return left at (or reverted to) "form" fails this line directly; a
    // `<Page` reformatted across lines (the admin/prerequisite-refusals/page.tsx:22-23 shape)
    // still resolves, because the match spans line breaks.
    expect(mainDensity(rel)).toBe('table');
  });
});

describe('T-348 S3 (DEF-440) — P2: the early-return branch stays density="form"', () => {
  it.each(TWO_WRAPPER_FILES)('%s: the FIRST <Page density=...> (the guard clause) is "form"', (rel) => {
    const hits = densitiesOf(rel);
    // Mutant proof: if a builder edit collapsed the guard clause into the main return (or added a
    // third <Page site), this count check catches it before the position check would silently
    // compare the wrong element.
    expect(hits.length, `${rel}: expected exactly 2 <Page density=...> (guard + main), found ${hits.length}`).toBe(2);
    expect(hits[0]).toBe('form');
  });
});
