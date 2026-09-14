import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-310 / DEF-344 regression guard.
 *
 * `packages/db/src/client.ts` used to derive TLS from `NODE_ENV` and pass an explicit `ssl`
 * option to `postgres()`, which OVERRIDES whatever the connection string's own `sslmode` says
 * (`node_modules/postgres/src/index.js:474-476` — an explicit option always wins over the URL).
 * Production's URL already carried `?sslmode=require`; every hand-run script inherited
 * `NODE_ENV=development` and connected in the clear. The fix is to delete the option and let the
 * URL decide, exactly as `packages/db/migrate.ts` already does.
 *
 * Two separate checks, deliberately not folded into one:
 *
 *   1. A repo-wide sweep: no `postgres(` call anywhere in shipped code passes an `ssl` key. This
 *      is the actual blast radius DEF-344 names — "every one-shot script, not just this one" —
 *      so it is scoped to every call site, not just the two that were broken, and it will catch
 *      the next script or app that hardcodes TLS the same way.
 *   2. A narrower, named tripwire on `client.ts` itself: neither `createClient()` nor
 *      `createSystemClient()` destructures `NODE_ENV` from `env()` any more. `NODE_ENV` had
 *      exactly one reader in this file — the deleted `ssl` line — so its reappearance in either
 *      function's destructuring is a strong tell that the old pattern is being rebuilt, even
 *      before an `ssl` key is typed back in.
 *
 * Deliberately dependency-free — reads real files with `node:fs`, no glob library, matching
 * `tests/unit/deploy-migrate-uses-system-db-url.test.ts`'s own stated rationale (no dependency,
 * reads the real file, turns a silent regression into a red unit test instead of a production
 * incident).
 *
 * ⚠️ This is a lightweight source scanner, not a JS parser. It tracks string/template literals
 * and `//`/`/* *\/` comments well enough to find the real closing paren/brace of a call or
 * function body, but it does NOT re-enter "code mode" for `${...}` interpolation inside a
 * template literal used as an argument. No call site in this repo does that today (checked by
 * inspection while writing this test) — if one ever does, this scanner may need to get smarter
 * rather than silently mis-scoping.
 *
 * ⭐ Swept roots are `packages/**`, `scripts/**` and `apps/**` — deliberately "all shipped code",
 * not "the two directories the original spec happened to name". The one thing NOT swept is the
 * repo root itself, which leaves `spike/firestore-two-lane/offline.test.ts:100`'s `ssl: false`
 * out on purpose: spike code is throwaway and never shipped. That is a genuine, reasoned
 * exception — do not "fix" it by adding `spike/` to the swept roots without checking with
 * whoever owns this spec first. If a fourth top-level root of real shipped code is ever added to
 * this repo, it belongs in this list the same way `apps/**` was added here — the rule is "all
 * shipped code", not the three names below it.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage']);
const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...listFiles(join(dir, entry.name)));
    } else if (INCLUDE_EXT.has(extname(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * From `startIndex` (the position of `open`), walk forward tracking `open`/`close` depth, skipping
 * over string/template literals and comments so a stray bracket inside either can't end the scan
 * early or late. Returns the balanced span INCLUDING both delimiters.
 */
function extractBalanced(source: string, startIndex: number, open: string, close: string): string {
  let depth = 0;
  let i = startIndex;
  let inString: string | null = null;
  let result = '';

  for (; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      result += ch;
      if (ch === inString && source[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      result += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      const stop = nl === -1 ? source.length : nl;
      result += source.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      result += source.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      result += ch;
      if (depth === 0) return result;
      continue;
    }
    result += ch;
  }
  return result;
}

/** Every `postgres(...)` call's full argument span, found by word-boundary match on the callee. */
function findPostgresCallSpans(source: string): string[] {
  const spans: string[] = [];
  const callRegex = /\bpostgres\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(source)) !== null) {
    const openParenIndex = match.index + match[0].length - 1;
    spans.push(extractBalanced(source, openParenIndex, '(', ')'));
  }
  return spans;
}

const DEF_344_RULING =
  'DEF-344 ruling: transport security (TLS) must come from the connection string\'s own ' +
  'sslmode, never from a hardcoded or derived option — postgres.js lets an explicit "ssl" key ' +
  'silently override whatever the URL says (node_modules/postgres/src/index.js:474-476), which ' +
  'is how production stayed encrypted while every hand-run script connected in the clear. ' +
  'packages/db/migrate.ts is the reference: no "ssl" key, ever. Delete it here too.';

describe('DEF-344: no postgres() call under packages/ or scripts/ sets an ssl option', () => {
  const files = ['packages', 'scripts', 'apps']
    .map((d) => join(repoRoot, d))
    .flatMap((root) => listFiles(root));

  it('swept at least one file and found packages/db/src/client.ts (the sweep is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
    const clientFile = files.find((f) => f.endsWith(join('db', 'src', 'client.ts')));
    expect(clientFile, 'expected packages/db/src/client.ts in the swept file set').toBeTruthy();
  });

  for (const file of files) {
    const relPath = relative(repoRoot, file);
    const content = readFileSync(file, 'utf8');
    const callSpans = findPostgresCallSpans(content);
    if (callSpans.length === 0) continue;

    it(`${relPath}: no postgres() call sets an ssl key`, () => {
      callSpans.forEach((span, index) => {
        expect(span, `${relPath} (call #${index + 1}): ${DEF_344_RULING}`).not.toMatch(/\bssl\s*:/);
      });
    });
  }
});

describe('DEF-344: client.ts does not destructure NODE_ENV in either connection factory', () => {
  const clientPath = join(repoRoot, 'packages', 'db', 'src', 'client.ts');
  const source = readFileSync(clientPath, 'utf8');

  const NODE_ENV_RULING =
    'DEF-344 ruling: createClient()/createSystemClient() must never destructure NODE_ENV from ' +
    'env() again — its only past reader was the deleted "ssl: NODE_ENV === \'production\' ? ' +
    '\'require\' : false" line, so its reappearance here is a strong tell that pattern is being ' +
    'rebuilt, even before an "ssl" key is typed back in. A genuine, unrelated need to read ' +
    'NODE_ENV belongs outside these two functions, with a comment saying why.';

  function functionBody(name: string): string {
    const marker = `function ${name}(): Sql {`;
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, `expected to find "${marker}" in packages/db/src/client.ts`).toBeGreaterThan(-1);
    const braceIndex = markerIndex + marker.length - 1;
    return extractBalanced(source, braceIndex, '{', '}');
  }

  it('createClient() does not destructure NODE_ENV', () => {
    expect(functionBody('createClient'), NODE_ENV_RULING).not.toMatch(/\bNODE_ENV\b/);
  });

  it('createSystemClient() does not destructure NODE_ENV', () => {
    expect(functionBody('createSystemClient'), NODE_ENV_RULING).not.toMatch(/\bNODE_ENV\b/);
  });
});
