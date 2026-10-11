import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-391 S6 census. `canAt(tx, personId, capability, storeId)` (packages/auth) answers "who can do what" for an ARBITRARY
 * personId. That is a report-time question (readiness), never a request-time one: a request path decides with
 * `authorize()` for the signed-in actor. So no file under apps/** may import or mention `canAt`.
 * The scanner is exercised against in-memory fixture strings, so a violation is proven to be caught.
 */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const APPS = join(root, 'apps');

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|jsx|mts|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** Any reference at all: an import, a call, a re-export, an alias, a property access, a string. */
const CAN_AT = /\bcanAt\b/;
export function referencesCanAt(src: string): boolean {
  return CAN_AT.test(src);
}

describe('T-391 S6 - canAt is unreachable from apps/**', () => {
  it('the scanner catches every shape of reference (proof it would fail on a violation)', () => {
    const violations = [
      "import { authorize, canAt } from '@shareat/auth';",
      "import { canAt as can } from '@shareat/auth';",
      "export { canAt } from '@shareat/auth';",
      "const ok = await canAt(tx, personId, 'create_expense', storeId);",
      "const auth = await import('@shareat/auth'); await auth.canAt(tx, p, c, s);",
      "const f = auth['canAt'];",
    ];
    for (const v of violations) expect(referencesCanAt(v), v).toBe(true);
    const clean = [
      "import { authorize } from '@shareat/auth';",
      'const canAttend = true; const scanAt = 1;',
      'await authorize(tx, actor, "create_expense", { storeId });',
    ];
    for (const c of clean) expect(referencesCanAt(c), c).toBe(false);
  });

  it('has app files to scan (guards against passing on an empty tree)', () => {
    expect(sourceFiles(APPS).length).toBeGreaterThan(0);
  });

  it('no file under apps/** imports or references canAt', () => {
    const offenders = sourceFiles(APPS)
      .filter((f) => referencesCanAt(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(offenders, 'canAt must never be reachable from a request path; use authorize() for the signed-in actor').toEqual([]);
  });
});
