import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-437 slice T: structural guards for the customer v2 skeleton. Imports NO app code.
 * T-455 S3 amendment (docs/tasks/455-customer-lobby.md section 5, S3 row): the app now has a SERVER half. Two zones:
 *   server zone = src/server/** and src/app/api/lobby/**  (route handlers + server code; stashed out of the static APK build by scripts/build-cap.mjs)
 *   client zone = every other file under src
 * Server code MAY import @shareat/db and @shareat/domain (and @shareat/core); client code may NOT, nor import the server zone. `fetch(` is allowed ONLY in
 * src/data/http-*. Still no Firebase, no Capacitor in the server zone, no 'use server'. Every new detector has a positive and a negative hand-made sample.
 * Every detector is a pure function here and has one hand-made bad sample it must flag, so a detector that
 * always returns [] cannot pass (pattern: tests/unit/app-boundaries.test.ts). Scans skip every __tests__ dir (Ruling 2).
 */

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SRC = join(APP, 'src');

// ---------- file walking ----------
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '.next' || name === 'out') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const rel = (base: string, f: string) => relative(base, f).split(sep).join('/');
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|mts)$/;
const srcFiles = () => walk(SRC).filter((f) => SOURCE_RE.test(f));
const read = (f: string) => readFileSync(f, 'utf8');

// ---------- text helpers ----------
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) out.push(m[1]);
  }
  return out;
}

/** JSX-ish element scanner: opening tag (brace/quote aware, so `=>` inside props is fine) and inner text. */
function elements(src: string, names: string[]): { open: string; inner: string }[] {
  const out: { open: string; inner: string }[] = [];
  const re = new RegExp(`<(${names.join('|')})\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = '';
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const open = src.slice(m.index, i + 1);
    if (src[i - 1] === '/') {
      out.push({ open, inner: '' });
      continue;
    }
    const close = src.indexOf(`</${m[1]}>`, i);
    out.push({ open, inner: close === -1 ? '' : src.slice(i + 1, close) });
  }
  return out;
}

// ---------- detectors (all pure) ----------
const EXPECTED_ROUTES = ['/', '/join', '/menu', '/cart', '/orders', '/bill', '/feedback', '/account', '/lobby', '/lobby/check-in', '/lobby/wait'];

/** page files (paths relative to src/app) -> route paths. Route groups "(x)" do not add a segment. */
function routesFrom(pageFiles: string[]): string[] {
  return pageFiles
    .filter((f) => /(^|\/)page\.(tsx|ts|jsx|js|mdx)$/.test(f))
    .map((f) => {
      const segs = f.split('/').slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
      return '/' + segs.join('/');
    })
    .sort();
}

/**
 * Paths (relative to src): dynamic segments are never allowed; an api dir or a route handler is allowed ONLY under app/api/lobby/ (T-455 S3:
 * the diner is identified by a cookie, so no [id] segment is ever needed).
 */
function structureViolations(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.some((s) => s.startsWith('['))) out.push(`${p}: dynamic segment`);
    const inLobbyApi = p.startsWith('app/api/lobby/');
    if (segs[0] === 'app' && segs.slice(1, -1).includes('api') && !inLobbyApi) out.push(`${p}: api dir outside app/api/lobby`);
    if (/(^|\/)route\.(ts|tsx|js|jsx|mjs)$/.test(p) && !inLobbyApi) out.push(`${p}: route handler outside app/api/lobby`);
  }
  return out;
}

/** The two zones. Paths are relative to src. */
const isServerZone = (relPath: string) => relPath.startsWith('server/') || relPath.startsWith('app/api/lobby/');

/** Never allowed anywhere (either zone): Firebase, Capacitor, @shareat/auth (the diner has no staff identity), raw packages/ paths. */
const FORBIDDEN_EVERYWHERE: RegExp[] = [
  /^firebase(\/|$)/,
  /^firebase-admin(\/|$)/,
  /^@firebase\//,
  /^@shareat\/auth(\/|$)/,
  /^@capacitor\//,
  /(^|\/)packages\//,
];
/** Forbidden in the CLIENT zone only: the database and the domain (they would reach the browser bundle and the APK). */
const SERVER_ONLY_PACKAGES: RegExp[] = [/^@shareat\/(db|domain)(\/|$)/];
/** Forbidden in the client zone: reaching into the server zone (the APK build moves that code away). */
const SERVER_ZONE_SPECIFIER: RegExp[] = [/(^|\/)server\//, /(^|\/)app\/api\//, /^@\/(server|app\/api)(\/|$)/, /^server-only$/];

function importsOf(src: string): string[] {
  return importSpecifiers(stripComments(src));
}
/** Violations for a file at `relPath` (relative to src), zone-aware. */
function forbiddenImports(src: string, relPath = 'components/x.tsx'): string[] {
  const server = isServerZone(relPath);
  return importsOf(src).filter((s) => {
    if (FORBIDDEN_EVERYWHERE.some((re) => re.test(s))) return true;
    if (!server && SERVER_ONLY_PACKAGES.some((re) => re.test(s))) return true;
    if (!server && SERVER_ZONE_SPECIFIER.some((re) => re.test(s))) return true;
    return false;
  });
}

const NETWORK: [string, RegExp][] = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['CapacitorHttp', /\bCapacitorHttp\b/],
];
function networkCalls(src: string): string[] {
  const s = stripComments(src);
  return NETWORK.filter(([, re]) => re.test(s)).map(([n]) => n);
}
/** `fetch(` is allowed ONLY in src/data/http-*.ts(x); every other network primitive is forbidden everywhere, http-* files included. */
const isHttpDataFile = (relPath: string) => /^data\/http-[^/]+\.(ts|tsx)$/.test(relPath);
function networkViolations(src: string, relPath: string): string[] {
  return networkCalls(src).filter((n) => !(n === 'fetch(' && isHttpDataFile(relPath)));
}

/** scripts/build-cap.mjs must move src/app/api and src/server aside for the static export and put them back in a finally. */
function capStashProblems(src: string): string[] {
  const s = stripComments(src);
  const out: string[] = [];
  if (!/['"]src['"]\s*,\s*['"]app['"]\s*,\s*['"]api['"]/.test(s)) out.push('src/app/api is not stashed');
  if (!/['"]src['"]\s*,\s*['"]server['"]/.test(s)) out.push('src/server is not stashed');
  if (!/finally\s*\{[\s\S]*restore\s*\(/.test(s)) out.push('the stash is not restored in a finally');
  return out;
}

function hasUseServer(src: string): boolean {
  return /^\s*['"]use server['"]/m.test(stripComments(src)) || /\{\s*['"]use server['"]/.test(stripComments(src));
}

function importsFixtureData(src: string): string[] {
  return importSpecifiers(stripComments(src)).filter((s) => /(^|\/)fixture-data$/.test(s));
}

/** Elements named button/Button whose text, aria-label or title says pay/split. */
function payOrSplitButtons(src: string): string[] {
  const out: string[] = [];
  for (const { open, inner } of elements(src, ['button', 'Button'])) {
    const text = inner.replace(/<[^>]*>/g, ' ');
    const labels = [...open.matchAll(/(?:aria-label|title)\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]!).join(' ');
    if (/pay|split/i.test(`${text} ${labels}`)) out.push(open.replace(/\s+/g, ' ').slice(0, 60));
  }
  return out;
}

function hasAdminPin(src: string): boolean {
  return /(?<!\d)000000(?!\d)/.test(src);
}

/** Consent checkbox problems on the /account page source. [] means good. */
function consentProblems(src: string): string[] {
  const s = stripComments(src);
  const problems: string[] = [];
  const boxes = elements(s, ['input', 'Checkbox']).filter(
    (e) => /type\s*=\s*["']checkbox["']/.test(e.open) || /^<Checkbox\b/.test(e.open),
  );
  const consentBoxes = boxes.filter((e) => /consent/i.test(e.open));
  if (consentBoxes.length === 0) problems.push('no checkbox bound to consent');
  for (const b of consentBoxes) {
    if (/\bdefaultChecked\b/.test(b.open)) problems.push('defaultChecked on consent checkbox');
    if (/\bchecked\s*=\s*\{\s*true\s*\}/.test(b.open)) problems.push('checked={true} on consent checkbox');
  }
  if (/\[\s*\w*consent\w*\s*,\s*set\w+\s*\]\s*=\s*useState(<[^>]*>)?\(\s*true\s*\)/i.test(s)) {
    problems.push('consent state initialised to true');
  }
  return problems;
}

function firebaseDeps(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = (pkg[key] ?? {}) as Record<string, string>;
    for (const name of Object.keys(deps)) if (/^(@?firebase)/.test(name)) out.push(`${key}.${name}`);
  }
  return out;
}

/** The CustomerData interface must stay free of payment methods and of the fixture-only hook. */
function interfaceProblems(src: string): string[] {
  const s = stripComments(src);
  const out: string[] = [];
  if (/advanceOrderForDemo/.test(s)) out.push('advanceOrderForDemo on the interface (fixture-only)');
  if (/\b(pay|split|charge|checkout|tender)\w*\s*[(:?]/i.test(s)) out.push('payment method on the interface');
  return out;
}

// ---------- detector self-tests: each must flag its hand-made bad sample ----------
describe('detector self-tests (a detector that returns [] must fail here)', () => {
  it('routesFrom lists routes; extra route is visible', () => {
    expect(routesFrom(['page.tsx', 'menu/page.tsx', '(g)/cart/page.tsx', 'layout.tsx', 'menu/loading.tsx'])).toEqual(['/', '/cart', '/menu']);
    expect(routesFrom(['page.tsx', 'admin/page.tsx'])).toContain('/admin');
  });
  it('structureViolations flags dynamic segment, api dir and route handler OUTSIDE app/api/lobby; allows them inside', () => {
    expect(structureViolations(['app/menu/[id]/page.tsx'])).toHaveLength(1);
    expect(structureViolations(['app/api/orders/x.ts'])).toHaveLength(1);
    expect(structureViolations(['app/anything/route.ts'])).toHaveLength(1);
    expect(structureViolations(['app/api/health/route.ts']).length).toBeGreaterThanOrEqual(1);
    expect(structureViolations(['app/api/lobby/[id]/route.ts']).some((v) => v.includes('dynamic segment'))).toBe(true);
    expect(structureViolations(['app/menu/page.tsx', 'data/types.ts'])).toEqual([]);
    expect(structureViolations(['app/api/lobby/check-in/route.ts', 'app/api/lobby/me/route.ts', 'app/api/lobby/cancel/route.ts'])).toEqual([]);
  });
  it('isServerZone: src/server/** and src/app/api/lobby/** are server; everything else is client', () => {
    expect(isServerZone('server/lobby/cookie.ts')).toBe(true);
    expect(isServerZone('app/api/lobby/me/route.ts')).toBe(true);
    for (const c of ['data/http-lobby-data.ts', 'app/lobby/page.tsx', 'lib/ids.ts', 'components/ui.tsx', 'serverish/x.ts', 'app/api/other/route.ts']) {
      expect(isServerZone(c), c).toBe(false);
    }
  });
  it('forbiddenImports (client zone) flags firebase, firebase-admin, @shareat db/domain/auth, @capacitor and the server zone, static and dynamic', () => {
    for (const bad of [
      `import { x } from 'firebase/app';`,
      `import a from "firebase-admin";`,
      `import { d } from '@shareat/db';`,
      `import { d } from '@shareat/domain/lobby/checkin';`,
      `import { a } from '@shareat/auth';`,
      `import { Capacitor } from '@capacitor/core';`,
      `const m = await import('firebase/firestore');`,
      `import '@capacitor/android';`,
      `import { c } from '@/server/lobby/cookie';`,
      `import { c } from '../server/lobby/cookie';`,
      `import { r } from '@/app/api/lobby/me/route';`,
      `import 'server-only';`,
    ]) {
      expect(forbiddenImports(bad, 'data/http-lobby-data.ts'), bad).toHaveLength(1);
    }
    expect(forbiddenImports(`import { money } from '@shareat/core/money'; import React from 'react'; import { next } from 'next/server';`, 'components/x.tsx')).toEqual([]);
    expect(forbiddenImports(`// import x from 'firebase/app'`, 'components/x.tsx')).toEqual([]);
  });
  it('forbiddenImports (server zone) ALLOWS @shareat/db, @shareat/domain, @shareat/core and server-only, and still flags firebase, @capacitor, @shareat/auth and raw packages/ paths', () => {
    for (const rp of ['server/lobby/glue.ts', 'app/api/lobby/me/route.ts']) {
      const ok = `import { withOrgPrincipal } from '@shareat/db'; import { checkIn } from '@shareat/domain/lobby/checkin'; import { logger } from '@shareat/core/logger'; import 'server-only'; import { h } from '@/server/lobby/http';`;
      expect(forbiddenImports(ok, rp), rp).toEqual([]);
      for (const bad of [
        `import { x } from 'firebase-admin/firestore';`,
        `import { x } from '@firebase/app';`,
        `import { C } from '@capacitor/core';`,
        `import { a } from '@shareat/auth';`,
        `import { d } from '../../../../packages/db/src/index';`,
        `const m = await import('firebase/app');`,
      ]) {
        expect(forbiddenImports(bad, rp), `${rp}: ${bad}`).toHaveLength(1);
      }
    }
  });
  it('networkViolations: fetch( is allowed ONLY in src/data/http-*; every other primitive is forbidden everywhere', () => {
    const f = `const r = await fetch('/api/lobby/me');`;
    expect(networkViolations(f, 'data/http-lobby-data.ts')).toEqual([]);
    expect(networkViolations(f, 'data/http-extra.tsx')).toEqual([]);
    for (const bad of ['components/ui.tsx', 'app/lobby/page.tsx', 'server/lobby/glue.ts', 'app/api/lobby/me/route.ts', 'data/fixture-data.ts', 'lib/http-x.ts', 'data/xhttp-a.ts', 'data/http/x.ts', 'data/http-lobby-data.mjs']) {
      expect(networkViolations(f, bad), bad).toEqual(['fetch(']);
    }
    expect(networkViolations(`new XMLHttpRequest()`, 'data/http-lobby-data.ts')).toEqual(['XMLHttpRequest']);
    expect(networkViolations(`new WebSocket('wss://x'); new EventSource('/s'); navigator.sendBeacon('/b'); CapacitorHttp.get({})`, 'data/http-lobby-data.ts')).toEqual(['WebSocket', 'EventSource', 'sendBeacon', 'CapacitorHttp']);
    expect(networkViolations(`// fetch(\nconst a = 1;`, 'components/ui.tsx')).toEqual([]);
  });
  it('networkCalls flags fetch(, XMLHttpRequest, WebSocket, EventSource, sendBeacon, CapacitorHttp', () => {
    for (const [name, bad] of [
      ['fetch(', `const r = await fetch('/x');`],
      ['XMLHttpRequest', `new XMLHttpRequest()`],
      ['WebSocket', `new WebSocket('wss://x')`],
      ['EventSource', `new EventSource('/s')`],
      ['sendBeacon', `navigator.sendBeacon('/b')`],
      ['CapacitorHttp', `CapacitorHttp.get({})`],
    ] as const) {
      expect(networkCalls(bad)).toEqual([name]);
    }
    expect(networkCalls(`// we never fetch(\nconst a = 1;`)).toEqual([]);
  });
  it('capStashProblems: the build-cap script must stash src/app/api and src/server and restore in a finally', () => {
    const good = `const targets = [ { from: join(root, 'src', 'app', 'api'), to: a }, { from: join(root, 'src', 'server'), to: b } ];\ntry { stash(); } finally { restore(); }`;
    expect(capStashProblems(good)).toEqual([]);
    expect(capStashProblems(good.replace(`'src', 'app', 'api'`, `'src', 'app', 'apx'`))).toEqual(['src/app/api is not stashed']);
    expect(capStashProblems(good.replace(`'src', 'server'`, `'src', 'srvr'`))).toEqual(['src/server is not stashed']);
    expect(capStashProblems(good.replace('finally { restore(); }', 'catch (e) {} restore();'))).toEqual(['the stash is not restored in a finally']);
    expect(capStashProblems(`spawnSync('npx', ['next', 'build'])`)).toHaveLength(3);
  });
  it('hasUseServer flags the directive', () => {
    expect(hasUseServer(`'use server';\nexport async function a() {}`)).toBe(true);
    expect(hasUseServer(`export async function a() { 'use server'; }`)).toBe(true);
    expect(hasUseServer(`'use client';\nexport const a = 1;`)).toBe(false);
  });
  it('importsFixtureData flags alias and relative spellings', () => {
    expect(importsFixtureData(`import { createFixtureCustomerData } from '@/data/fixture-data';`)).toHaveLength(1);
    expect(importsFixtureData(`import x from '../../data/fixture-data';`)).toHaveLength(1);
    expect(importsFixtureData(`import { useCustomerData } from '@/data/provider';`)).toEqual([]);
  });
  it('payOrSplitButtons flags <button> and <Button> by text, label, and with => inside props', () => {
    expect(payOrSplitButtons(`<button onClick={() => go()}>Pay now</button>`)).toHaveLength(1);
    expect(payOrSplitButtons(`<Button>Split the bill</Button>`)).toHaveLength(1);
    expect(payOrSplitButtons(`<button aria-label="Pay"><Icon/></button>`)).toHaveLength(1);
    expect(payOrSplitButtons(`<Button variant="x">\n  <span>PAY</span>\n</Button>`)).toHaveLength(1);
    expect(payOrSplitButtons(`<button onClick={() => back()}>Back to menu</button><p>Pay at the cashier</p>`)).toEqual([]);
  });
  it('hasAdminPin flags 000000 but not longer digit runs', () => {
    expect(hasAdminPin(`if (pin === '000000') return admin();`)).toBe(true);
    expect(hasAdminPin(`const n = 1000000;`)).toBe(false);
  });
  it('consentProblems flags missing, defaultChecked, checked={true}, state true; passes a clean box', () => {
    expect(consentProblems(`<input type="text" name="name" />`)).toContain('no checkbox bound to consent');
    expect(consentProblems(`<input type="checkbox" name="consent" defaultChecked />`)).toContain('defaultChecked on consent checkbox');
    expect(consentProblems(`<input type="checkbox" name="consent" checked={true} onChange={() => {}} />`)).toContain(
      'checked={true} on consent checkbox',
    );
    expect(
      consentProblems(`const [consent, setConsent] = useState(true);\n<input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />`),
    ).toContain('consent state initialised to true');
    expect(
      consentProblems(`const [consent, setConsent] = useState(false);\n<input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />`),
    ).toEqual([]);
  });
  it('firebaseDeps flags firebase and @firebase in any dependency block', () => {
    expect(firebaseDeps({ dependencies: { firebase: '^11' } })).toHaveLength(1);
    expect(firebaseDeps({ devDependencies: { '@firebase/app': '1' } })).toHaveLength(1);
    expect(firebaseDeps({ dependencies: { next: '16' } })).toEqual([]);
  });
  it('interfaceProblems flags a pay method and the fixture-only hook', () => {
    expect(interfaceProblems(`interface C { payBill(sessionId: string): Promise<void>; }`)).toHaveLength(1);
    expect(interfaceProblems(`interface C { advanceOrderForDemo(id: string): void; }`)).toHaveLength(1);
    expect(interfaceProblems(`interface C { getBill(sessionId: string): Promise<Result<Bill>>; }`)).toEqual([]);
  });
});

// ---------- the real tree ----------
describe('skeleton guards on apps/customer', () => {
  const files = srcFiles();

  it('scans a non-empty tree (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('route set is exactly the 8 spec routes plus the 3 T-455 S4 lobby screens', () => {
    const pages = walk(join(SRC, 'app')).map((f) => rel(join(SRC, 'app'), f));
    expect(routesFrom(pages)).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('no dynamic segments; api dirs and route handlers only under app/api/lobby', () => {
    expect(structureViolations(walk(SRC).map((f) => rel(SRC, f)))).toEqual([]);
  });

  it('the server half exists (not vacuous): src/server has source, and app/api/lobby has check-in, me, cancel and store route handlers [T-455 S3/S4]', () => {
    const server = walk(join(SRC, 'server')).filter((f) => SOURCE_RE.test(f));
    expect(server.length, 'src/server/** must hold the cookie, hash and glue code').toBeGreaterThan(0);
    const lobbyApi = join(SRC, 'app', 'api', 'lobby');
    const routes = walk(lobbyApi).map((f) => rel(lobbyApi, f)).sort();
    for (const r of ['cancel/route.ts', 'check-in/route.ts', 'me/route.ts', 'store/route.ts']) expect(routes, r).toContain(r);
    expect(routes.filter((r) => !/(^|\/)route\.ts$/.test(r)), 'only route.ts files live under app/api/lobby').toEqual([]);
  });

  it('no forbidden imports: client code has no firebase, @shareat/db|domain|auth, @capacitor or server-zone import; server code may import @shareat/db|domain but never firebase/capacitor/auth', () => {
    const v = files.flatMap((f) => forbiddenImports(read(f), rel(SRC, f)).map((s) => `${rel(SRC, f)}: ${s}`));
    expect(v).toEqual([]);
  });

  it('the server zone and the client zone are both non-empty (the zone split is not vacuous)', () => {
    const rels = files.map((f) => rel(SRC, f));
    expect(rels.filter(isServerZone).length).toBeGreaterThan(0);
    expect(rels.filter((r) => !isServerZone(r)).length).toBeGreaterThan(0);
  });

  it('fetch( appears only in src/data/http-*; no other network primitive anywhere; the http data module exists and really uses fetch', () => {
    const v = files.flatMap((f) => networkViolations(read(f), rel(SRC, f)).map((n) => `${rel(SRC, f)}: ${n}`));
    expect(v).toEqual([]);
    const httpFiles = files.filter((f) => isHttpDataFile(rel(SRC, f)));
    expect(httpFiles.map((f) => rel(SRC, f)), 'src/data/http-lobby-data.ts must exist').toContain('data/http-lobby-data.ts');
    expect(httpFiles.some((f) => networkCalls(read(f)).includes('fetch(')), 'the allowed zone is not empty: the lobby data module calls fetch').toBe(true);
  });

  it('scripts/build-cap.mjs stashes src/app/api and src/server for the static export and restores them in a finally', () => {
    const p = join(APP, 'scripts', 'build-cap.mjs');
    expect(existsSync(p)).toBe(true);
    expect(capStashProblems(read(p))).toEqual([]);
  });

  it("no 'use server'", () => {
    expect(files.filter((f) => hasUseServer(read(f))).map((f) => rel(SRC, f))).toEqual([]);
  });

  it('package.json has no firebase dependency', () => {
    expect(firebaseDeps(JSON.parse(read(join(APP, 'package.json'))))).toEqual([]);
  });

  it('no file under src/app or src/components imports data/fixture-data', () => {
    const screens = [...walk(join(SRC, 'app')), ...walk(join(SRC, 'components'))].filter((f) => SOURCE_RE.test(f));
    expect(screens.length).toBeGreaterThan(1); // the 8 pages must exist, or this passes vacuously
    expect(screens.filter((f) => importsFixtureData(read(f)).length > 0).map((f) => rel(SRC, f))).toEqual([]);
  });

  it('no pay / split button under src/app/bill', () => {
    const billFiles = walk(join(SRC, 'app', 'bill')).filter((f) => /\.tsx$/.test(f));
    expect(billFiles.length, 'src/app/bill/page.tsx must exist').toBeGreaterThan(0);
    expect(billFiles.flatMap((f) => payOrSplitButtons(read(f)))).toEqual([]);
  });

  it('000000 appears nowhere outside tests', () => {
    expect(files.filter((f) => hasAdminPin(read(f))).map((f) => rel(SRC, f))).toEqual([]);
  });

  it('/account has an unticked-by-default consent checkbox', () => {
    const p = join(SRC, 'app', 'account', 'page.tsx');
    expect(existsSync(p), 'src/app/account/page.tsx must exist').toBe(true);
    expect(consentProblems(read(p))).toEqual([]);
  });

  it('CustomerData interface has no payment method and not the fixture-only hook', () => {
    const p = join(SRC, 'data', 'customer-data.ts');
    expect(existsSync(p), 'src/data/customer-data.ts must exist').toBe(true);
    expect(interfaceProblems(read(p))).toEqual([]);
  });
});
