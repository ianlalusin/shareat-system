import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⛔ **A `'use client'` file may not reach `@shareat/db`** — T-266.
 *
 * ## The defect this exists for, and why nothing else caught it
 *
 * `@shareat/domain` is a BARREL: `packages/domain/src/index.ts` re-exports ~60 modules, and
 * several of them import `@shareat/db`, which imports the `postgres` driver. So a single
 * `import { … } from '@shareat/domain'` inside a `'use client'` component pulls a TCP database
 * driver into the browser bundle.
 *
 * ⚠️ **Typecheck passed. All 1346 unit tests passed. `next build` refused it.** T-266 wrote
 * exactly that import in `components/money/MoneyLines.tsx` and found out only at build:
 *
 *     Module not found: Can't resolve 'net'
 *     #3 [Client Component Browser]:
 *       ./node_modules/postgres/src/connection.js [Client Component Browser]
 *       ./packages/domain/src/index.ts [Client Component Browser]
 *       ./apps/erp/src/components/money/MoneyLines.tsx [Client Component Browser]
 *
 * ⭐ **A build is the slowest gate we have and was the only one that could see this.** The
 * orchestrating session's response to the finding was to make it a standing note for its lanes;
 * this project's own rule is that a note is the weaker form — `app-boundaries.test.ts` exists for
 * the same reason (*"the project has no linter at all (DEF-027) and waiting for one would leave
 * the boundary unguarded"*). So it is a guard that executes, in the fast gate.
 *
 * ## The rule
 *
 * For every file containing a `'use client'` directive:
 *   1. it may not import `@shareat/db` (or a subpath) at all;
 *   2. it may not import the bare `@shareat/domain` barrel — the barrel always reaches the driver;
 *   3. it MAY import a `@shareat/domain/<subpath>` leaf, and this test walks that leaf's own
 *      imports transitively to prove the leaf is genuinely DB-free rather than merely narrower.
 *
 * ⚠️ Rule 3 is the one that matters long-term. Adding a subpath export is easy; adding one that
 * quietly imports a repo a year from now is just as easy, and the symptom would again be a build
 * failure far from the cause.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** ⛔ `git ls-files`, never a directory walk — `apps/erp/.next` holds turbopack copies of the
 *  source, and scanning them reports the same violation dozens of times from generated paths
 *  nobody can fix (the trap `domain-actions-have-callers.test.ts` documents). */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/**
 * ⚠️ `[^;]` and NOT `[^;\n]` — a negated class matches newlines, and that is the whole point.
 *
 * ⛔ The first version of this line used `[^;\n]*?`, which cannot match a MULTI-LINE import — and
 * a multi-line `import { … } from '@shareat/domain'` is precisely the shape of the defect this
 * guard exists for. It passed against the real, reintroduced defect. **A guard that cannot see
 * the bug it was written for is worse than no guard, because it is credited for passing.** Caught
 * only by re-introducing the defect and watching for red (§3.2 — confirm it fails, and for the
 * right reason).
 */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;

function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push(m[1]!);
  return out;
}

function isClientFile(source: string): boolean {
  // The directive must be at the very top to count — a `'use client'` inside a string or a
  // comment further down does not make a module a client module.
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]use client['"]/.test(source);
}

/** Resolve a `@shareat/domain/<sub>` specifier to a file under `packages/domain/src`. */
function resolveDomainSubpath(spec: string): string | null {
  const sub = spec.slice('@shareat/domain/'.length);
  for (const candidate of [
    `packages/domain/src/${sub}.ts`,
    `packages/domain/src/${sub}/index.ts`,
    `packages/domain/src/shared/${sub}.ts`,
  ]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/** Resolve a relative import from one repo-relative file to another. */
function resolveRelative(fromRel: string, spec: string): string | null {
  const base = resolve(dirname(join(root, fromRel)), spec);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate.slice(root.length + 1).split('\\').join('/');
  }
  return null;
}

/**
 * Does this module reach `@shareat/db` through any chain of relative imports?
 * Returns the chain that proves it, or null.
 *
 * ⚠️ Type-only imports are NOT excluded, deliberately. `import type` is erased and would be safe,
 * but distinguishing it reliably here means parsing TypeScript, and the false-positive direction
 * ("you were made to use a subpath you did not strictly need") is cheap while the false-negative
 * direction ships a database driver to a browser.
 */
function reachesDb(startRel: string): string[] | null {
  const seen = new Set<string>();
  const walk = (rel: string, chain: string[]): string[] | null => {
    if (seen.has(rel)) return null;
    seen.add(rel);
    let source: string;
    try {
      source = read(rel);
    } catch {
      return null;
    }
    for (const spec of importsOf(source)) {
      if (spec === '@shareat/db' || spec.startsWith('@shareat/db/')) {
        return [...chain, rel, spec];
      }
      if (spec.startsWith('.')) {
        const next = resolveRelative(rel, spec);
        if (next) {
          const found = walk(next, [...chain, rel]);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return walk(startRel, []);
}

describe("T-266 — a 'use client' file may not reach the database driver", () => {
  const clientFiles = trackedFiles()
    .filter((f) => /\.(ts|tsx)$/.test(f) && f.startsWith('apps/'))
    .filter((f) => {
      try {
        return isClientFile(read(f));
      } catch {
        return false;
      }
    });

  it('finds the client components at all — a guard scanning nothing is worse than none', () => {
    // ⭐ `integration-glob-guard.test.ts`'s lesson (DEF-081): a guard that matches zero files
    // passes forever and is credited for it. If this ever drops to 0, the scanner broke, not the
    // codebase.
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it('⛔ none imports @shareat/db, directly or through a subpath', () => {
    const offenders = clientFiles
      .filter((f) => importsOf(read(f)).some((s) => s === '@shareat/db' || s.startsWith('@shareat/db/')))
      .map((f) => `${f} imports @shareat/db — a browser bundle cannot open a TCP connection`);
    expect(offenders).toEqual([]);
  });

  it('⛔ none imports the bare @shareat/domain barrel — it re-exports modules that reach the driver', () => {
    const offenders = clientFiles
      .filter((f) => importsOf(read(f)).includes('@shareat/domain'))
      .map(
        (f) =>
          `${f} imports the '@shareat/domain' BARREL. It re-exports every domain module and ` +
          `several import @shareat/db, so this pulls the postgres driver into the browser ` +
          `bundle — next build fails with "Can't resolve 'net'". Import a DB-free subpath ` +
          `instead (e.g. '@shareat/domain/money-lines'), adding one to packages/domain/` +
          `package.json's exports, apps/erp/tsconfig.json and vitest.config.mts if needed.`,
      );
    expect(offenders).toEqual([]);
  });

  it('⭐ every @shareat/domain subpath a client file imports is genuinely DB-free, transitively', () => {
    const offenders: string[] = [];
    for (const file of clientFiles) {
      for (const spec of importsOf(read(file))) {
        if (!spec.startsWith('@shareat/domain/')) continue;
        const target = resolveDomainSubpath(spec);
        if (!target) {
          offenders.push(`${file} imports ${spec}, which resolves to no file under packages/domain/src`);
          continue;
        }
        const chain = reachesDb(target);
        if (chain) {
          offenders.push(
            `${file} imports ${spec}, which reaches @shareat/db: ${chain.join(' -> ')}. ` +
              `Split the DB-free half into its own module, the way ` +
              `money-accounts/draw-verdict.ts was split out of overdraft.ts.`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * T-343 S6a — closes the gap named in the S6 evidence: `@shareat/auth`'s barrel reaches
   * `@shareat/db` through `authorize.ts`'s repo imports, but this test file (T-266) never checked
   * it. A client file importing `ROLE_LABEL`/`ORDER_WASTAGE_DISPOSITION_LABEL`-shaped names from
   * the bare `'@shareat/auth'` specifier would pass every fast gate and fail only at `next build`.
   * The `'@shareat/auth/errors'` leaf (error classes only, no `@shareat/db` behind it — T-237)
   * stays allowed.
   */
  it("⛔ none imports the bare @shareat/auth barrel — it reaches @shareat/db through authorize.ts's repo imports (S6a)", () => {
    const offenders = clientFiles
      .filter((f) => importsOf(read(f)).includes('@shareat/auth'))
      .map(
        (f) =>
          `${f} imports the '@shareat/auth' BARREL. It reaches @shareat/db through authorize.ts's ` +
          `repo imports, so this pulls the postgres driver into the browser bundle. Import ` +
          `'@shareat/auth/errors' instead, or have the server page resolve the label and pass it as a prop.`,
      );
    expect(offenders).toEqual([]);
  });

  /**
   * DEF-179's lesson, applied to the previous `it`'s own matcher: a scan that cannot see a
   * multi-line import passes on the exact defect it exists to catch. Fed a fixture, not a real
   * file, so this is provable without waiting for anyone to write the bad import for real.
   */
  it("⭐ the @shareat/auth matcher sees a multi-line import and does not confuse it with the '/errors' leaf (DEF-179)", () => {
    const multiLineImport = "'use client';\nimport {\n  ROLE_LABEL,\n} from '@shareat/auth';";
    const errorsLeafImport = "'use client';\nimport { AuthenticationError } from '@shareat/auth/errors';";
    expect(importsOf(multiLineImport).filter((s) => s === '@shareat/auth').length).toBe(1);
    expect(importsOf(errorsLeafImport).filter((s) => s === '@shareat/auth').length).toBe(0);
  });
});
