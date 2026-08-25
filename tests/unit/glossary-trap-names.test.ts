import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * v1 field names that mean the OPPOSITE of what they look like must not appear in v2 code.
 *
 * `docs/GLOSSARY.md` marks these ⚠️ and the reason is not pedantry:
 *
 *   - `dineInSales` is **package-only** — it is NOT "sales that were dined in"
 *   - `takeOutSales` is a **residual**, `max(0, totalGross - dineInSales)` — not a measurement
 *   - `receiptSeq` is **not a monotonic key**
 *   - `billOnServe` means the bill is created on SERVE — recognise revenue at order and unserved
 *     orders become revenue
 *
 * Reusing one of these names in v2 imports the misunderstanding along with it, and the next
 * person to read it will be confidently wrong. **This is the failure the glossary exists to
 * prevent, made into a build failure rather than a warning nobody reads.**
 *
 * The ETL is exempt, and legitimately so: it reads v1 payloads, where these are the actual field
 * names on the wire. Renaming them there would be a lie about the source data.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

/** Marked ⚠️ in docs/GLOSSARY.md — a name whose meaning is the opposite of its reading. */
const TRAP_NAMES = ['dineInSales', 'takeOutSales', 'receiptSeq', 'billOnServe', 'voidCashRetained'] as const;

/**
 * Paths where a trap name is CORRECT rather than a mistake.
 *
 * `packages/etl` and its corpus read v1 documents on the wire — those really are the field names,
 * and pretending otherwise would misdescribe the source. `docs/` explains the traps, so it must be
 * able to name them. This test names them too.
 */
const ALLOWED_PREFIXES = [
  'packages/etl/',
  'docs/',
  // T-108's worked examples model the v1 salesDay document AS INPUT — the shape a v2 module
  // receives off a v1 payload — so they must name its real fields. Verified rather than assumed
  // when this test first fired on them: every use sits beside a narrative citing GLOSSARY.md, and
  // the fixtures carry an explicit `trap:` field warning that takeOutSales is a residual and must
  // never be charted as take-out. They TEACH the trap; exempting them protects the lesson.
  'tests/worked-examples/',
  'tests/unit/glossary-trap-names.test.ts',
];

/** Only source we author. Generated output and lockfiles are not v2 code. */
const CHECKED_EXTENSIONS = new Set(['.ts', '.tsx', '.sql']);

function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\0')
    .filter((f) => f.length > 0)
    .filter((f) => !ALLOWED_PREFIXES.some((p) => f.startsWith(p)))
    .filter((f) => {
      const dot = f.lastIndexOf('.');
      return dot > 0 && CHECKED_EXTENSIONS.has(f.slice(dot));
    });
}

describe('glossary trap names', () => {
  it('the checked set is non-empty — a vacuous pass would prove nothing', () => {
    const files = trackedSourceFiles();
    expect(files.length).toBeGreaterThan(20);
  });

  it('no v2 source file uses a v1 trap name', () => {
    const offenders: string[] = [];

    for (const rel of trackedSourceFiles()) {
      let content: string;
      try {
        content = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue; // tracked but absent (sparse checkout) — scanned wherever it IS present
      }
      for (const name of TRAP_NAMES) {
        if (content.includes(name)) offenders.push(`${rel} — uses "${name}"`);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `v1 trap names found in v2 source:\n  ${offenders.join('\n  ')}\n\n` +
            'These names mean the OPPOSITE of what they look like (docs/GLOSSARY.md):\n' +
            '  dineInSales   — package-only, NOT "sales dined in"\n' +
            '  takeOutSales  — a RESIDUAL, max(0, totalGross - dineInSales)\n' +
            '  receiptSeq    — NOT a monotonic key\n' +
            '  billOnServe   — the bill exists on SERVE, not on order\n\n' +
            'Reusing one imports the misunderstanding with it. Name the thing you actually mean — ' +
            'and if you are reading a v1 payload, that belongs in packages/etl, which is exempt.',
    ).toEqual([]);
  });

  it('every trap name is still documented in the glossary', () => {
    // If a name is worth banning it is worth explaining. A ban with no explanation just looks
    // arbitrary to whoever hits it, and arbitrary rules get worked around.
    const glossary = readFileSync(join(repoRoot, 'docs', 'GLOSSARY.md'), 'utf8');
    const undocumented = TRAP_NAMES.filter((n) => !glossary.includes(n));
    expect(undocumented, `Banned but not explained in GLOSSARY.md: ${undocumented.join(', ')}`).toEqual([]);
  });
});
