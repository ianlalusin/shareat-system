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

// T-417: `out` (Capacitor static export) and `android` (generated native project, web assets copied
// in) hold BUILT bundles, not source. Scanning them is slow and false-alarms after a local `build:cap`.
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'out', 'android']);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
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

function appNamesIn(appsDir: string): string[] {
  return existsSync(appsDir) ? readdirSync(appsDir).filter((n) => statSync(join(appsDir, n)).isDirectory()) : [];
}

/**
 * The app->app detector, parameterised on the apps directory so the fixtures below can feed it
 * known-bad trees (T-417 case 4: today the real tree has no cross-app import, so without fixtures
 * a detector that returned [] would pass vacuously). Paths are reported relative to `base`.
 */
function appToAppViolations(appsDir: string, base: string): string[] {
  const names = appNamesIn(appsDir);
  const violations: string[] = [];
  for (const app of names) {
    for (const file of sourceFiles(join(appsDir, app))) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        // A workspace-name import of a sibling app, e.g. '@shareat/pos'.
        const byName = names.find(
          (other) => other !== app && (spec === `@shareat/${other}` || spec.startsWith(`@shareat/${other}/`)),
        );
        // A relative escape into a sibling app, e.g. '../../customer/src/x'.
        const byPath = spec.startsWith('.')
          ? names.find((other) => {
              if (other === app) return false;
              const resolved = join(file, '..', spec);
              return relative(join(appsDir, other), resolved).startsWith('..') === false;
            })
          : undefined;

        const offender = byName ?? byPath;
        if (offender) {
          violations.push(`${relative(base, file).split(sep).join('/')} imports '${spec}' (app: ${offender})`);
        }
      }
    }
  }
  return violations;
}

const appNames = appNamesIn(APPS);

describe('app boundaries — bible §8, ADR-004', () => {
  it('has apps to check (guards against this test silently passing on an empty tree)', () => {
    expect(appNames.length).toBeGreaterThan(0);
  });

  it('no app imports from another app', () => {
    const violations = appToAppViolations(APPS, root);
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

// T-417 cases 4 and 5 — the detector is proven on known-bad trees, so a detector that returns []
// (or scans built bundles) cannot hide behind a real tree that happens to be clean.
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'app-boundaries');
const fixtureApps = (name: string) => join(FIXTURES, name, 'apps');

describe('app boundaries — detector fixtures (T-417)', () => {
  it('reports pos importing erp by relative path. Mutant: detector returns []', () => {
    const v = appToAppViolations(fixtureApps('pos-relative'), FIXTURES);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('pos-relative/apps/pos/src/a.tsx');
    expect(v[0]).toContain('(app: erp)');
  });

  it('reports pos importing @shareat/erp/... by workspace name', () => {
    const v = appToAppViolations(fixtureApps('pos-by-name'), FIXTURES);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('pos-by-name/apps/pos/src/a.tsx');
    expect(v[0]).toContain('(app: erp)');
  });

  it('reports erp importing @shareat/customer', () => {
    const v = appToAppViolations(fixtureApps('erp-imports-customer'), FIXTURES);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('erp-imports-customer/apps/erp/src/a.tsx');
    expect(v[0]).toContain('(app: customer)');
  });

  it('reports nothing for a clean tree (the detector is not just always-red)', () => {
    expect(appToAppViolations(fixtureApps('clean'), FIXTURES)).toEqual([]);
  });

  it('does NOT report cross-app imports inside apps/pos/out/ or apps/pos/android/, and does not even list them. Mutant: built bundles scanned', () => {
    const apps = fixtureApps('skipped-dirs');
    expect(appToAppViolations(apps, FIXTURES)).toEqual([]);
    const listed = sourceFiles(join(apps, 'pos')).map((f) => relative(apps, f).split(sep).join('/'));
    expect(listed).toEqual(['pos/src/ok.tsx']);
  });
});
