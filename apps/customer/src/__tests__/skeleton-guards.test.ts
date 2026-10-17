import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-437 slice T: structural guards for the customer v2 skeleton (fixtures only). Imports NO app code.
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
const EXPECTED_ROUTES = ['/', '/join', '/menu', '/cart', '/orders', '/bill', '/feedback', '/account'];

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

/** Paths (relative to src) that are dynamic segments, API dirs, or route handlers. */
function structureViolations(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.some((s) => s.startsWith('['))) out.push(`${p}: dynamic segment`);
    if (segs[0] === 'app' && segs.slice(1, -1).includes('api')) out.push(`${p}: api dir`);
    if (/(^|\/)route\.(ts|tsx|js|jsx|mjs)$/.test(p)) out.push(`${p}: route handler`);
  }
  return out;
}

const FORBIDDEN_IMPORT: RegExp[] = [
  /^firebase(\/|$)/,
  /^firebase-admin(\/|$)/,
  /^@firebase\//,
  /^@shareat\/(db|domain|auth)(\/|$)/,
  /^@capacitor\//,
  /(^|\/)packages\/(db|domain|auth)(\/|$)/,
];
function forbiddenImports(src: string): string[] {
  return importSpecifiers(stripComments(src)).filter((s) => FORBIDDEN_IMPORT.some((re) => re.test(s)));
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
  it('structureViolations flags dynamic segment, api dir, route handler', () => {
    expect(structureViolations(['app/menu/[id]/page.tsx'])).toHaveLength(1);
    expect(structureViolations(['app/api/orders/x.ts'])).toHaveLength(1);
    expect(structureViolations(['app/anything/route.ts'])).toHaveLength(1);
    expect(structureViolations(['app/menu/page.tsx', 'data/types.ts'])).toEqual([]);
  });
  it('forbiddenImports flags firebase, firebase-admin, @shareat db/domain/auth, @capacitor, static and dynamic', () => {
    for (const bad of [
      `import { x } from 'firebase/app';`,
      `import a from "firebase-admin";`,
      `import { d } from '@shareat/db';`,
      `import { d } from '@shareat/domain/orders';`,
      `import { a } from '@shareat/auth';`,
      `import { Capacitor } from '@capacitor/core';`,
      `const m = await import('firebase/firestore');`,
      `import '@capacitor/android';`,
    ]) {
      expect(forbiddenImports(bad), bad).toHaveLength(1);
    }
    expect(forbiddenImports(`import { money } from '@shareat/core/money'; import React from 'react';`)).toEqual([]);
    expect(forbiddenImports(`// import x from 'firebase/app'`)).toEqual([]);
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

  it('route set is exactly the 8 spec routes', () => {
    const pages = walk(join(SRC, 'app')).map((f) => rel(join(SRC, 'app'), f));
    expect(routesFrom(pages)).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('no dynamic segments, no api dir, no route.ts', () => {
    expect(structureViolations(walk(SRC).map((f) => rel(SRC, f)))).toEqual([]);
  });

  it('no forbidden imports (firebase, @shareat/db|domain|auth, @capacitor)', () => {
    const v = files.flatMap((f) => forbiddenImports(read(f)).map((s) => `${rel(SRC, f)}: ${s}`));
    expect(v).toEqual([]);
  });

  it('no network calls', () => {
    const v = files.flatMap((f) => networkCalls(read(f)).map((n) => `${rel(SRC, f)}: ${n}`));
    expect(v).toEqual([]);
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
