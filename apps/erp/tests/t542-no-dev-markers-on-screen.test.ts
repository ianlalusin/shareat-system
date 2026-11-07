/**
 * T-542 — no developer markers or task codes in on-screen text.
 *
 * Staff saw internal markers and codes in the ERP's help text — `⛔`, `⭐`, `(T-130)`, `(DEF-129)`,
 * `(T-394)` — and read the screens as unfinished. `docs/tasks/542-dev-notes-out-of-screen-text.md`
 * §3 step 2 removes them from **rendered** text only; comments (`//`, `/* *\/`, `{/* *\/}`) keep
 * their markers on purpose, because they are for the next developer and never reach a screen.
 *
 * This guard strips comments from each file the task changed and then asserts the remaining source
 * contains no `⛔`, no `⭐`, and no parenthesised `(T-nnn…)` / `(DEF-nnn…)`. Block comments are
 * replaced with their own newlines so a reported line number is the real one.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', 'src', 'app');

/** The files T-542 changed (paths under apps/erp/src/app/). */
const CHANGED: readonly string[] = [
  'admin/stores/[id]/page.tsx',
  'ap/invoices/[id]/page.tsx',
  'ap/page.tsx',
  'ap/suppliers/page.tsx',
  'attendance/[dayId]/page.tsx',
  'attendance/page.tsx',
  'budgets/page.tsx',
  'cash-requests/[id]/page.tsx',
  'channel-settlements/SettlementForm.tsx',
  'commissary/catalogue/page.tsx',
  'commissary/discrepancies/page.tsx',
  'customers/[customerId]/AutoAllocateCollectionForm.tsx',
  'customers/[customerId]/page.tsx',
  'customers/page.tsx',
  'cutover/opening/page.tsx',
  'findings/page.tsx',
  'findings/scorecard/page.tsx',
];

const MARKER = /⛔|⭐/;
const CODE = /\((?:T|DEF)-\d{3}[^)]*\)/;

/**
 * Remove comments while keeping every newline, so line numbers stay true to the file:
 * `/* … *\/` covers `{/* … *\/}` too (the JSX form is just a block comment between braces), and a
 * whole-line `//` is a comment — a `//` inside a string (a URL) is left alone on purpose.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ''));
}

describe('T-542 — no developer markers in rendered text', () => {
  it('every changed file is free of ⛔, ⭐ and (T-nnn)/(DEF-nnn) outside comments', () => {
    const offenders: string[] = [];

    for (const rel of CHANGED) {
      const lines = stripComments(readFileSync(resolve(appRoot, rel), 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        const marker = MARKER.exec(line);
        const code = CODE.exec(line);
        if (marker !== null || code !== null) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('the comment rule is real: a marker inside a comment is stripped, one in text is not', () => {
    const sample = [
      'const a = 1;',
      '/* ⛔ this is a comment and is allowed */',
      '// ⭐ (T-999) this line is a comment too',
      '<p>⛔ this one is on screen</p>',
    ].join('\n');

    const stripped = stripComments(sample);
    expect(stripped).not.toContain('comment and is allowed');
    expect(stripped).not.toContain('(T-999)');
    expect(stripped).toContain('⛔ this one is on screen');
    // Newlines are preserved, so line 4 is still line 4.
    expect(stripped.split('\n')).toHaveLength(4);
  });
});
