import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-004's one real cost: a monorepo trades a boundary the filesystem enforced for one
 * that only a rule enforces. In separate repos, POS *could not* import CUSTOMER's
 * internals — there was nothing to import. Here it is one relative path away, and doing
 * it would silently rebuild the exact coupling ADR-003 spent a day deleting.
 *
 * THE RULE (PROJECT_BIBLE.md §8): an app may never import from another app.
 * Apps depend on packages/. Packages never depend on apps.
 *
 * This test is the enforcement. It is deliberately dependency-free and runs in the
 * existing unit gate, because the project has no linter at all (DEF-027) and waiting for
 * one would leave the boundary unguarded through the first front-end rebuild.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const APPS = join(root, 'apps');
const PACKAGES = join(root, 'packages');

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|jsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every `from '...'` / `import('...')` / `require('...')` specifier in a file. */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) out.push(m[1]);
  }
  return out;
}

const appNames = existsSync(APPS)
  ? readdirSync(APPS).filter((n) => statSync(join(APPS, n)).isDirectory())
  : [];

describe('app boundaries — bible §8, ADR-004', () => {
  it('has apps to check (guards against this test silently passing on an empty tree)', () => {
    expect(appNames.length).toBeGreaterThan(0);
  });

  it('no app imports from another app', () => {
    const violations: string[] = [];

    for (const app of appNames) {
      for (const file of sourceFiles(join(APPS, app))) {
        for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
          // A workspace-name import of a sibling app, e.g. '@shareat/pos'.
          const byName = appNames.find(
            (other) => other !== app && (spec === `@shareat/${other}` || spec.startsWith(`@shareat/${other}/`)),
          );
          // A relative escape into a sibling app, e.g. '../../customer/src/x'.
          const byPath = spec.startsWith('.')
            ? appNames.find((other) => {
                if (other === app) return false;
                const resolved = join(file, '..', spec);
                return relative(join(APPS, other), resolved).startsWith('..') === false;
              })
            : undefined;

          const offender = byName ?? byPath;
          if (offender) {
            violations.push(`${relative(root, file).split(sep).join('/')} imports '${spec}' (app: ${offender})`);
          }
        }
      }
    }

    expect(
      violations,
      `An app may never import from another app. Apps depend on packages/; move the shared code into packages/.\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('no package imports from an app', () => {
    const violations: string[] = [];

    for (const file of sourceFiles(PACKAGES)) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        const byName = appNames.find(
          (a) => spec === `@shareat/${a}` || spec.startsWith(`@shareat/${a}/`),
        );
        const byPath =
          spec.startsWith('.') &&
          !relative(APPS, join(file, '..', spec)).startsWith('..')
            ? 'apps/'
            : undefined;

        if (byName ?? byPath) {
          violations.push(`${relative(root, file).split(sep).join('/')} imports '${spec}'`);
        }
      }
    }

    expect(
      violations,
      `Packages must never depend on apps — that inverts the dependency and couples every front-end to one.\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
