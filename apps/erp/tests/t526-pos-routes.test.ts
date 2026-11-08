// ASSUMED API (T-530a): none.
// ASSUMED API: route tree apps/erp/src/app/pos/{layout.tsx, page.tsx, kitchen/page.tsx, refills/page.tsx, receipts/page.tsx, till/page.tsx}, client shell under app/pos/_shell/.
// ASSUMED API: each page calls `requirePageAccess('<its own literal route>')` and renders `refusal` when it is not null (lib/page-access.tsx).
/**
 * T-526 R1 / R3 - the /pos route tree, its ROUTE_CAPABILITY rows, the census duties, and the shell's source-level promises (aria-current, 48 px targets from
 * tokens, no raw pixel values, Switch cashier through the existing signOutAction). Written BEFORE the code (tester lane).
 * The existing census tests (route-capability-coverage, no-ungated-read-surface, nav-route-reachability) are the builder's gates; nav-route-reachability
 * was extended here with the five /pos routes (its "every entry is a real route" check is red until the pages exist).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTE_CAPABILITY, capabilitiesForRoute, capabilityForRoute, navHrefAllowed } from '@/lib/route-capability';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..', 'src', 'app');
const posDir = resolve(appDir, 'pos');

const PAGES: [file: string, route: string, capability: string][] = [
  ['page.tsx', '/pos', 'record_sale'],
  ['receipts/page.tsx', '/pos/receipts', 'record_sale'],
  ['till/page.tsx', '/pos/till', 'record_sale'],
  ['kitchen/page.tsx', '/pos/kitchen', 'serve_pos_ticket'],
  ['refills/page.tsx', '/pos/refills', 'request_pos_refill'],
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('T-526 R1 - ROUTE_CAPABILITY for /pos', () => {
  it('/pos, /pos/receipts and /pos/till need record_sale; /pos/kitchen serve_pos_ticket; /pos/refills request_pos_refill (exact, single words, not ANY-OF lists)', () => {
    for (const [, route, cap] of PAGES) {
      expect(capabilityForRoute(route), route).toBe(cap);
      expect(capabilitiesForRoute(route), route).toEqual([cap]);
    }
  });

  it('a person without the word is not allowed the route, and holding another POS word does not help (the nav-side twin of the page gate)', () => {
    expect(navHrefAllowed('/pos/kitchen', new Set(['record_sale', 'request_pos_refill']))).toBe(false);
    expect(navHrefAllowed('/pos/refills', new Set(['record_sale', 'serve_pos_ticket']))).toBe(false);
    expect(navHrefAllowed('/pos', new Set(['serve_pos_ticket', 'request_pos_refill']))).toBe(false);
    expect(navHrefAllowed('/pos/kitchen', new Set(['serve_pos_ticket']))).toBe(true);
    expect(navHrefAllowed('/pos', new Set())).toBe(false);
  });

  it('the map names /pos at all (a scan that finds nothing must not pass)', () => {
    expect(Object.keys(ROUTE_CAPABILITY).filter((k) => k === '/pos' || k.startsWith('/pos/')).length).toBeGreaterThanOrEqual(3);
  });
});

describe('T-526 R1 - the page files', () => {
  it('layout.tsx and the five pages exist', () => {
    expect(existsSync(resolve(posDir, 'layout.tsx')), 'app/pos/layout.tsx').toBe(true);
    for (const [file] of PAGES) expect(existsSync(resolve(posDir, file)), `app/pos/${file}`).toBe(true);
  });

  it.each(PAGES)('%s is a Server Component whose first act is requirePageAccess(%j), and it renders the refusal', (file, route) => {
    const p = resolve(posDir, file);
    expect(existsSync(p), p).toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).not.toMatch(/^\s*['"]use client['"]/m);
    expect(src).toContain(`requirePageAccess('${route}')`);
    expect(src).toMatch(/refusal/);
  });

  it('the Kitchen page does not gate on the wrong word (control: it never names record_sale or request_pos_refill as its own requirement)', () => {
    const src = readFileSync(resolve(posDir, 'kitchen', 'page.tsx'), 'utf8');
    expect(src).toContain("requirePageAccess('/pos/kitchen')");
    expect(src).not.toContain("requirePageAccess('/pos')");
    expect(src).not.toContain("requirePageAccess('/pos/refills')");
  });
});

describe('T-526 R3 - the shell layout and client parts', () => {
  const layoutPath = resolve(posDir, 'layout.tsx');
  const shellFiles = walk(resolve(posDir, '_shell'));

  it('the server layout resolves the session, the pairing and the held tabs: requirePageAccess, readPosTabletToken, resolvePosTablet, heldCapabilities', () => {
    expect(existsSync(layoutPath)).toBe(true);
    const src = readFileSync(layoutPath, 'utf8');
    expect(src).toMatch(/requirePageAccess\(/);
    expect(src).toContain('readPosTabletToken');
    expect(src).toContain('resolvePosTablet');
    expect(src).toContain('heldCapabilities');
  });

  it('there is a client shell under app/pos/_shell/ marked use client', () => {
    expect(shellFiles.length).toBeGreaterThan(0);
    const clients = shellFiles.filter((f) => /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8')));
    expect(clients.length).toBeGreaterThan(0);
  });

  it('the tab strip marks the active tab with aria-current="page"; the buttons say "Switch cashier" and "ERP"; Switch cashier online uses the existing signOutAction', () => {
    const all = shellFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).toContain('aria-current');
    expect(all).toContain('Switch cashier');
    expect(all).toMatch(/>\s*ERP\s*</);
    expect(all).toContain('signOutAction');
    expect(all).toContain('offline sign-in');
  });

  it('no new state library: the shell imports none of zustand, redux, jotai, recoil, swr, @tanstack/react-query', () => {
    expect(shellFiles.length).toBeGreaterThan(0);
    const all = shellFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).not.toMatch(/from\s+['"](zustand|redux|@reduxjs\/toolkit|jotai|recoil|swr|@tanstack\/react-query)/);
  });

  it('touch targets come from tokens: no raw pixel value (min-h-[48px], style px, etc.) anywhere under app/pos', () => {
    const files = walk(posDir);
    expect(files.length, 'app/pos has no source files yet').toBeGreaterThan(5);
    const offenders = files.flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(/(?:\[\d+(?:\.\d+)?px\]|\b\d+(?:\.\d+)?px\b)/g)].map((m) => `${f.slice(posDir.length)}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  it('the polling hook polls every 3 s only while the tab is visible and the drain never runs on a hidden tab (source promise: visibilityState is read)', () => {
    expect(shellFiles.length).toBeGreaterThan(0);
    const all = shellFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).toContain('visibilityState');
    expect(all).toContain('POS_POLL_INTERVAL_MS');
  });
});

describe('T-526 R1 - the proxy tags /pos as a kiosk so the ERP chrome is hidden', () => {
  it('proxy.ts matcher names /pos and /pos/:path* (exactness is held by proxy-kiosk-header.test.ts)', () => {
    const src = readFileSync(resolve(here, '..', 'src', 'proxy.ts'), 'utf8');
    expect(src).toContain("'/pos'");
    expect(src).toContain("'/pos/:path*'");
  });
});
