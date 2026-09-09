import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEF-221 — `apps/erp/tests/integration/**` matched NO vitest include glob: a file placed there
 * the obvious way (mirroring the already-working `packages/**\/tests/integration/**` convention)
 * silently never ran, and CI stayed green. DEF-081's shape one directory over.
 *
 * T-247 pairs this guard with widening `vitest.config.mts`'s integration `include` to add
 * `apps/**\/tests/integration/**\/*.test.ts` — the concrete gap DEF-221 named. This guard is the
 * durable half: it fails on the NEXT unreachable `tests/integration/` directory too, at any depth,
 * without anyone having to remember to widen the config again.
 *
 * ⭐ Reads `vitest.config.mts`'s own text for its `include`/`exclude` globs rather than hand-typing
 * a second copy of them — same principle as `tests/unit/toc-freshness.test.ts` importing
 * `scripts/gen-toc` for real instead of re-deriving its logic, so this guard cannot drift from the
 * config it checks. A direct `import` of the `.mts` config was tried first and rejected: `tsc`
 * refuses an explicit `.mts` extension in an import specifier without `allowImportingTsExtensions`
 * (TS5097), and that compiler flag is outside this task's Scope. Text extraction, the technique
 * `domain-actions-have-callers.test.ts` and `scheduler-jobs-have-callers.test.ts` already use for
 * exactly this kind of "read the real source, don't copy it" guard, has no such restriction.
 */

const repoRoot = path.resolve(__dirname, '../..');

/** Same technique and same reasoning as `scheduler-jobs-have-callers.test.ts`: `git ls-files`,
 *  never a directory walk — `apps/erp/.next` holds build output that a walk would read as real
 *  source. `--others --exclude-standard` includes untracked-but-not-ignored files, so a test
 *  written moments ago and not yet staged is still seen. */
function trackedFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
}

/**
 * Strips single-line comments before matching — a quote character inside an explanatory comment
 * (a contraction, an apostrophe) could otherwise be read as a glob string. CRLF normalised first
 * (DEF-179 — a Windows checkout is CRLF, and `.` does not match `\r`).
 *
 * DELIBERATELY DOES NOT STRIP BLOCK COMMENTS, unlike `scheduler-jobs-have-callers.test.ts`'s
 * `codeOnly()` this is otherwise modelled on. `vitest.config.mts` has none — every comment in it
 * is single-line. And every glob string this function reads, spelled two stars then a slash then
 * a star (the wildcard's trailing separator meeting the next segment's star), contains the same
 * two characters — slash then star — that open a block comment. A block-comment stripper reads
 * that pair inside the glob as an opening marker and keeps consuming text looking for the closing
 * pair, which it then finds inside some OTHER glob string later in the file — silently deleting
 * real config text in between. Found empirically: the search for the integration project's name
 * came back empty on the stripped text while present in the raw text. Re-adding block-comment
 * support would need its own proof that no glob in this file can still produce that collision.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Pulls the `include`/`exclude` glob arrays for the vitest project named `projectName`, bounded
 * to that project's own block so a sibling project's arrays can never bleed in — found by
 * cutting the source at the NEXT `name: '...'` after this one (or end of file, since today's
 * config has no project after `integration`).
 */
function projectGlobs(src: string, projectName: string): { include: string[]; exclude: string[] } {
  const clean = codeOnly(src);
  const start = clean.search(new RegExp(`name:\\s*'${projectName}'`));
  if (start === -1) throw new Error(`vitest.config.mts: no project named '${projectName}' found`);
  const rest = clean.slice(start);
  const nextNameOffset = rest.slice(1).search(/name:\s*'/);
  const block = nextNameOffset === -1 ? rest : rest.slice(0, nextNameOffset + 1);

  const arrayFor = (label: string): string[] => {
    const m = new RegExp(`${label}:\\s*\\[([\\s\\S]*?)\\]`).exec(block);
    if (!m) return [];
    return [...m[1]!.matchAll(/'([^']*)'/g)].map((g) => g[1]!);
  };

  return { include: arrayFor('include'), exclude: arrayFor('exclude') };
}

/**
 * Converts one of `vitest.config.mts`'s own glob patterns into a `RegExp`. Handles exactly the
 * vocabulary those patterns use — literal segments, `*` (one path segment) and `**` (zero or more
 * path segments) — nothing more, because supporting glob syntax this config never uses would be
 * untested code by construction.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?';
        i++;
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(patterns: readonly string[], file: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(file));
}

const configSrc = readFileSync(path.join(repoRoot, 'vitest.config.mts'), 'utf8');
const integrationGlobs = projectGlobs(configSrc, 'integration');

describe('DEF-221 — every tests/integration/ file is reachable by the integration project', () => {
  it('extracts the integration project globs from the real config (a scan of nothing passes)', () => {
    // Positive control on the extraction itself: a known, stable literal must survive the
    // parse, or an empty violation list downstream would mean nothing.
    expect(integrationGlobs.include).toContain('tests/integration/**/*.test.ts');
    expect(integrationGlobs.include.length).toBeGreaterThan(0);
  });

  it('⚠️ the matcher actually distinguishes covered from uncovered — DEF-221\'s exact shape, reproduced synthetically', () => {
    // Zero shared-state: no real file, no touching vitest.config.mts. Proves this guard's own
    // logic (not just the real config today) would have caught DEF-221 and clears once fixed —
    // same technique scheduler-jobs-have-callers.test.ts uses for isCalled()'s import-vs-call case.
    const before = `test: { name: 'integration', include: ['tests/integration/**/*.test.ts', 'packages/**/tests/integration/**/*.test.ts'], exclude: ['**/node_modules/**'] }`;
    const after = `test: { name: 'integration', include: ['tests/integration/**/*.test.ts', 'packages/**/tests/integration/**/*.test.ts', 'apps/**/tests/integration/**/*.test.ts'], exclude: ['**/node_modules/**'] }`;
    const file = 'apps/erp/tests/integration/example.test.ts';
    const covered = (globs: { include: string[]; exclude: string[] }) =>
      matchesAny(globs.include, file) && !matchesAny(globs.exclude, file);

    expect(covered(projectGlobs(before, 'integration')), 'DEF-221 shape must NOT be covered').toBe(false);
    expect(covered(projectGlobs(after, 'integration')), 'the fixed shape must be covered').toBe(true);
  });

  const candidates = trackedFiles().filter(
    (f) => /(^|\/)tests\/integration\//.test(f) && f.endsWith('.test.ts'),
  );

  it('⭐ finds real tests/integration/ files today — a non-zero control, not an assumption', () => {
    // reference_sweep_needs_nonzero_control: a scan that matches nothing exits green whether the
    // rule holds or the scan itself is broken. This floor proves it is the former.
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('⛔ every *.test.ts under a tests/integration/ directory is matched by the integration project', () => {
    const violations = candidates.filter(
      (f) => !matchesAny(integrationGlobs.include, f) || matchesAny(integrationGlobs.exclude, f),
    );

    expect(
      violations,
      'These files sit under a tests/integration/ directory but vitest.config.mts\'s integration ' +
        'project include/exclude does not reach them, so they are collected by NO project and ' +
        `silently never run (DEF-221):\n${violations.join('\n')}\n\n` +
        "Fix: widen vitest.config.mts's integration project `include` to cover this directory.",
    ).toEqual([]);
  });
});
