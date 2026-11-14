/**
 * T-560: stray pixel text sizes are back on the type scale.
 *
 * Why a guard and not just a sweep. One-off sizes like `text-[11px]` or `text-[28px]` bypass the
 * design system's type scale, so the same kind of caption renders at a slightly different size from
 * page to page. The sweep moved every occurrence outside the POS onto the scale:
 *
 *   text-[10px|11px|12px] -> text-xs    text-[13px|14px] -> text-sm    text-[15px|16px] -> text-base
 *   text-[26px] -> text-2xl             text-[28px] -> text-3xl        (the two display sizes: nearest step)
 *
 * `apps/erp/src/app/pos/` is EXCLUDED: the POS screens are being built by another team and their
 * sizes are theirs to decide (T-560 §3.1). The rule is therefore "outside the POS".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = `${here}../src`;
/** The POS subtree, as it appears in a joined path on this OS. */
const POS = `${sep}app${sep}pos${sep}`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Any arbitrary Tailwind pixel font size, with or without a variant prefix (`sm:text-[13px]`). */
const ARBITRARY_PX = /text-\[\d+(?:\.\d+)?px\]/g;

describe('T-560 — stray pixel text sizes are back on the type scale', () => {
  it('no arbitrary pixel text size outside the POS', () => {
    const uses: string[] = [];
    for (const f of sourceFiles(srcDir)) {
      if (f.includes(POS)) continue;
      const rel = relative(srcDir, f).split(sep).join('/');
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(ARBITRARY_PX)) uses.push(`${rel}:${i + 1}  ${m[0]}`);
        });
    }
    expect(uses, `${uses.length} arbitrary pixel text size(s):\n${uses.join('\n')}`).toEqual([]);
  });

  it('still finds the POS subtree, so the exclusion cannot silently become "everything"', () => {
    // NEGATIVE for the exclusion: if the path separator ever changes, this fails instead of the
    // rule quietly passing because every file was skipped.
    expect(sourceFiles(srcDir).some((f) => f.includes(POS))).toBe(true);
  });
});
