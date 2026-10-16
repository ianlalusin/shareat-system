/**
 * T-417 (phase S, PC-2) - `apps/pos` and `apps/customer` are real, empty, self-contained workspaces.
 * `docs/tasks/417-pos-customer-monorepo-setup.md` acceptance cases 1, 3, 6, 7 and the version
 * rulings. Static file/config shape only; no build is run here.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), 'utf8');
const readJson = (...p: string[]) => JSON.parse(read(...p)) as Record<string, any>;

const APPS = {
  pos: { port: 9009, appId: 'net.shareat.pos2' },
  customer: { port: 9010, appId: 'net.shareat.order' },
} as const;
type AppName = keyof typeof APPS;
const names = Object.keys(APPS) as AppName[];

/** `-p 9009` / `--port 9009` in an npm script line. */
function portOf(script: string | undefined): number | undefined {
  const m = /(?:-p|--port)[ =](\d+)/.exec(script ?? '');
  return m ? Number(m[1]) : undefined;
}

describe.each(names)('T-417 apps/%s is a real workspace', (app) => {
  const dir = `apps/${app}`;

  it('is a root workspace and named @shareat/<app>. Mutant: not added to root workspaces', () => {
    const rootPkg = readJson('package.json');
    expect(rootPkg.workspaces).toContain(dir);
    expect(existsSync(path.join(repoRoot, dir, 'package.json'))).toBe(true);
    expect(readJson(dir, 'package.json').name).toBe(`@shareat/${app}`);
  });

  it('has its own tsconfig that extends the root one. Mutant: app tsconfig missing or not extending root', () => {
    const file = path.join(repoRoot, dir, 'tsconfig.json');
    expect(existsSync(file)).toBe(true);
    const ts = JSON.parse(readFileSync(file, 'utf8'));
    expect(ts.extends).toBe('../../tsconfig.json');
    expect(Array.isArray(ts.include)).toBe(true);
    expect(ts.include.length).toBeGreaterThan(0);
  });

  it('defines its OWN @/* paths and every paths target stays inside the app or packages/. Mutant: @/* -> ../erp/src/*', () => {
    const ts = readJson(dir, 'tsconfig.json');
    const paths = (ts.compilerOptions?.paths ?? {}) as Record<string, string[]>;
    expect(paths['@/*']).toEqual(['./src/*']);
    const bad: string[] = [];
    for (const [alias, targets] of Object.entries(paths)) {
      for (const t of targets) {
        const abs = path.resolve(repoRoot, dir, t);
        const inApp = !path.relative(path.join(repoRoot, dir), abs).startsWith('..');
        const inPackages = !path.relative(path.join(repoRoot, 'packages'), abs).startsWith('..');
        if (!inApp && !inPackages) bad.push(`${alias} -> ${t}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('is excluded from the root tsconfig so the ERP typecheck never compiles it (case 1)', () => {
    const rootTs = readJson('tsconfig.json');
    expect(rootTs.exclude).toContain(dir);
  });

  it('serves on its own port: dev and start (case 6)', () => {
    const scripts = readJson(dir, 'package.json').scripts as Record<string, string>;
    expect(portOf(scripts.dev)).toBe(APPS[app].port);
    expect(portOf(scripts.start)).toBe(APPS[app].port);
    expect(scripts.start).toMatch(/127\.0\.0\.1/);
  });

  it('has build and build:cap scripts; build:cap sets BUILD_TARGET=capacitor (ruling 3)', () => {
    const scripts = readJson(dir, 'package.json').scripts as Record<string, string>;
    expect(scripts.build).toMatch(/next build/);
    expect(scripts['build:cap']).toBeTruthy();
    const capScript = scripts['build:cap'] ?? '';
    // Either inline env, or a 5-line scripts/build-cap.mjs inside the app that sets it.
    const viaFile = /node\s+(\S*build-cap\.mjs)/.exec(capScript);
    const body = viaFile ? read(dir, viaFile[1]!.replace(/^\.\//, '')) : capScript;
    expect(body).toMatch(/BUILD_TARGET\W+capacitor/);
  });

  it('uses exactly the ERP next/react/react-dom ranges and Capacitor ^6 in the right sections (ruling 2, case 14)', () => {
    const erp = readJson('apps/erp/package.json');
    const pkg = readJson(dir, 'package.json');
    for (const dep of ['next', 'react', 'react-dom']) {
      expect(pkg.dependencies?.[dep], dep).toBe(erp.dependencies[dep]);
    }
    expect(pkg.dependencies?.['@capacitor/core']).toMatch(/^\^6/);
    expect(pkg.devDependencies?.['@capacitor/cli']).toMatch(/^\^6/);
    expect(pkg.devDependencies?.['@capacitor/android']).toMatch(/^\^6/);
  });

  it('has a root page and no API routes (ruling 3; T-422 for pos)', () => {
    expect(existsSync(path.join(repoRoot, dir, 'src/app/layout.tsx'))).toBe(true);
    expect(existsSync(path.join(repoRoot, dir, 'src/app/page.tsx'))).toBe(true);
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
      );
    const srcApp = path.join(repoRoot, dir, 'src/app');
    const routeHandlers = walk(srcApp).filter((f) => /[\\/]route\.(ts|js|tsx)$/.test(f));
    expect(routeHandlers).toEqual([]);
    // T-422 filled apps/pos with POS v1's floor screens (its root page renders the login page), so
    // for pos the app name is checked where the copy puts it: the root layout's title.
    if (app === 'pos') expect(read(dir, 'src/app/layout.tsx')).toContain('Shareat POS v2');
    else expect(read(dir, 'src/app/page.tsx')).toContain('Shareat Customer v2');
  });

  it('gitignores build output and signing material', () => {
    const gi = read(dir, '.gitignore').split(/\r?\n/).map((l) => l.trim());
    for (const entry of ['out/', '.next/', 'android/app/build/', 'android/app/src/main/assets/public/', 'android/.gradle/', '*.jks']) {
      expect(gi, entry).toContain(entry);
    }
  });
});

describe('T-417 ports across all apps (case 6)', () => {
  it('no two apps/*/package.json share a dev or start port. Mutant: 9003 kept / copy-paste port', () => {
    const seen = new Map<number, string>();
    const clashes: string[] = [];
    for (const e of readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })) {
      const pj = path.join(repoRoot, 'apps', e.name, 'package.json');
      if (!e.isDirectory() || !existsSync(pj)) continue;
      const scripts = (JSON.parse(readFileSync(pj, 'utf8')).scripts ?? {}) as Record<string, string>;
      for (const key of ['dev', 'start']) {
        const port = portOf(scripts[key]);
        if (port === undefined) continue;
        const prev = seen.get(port);
        if (prev && prev !== e.name) clashes.push(`${port}: ${prev} and ${e.name}`);
        seen.set(port, e.name);
      }
    }
    expect(clashes).toEqual([]);
    expect(seen.get(9009)).toBe('pos');
    expect(seen.get(9010)).toBe('customer');
    expect(seen.get(9008)).toBe('erp');
  });

  it('root dev:pos and dev:customer scripts exist; root build/dev/start stay ERP-only', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts['dev:pos']).toMatch(/@shareat\/pos/);
    expect(scripts['dev:customer']).toMatch(/@shareat\/customer/);
    expect(scripts.build).toBe('npm run build -w @shareat/erp');
    expect(scripts.dev).toBe('npm run dev -w @shareat/erp');
    expect(scripts.start).toBe('npm run start -w @shareat/erp');
    expect(scripts.typecheck).toBe('tsc --noEmit');
  });
});

describe('T-417 Android app ids (case 7)', () => {
  const idsOf = (app: AppName) => {
    const cap = read(`apps/${app}/capacitor.config.ts`);
    const gradle = read(`apps/${app}/android/app/build.gradle`);
    return {
      cap: /appId\s*:\s*['"]([^'"]+)['"]/.exec(cap)?.[1],
      gradle: /applicationId\s+['"]([^'"]+)['"]/.exec(gradle)?.[1],
    };
  };

  it.each(names)('%s: capacitor appId equals gradle applicationId and is the ruled id', (app) => {
    const { cap, gradle } = idsOf(app);
    expect(cap).toBe(APPS[app].appId);
    expect(gradle).toBe(cap);
  });

  it.each(names)('%s: never reuses v1\'s id or the culinaryflow name. Mutant: v1 id reused (installs over v1, wipes unsent sales)', (app) => {
    const { cap, gradle } = idsOf(app);
    for (const id of [cap, gradle]) {
      expect(id).not.toBe('net.shareat.pos');
      expect(id).not.toMatch(/culinaryflow/i);
    }
  });

  it('the two apps have different ids', () => {
    expect(idsOf('pos').cap).not.toBe(idsOf('customer').cap);
  });

  it.each(names)('%s: release signing reads the RELEASE_* env vars, never a literal secret', (app) => {
    const gradle = read(`apps/${app}/android/app/build.gradle`);
    expect(gradle).toMatch(/signingConfigs\s*\{[\s\S]*release/);
    for (const v of ['RELEASE_STORE_PASSWORD', 'RELEASE_KEY_ALIAS', 'RELEASE_KEY_PASSWORD']) {
      expect(gradle, v).toContain(v);
    }
  });
});
