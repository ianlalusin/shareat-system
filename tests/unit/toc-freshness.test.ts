import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOC_TARGETS, withFreshToc } from '../../scripts/gen-toc';

/**
 * The tables of contents in the long documents carry LINE RANGES, so a reader can `offset`/`limit`
 * straight to a section instead of pulling 1,680 lines to answer one question.
 *
 * **A stale line-range TOC is worse than no TOC.** It sends the reader to the wrong place with
 * complete confidence, and nothing about the output says it is wrong. So the document is the
 * source, the TOC is generated from it, and this test fails the build the moment they disagree.
 *
 * That is the same rule the rest of this repo runs on: one source of truth, and a guard that
 * fires rather than a convention that is remembered.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

describe('TOC freshness', () => {
  it.each(TOC_TARGETS)('%s has an up-to-date line-range TOC', (rel) => {
    const p = join(repoRoot, rel);
    const current = readFileSync(p, 'utf8');
    const fresh = withFreshToc(current);

    expect(
      current === fresh,
      `${rel}'s table of contents is STALE — its line numbers no longer match its headings.\n\n` +
        'Run:  npm run toc\n\n' +
        'The TOC exists so a reader can jump to a section with offset/limit rather than reading ' +
        'the whole file. A stale one points confidently at the wrong place, which is worse than ' +
        'not having one.',
    ).toBe(true);
  });

  it('every TOC line range points at a real heading', () => {
    // Belt and braces: the generator could agree with itself and still be wrong. This checks the
    // claim the TOC actually makes — that line N is the heading it names.
    for (const rel of TOC_TARGETS) {
      const lines = readFileSync(join(repoRoot, rel), 'utf8').split('\n');
      const entries = lines
        .map((l) => /^\s*- `\s*(\d+)–(\d+)\s*` (.+)$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null);

      expect(entries.length, `${rel} has no TOC entries — did the generator run?`).toBeGreaterThan(5);

      for (const m of entries) {
        const start = Number(m[1]);
        const heading = lines[start - 1] ?? '';
        expect(
          /^#{2,3}\s/.test(heading),
          `${rel}: TOC says line ${start} is "${m[3]}", but that line is:\n  ${heading}`,
        ).toBe(true);
      }
    }
  });

  it('a range never starts after it ends', () => {
    for (const rel of TOC_TARGETS) {
      const lines = readFileSync(join(repoRoot, rel), 'utf8').split('\n');
      for (const l of lines) {
        const m = /^\s*- `\s*(\d+)–(\d+)\s*`/.exec(l);
        if (m) expect(Number(m[1]), `${rel}: inverted range in "${l.trim()}"`).toBeLessThanOrEqual(Number(m[2]));
      }
    }
  });
});
