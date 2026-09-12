import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROUTE_CAPABILITY, capabilityForRoute, navHrefAllowed } from '../../apps/erp/src/lib/route-capability';

/**
 * T-288 — the guard that stops the nav filter and the read gate drifting apart.
 *
 * **Ian, 2026-09-12:** *"do both hide the menu and gate the reads."*
 *
 * ## ⛔ The failure this exists to catch
 *
 * `ROUTE_CAPABILITY` is read by two consumers — `AppShell` hides nav links from it, and
 * `requirePageAccess` refuses routes from it. The dangerous drift is one-directional and SILENT:
 * a route named in the map whose page never calls the gate is a link that VANISHES from the menu
 * while the URL still renders everything on it. An operator sees a shorter menu and reasonably
 * concludes the screen is protected.
 *
 * That is DEF-310's exact shape — two guards described as twins, one widened, the other not,
 * passing happily while blind. So this asserts the relationship rather than either side alone.
 *
 * ⚠️ **`reportScope(` counts as a gate, and that is not a loophole.** The eight report pages were
 * already read-gated before T-288: `reportScope(path, capability, …)` calls `authorizeForScope`,
 * which proves the capability PER STORE and throws — strictly stronger than `requirePageAccess`.
 * They are in the map so the NAV hides them; forcing a second, weaker call into a page that
 * already has a stronger one would be churn that buys nothing.
 */

const repoRoot = path.resolve(__dirname, '../..');
const APP = path.join(repoRoot, 'apps/erp/src/app');

/** ⚠️ Comments stripped before matching — `no-ungated-read-surface.test.ts` records why: an early
 *  version of that guard tripped on the prose explaining the fix. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/**
 * ⚠️ **Reads the FILESYSTEM, not `git ls-files` — deliberately differing from its sibling
 * `no-ungated-read-surface.test.ts`.**
 *
 * That guard asks *"does this page skip the session question"*, which is only meaningful for code
 * that is committed. This one asks *"does a page exist behind this map entry"* — and a page that
 * exists but is not yet staged **is a page that exists**. Using git here produced a false
 * "orphan route" the moment a peer lane added its `ROUTE_CAPABILITY` row before staging its new
 * page (2026-09-12, T-290). That is a normal mid-flight state on a shared tree, not a defect, and
 * a guard that reports it teaches people to explain red away (T-262's ruling).
 *
 * ⭐ **The general rule, because this will come up again: on a multi-session tree, "is it
 * committed yet" is never the question a CORRECTNESS guard should be asking.** Staging state is
 * a fact about someone's workflow, not about whether the code is right. A guard that conflates
 * the two goes red for reasons its own message cannot explain.
 *
 * ⛔ Scanning `apps/erp/src/app` only — never the repo root — so `.next` and `node_modules` are
 * structurally out of reach rather than filtered out afterwards.
 */
function trackedPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page.tsx') {
        out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  };
  walk(APP);
  return out;
}

/** `apps/erp/src/app/admin/users/[personId]/page.tsx` -> `/admin/users/[personId]` */
function routeOf(file: string): string {
  const rel = path.relative(APP, path.join(repoRoot, file)).split(path.sep).join('/');
  const dir = rel.replace(/\/?page\.tsx$/, '');
  // Route groups `(x)` contribute nothing to the URL.
  const segments = dir.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
  return `/${segments.join('/')}`;
}

/** A dynamic segment resolves to a real value at runtime; for coverage it stands for its parent. */
function staticPrefix(route: string): string {
  const cut = route.indexOf('/[');
  return cut === -1 ? route : route.slice(0, cut);
}

const GATE_MARKERS = ['requirePageAccess(', 'reportScope('];

describe('T-288 — ROUTE_CAPABILITY covers what it claims, and only what it can', () => {
  const pages = trackedPages();

  it('every page under a mapped route actually calls a gate', () => {
    const ungated: string[] = [];
    for (const file of pages) {
      const route = routeOf(file);
      if (capabilityForRoute(staticPrefix(route)) === null) continue;
      const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));
      if (!GATE_MARKERS.some((m) => src.includes(m))) ungated.push(route);
    }
    expect(ungated.sort()).toEqual([]);
  });

  it('every route NAMED in the map has at least one page behind it', () => {
    // ⛔ A map entry pointing at nothing hides a nav link for a screen that does not exist, and
    //    worse, makes the assertion above vacuously true for that row.
    const reachable = new Set(pages.map((f) => staticPrefix(routeOf(f))));
    const orphans = Object.keys(ROUTE_CAPABILITY).filter(
      (route) => ![...reachable].some((r) => r === route || r.startsWith(`${route}/`)),
    );
    expect(orphans.sort()).toEqual([]);
  });

  it('⛔ THE PLANT — a mapped route whose page loses its gate is caught', () => {
    // The state that proves this guard works is the one where a gate is REMOVED and the guard
    // goes red. Simulated on real source rather than a fixture: take a file that is genuinely
    // mapped and gated, strip the marker, and confirm the same predicate now fails.
    const gatedFile = pages.find(
      (f) =>
        capabilityForRoute(staticPrefix(routeOf(f))) !== null &&
        readFileSync(path.join(repoRoot, f), 'utf8').includes('requirePageAccess('),
    );
    expect(gatedFile, 'no mapped+gated page found — the suite above cannot be proving anything').toBeDefined();

    const src = codeOnly(readFileSync(path.join(repoRoot, gatedFile!), 'utf8'));
    expect(GATE_MARKERS.some((m) => src.includes(m))).toBe(true);

    const stripped = src.replaceAll('requirePageAccess(', 'requireSession(');
    expect(GATE_MARKERS.some((m) => stripped.includes(m))).toBe(false);
  });
});

describe('capabilityForRoute — prefix matching', () => {
  it('an exact route matches', () => {
    expect(capabilityForRoute('/admin/users')).toBe('manage_users');
  });

  it('a child route inherits its parent', () => {
    expect(capabilityForRoute('/admin/users/01a0-abcd')).toBe('manage_users');
  });

  it('⛔ a route that merely SHARES A PREFIX does not inherit', () => {
    // `/owners` is mapped. A bare startsWith would capture `/ownership-transfer` — a route that
    // does not exist today, which is exactly how this helper would acquire a wrong answer that
    // nobody notices until someone adds that page.
    expect(capabilityForRoute('/ownership-transfer')).toBeNull();
  });

  it('the LONGEST matching prefix wins', () => {
    // `/settings` and `/settings/sales-channels` would both match if the latter were mapped
    // separately; the deeper one must win so a narrower rule is never shadowed by a broader one.
    const deep = capabilityForRoute('/reports/trial-balance');
    expect(deep).toBe('view_trial_balance');
    expect(capabilityForRoute('/reports/ap-aging')).toBe('view_financial_reports');
  });

  it('an unmapped route is open to any signed-in person', () => {
    expect(capabilityForRoute('/till')).toBeNull();
    expect(capabilityForRoute('/sales-days')).toBeNull();
  });
});

describe('navHrefAllowed — presentation only', () => {
  it('shows an unmapped link to everyone', () => {
    expect(navHrefAllowed('/till', new Set())).toBe(true);
  });

  it('hides a mapped link from someone without the capability', () => {
    expect(navHrefAllowed('/payroll', new Set())).toBe(false);
  });

  it('shows it once they hold it', () => {
    expect(navHrefAllowed('/payroll', new Set(['run_payroll']))).toBe(true);
  });
});
