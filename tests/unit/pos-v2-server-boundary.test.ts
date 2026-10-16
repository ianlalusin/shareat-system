/**
 * T-424 slice T - tree guards for the POS v2 server boundary. Acceptance 1 (+ Ruling 2, Ruling 1's build:cap stash).
 * Reads the tree with fs; imports no app code. The positive side of the narrowed T-422 guard in `pos-v2-copy.test.ts`.
 *
 *  - no CLIENT file (any code under apps/pos/src outside src/app/api/pos2, src/server, src/middleware.ts, tests, test-helpers, fixtures) imports
 *    `firebase-admin`, `@shareat/db`, `@shareat/auth`, `@shareat/domain`, `server-only` or `src/server/**`;
 *  - the import CLOSURE of the client (pages, layouts, providers, i18n...) never reaches src/server, src/app/api or src/middleware.ts;
 *  - every non-test file under src/server starts with `import 'server-only'`;
 *  - `build:cap` stashes src/app/api and src/middleware.ts during the static export and always restores them;
 *  - no service-account key or database URL is committed or exposed through a NEXT_PUBLIC_ variable.
 *
 * RED FOR THE RIGHT REASON: the "non-vacuous" test asserts the server tree exists (it does not yet); the others are guards that must stay green.
 * MUTANTS: M1 a component imports @/server/...; M2 a client lib imports @shareat/auth; M3 a server file without 'server-only';
 *   M4 build-cap forgets to stash middleware; M5 NEXT_PUBLIC_POS_FIREBASE_SA_KEY; M6 a page reaches firebase-admin through a helper.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const POS = path.join(repoRoot, 'apps', 'pos');
const SRC = path.join(POS, 'src');
const rel = (f: string) => path.relative(POS, f).split(path.sep).join('/');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    ['node_modules', '.next', 'out', 'android'].includes(e.name) ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const isCode = (f: string) => /\.(ts|tsx|mts)$/.test(f) && !/\.d\.ts$/.test(f);
const isTest = (f: string) => /\.test\.(ts|tsx)$/.test(f) || /[\\/]__tests__[\\/]/.test(f);
const isServerFile = (f: string) => /^src\/(app\/api\/pos2\/|server\/)/.test(rel(f)) || rel(f) === 'src/middleware.ts';
const isSupport = (f: string) => /^src\/(test-helpers\/|(.*\/)?__fixtures__\/)/.test(rel(f));

function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) out.push(m[1]);
  }
  return out;
}
function resolveSpec(spec: string, fromFile: string): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return undefined;
  const candidates = [base, ...['.ts', '.tsx', '.mts'].map((e) => base + e), ...['index.ts', 'index.tsx'].map((i) => path.join(base, i))];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile() && isCode(c));
}
const FORBIDDEN_PKG = /^(firebase-admin(\/.*)?|@shareat\/(db|auth|domain)(\/.*)?|server-only)$/;

const allCode = () => walk(SRC).filter(isCode);
const clientFiles = () => allCode().filter((f) => !isServerFile(f) && !isTest(f) && !isSupport(f));
const POS2_ROUTES = ['refunds', 'tender-corrections', 'session-voids', 'analytics/apply-delta'];
const SERVER_MODULES = ['deps', 'refunds', 'tender-corrections', 'session-voids', 'apply-delta'];

describe('T-424 Acceptance 1 - the server tree exists (non-vacuous guard)', () => {
  it.each(POS2_ROUTES)('src/app/api/pos2/%s/route.ts exists', (r) => {
    expect(existsSync(path.join(SRC, 'app', 'api', 'pos2', ...r.split('/'), 'route.ts'))).toBe(true);
  });
  it.each(SERVER_MODULES)('src/server/pos2/%s.ts exists', (m) => {
    expect(existsSync(path.join(SRC, 'server', 'pos2', `${m}.ts`))).toBe(true);
  });
  it('src/middleware.ts exists (CORS for the APK origin)', () => {
    expect(existsSync(path.join(SRC, 'middleware.ts'))).toBe(true);
  });
});

describe('T-424 Acceptance 1 - no client file reaches server code', () => {
  it('no client file imports firebase-admin, @shareat/db|auth|domain, server-only, or src/server/** (M1, M2, M6)', () => {
    const bad: string[] = [];
    for (const f of clientFiles()) {
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        const resolved = resolveSpec(s, f);
        if (FORBIDDEN_PKG.test(s)) bad.push(`${rel(f)} imports ${s}`);
        else if (s.startsWith('@/server/') || s === '@/server' || s === '@/middleware') bad.push(`${rel(f)} imports ${s}`);
        else if (resolved && isServerFile(resolved)) bad.push(`${rel(f)} imports ${rel(resolved)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the import closure of every page, layout and provider never reaches src/server, src/app/api or src/middleware.ts (M6)', () => {
    const app = path.join(SRC, 'app');
    const special = /^(page|layout|template|loading|error|global-error|not-found|default|icon|apple-icon|opengraph-image)\.(ts|tsx)$/;
    const roots = walk(app).filter((f) => special.test(path.basename(f)) && !isServerFile(f) && !isTest(f));
    const providers = path.join(app, 'providers.tsx');
    if (existsSync(providers)) roots.push(providers);
    expect(roots.length, 'client roots exist (non-vacuous)').toBeGreaterThan(20);
    const seen = new Set<string>();
    const stack = [...roots];
    const via = new Map<string, string>();
    const bad: string[] = [];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of specifiers(readFileSync(f, 'utf8'))) {
        if (FORBIDDEN_PKG.test(spec)) bad.push(`${rel(f)} -> ${spec}`);
        const r = resolveSpec(spec, f);
        if (!r) continue;
        if (isServerFile(r)) bad.push(`${rel(f)} -> ${rel(r)}`);
        else if (!seen.has(r)) {
          via.set(r, f);
          stack.push(r);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("T-424 Ruling 2 - server files are marked 'server-only'", () => {
  it("every non-test file under src/server starts with import 'server-only' (M3)", () => {
    const files = walk(path.join(SRC, 'server')).filter((f) => isCode(f) && !isTest(f));
    expect(files.length, 'server files exist (non-vacuous)').toBeGreaterThan(SERVER_MODULES.length - 1);
    const bad: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter(Boolean);
      if (!/^import\s+['"]server-only['"];?$/.test(code[0] ?? '')) bad.push(rel(f));
    }
    expect(bad).toEqual([]);
  });

  it('only server paths import firebase-admin or @shareat/db|auth|domain (the positive restatement)', () => {
    const importers = allCode()
      .filter((f) => !isTest(f) && !isSupport(f))
      .filter((f) => specifiers(readFileSync(f, 'utf8')).some((s) => /^(firebase-admin(\/.*)?|@shareat\/(db|auth|domain)(\/.*)?)$/.test(s)))
      .map(rel);
    for (const f of importers) expect(f.startsWith('src/server/') || f.startsWith('src/app/api/pos2/'), f).toBe(true);
  });
});

describe('T-424 Ruling 1 - build:cap leaves the server out of the APK', () => {
  const script = () => readFileSync(path.join(POS, 'scripts', 'build-cap.mjs'), 'utf8');

  it('build-cap.mjs stashes src/app/api and src/middleware.ts before the build and restores them in a finally (M4)', () => {
    const s = script();
    expect(s).toMatch(/src[\\/]+app[\\/]+api|['"]app['"]\s*,\s*['"]api['"]/);
    expect(s).toMatch(/middleware/);
    expect(s).toMatch(/finally/);
    expect(s).toMatch(/rename|renameSync|cpSync|mv\b|move/i);
  });

  it('the package script is still `node scripts/build-cap.mjs` and the server start script serves the standard build', () => {
    const pkg = JSON.parse(readFileSync(path.join(POS, 'package.json'), 'utf8'));
    expect(pkg.scripts['build:cap']).toBe('node scripts/build-cap.mjs');
    expect(pkg.scripts.start).toMatch(/next start/);
  });

  it('a built APK bundle (apps/pos/out), when present, holds no API route output and no admin SDK', () => {
    const out = path.join(POS, 'out');
    if (!existsSync(out)) return; // build:cap has not been run in this checkout; Acceptance 9 runs it
    expect(existsSync(path.join(out, 'api'))).toBe(false);
    const hits = walk(out).filter((f) => /\.(js|html|txt)$/.test(f)).filter((f) => /firebase-admin|server-only|POS_FIREBASE_SA_KEY_FILE/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(out, f))).toEqual([]);
  });
});

describe('T-424 Ruling 4 - credentials are never committed or exposed to the client', () => {
  it('no NEXT_PUBLIC_ variable names a service-account key or a database URL, anywhere in apps/pos (M5)', () => {
    const bad: string[] = [];
    for (const f of [...allCode(), ...['package.json', 'next.config.mjs', 'capacitor.config.ts'].map((n) => path.join(POS, n))].filter(existsSync)) {
      const text = readFileSync(f, 'utf8');
      if (/NEXT_PUBLIC_[A-Z0-9_]*(SA_KEY|SERVICE_ACCOUNT|DATABASE_URL|PRIVATE_KEY)/.test(text)) bad.push(rel(f));
    }
    expect(bad).toEqual([]);
  });

  it('no file under apps/pos holds a Google service-account private key or a committed key file', () => {
    const bad: string[] = [];
    for (const f of walk(POS)) {
      if (/service-?account.*\.json$/i.test(f) || /firebase-adminsdk.*\.json$/i.test(f)) bad.push(rel(f));
      else if (/\.(ts|tsx|mjs|json|md|env|example)$/.test(f) && readFileSync(f, 'utf8').includes('"private_key"')) bad.push(rel(f));
    }
    expect(bad).toEqual([]);
  });

  it('POS_FIREBASE_SA_KEY_FILE is read only by server code', () => {
    const readers = allCode()
      .filter((f) => !isTest(f) && !isSupport(f))
      .filter((f) => readFileSync(f, 'utf8').includes('POS_FIREBASE_SA_KEY_FILE'))
      .map(rel);
    for (const f of readers) expect(f.startsWith('src/server/') || f.startsWith('src/app/api/pos2/'), f).toBe(true);
  });
});
