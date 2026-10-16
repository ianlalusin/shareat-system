/**
 * T-422 slice T - tree guards for the POS v1 -> `apps/pos` copy.
 * `docs/tasks/422-pos-v2-copy-v1.md`, Acceptance cases 1-6, 8, 9, 10. Reads the tree with fs; never
 * imports app code. The copy script's own behaviour is case 7, in `pos-v2-copy-script.test.ts`.
 *
 * Every test names the mutant it kills. Where a guard would pass vacuously on an empty tree
 * (cases 4, 5, 6), it first asserts the file it polices exists, so it is red until the copy lands.
 *
 * Spec gaps settled here (builder: follow these or tell the planner):
 *  - V1-COPY.md lists hand-edited files as backtick-quoted paths (`apps/pos/src/...` or `src/...`).
 *  - The moved page is `src/app/online-orders/page.tsx`; its v1 original is `src/app/admin/online-orders/page.tsx`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const POS = path.join(repoRoot, 'apps', 'pos');
const SRC = path.join(POS, 'src');
const APP = path.join(SRC, 'app');
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), 'utf8');
const rel = (f: string) => path.relative(POS, f).split(path.sep).join('/');

/** Ruling 1, verbatim. */
const KEPT_ROUTES = [
  '/', '/login', '/signup', '/forgot-password', '/pending', '/support', '/change-password', '/account',
  '/settings', '/cashier', '/cashier/handover', '/cashier/receipts', '/cashier/sessions', '/kitchen',
  '/kitchen/history', '/server', '/refill', '/receipts', '/receipt', '/pins', '/print/session-pin',
  '/reservations', '/reservations/details', '/online-orders',
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const srcFiles = () => walk(SRC);
const isCode = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f);
const isTest = (f: string) => /\.test\.(ts|tsx)$/.test(f);

// ---------------------------------------------------------------------------------------------
// Import walker (case 3, 5). Static `import ... from`, `export ... from`, side-effect `import 'x'`,
// and dynamic `import('x')`. `@/` -> apps/pos/src; relative paths; .ts/.tsx/index resolution.
// ---------------------------------------------------------------------------------------------
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) out.push(m[1]);
  }
  return out;
}

function resolveSpec(spec: string, fromFile: string): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return undefined; // external package
  const candidates = [
    base,
    ...['.ts', '.tsx'].map((e) => base + e),
    ...['index.ts', 'index.tsx'].map((i) => path.join(base, i)),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile() && isCode(c));
}

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = roots.filter((r) => existsSync(r));
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of specifiers(readFileSync(f, 'utf8'))) {
      const r = resolveSpec(spec, f);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

/** Route-level special files under src/app + providers.tsx (case 3 roots). */
function routeRoots(): string[] {
  const special = /^(page|layout|template|loading|error|global-error|not-found|default|route|icon|apple-icon|opengraph-image)\.(ts|tsx)$/;
  const roots = walk(APP).filter((f) => special.test(path.basename(f)) && !isTest(f));
  const providers = path.join(APP, 'providers.tsx');
  if (existsSync(providers)) roots.push(providers);
  return roots;
}

function routes(): string[] {
  return walk(APP)
    .filter((f) => /^page\.(tsx|ts|jsx|js)$/.test(path.basename(f)))
    .map((f) => {
      const dir = path.relative(APP, path.dirname(f)).split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
      return '/' + dir.join('/');
    })
    .sort();
}

// ---------------------------------------------------------------------------------------------
describe('T-422 case 1 - route set', () => {
  it('apps/pos routes equal ruling 1 exactly. Mutant: an admin/manager/report page copied, or a floor page forgotten', () => {
    expect(routes()).toEqual([...KEPT_ROUTES].sort());
  });
});

describe('T-422 case 2 - no server code', () => {
  it('no src/app/api, no middleware. Mutant: server routes shipped in the APK', () => {
    expect(existsSync(path.join(APP, 'api'))).toBe(false);
    for (const m of ['middleware.ts', 'middleware.js', 'proxy.ts']) {
      expect(existsSync(path.join(SRC, m)), m).toBe(false);
    }
    const handlers = walk(APP).filter((f) => /[\\/]route\.(ts|js|tsx)$/.test(f));
    expect(handlers).toEqual([]);
  });

  it('nothing imports firebase-admin / genkit / @anthropic-ai/sdk / server-only / @/lib/server/. Mutant: server code in the client bundle', () => {
    const bad: string[] = [];
    for (const f of srcFiles().filter(isCode)) {
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        if (
          s === 'firebase-admin' || s.startsWith('firebase-admin/') ||
          s === 'genkit' || s.startsWith('genkit/') || s.startsWith('@genkit-ai/') ||
          s === '@anthropic-ai/sdk' || s.startsWith('@anthropic-ai/sdk/') ||
          s === 'server-only' || s.startsWith('@/lib/server/') || s.includes('/lib/server/')
        ) bad.push(`${rel(f)} imports ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('T-422 case 3 - closure guard', () => {
  it('apps/pos/src has page files to walk from (non-vacuous)', () => {
    expect(routeRoots().length).toBeGreaterThan(KEPT_ROUTES.length); // pages + layouts at least
  });

  it('every non-test .ts/.tsx under src is reachable from the kept routes. Mutant: "copied all of src/" (dead admin code)', () => {
    const reach = closure(routeRoots());
    const orphans = srcFiles()
      // T-423 slice T: test support (src/test-helpers/**, vendored src/**/__fixtures__/**) is read by tests only, never by a route.
      .filter((f) => isCode(f) && !isTest(f) && !reach.has(f) && !/^src\/(test-helpers\/|(.*\/)?__fixtures__\/)/.test(rel(f)))
      .map(rel)
      .sort();
    expect(orphans).toEqual([]);
  });
});

describe('T-422 case 4 - unsafe void and paid-receipt edit are gone (DEF-651, ADR-015 A4.1/A4.2)', () => {
  const receiptsPage = path.join(APP, 'receipts', 'page.tsx');

  it('the live /receipts page exists (guard is not vacuous)', () => {
    expect(existsSync(receiptsPage)).toBe(true);
  });

  it('no handleVoidReceipt; no import of EditReceiptDialog/PaymentConvertModal/VoidReceiptModal/ReRingLinkModal; no components/receipts/page fork. Mutant: unsafe void path ported', () => {
    const bad: string[] = [];
    const forbidden = ['EditReceiptDialog', 'PaymentConvertModal', 'VoidReceiptModal', 'ReRingLinkModal'];
    for (const f of srcFiles().filter(isCode)) {
      const text = readFileSync(f, 'utf8');
      if (text.includes('handleVoidReceipt')) bad.push(`${rel(f)} contains handleVoidReceipt`);
      for (const name of forbidden) {
        if (new RegExp(`import\\s[^'";]*\\b${name}\\b[^'";]*from\\s*['"]`).test(text)) bad.push(`${rel(f)} imports ${name}`);
        if (new RegExp(`import\\(\\s*['"][^'"]*${name}`, 'i').test(text)) bad.push(`${rel(f)} dynamically imports ${name}`);
      }
      for (const s of specifiers(text)) {
        if (/(^|\/)components\/receipts\/page$/.test(s)) bad.push(`${rel(f)} imports the receipts page fork (${s})`);
      }
    }
    expect(existsSync(path.join(SRC, 'components', 'receipts', 'page.tsx'))).toBe(false);
    expect(bad).toEqual([]);
  });

  it('no updateDoc( under src/app/receipts sets status to "voided". Mutant: the plain-updateDoc void kept under a new name', () => {
    const bad: string[] = [];
    for (const f of walk(path.join(APP, 'receipts')).filter(isCode)) {
      const text = readFileSync(f, 'utf8');
      let i = text.indexOf('updateDoc(');
      while (i !== -1) {
        let depth = 0;
        let j = i + 'updateDoc'.length;
        for (; j < text.length; j++) {
          if (text[j] === '(') depth++;
          else if (text[j] === ')' && --depth === 0) break;
        }
        const call = text.slice(i, j + 1);
        if (/status\s*:\s*['"`]voided['"`]/.test(call)) bad.push(`${rel(f)}: ${call.slice(0, 80).replace(/\s+/g, ' ')}`);
        i = text.indexOf('updateDoc(', i + 1);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('T-422 case 5 - unpaid-session void survives', () => {
  it('void-session-dialog is reachable from /cashier. Mutant: over-deletion of the unpaid void', () => {
    const cashier = path.join(APP, 'cashier', 'page.tsx');
    expect(existsSync(cashier)).toBe(true);
    const reach = [...closure([cashier])].map((f) => path.basename(f));
    expect(reach).toContain('void-session-dialog.tsx');
  });
});

describe('T-422 case 6 - nav and links', () => {
  const nav = path.join(SRC, 'components', 'layout', 'main-nav.tsx');
  const kept = new Set(KEPT_ROUTES);

  it('main-nav.tsx exists and every internal link in it is a kept route; /online-orders present. Mutant: dead links to dropped pages', () => {
    expect(existsSync(nav)).toBe(true);
    const text = readFileSync(nav, 'utf8');
    const links: string[] = [];
    const re = /(?:href|to|path)\s*[:=]\s*\{?\s*['"`](\/[^'"`]*)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) links.push(m[1]!);
    expect(links.length).toBeGreaterThan(0);
    const unknown = links.map((l) => l.split(/[?#]/)[0]!).filter((l) => !kept.has(l));
    expect(unknown).toEqual([]);
    expect(links.map((l) => l.split(/[?#]/)[0])).toContain('/online-orders');
  });

  it('no path string to a dropped route (/admin, /dashboard, /manager, /sales-report, /weather-calendar) anywhere in src. Mutant: a stray redirect to a dropped page', () => {
    const bad: string[] = [];
    const re = /['"`]\/(admin|dashboard|manager|sales-report|weather-calendar)(?:[/?#'"`])/;
    for (const f of srcFiles().filter(isCode)) {
      if (re.test(readFileSync(f, 'utf8'))) bad.push(rel(f));
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Case 8 - V1-COPY.md vs the pinned v1 commit
// ---------------------------------------------------------------------------------------------
const V1_COMMIT = 'e26d0c1';
const V1_REPO = 'C:\\Users\\ianla\\webapps\\POS';
const v1Present = (() => {
  if (!existsSync(V1_REPO)) return false;
  try {
    execFileSync('git', ['-C', V1_REPO, 'cat-file', '-e', `${V1_COMMIT}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('T-422 case 8 - V1-COPY.md', () => {
  const doc = path.join(POS, 'V1-COPY.md');

  it('exists and names the pinned v1 commit. Mutant: no provenance for the copy', () => {
    expect(existsSync(doc)).toBe(true);
    expect(readFileSync(doc, 'utf8')).toContain(V1_COMMIT);
  });

  if (!v1Present) console.warn(`[T-422 case 8] ${V1_REPO} @ ${V1_COMMIT} not available - hand-edit diff skipped (expected in CI).`);

  it.skipIf(!v1Present)('lists exactly the files whose content differs from v1. Mutant: an unlogged hand edit', () => {
    expect(existsSync(doc)).toBe(true);
    const MOVED: Record<string, string> = {
      'src/app/online-orders/page.tsx': 'src/app/admin/online-orders/page.tsx',
    };
    const norm = (b: Buffer) => b.toString('latin1').replace(/\r\n/g, '\n');
    const v1Content = (p: string): string | undefined => {
      try {
        return norm(execFileSync('git', ['-C', V1_REPO, 'show', `${V1_COMMIT}:${p}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch {
        return undefined;
      }
    };
    const files = [...walk(SRC), ...walk(path.join(POS, 'public'))].map(rel);
    const changed: string[] = [];
    const identicalToV1 = new Set<string>();
    for (const f of files) {
      const orig = v1Content(MOVED[f] ?? f);
      if (orig === undefined) continue; // new file (not a copy)
      if (orig === norm(readFileSync(path.join(POS, f)))) identicalToV1.add(f);
      else changed.push(f);
    }
    const listed = new Set<string>();
    const re = /`((?:apps\/pos\/)?(?:src|public)\/[^`\s]+)`/g;
    let m: RegExpExecArray | null;
    const text = readFileSync(doc, 'utf8');
    while ((m = re.exec(text)) !== null) listed.add(m[1]!.replace(/^apps\/pos\//, ''));
    expect(changed.filter((f) => !listed.has(f)).sort(), 'hand-edited but not listed').toEqual([]);
    expect([...listed].filter((f) => identicalToV1.has(f)).sort(), 'listed but identical to v1').toEqual([]);
  }, 180_000); // ~300 `git show` calls against the local v1 repo; runs only where that repo exists
});

// ---------------------------------------------------------------------------------------------
// Case 9 - dependencies and lockfile
// ---------------------------------------------------------------------------------------------
describe('T-422 case 9 - dependencies', () => {
  const FORBIDDEN = ['firebase-admin', 'genkit', '@anthropic-ai/sdk', 'firebase-tools', 'genkit-cli', 'eslint-config-next'];

  it('apps/pos/package.json has none of the forbidden packages. Mutant: server-side deps dragged into the APK', () => {
    const pkg = JSON.parse(read('apps/pos/package.json')) as Record<string, Record<string, string> | undefined>;
    const all = Object.keys({
      ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies,
    });
    expect(all.filter((d) => FORBIDDEN.includes(d) || d.startsWith('@genkit-ai/'))).toEqual([]);
  });

  it('firebase is declared at v1\'s ^10 (not the ERP\'s 11). Mutant: firebase 11 forced onto v1 code', () => {
    const pkg = JSON.parse(read('apps/pos/package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.firebase).toMatch(/^\^?10\./);
  });

  it('package-lock.json changes no version of a package that existed at f18494f; one react/react-dom/next. Mutant: ERP firebase dropped to 10, or a second react', () => {
    type Lock = { packages: Record<string, { version?: string }> };
    const before = JSON.parse(
      execFileSync('git', ['show', 'f18494f:package-lock.json'], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 }).toString('utf8'),
    ) as Lock;
    const after = JSON.parse(read('package-lock.json')) as Lock;
    const changed: string[] = [];
    for (const [key, entry] of Object.entries(before.packages)) {
      if (!key.startsWith('node_modules/') || !entry.version) continue;
      const now = after.packages[key];
      if (!now) changed.push(`${key}: ${entry.version} -> (removed)`);
      else if (now.version !== entry.version) changed.push(`${key}: ${entry.version} -> ${now.version}`);
    }
    expect(changed).toEqual([]);
    const dupes = Object.keys(after.packages).filter((k) => /(^|\/)node_modules\/(react|react-dom|next)$/.test(k) && k.startsWith('apps/'));
    expect(dupes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Case 10 - native
// ---------------------------------------------------------------------------------------------
describe('T-422 case 10 - native Android', () => {
  const javaDir = path.join(POS, 'android', 'app', 'src', 'main', 'java', 'net', 'shareat', 'pos2');
  const manifest = path.join(POS, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

  it('ThermalPrinterPlugin.java is under net/shareat/pos2 with package net.shareat.pos2. Mutant: printer plugin missing, or v1 package name kept', () => {
    const f = path.join(javaDir, 'ThermalPrinterPlugin.java');
    expect(existsSync(f)).toBe(true);
    const text = readFileSync(f, 'utf8');
    expect(text).toMatch(/^\s*package\s+net\.shareat\.pos2\s*;/m);
    expect(text).not.toMatch(/net\.shareat\.pos\s*;/);
  });

  it('MainActivity registers the plugin. Mutant: plugin copied but never registered (no receipts print)', () => {
    const f = path.join(javaDir, 'MainActivity.java');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/registerPlugin\s*\(\s*ThermalPrinterPlugin\.class\s*\)/);
  });

  it('manifest has BLUETOOTH_CONNECT and the FileProvider; file_paths.xml exists. Mutant: v1 permissions not merged', () => {
    expect(existsSync(manifest)).toBe(true);
    const text = readFileSync(manifest, 'utf8');
    expect(text).toContain('android.permission.BLUETOOTH_CONNECT');
    expect(text).toMatch(/androidx\.core\.content\.FileProvider/);
    expect(existsSync(path.join(POS, 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'))).toBe(true);
  });

  it('capacitor appId = gradle applicationId = net.shareat.pos2', () => {
    const cap = /appId\s*:\s*['"]([^'"]+)['"]/.exec(read('apps/pos/capacitor.config.ts'))?.[1];
    const gradle = /applicationId\s+['"]([^'"]+)['"]/.exec(read('apps/pos/android/app/build.gradle'))?.[1];
    expect(cap).toBe('net.shareat.pos2');
    expect(gradle).toBe('net.shareat.pos2');
  });
});
