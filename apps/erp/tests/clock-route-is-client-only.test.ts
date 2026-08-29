import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⛔⛔ **T-184 invariant 1 — the clock terminal may not touch the server.**
 *
 * Bible §5.2 is binding and has been true in prose since Phase 0:
 *
 * > *"the clock terminal reads and writes Firestore via the **client SDK**, never via Server
 * > Actions. A Server Action cannot function offline."*
 *
 * ⭐ **It had never once been checked.** A rule nothing enforces is a comment, and this is the
 * class of rule that stays true right up until the afternoon somebody adds one convenient
 * `await getConfig()` to the terminal and every tablet in every store silently stops working the
 * next time the internet drops — which is exactly when nobody is watching a test suite.
 *
 * So: walk the real import graph from the route, and fail on anything that cannot run in a browser
 * with no network.
 *
 * ⚠️ This is a static walk over relative imports, deliberately, rather than a bundler plugin. It
 * follows what the terminal actually reaches and needs no build step, so it runs in the unit suite
 * where a red result stops a commit rather than a deploy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const ENTRY = join(appRoot, 'src/app/clock/page.tsx');

/**
 * Each of these is a different way to accidentally require a server.
 *
 * ⚠️ `@shareat/domain` is on the list even though it is "just business logic": it owns transactions
 * and imports `@shareat/db`, so reaching it from the terminal drags a Postgres client into a
 * browser bundle. The terminal's rules live in Postgres and in the Firestore ruleset, and it is
 * supposed to be able to work without either being reachable.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /^next\/headers$/, why: 'reads request headers — there is no request offline' },
  { pattern: /^next\/cache$/, why: 'server-side caching primitives' },
  { pattern: /^@shareat\/db(\/|$)/, why: 'a Postgres client cannot run on a tablet with no network' },
  { pattern: /^@shareat\/domain(\/|$)/, why: 'owns transactions, and pulls @shareat/db with it' },
  { pattern: /^@shareat\/auth(\/|$)/, why: 'resolves a human session from Postgres; the terminal is a DEVICE' },
  { pattern: /^firebase-admin(\/|$)/, why: 'the ADMIN sdk — server-only, and holds a service account' },
  { pattern: /^pg$|^postgres$/, why: 'a database driver' },
];

interface Finding {
  file: string;
  problem: string;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Resolve a relative import the way the bundler will, trying the usual extensions. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && !existsSync(join(candidate, 'package.json'))) {
      const source = readIfExists(candidate);
      if (source !== null) return candidate;
    }
  }
  return null;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const re of [IMPORT, DYNAMIC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) found.push(m[1]!);
  }
  return found;
}

function walk(entry: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readIfExists(file);
    if (source === null) continue;

    const rel = file.slice(appRoot.length + 1).replace(/\\/g, '/');

    // ⛔ A `'use server'` file IS a Server Action module, whatever it imports.
    if (/^\s*['"]use server['"]/m.test(source)) {
      findings.push({ file: rel, problem: "is a 'use server' module — a Server Action" });
    }

    for (const spec of specifiersIn(source)) {
      const forbidden = FORBIDDEN.find((f) => f.pattern.test(spec));
      if (forbidden) {
        findings.push({ file: rel, problem: `imports '${spec}' — ${forbidden.why}` });
      }
      if (spec.startsWith('.')) {
        const next = resolveRelative(file, spec);
        if (next) queue.push(next);
      }
    }
  }

  return findings;
}

describe('⛔ the clock terminal is client-only (bible §5.2)', () => {
  it('the route exists and is a client component', () => {
    const source = readIfExists(ENTRY);
    expect(source, `${ENTRY} is missing`).not.toBeNull();
    expect(source!).toMatch(/^\s*['"]use client['"]/);
  });

  it('⛔ nothing it imports needs a server — checked across the whole reachable graph', () => {
    const findings = walk(ENTRY);
    const report = findings.map((f) => `  ${f.file} ${f.problem}`).join('\n');
    expect(
      findings,
      findings.length
        ? `The clock terminal must work with the network pulled, so nothing on its import graph ` +
            `may need a server (bible §5.2):\n${report}`
        : '',
    ).toEqual([]);
  });

  /**
   * ⭐ The guard proving the guard. T-180 established the discipline: every refusal in the ruleset
   * was **watched failing** against a permissive version, because a test that has never failed is
   * a test nobody has proven detects anything.
   *
   * This feeds the walker a file that imports `@shareat/db` and asserts it is caught — so a future
   * refactor that quietly breaks the detection (a changed regex, a resolution bug) turns this red
   * instead of leaving the real check silently passing on everything.
   */
  it('⭐ the detector actually detects — watched failing, not assumed', () => {
    const decoy = join(appRoot, 'tests/fixtures/detector-probe.tsx');
    expect(existsSync(decoy), 'the probe fixture is missing').toBe(true);
    const findings = walk(decoy);
    expect(findings.some((f) => f.problem.includes('@shareat/db'))).toBe(true);
    expect(findings.some((f) => f.problem.includes("'use server'"))).toBe(true);
  });
});
