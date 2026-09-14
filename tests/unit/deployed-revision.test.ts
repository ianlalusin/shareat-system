import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * T-308 Slice A regression guard.
 *
 * `apps/erp/src/generated/revision.ts` is a committed placeholder (Contract A2) that
 * `scripts/write-revision.mjs` overwrites in place before `next build`, so `/api/health` can
 * report which commit produced the running build without ever reading it at runtime (a runtime
 * read would report the NEW release's sha while the process still executes the OLD build, on the
 * exact partial-deploy shape §Why names). The generator never invents a value — DEF-311 is the
 * standing proof that a plausible-looking wrong value costs more than an honest absence — so an
 * unset or malformed `DEPLOY_REVISION_SHA` either writes the honest placeholder (local dev, any
 * test) or, under `--require` (every CI deploy), refuses outright and writes nothing.
 *
 * ⛔ **Every mutating test below writes to a fresh OS temp directory, NEVER to the tracked
 * `apps/erp/src/generated/revision.ts`.** An earlier version of this file pointed the generator
 * at the real file and restored it in `afterEach` — lane C found that this tree has concurrent
 * lanes, and a crash mid-suite, or two lanes' `npm run test` racing each other's restore, could
 * leave a plausible-looking fake sha committed as if it were real: an Invariant A2 violation
 * manufactured by the very test meant to guard it, and strictly worse than the honest `unknown`
 * placeholder it would replace (DEF-311's shape exactly). `scripts/write-revision.mjs` now takes
 * an `--out <path>` ARGV FLAG (Contract A3b) — WHERE it writes, never WHETHER `--require`
 * refuses — defaulting to the real path when absent, which is every real build and every real
 * deploy (`deploy.yml` passes none). Deliberately a flag, not an env var: an env var is inherited
 * by every child process and could be set far from the command it affects, which is this same
 * failure shape re-entering through the mechanism meant to prevent it. Only Test 1 and the shape
 * test below read the real committed file, and only ever read it — never write it.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const SCRIPT_PATH = join(repoRoot, 'scripts', 'write-revision.mjs');
const OUTPUT_PATH = join(repoRoot, 'apps', 'erp', 'src', 'generated', 'revision.ts');
const ROUTE_PATH = join(repoRoot, 'apps', 'erp', 'src', 'app', 'api', 'health', 'route.ts');
const DEPLOY_YML_PATH = join(repoRoot, '.github', 'workflows', 'deploy.yml');
const PACKAGE_JSON_PATH = join(repoRoot, 'package.json');

/** Read-only snapshot of the real, tracked file — never written by this suite. */
const ORIGINAL_OUTPUT = readFileSync(OUTPUT_PATH, 'utf8');

/** Temp dirs created by `runGenerator` during the CURRENT test only, cleaned up in `afterEach`. */
let tempDirsThisTest: string[] = [];

afterEach(() => {
  for (const dir of tempDirsThisTest) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirsThisTest = [];
});

function runGenerator(sha: string | undefined, extraArgs: string[] = []) {
  const tempDir = mkdtempSync(join(tmpdir(), 'write-revision-test-'));
  tempDirsThisTest.push(tempDir);
  const outputPath = join(tempDir, 'revision.ts');

  const env = { ...process.env };
  if (sha === undefined) {
    delete env.DEPLOY_REVISION_SHA;
  } else {
    env.DEPLOY_REVISION_SHA = sha;
  }
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, '--out', outputPath, ...extraArgs], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      // Explicit, not the default: some of these runs are EXPECTED to exit 1 with a stderr
      // explanation (that is Contract A3's whole point) — piping rather than inheriting keeps
      // an expected, asserted-on failure from reading as unexplained noise in a CI log.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '', outputPath };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', outputPath };
  }
}

/**
 * Parses the two fields out of the generated module's SOURCE TEXT rather than importing it as a
 * module — the file changes on disk within this suite and Node's ESM module cache would happily
 * serve a stale import across `it()` blocks, which is exactly the kind of caching gotcha that
 * makes a test pass for the wrong reason. Reading it as data sidesteps that entirely.
 */
function parseRevisionFile(text: string): { sha: string; builtAt: string | null } {
  const shaMatch = text.match(/sha:\s*'([^']*)'/);
  const builtAtMatch = text.match(/builtAt:\s*(null|'([^']*)')/);
  if (!shaMatch || !builtAtMatch) {
    throw new Error(`could not parse a REVISION shape out of:\n${text}`);
  }
  return {
    // shaMatch has exactly one capture group with no alternation, so a successful match
    // (confirmed non-null by the guard above) always defines it.
    sha: shaMatch[1]!,
    // builtAtMatch's group 2 lives only inside the quoted alternative `'([^']*)'` — it is
    // undefined whenever the `null` alternative matched instead. It's read here only in the
    // branch where group 1 !== 'null', which is exactly proof that the quoted alternative is
    // the one that matched, so group 2 is defined every time this line actually runs.
    builtAt: builtAtMatch[1] === 'null' ? null : builtAtMatch[2]!,
  };
}

function isLegalShape({ sha, builtAt }: { sha: string; builtAt: string | null }): boolean {
  const placeholder = sha === 'unknown' && builtAt === null;
  const real =
    /^[0-9a-f]{40}$/.test(sha) &&
    typeof builtAt === 'string' &&
    !Number.isNaN(Date.parse(builtAt));
  return placeholder || real;
}

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';

/** The six inputs Contract A3 / Test 3 / Test 4 name explicitly. */
const INVALID_INPUTS: Array<[label: string, value: string | undefined]> = [
  ['unset', undefined],
  ['empty string', ''],
  ['"HEAD"', 'HEAD'],
  ['39 hex chars (one short)', 'a'.repeat(39)],
  ['uppercase 40 chars', 'A'.repeat(40)],
  ['non-hex 40 chars', 'g'.repeat(40)],
];

describe('T-308 Slice A: apps/erp/src/generated/revision.ts', () => {
  it('the committed module is the placeholder: sha "unknown", builtAt null', () => {
    const { sha, builtAt } = parseRevisionFile(ORIGINAL_OUTPUT);
    expect(sha).toBe('unknown');
    expect(builtAt).toBeNull();
  });
});

describe('T-308 Slice A: scripts/write-revision.mjs — happy path', () => {
  it('a valid 40-hex DEPLOY_REVISION_SHA is written verbatim with a fresh ISO builtAt', () => {
    const result = runGenerator(VALID_SHA);
    expect(result.status).toBe(0);

    const { sha, builtAt } = parseRevisionFile(readFileSync(result.outputPath, 'utf8'));
    expect(sha).toBe(VALID_SHA);
    expect(builtAt).not.toBeNull();
    expect(builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(builtAt as string))).toBe(false);
  });
});

describe('T-308 Slice A: scripts/write-revision.mjs — unset/invalid path (no --require)', () => {
  for (const [label, value] of INVALID_INPUTS) {
    it(`${label} writes the placeholder and exits 0`, () => {
      const result = runGenerator(value);
      expect(result.status).toBe(0);

      const { sha, builtAt } = parseRevisionFile(readFileSync(result.outputPath, 'utf8'));
      expect(sha).toBe('unknown');
      expect(builtAt).toBeNull();
    });
  }
});

describe('T-308 Slice A: scripts/write-revision.mjs --require — the DEF-311 guard', () => {
  for (const [label, value] of INVALID_INPUTS) {
    it(`${label} exits 1 and writes nothing`, () => {
      const result = runGenerator(value, ['--require']);

      expect(result.status).toBe(1);
      expect(result.stderr.length, 'expected a non-empty stderr explanation').toBeGreaterThan(0);
      // The temp dir is freshly created per run and nothing pre-populates it, so "writes
      // nothing" means the output file must simply never come into existence.
      expect(
        existsSync(result.outputPath),
        `${label}: the output file must not exist — the generator must write nothing under --require`,
      ).toBe(false);
    });
  }

  it('a valid 40-hex DEPLOY_REVISION_SHA still succeeds under --require', () => {
    const result = runGenerator(VALID_SHA, ['--require']);
    expect(result.status).toBe(0);
    const { sha } = parseRevisionFile(readFileSync(result.outputPath, 'utf8'));
    expect(sha).toBe(VALID_SHA);
  });
});

describe('T-308 Slice A: /api/health carries the revision field', () => {
  const routeSource = readFileSync(ROUTE_PATH, 'utf8');

  /**
   * This does NOT execute GET() — the handler calls getSql() against a real database, and a
   * unit test may never touch one (vitest.config.mts's own rule: "a test that needs a database
   * is not a unit test"). Instead: (a) prove the route imports and statically wires the same
   * baked-in constant into all three response bodies (Invariant A1 — the value never depends on
   * env(), so it must be a plain reference, not something computed inside either try block);
   * (b) prove that constant's CURRENT on-disk value is one of the two legal shapes.
   */
  it('imports REVISION from the generated module', () => {
    expect(routeSource).toMatch(/import\s*\{\s*REVISION\s*\}\s*from\s*['"]@\/generated\/revision['"]/);
  });

  it('wires `revision: REVISION` into exactly three response bodies (200 and both 503s)', () => {
    const occurrences = routeSource.match(/revision:\s*REVISION\b/g) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it('the module currently holds one of the two legal shapes and nothing else', () => {
    const shape = parseRevisionFile(readFileSync(OUTPUT_PATH, 'utf8'));
    expect(isLegalShape(shape)).toBe(true);
  });
});

describe('T-308 Slice A: wiring beyond the five named tests — deploy.yml and package.json', () => {
  const workflow = readFileSync(DEPLOY_YML_PATH, 'utf8');
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    scripts?: Record<string, string>;
  };

  const SAME_EXPRESSION = '${{ github.event.workflow_run.head_sha || github.sha }}';

  it('package.json has a write-revision script pointing at the real file', () => {
    expect(packageJson.scripts?.['write-revision']).toBe('node scripts/write-revision.mjs');
  });

  it('deploy.yml passes DEPLOY_REVISION_SHA from line 47\'s own expression to a revision step', () => {
    // Scoped to the revision-writing step specifically (not just "anywhere in the file") so a
    // DEPLOY_REVISION_SHA mention elsewhere (a comment, a different step) can't satisfy this by
    // accident — same discipline tests/unit/deploy-migrate-uses-system-db-url.test.ts uses.
    const stepIdx = workflow.indexOf('run: npm run write-revision -- --require');
    expect(stepIdx, 'expected a step running "npm run write-revision -- --require"').toBeGreaterThan(-1);
    const before = workflow.slice(0, stepIdx);
    const envBlockStart = before.lastIndexOf('env:');
    expect(envBlockStart).toBeGreaterThan(-1);
    const envBlock = workflow.slice(envBlockStart, stepIdx);
    expect(envBlock).toContain(`DEPLOY_REVISION_SHA: ${SAME_EXPRESSION}`);
  });

  // ⛔ Deliberately no "Build step also gets DEPLOY_REVISION_SHA" case. Lane C withdrew that
  // requirement: nothing on the Build step reads the variable — next.config.js never
  // references it, and the generated module is already a static file written by the
  // preceding step by the time `next build` runs. Asserting its presence would have made a
  // dead variable permanent and told a future reader that Build consumes it (DEF-240's shape:
  // a second copy of a value nothing reads is the hand-maintained half that rots).

  it('never substitutes git rev-parse HEAD for the resolved commit', () => {
    expect(workflow).not.toMatch(/git rev-parse/);
  });
});
