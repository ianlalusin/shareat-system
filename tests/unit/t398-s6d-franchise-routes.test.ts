import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROUTE_CAPABILITY, capabilitiesForRoute, navHrefAllowed } from '../../apps/erp/src/lib/route-capability';

/**
 * T-398 S6d (TESTER) - the three franchise screens are wired to the right gates. docs/tasks/398-s6/{S6-REFRESH s4 + s6, TESTS U1/U2}.md.
 * (route-capability-coverage, no-ungated-read-surface and nav-route-reachability stay the general guards; these pin THIS slice's exact names.)
 *
 *   U1a  the route map: /franchise/sales and /franchise/stock -> view_franchise_sales ONLY; /franchise/access-log -> view_franchise_access_log ONLY
 *        (never the sales capability: a mapped-to-sales access log would hand Ian's people PG's owner log, and refuse PG's manager).
 *   U1b  each page.tsx calls requirePageAccess with its own LITERAL route, before anything else reads, and returns the refusal.
 *   U1c  nav: a Franchise link to each page exists in nav.tsx, gated by the route map (no hand-rolled checks): Ian's capability shows Sales + Stock, not the log;
 *        a PG manager's shows the log, not Sales/Stock; staff see none.
 *   U1d  no page fetches figures on render: the franchisor reads are called only from actions.ts (U3: a render must not log), and the pages import no repo/SQL.
 *   U1e  the actions authorise from the SESSION actor: no franchiseeOrgId-as-actor, no client-supplied person/org (the franchisee id is a choice, never an identity).
 */
const repoRoot = path.resolve(__dirname, '../..');
const FRANCHISE = path.join(repoRoot, 'apps/erp/src/app/franchise');
const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '');
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (l.includes('//') ? l.slice(0, l.indexOf('//')) : l))
    .join('\n');

const PAGES: Array<[string, string]> = [
  ['/franchise/sales', 'view_franchise_sales'],
  ['/franchise/stock', 'view_franchise_sales'],
  ['/franchise/access-log', 'view_franchise_access_log'],
];

describe('U1a the route map', () => {
  it.each(PAGES)('%s -> exactly %s', (route, cap) => {
    expect(ROUTE_CAPABILITY[route], `${route} is missing from ROUTE_CAPABILITY`).toBeDefined();
    expect([...capabilitiesForRoute(route)]).toEqual([cap]);
  });
});

describe('U1b each page is behind requirePageAccess with its own literal route', () => {
  it.each(PAGES)('%s', (route) => {
    const file = path.join(FRANCHISE, route.replace('/franchise/', ''), 'page.tsx');
    expect(existsSync(file), `${file} does not exist`).toBe(true);
    const src = code(read(file));
    expect(src, 'the gate call with the literal route').toContain(`requirePageAccess('${route}')`);
    expect(src, 'the refusal is returned, not ignored').toMatch(/if\s*\(\s*refusal\s*\)\s*return\s+refusal/);
    const gate = src.indexOf('requirePageAccess(');
    for (const reader of ['listFranchisees', 'franchiseeList', 'listFranchiseAccessLog', 'accessLog', 'viewFranchiseSales', 'viewFranchiseStock']) {
      const at = src.indexOf(`${reader}(`);
      if (at !== -1) expect(at, `${reader} is called before the page gate`).toBeGreaterThan(gate);
    }
  });
});

describe('U1c the nav', () => {
  const nav = read(path.join(repoRoot, 'apps/erp/src/components/nav.tsx'));
  it.each(PAGES)('nav.tsx links to %s as a single-quoted href literal', (route) => {
    expect(nav, `no nav link to ${route}`).toContain(`href: '${route}'`);
  });
  it('the Franchise links are shown by capability alone', () => {
    const ian = new Set(['view_franchise_sales']);
    const pgManager = new Set(['view_franchise_access_log']);
    const staff = new Set<string>();
    expect(navHrefAllowed('/franchise/sales', ian)).toBe(true);
    expect(navHrefAllowed('/franchise/stock', ian)).toBe(true);
    expect(navHrefAllowed('/franchise/access-log', ian)).toBe(false);
    expect(navHrefAllowed('/franchise/access-log', pgManager)).toBe(true);
    expect(navHrefAllowed('/franchise/sales', pgManager)).toBe(false);
    for (const [route] of PAGES) expect(navHrefAllowed(route, staff), `${route} shown to a person holding nothing`).toBe(false);
  });
});

describe('U1d / U1e no figures on render; the actor is the session', () => {
  it.each(PAGES)('%s: the page itself never calls the logged reads', (route) => {
    expect(existsSync(path.join(FRANCHISE, route.replace('/franchise/', ''), 'page.tsx')), `${route} page does not exist`).toBe(true);
    const src = code(read(path.join(FRANCHISE, route.replace('/franchise/', ''), 'page.tsx')));
    expect(src, 'a page that calls the logged sales/stock read fetches (and logs) on every load').not.toMatch(/viewFranchiseSales\s*\(|viewFranchiseStock\s*\(|franchiseRepo\.|salesDaily\s*\(|stockLevels\s*\(/);
    expect(src, 'no SQL in a page').not.toMatch(/franchise_sales_daily|franchise_stock_levels|franchise_access_log\b/);
  });

  it('actions.ts exists, is a server-action module, and takes the actor from the session only', () => {
    const file = path.join(FRANCHISE, 'actions.ts');
    expect(existsSync(file), 'apps/erp/src/app/franchise/actions.ts does not exist').toBe(true);
    const src = code(read(file));
    expect(src).toMatch(/^\s*['"]use server['"]/m);
    expect(src).toContain('viewFranchiseSalesAction');
    expect(src).toContain('viewFranchiseStockAction');
    expect(src, 'the actor comes from the session').toMatch(/requireActor\s*\(|requireSession\s*\(/);
    expect(src, 'the person is carried into the transaction (the database checks it)').toMatch(/withActorPrincipal\s*\(/);
    expect(src, 'a client-supplied actor').not.toMatch(/formData\.get\(\s*['"](personId|orgId|actor)['"]\s*\)|fd\.get\(\s*['"](personId|orgId|actor)['"]\s*\)/);
    expect(src, 'a database sentence must be shown as words: refusals are caught, not left to crash').toMatch(/catch/);
  });
});
