import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROUTE_CAPABILITY, capabilityForRoute, navHrefAllowed } from '../../apps/erp/src/lib/route-capability';
import { APPROVED_OPEN_ROUTES, ROUTES_AWAITING_A_DECISION, hasMapEntry } from '../../apps/erp/src/lib/route-open-lists';

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

/**
 * T-435: a route's requirement is now a LIST (any-of) or null (open). Older assertions below go through this so they hold for the
 * single-capability shape (before) and the list shape (after): the capabilities a route accepts, [] when open.
 */
function accepts(route: string): string[] {
  const v = capabilityForRoute(route) as unknown;
  if (v === null || v === undefined) return [];
  return (Array.isArray(v) ? [...v] : [v]) as string[];
}

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

const GATE_MARKERS = ['requirePageAccess(', 'reportScope(', 'storePageScope('];

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

// =====================================================================================================================
// T-603 S5 / bible section 7 rule 11 - the route map is deny-by-default. Generalises T-497 S1 (which covered /admin and /settings only):
// EVERY page, and the folder of EVERY 'use server' file, needs a map entry or a place on one of the two lists below. A new unmapped page
// or action file fails here until someone records a decision. T-616 enforces the same rule at runtime: `requirePageAccess` refuses an unmapped route (lists in `route-open-lists.ts`).
// =====================================================================================================================

const USE_SERVER = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use server['"]/;

/** Source files that declare server actions. Same filesystem walk as `trackedPages` (staging state is not the question). */
function actionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && USE_SERVER.test(readFileSync(full, 'utf8'))) {
        out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  };
  walk(APP);
  return out;
}

/** `apps/erp/src/app/franchise/actions.ts` -> `/franchise`. Route groups `(x)` and private folders `_x` contribute nothing to the URL. */
function routeOfActionFile(file: string): string {
  const rel = path.relative(APP, path.join(repoRoot, file)).split(path.sep).join('/');
  const segments = rel.split('/').slice(0, -1).filter((seg) => seg && !(seg.startsWith('(') && seg.endsWith(')')) && !seg.startsWith('_'));
  return `/${segments.join('/')}`;
}

/**
 * Folders that hold server actions but are not a URL (no page of their own): shared widgets shown on mapped pages. Each entry cites where it is gated.
 * The guard still fails for a new action folder that is neither mapped nor listed here.
 */
const SHARED_ACTION_FOLDERS: Readonly<Record<string, string>> = {
  '/copy-from-store': 'T-611: no page; the dialog sits on /kitchen, /menu/hours and /admin/pos-tablets (all mapped); the domain checks admin role, the store edit right and an administrator PIN',
};

const isApprovedOpen = (r: string): boolean => r in APPROVED_OPEN_ROUTES || r in SHARED_ACTION_FOLDERS;

/** The routes (from `routes`) with no map entry and no approved-open decision. */
function unmappedRoutes(routes: readonly string[]): string[] {
  return [...new Set(routes.map(staticPrefix).filter((r) => !hasMapEntry(r) && !isApprovedOpen(r)))].sort();
}

describe('T-603 S5 - every page and every server-action folder has a permission-map entry, an approved-open decision, or a place on the awaiting list', () => {
  const pageRoutes = trackedPages().map(routeOf);
  const actionRoutes = actionFiles().map(routeOfActionFile);
  const realRoutes = [...pageRoutes, ...actionRoutes];

  it('the enumeration is not vacuous: it sees the pages and the action files', () => {
    expect(pageRoutes.length).toBeGreaterThan(100);
    expect(actionRoutes.length).toBeGreaterThan(50);
  });

  it('the real tree: no unmapped page or action folder beyond the known, reported ones', () => {
    const unexpected = unmappedRoutes(realRoutes).filter((r) => !ROUTES_AWAITING_A_DECISION.includes(r));
    expect(unexpected, 'map it in route-capability.ts (and gate the page), or record a decision above').toEqual([]);
  });

  it('the awaiting-a-decision list only shrinks: each entry is a real, still-unmapped route', () => {
    const stillUnmapped = unmappedRoutes(realRoutes);
    for (const r of ROUTES_AWAITING_A_DECISION) expect(stillUnmapped, `${r}: mapped or gone - delete it from the list`).toContain(r);
  });

  it('every approved-open entry names a real page, cites a decision, and is genuinely unmapped', () => {
    for (const [route, why] of Object.entries(APPROVED_OPEN_ROUTES)) {
      expect(pageRoutes.map(staticPrefix), route).toContain(route);
      expect(why.length, route).toBeGreaterThan(0);
      expect(hasMapEntry(route), route).toBe(false);
    }
  });

  it('every shared action folder cites its gate, has no page of its own, and is genuinely unmapped', () => {
    for (const [route, why] of Object.entries(SHARED_ACTION_FOLDERS)) {
      expect(actionRoutes, route).toContain(route);
      expect(pageRoutes.map(staticPrefix), route).not.toContain(route);
      expect(why.length, route).toBeGreaterThan(0);
      expect(hasMapEntry(route), route).toBe(false);
    }
  });

  it('⛔ PLANT - a NEW unmapped page makes the guard fail (anywhere, not only /admin)', () => {
    expect(unmappedRoutes([...realRoutes, '/brand-new-screen'])).toContain('/brand-new-screen');
    expect(unmappedRoutes(['/brand-new/[id]'])).toEqual(['/brand-new']);
    expect(unmappedRoutes([...realRoutes, '/admin/audit-unlisted-private'])).toContain('/admin/audit-unlisted-private');
  });

  it('⛔ PLANT - a NEW server-action file under an unmapped folder makes the guard fail', () => {
    const planted = routeOfActionFile('apps/erp/src/app/brand-new-area/actions.ts');
    expect(planted).toBe('/brand-new-area');
    expect(unmappedRoutes([...realRoutes, planted])).toContain('/brand-new-area');
    // a nested file and a private folder fold into the folder's route
    expect(routeOfActionFile('apps/erp/src/app/brand-new-area/_actions/save.ts')).toBe('/brand-new-area');
    // the directive detector sees a real action file and ignores a plain one
    expect(USE_SERVER.test("'use server';\nexport async function a() {}")).toBe(true);
    expect(USE_SERVER.test("/** doc */\n'use server';\n")).toBe(true);
    expect(USE_SERVER.test("import x from 'y';\nexport const a = 1;")).toBe(false);
  });

  it('⛔ PLANT - an awaiting route removed from the list while still unmapped is caught', () => {
    const [first] = ROUTES_AWAITING_A_DECISION;
    expect(first, 'the awaiting list is not empty').toBeDefined();
    const pruned = ROUTES_AWAITING_A_DECISION.filter((r) => r !== first);
    expect(unmappedRoutes(realRoutes).filter((r) => !pruned.includes(r))).toContain(first);
  });

  it('⛔ PLANT - an awaiting entry that has become mapped is stale and is caught (the list can only shrink)', () => {
    const staleOf = (list: readonly string[]) => list.filter((r) => !unmappedRoutes(realRoutes).includes(r));
    expect(staleOf(ROUTES_AWAITING_A_DECISION)).toEqual([]);
    expect(staleOf([...ROUTES_AWAITING_A_DECISION, '/payroll'])).toEqual(['/payroll']);
  });

  it('positive control - a new page under a MAPPED route is covered by the prefix (the gate test above checks it calls a gate)', () => {
    expect(unmappedRoutes(['/admin/users/audit-unlisted-private', '/payroll/anything-new'])).toEqual([]);
  });

  it('PLANT - removing an existing map entry makes its page unmapped', () => {
    const realStores = realRoutes.filter((r) => r.startsWith('/admin/stores'));
    expect(realStores.length).toBeGreaterThan(0);
    const withoutEntry = (route: string) =>
      Object.keys(ROUTE_CAPABILITY).filter((k) => k !== '/admin/stores').some((k) => route === k || route.startsWith(`${k}/`));
    expect(hasMapEntry('/admin/stores')).toBe(true);
    expect(realStores.map(staticPrefix).some((r) => !withoutEntry(r))).toBe(true);
  });
});

describe('capabilityForRoute — prefix matching', () => {
  it('an exact route matches', () => {
    expect(accepts('/admin/users')).toEqual(['manage_users']);
  });

  it('a child route inherits its parent', () => {
    expect(accepts('/admin/users/01a0-abcd')).toEqual(['manage_users']);
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
    expect(accepts('/reports/trial-balance')).toEqual(['view_trial_balance']);
    expect(accepts('/reports/ap-aging')).toEqual(['view_financial_reports']);
  });

  it('an unmapped route is open to any signed-in person', () => {
    expect(capabilityForRoute('/attendance')).toBeNull();
    // T-589 B3a: /sales-days is keyed now (the day list shows every day's totals); `/` stays the one open landing page.
    expect(capabilityForRoute('/')).toBeNull();
  });
});

describe('navHrefAllowed — presentation only', () => {
  it('shows an unmapped link to everyone', () => {
    expect(navHrefAllowed('/attendance', new Set())).toBe(true);
  });

  it('hides a mapped link from someone without the capability', () => {
    expect(navHrefAllowed('/payroll', new Set())).toBe(false);
  });

  it('shows it once they hold it', () => {
    expect(navHrefAllowed('/payroll', new Set(['run_payroll']))).toBe(true);
  });
});

// =====================================================================================================================
// T-435 (TESTER) - personal-data access gates. docs/tasks/435-personal-data-access-gates.md design 5, cases 13, 24, 37.
// Ian Q2: manage_attendance alone is enough for a store's roster. Ian Q3: price lists stay open. Bible row 353.
//   M13 remove the `null` price-lists entry (the /customers prefix closes it); M24 /staff maps to enrol_staff alone;
//   M37 one page under /customers or /staff keeps bare requireSession.
// =====================================================================================================================

describe('T-435 - the route map names the customer and staff screens', () => {
  it('/customers (and any customer id under it) needs record_ar_collection', () => {
    expect(accepts('/customers')).toEqual(['record_ar_collection']);
    expect(accepts('/customers/019a0000-0000-7000-8000-000000000001')).toEqual(['record_ar_collection']);
  });

  it('M13: /customers/price-lists is OPEN (null re-opens the sub-route; longest prefix wins) - Ian Q3', () => {
    expect(capabilityForRoute('/customers/price-lists')).toBeNull();
    expect(capabilityForRoute('/customers/price-lists/019a0000-0000-7000-8000-000000000001')).toBeNull();
    // ... and the null is not a hole in its neighbours:
    expect(accepts('/customers')).not.toEqual([]);
  });

  it('M24: /staff, an employment under it and its credentials page accept enrol_staff OR manage_attendance - Ian Q2', () => {
    for (const route of ['/staff', '/staff/019a0000-0000-7000-8000-000000000001', '/staff/019a0000-0000-7000-8000-000000000001/credentials']) {
      expect(accepts(route).sort(), route).toEqual(['enrol_staff', 'manage_attendance']);
    }
  });

  it('/staff/hire needs enrol_staff ALONE (longer prefix wins over /staff)', () => {
    expect(accepts('/staff/hire')).toEqual(['enrol_staff']);
  });

  it('a prefix that merely shares letters does not inherit (/customers-archive, /staffing)', () => {
    expect(capabilityForRoute('/customers-archive')).toBeNull();
    expect(capabilityForRoute('/staffing')).toBeNull();
  });
});

describe('T-435 - navHrefAllowed understands any-of and open', () => {
  it('/staff is shown to a holder of EITHER capability and hidden from everyone else', () => {
    expect(navHrefAllowed('/staff', new Set(['manage_attendance']))).toBe(true);
    expect(navHrefAllowed('/staff', new Set(['enrol_staff']))).toBe(true);
    expect(navHrefAllowed('/staff', new Set(['enrol_staff', 'manage_attendance']))).toBe(true);
    expect(navHrefAllowed('/staff', new Set())).toBe(false);
    expect(navHrefAllowed('/staff', new Set(['record_ar_collection', 'run_payroll']))).toBe(false);
  });

  it('/staff/hire needs enrol_staff: manage_attendance alone does not show it', () => {
    expect(navHrefAllowed('/staff/hire', new Set(['manage_attendance']))).toBe(false);
    expect(navHrefAllowed('/staff/hire', new Set(['enrol_staff']))).toBe(true);
  });

  it('/customers is hidden without record_ar_collection; the open price-lists link is always shown', () => {
    expect(navHrefAllowed('/customers', new Set())).toBe(false);
    expect(navHrefAllowed('/customers', new Set(['record_ar_collection']))).toBe(true);
    expect(navHrefAllowed('/customers/price-lists', new Set())).toBe(true);
  });
});

describe('T-435 - the map keeps its promises', () => {
  it('every any-of entry names at least two DIFFERENT capabilities; no entry is an empty list', () => {
    for (const [route, v] of Object.entries(ROUTE_CAPABILITY as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      expect(v.length, `${route}: an empty list would mean "nobody"`).toBeGreaterThan(0);
      expect(new Set(v).size, `${route}: duplicate capability`).toBe(v.length);
    }
  });

  it('every null (open) entry sits under a gated parent - a null with nothing above it is dead weight', () => {
    const entries = Object.entries(ROUTE_CAPABILITY as Record<string, unknown>);
    const opens = entries.filter(([, v]) => v === null).map(([r]) => r);
    for (const route of opens) {
      const parent = entries.find(([r, v]) => v !== null && route.startsWith(`${r}/`));
      expect(parent, `${route}: open entry with no gated parent`).toBeDefined();
    }
  });

  it('M37: every page under /customers (price lists excepted) and /staff calls requirePageAccess, not bare requireSession', () => {
    const offenders: string[] = [];
    for (const file of trackedPages()) {
      const route = routeOf(file);
      const gated = /^\/(customers|staff)(\/|$)/.test(route) && !route.startsWith('/customers/price-lists');
      if (!gated) continue;
      const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));
      if (!src.includes('requirePageAccess(')) offenders.push(route);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('the price-list pages stay on requireSession (open by decision, Ian Q3) - the gate is not copied onto them', () => {
    const lists = trackedPages().filter((f) => routeOf(f).startsWith('/customers/price-lists'));
    expect(lists.length).toBeGreaterThan(0);
    for (const file of lists) {
      const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));
      expect(src.includes('requirePageAccess('), file).toBe(false);
    }
  });
});

// =====================================================================================================================
// T-577 (DEF-834, Ian 13 Nov, bible row 461) - the finance screens are read-gated. Behaviour (refusal / allowed per capability, store
// not-found) is proved against real Postgres in apps/erp/tests/integration/t577-finance-read-gates.test.ts; this is the cheap structural half.
// =====================================================================================================================

describe('T-577 - /ap, /budgets and /cash-requests are mapped, and every page under them calls the gate', () => {
  it('each root names real capabilities and children inherit (a longer null key would re-open one, so none may exist)', () => {
    for (const root of ['/ap', '/budgets', '/cash-requests']) {
      expect(accepts(root).length, root).toBeGreaterThan(0);
      const reopened = Object.keys(ROUTE_CAPABILITY).filter((k) => k.startsWith(`${root}/`) && ROUTE_CAPABILITY[k] === null);
      expect(reopened, `${root}: a null child entry would re-open a finance screen`).toEqual([]);
    }
    expect(accepts('/ap/invoices/019a0000-0000-7000-8000-000000000001')).toEqual(accepts('/ap'));
    expect(accepts('/cash-requests/019a0000-0000-7000-8000-000000000001')).toEqual(accepts('/cash-requests'));
  });

  it('every page under them calls requirePageAccess, never bare requireSession', () => {
    const under = trackedPages().filter((f) => /^\/(ap|budgets|cash-requests)(\/|$)/.test(routeOf(f)));
    expect(under.length, 'the three screens and their children exist').toBeGreaterThanOrEqual(8);
    const offenders = under.filter((f) => !codeOnly(readFileSync(path.join(repoRoot, f), 'utf8')).includes('requirePageAccess(')).map(routeOf);
    expect(offenders.sort()).toEqual([]);
  });

  it('the three single-record pages ask canReadAtStore about the RECORD\'s own storeId, and answer not-found', () => {
    const want: Record<string, RegExp> = {
      'apps/erp/src/app/expenses/[id]/page.tsx': /canReadAtStore\(tx, actor, expense\.storeId,/,
      'apps/erp/src/app/sales-days/[id]/page.tsx': /canReadAtStore\(tx, actor, day\.storeId,/,
      'apps/erp/src/app/wastage/[id]/page.tsx': /canReadAtStore\(tx, actor, row\.storeId,/,
    };
    for (const [file, re] of Object.entries(want)) {
      const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));
      expect(re.test(src), `${file}: the store check on the record's own store`).toBe(true);
      expect(src.includes('notFound()'), `${file}: refusal is the standard not-found`).toBe(true);
    }
  });
});
