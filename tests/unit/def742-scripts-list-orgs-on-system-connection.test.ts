import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEF-742 — every script that lists organisations (`listOrgsToRun`) must do it on the SYSTEM
 * connection (`systemTransaction`), never on a bare `transaction()`.
 *
 * Why: `organizations` has FORCE ROW LEVEL SECURITY. A bare `transaction()` carries no principal,
 * so the policy hides every row and the script reports "No organizations exist" while one does.
 * `scripts/backfill-canonical-positions.ts` already does it right (see its header comment).
 *
 * This guard walks every file under `scripts/` (which includes `scripts/lib/`), finds each
 * `listOrgsToRun(` call, and asks which transaction helper encloses it. Anything other than
 * `systemTransaction` fails.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(repoRoot, 'scripts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

/**
 * Returns one entry per `listOrgsToRun(` call in `src`: the name of the innermost enclosing
 * `transaction` / `systemTransaction` call, or `'none'` if neither encloses it.
 *
 * A single forward pass that skips comments and string literals, and keeps a stack of the open
 * parentheses (each labelled with the identifier just before it). Comments are skipped so a
 * mention in prose never counts as a call.
 */
function listOrgsCallOwners(src: string): string[] {
  const owners: string[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(') {
      const before = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(Math.max(0, i - 64), i));
      const name = before ? before[1]! : '';
      if (name === 'listOrgsToRun') {
        const owner = [...stack]
          .reverse()
          .find((n) => n === 'transaction' || n === 'systemTransaction');
        owners.push(owner ?? 'none');
      }
      stack.push(name);
      i++;
      continue;
    }
    if (c === ')') {
      stack.pop();
    }
    i++;
  }
  return owners;
}

/** Owners of `listOrgsToRun` calls that are NOT the system connection. */
function badOwners(src: string): string[] {
  return listOrgsCallOwners(src).filter((o) => o !== 'systemTransaction');
}

describe('DEF-742 — listOrgsToRun runs only on the system connection', () => {
  it('detector goes red on a planted bare transaction() call (in-memory)', () => {
    const planted = `
      export async function run() {
        const orgs = await transaction((tx) => schedulerRepo.listOrgsToRun(tx));
      }
    `;
    expect(listOrgsCallOwners(planted)).toEqual(['transaction']);
    expect(badOwners(planted)).toEqual(['transaction']);
  });

  it('detector accepts a planted systemTransaction() call (in-memory)', () => {
    const planted = `
      export async function run() {
        const orgs = await systemTransaction((tx) => schedulerRepo.listOrgsToRun(tx));
      }
    `;
    expect(listOrgsCallOwners(planted)).toEqual(['systemTransaction']);
    expect(badOwners(planted)).toEqual([]);
  });

  it('detector ignores a mention of listOrgsToRun( inside a comment', () => {
    const planted = `
      // the bare transaction((tx) => schedulerRepo.listOrgsToRun(tx)) is wrong
      /* listOrgsToRun( inside a block comment */
      export const x = 1;
    `;
    expect(listOrgsCallOwners(planted)).toEqual([]);
  });

  it('⭐ positive control — the scan finds real listOrgsToRun call sites in scripts/', () => {
    // reference_sweep_needs_nonzero_control: a scan that found nothing would pass vacuously.
    // Four call sites exist today (three bare, one correct in backfill-canonical-positions.ts).
    let total = 0;
    for (const abs of walk(SCRIPTS_DIR)) {
      if (!/\.(ts|mjs)$/.test(abs) || abs.endsWith('.test.ts')) continue;
      total += listOrgsCallOwners(readFileSync(abs, 'utf8')).length;
    }
    expect(total).toBeGreaterThanOrEqual(4);
  });

  it('every listOrgsToRun( call under scripts/ sits inside systemTransaction(, not a bare transaction(', () => {
    const offenders: string[] = [];
    for (const abs of walk(SCRIPTS_DIR)) {
      if (!/\.(ts|mjs)$/.test(abs) || abs.endsWith('.test.ts')) continue;
      const bad = badOwners(readFileSync(abs, 'utf8'));
      if (bad.length > 0) {
        offenders.push(`${path.relative(repoRoot, abs).split(path.sep).join('/')} — ${bad.join(', ')}`);
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `listOrgsToRun() called outside systemTransaction() (${offenders.length} file(s)):\n  ` +
            `${offenders.join('\n  ')}\n\n` +
            'organizations has FORCE RLS: a bare transaction() reads no rows, so the script reports ' +
            '"No organizations exist". Wrap the call in systemTransaction() as ' +
            'scripts/backfill-canonical-positions.ts does (DEF-742).',
    ).toEqual([]);
  });
});
