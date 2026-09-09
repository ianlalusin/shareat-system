/**
 * DEF-216 / T-243 — every value in `READINESS_REMEDY_ROUTE` resolves to a real screen.
 *
 * ⚠️ Reads `service.ts` as TEXT and regex-extracts the literal, rather than importing the module:
 * `stores/service.ts` pulls in `@shareat/auth`, which needs a database, so a static import here
 * would defeat the point of a unit guard (the `reference_vitest_resetmodules_import_timeout`
 * family of landmines — `shell-active-href.test.ts` sidesteps the same class by importing a leaf
 * module instead of the client component that uses it).
 *
 * Without this guard, a renamed ERP route is a silent 404 that no typecheck and no test catches —
 * the standing green-but-broken shape this project keeps finding. Orchestrator ruling, 2026-09-09:
 * strip any query string before resolving, and keep a deliberate failing control.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(here, '..', 'src', 'app');
const serviceSourcePath = resolve(here, '..', '..', '..', 'packages', 'domain', 'src', 'stores', 'service.ts');
const serviceSource = readFileSync(serviceSourcePath, 'utf8');

/** `/inventory/locations?store=<id>` → `/inventory/locations` — a route resolves regardless of
 *  any query string a caller appends at read time. */
function stripQuery(route: string): string {
  return route.split('?')[0]!;
}

/** `/inventory/locations` → does `apps/erp/src/app/inventory/locations/page.tsx` exist? */
function routeIsARealPage(route: string): boolean {
  const segments = stripQuery(route).split('/').filter(Boolean);
  return existsSync(join(appSrc, ...segments, 'page.tsx'));
}

function extractRemedyRoutes(source: string): Record<string, string> {
  const block = source.match(/READINESS_REMEDY_ROUTE\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!block) {
    throw new Error('READINESS_REMEDY_ROUTE not found in service.ts — did it move or get renamed?');
  }
  const routes: Record<string, string> = {};
  for (const m of block[1]!.matchAll(/(\w+):\s*'([^']+)'/g)) {
    routes[m[1]!] = m[2]!;
  }
  return routes;
}

describe('READINESS_REMEDY_ROUTE — every remedy points at a real screen', () => {
  const routes = extractRemedyRoutes(serviceSource);

  it('found at least one route to check — a guard that scans nothing cannot pass as one', () => {
    expect(Object.keys(routes).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(routes))('%s → %s resolves to a real page.tsx', (_key, route) => {
    expect(routeIsARealPage(route)).toBe(true);
  });

  it('strips a query string before resolving', () => {
    expect(routeIsARealPage('/inventory/locations?store=abc-123')).toBe(true);
  });

  it('⛔ the control: a route that does not exist fails the guard', () => {
    expect(routeIsARealPage('/no-such-route')).toBe(false);
  });
});
