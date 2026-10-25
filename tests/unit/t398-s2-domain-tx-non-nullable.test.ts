/**
 * T-398 S2b - the DEF-421 guard in its FINAL form. `docs/tasks/398-padre-garcia-franchise-org.md` S2, R4, A9, B2, D5, D6.
 *
 * History: S2a shipped this file as a RATCHET (per-directory ceilings: 206 `Tx | null` in 55 files, 188 `\btransaction\(`
 * in 60 files; re-measured on main fb17323 for S2b: still exactly 206 / 55 and 188 / 60, nothing drifted with T-441/T-464).
 * S2b (this version) moves every pin to its post-conversion TARGET, so the file is RED until the builder lands:
 *   - `Tx | null` target: ONE occurrence, in `fixed-assets` (the `runDepreciation` signature, A9/B2).
 *   - non-member `transaction(` target: ZERO (D6: `tx.transaction(` / `x.transaction(` savepoints are allowed, so the T2 count
 *     is the NON-MEMBER form `(?<![.\w$])transaction\(`; 177 in 56 files today, the other 11 of the 188 are member calls).
 * The ratchet mechanism is unchanged (rise = fail, fall without lowering the pin = fail), so the target can never regress.
 *
 * Added in S2b, same file:
 *   - T1  no exported domain function takes `tx: Tx | null` (only that form; optional `tx?:` and `| undefined` are NOT
 *         covered, per orchestrator ruling 2026-10-24); the offender set is pinned BY VALUE to
 *         ['runDepreciation'] (D5: the allow-list does NOT grow - dual-run is fixed at its call site, not allow-listed).
 *   - T2  no `transaction` import from @shareat/db (or /client) in packages/domain/src.
 *   - D5  scripts/dual-run.ts calls runDualRun inside withOrgPrincipal and never with null.
 *
 * Comments are stripped before every measurement (a doc comment saying "Tx | null" is not a signature).
 * Pure `fs` traversal; scans packages/domain/src only (never .claude/ or nested worktrees, DEF-669); skips node_modules, `tests`
 * dirs and *.test.ts.
 *
 * Mutants killed: `| null` put back on dispatchTradeOrder (ratchet T1 + signature T1); a second name in the allow-list const or
 * a second offender (value pin); a bare `transaction(` or `import { transaction }` anywhere in domain src (ratchet T2 + import
 * test); `withOrgPrincipal` replaced by `transaction` in runDepreciationCore (ratchet T2); `runDualRun(null, ...)` back in
 * scripts/dual-run.ts, or the call moved outside the withOrgPrincipal callback (D5).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const DOMAIN_SRC = resolve(REPO, 'packages', 'domain', 'src');
const LOOSE = '*'; // .ts files directly at packages/domain/src

/** Per-directory `Tx | null` TARGETS after S2b. Only `runDepreciation` keeps it (A9, B2). LOWER on reduction; never raise. */
const TX_NULL: Record<string, number> = { 'fixed-assets': 1 };
/** Per-directory NON-MEMBER `transaction(` TARGETS after S2b: none anywhere (D6). */
const TRANSACTION_CALLS: Record<string, number> = {};
const TX_NULL_TOTAL = 1;
const TRANSACTION_TOTAL = 0;
/** D5: pinned by value. It does NOT grow. */
const TX_NULL_ALLOWLIST = ['runDepreciation'];

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tests') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Block comments and `//` line comments out (a `//` right after `:` is a URL scheme, kept). */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const read = (f: string) => strip(readFileSync(f, 'utf8'));

function measure(re: RegExp): Record<string, number> {
  const by: Record<string, number> = {};
  for (const f of collect(DOMAIN_SRC)) {
    const n = (read(f).match(re) ?? []).length;
    if (!n) continue;
    const parts = relative(DOMAIN_SRC, f).split(sep);
    const key = parts.length > 1 ? (parts[0] as string) : LOOSE;
    by[key] = (by[key] ?? 0) + n;
  }
  return by;
}

function check(label: string, actual: Record<string, number>, pins: Record<string, number>, total: number) {
  const problems: string[] = [];
  for (const k of new Set([...Object.keys(actual), ...Object.keys(pins)])) {
    const a = actual[k] ?? 0;
    const p = pins[k] ?? 0;
    if (a > p) problems.push(`${k}: ${a} > target ${p} (DEF-421: convert / remove the ${label})`);
    if (a < p) problems.push(`${k}: ${a} < pinned ${p} (stale pin - lower the pin to ${a} in this commit)`);
  }
  const sum = Object.values(actual).reduce((x, y) => x + y, 0);
  if (sum > total) problems.push(`TOTAL ${sum} > ${total}`);
  if (sum < total) problems.push(`TOTAL ${sum} < ${total}: lower the total pin to ${sum}`);
  expect(problems, `${label} ratchet (T-398 S2b):\n${problems.join('\n')}`).toEqual([]);
}

/** The text of the balanced `( ... )` that opens at `open` (index of the '('). */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Exported functions (declarations and `export const f = (..)` arrows) whose parameter list takes `tx: Tx | null`.
 *  Only `Tx | null` counts (orchestrator ruling 2026-10-24): optional `tx?:` and `| undefined` are NOT flagged,
 *  so menu/ and pos/depletion-source.ts keep their optional tx. */
function nullableTxExports(): string[] {
  const bad = new Set<string>();
  const decl = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*?>)?\s*\(/g;
  const arrow = /export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^(]*?>\s*)?\(/g;
  for (const f of collect(DOMAIN_SRC)) {
    const src = read(f);
    for (const re of [decl, arrow]) {
      re.lastIndex = 0;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const params = balanced(src, m.index + m[0].length - 1);
        const nullable =
          /\bTx\s*\|\s*null\b/.test(params) ||
          /\b(?:tx|trx)\s*:[^,]*\|\s*null\b/.test(params);
        if (nullable) bad.add(m[1] as string);
      }
    }
  }
  return [...bad].sort();
}

describe('T-398 S2b: DEF-421 final-form guard over packages/domain/src', () => {
  it('ratchet T1: `Tx | null` occurs once in all of packages/domain/src - on runDepreciation', () => {
    check('`Tx | null`', measure(/Tx \| null/g), TX_NULL, TX_NULL_TOTAL);
  });

  it('ratchet T2: zero NON-MEMBER `transaction(` calls (D6: `tx.transaction(` savepoints are allowed)', () => {
    check('bare `transaction(` call', measure(/(?<![.\w$])transaction\(/g), TRANSACTION_CALLS, TRANSACTION_TOTAL);
  });

  it('T1: the allow-list const is exactly [runDepreciation] (D5: it does not grow)', () => {
    expect(TX_NULL_ALLOWLIST).toEqual(['runDepreciation']);
  });

  it('T1: no exported domain function takes `tx: Tx | null` except the allow-list (`tx?:` / `| undefined` not covered, orchestrator ruling 2026-10-24)', () => {
    const offenders = nullableTxExports();
    // equality, not subset: if runDepreciation ever loses its `| null` the pin is stale and must be removed here.
    expect(offenders, `exported functions with an optional/nullable tx:\n${offenders.join('\n')}`).toEqual(TX_NULL_ALLOWLIST);
  });

  it('T2: no `transaction` is imported from @shareat/db in packages/domain/src', () => {
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@shareat\/db(?:\/client)?['"]/g;
    const hits: string[] = [];
    for (const f of collect(DOMAIN_SRC)) {
      const src = read(f);
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const names = (m[1] as string).split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
        if (names.includes('transaction')) hits.push(relative(DOMAIN_SRC, f).split(sep).join('/'));
      }
    }
    expect(hits, `files importing \`transaction\` from @shareat/db:\n${hits.join('\n')}`).toEqual([]);
  });

  it('D5: scripts/dual-run.ts calls runDualRun inside withOrgPrincipal and never with null', () => {
    const src = strip(readFileSync(resolve(REPO, 'scripts', 'dual-run.ts'), 'utf8'));
    const call = /\brunDualRun\(\s*([^,)]*)/g;
    const calls: { at: number; first: string }[] = [];
    for (let m = call.exec(src); m; m = call.exec(src)) calls.push({ at: m.index, first: (m[1] as string).trim() });
    expect(calls.length, 'scripts/dual-run.ts must still call runDualRun').toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.first, `runDualRun first argument is "${c.first}" - a null/undefined tx is DEF-421`).not.toMatch(/^(?:null|undefined)\b/);
      const open = src.lastIndexOf('withOrgPrincipal(', c.at);
      expect(open, 'runDualRun is not preceded by any withOrgPrincipal(').toBeGreaterThanOrEqual(0);
      let depth = 0;
      for (const ch of src.slice(open, c.at)) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      expect(depth, 'runDualRun is called OUTSIDE the withOrgPrincipal callback').toBeGreaterThan(0);
    }
  });
});
