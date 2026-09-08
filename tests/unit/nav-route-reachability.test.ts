/**
 * T-227 — **a menu entry with no page, and a page with no menu entry, are one defect seen from
 * two sides. Nothing was checking either direction.**
 *
 * `docs/tasks/227-caller-and-nav-guards.md`. Nine logged defects share this shape and every one was
 * found by a human opening a browser: DEF-107 (a nav entry that 404s), DEF-133, DEF-137, DEF-139,
 * DEF-174, DEF-181, DEF-186, DEF-190 and DEF-192. The 2,400-test suite went green through all of
 * them, because **a page with no link renders perfectly when you type its URL.**
 *
 * `docs/CAPABILITY-GAPS.md`'s *"The sweep that found these"* recorded the manual audit and said the
 * obvious next thing — *"both checks are mechanical enough to be tests rather than a periodic
 * audit"*. This is that, in the two directions the sweep names:
 *
 *   A. every `href:` in `nav.tsx` resolves to a `page.tsx`            — would have caught DEF-107, DEF-192
 *   B. every non-dynamic route is reachable from nav, transitively    — would have caught DEF-139, DEF-181
 *
 * ⭐ **Its first run was red on two live failures**, which is the only way to know a guard guards:
 * `/settings` was in nav with no page behind it (DEF-192), and `/attendance/lane` — landmine #14's
 * entire structural fix, the screen that exists so a dead letter is visible — was itself reachable
 * from nowhere (DEF-197).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const APP_ROOT = 'apps/erp/src/app';
const NAV_FILE = 'apps/erp/src/components/nav.tsx';

/**
 * ⛔ `git ls-files`, never a directory walk. `apps/erp/.next` holds turbopack copies of every route
 * and every domain symbol; scanning it makes everything look linked and called. It is gitignored,
 * so enumerating from git cannot see it — the exclusion is structural rather than a rule someone
 * has to remember. Same reasoning as `no-ungated-read-surface.test.ts`.
 *
 * ⭐ `--others --exclude-standard` adds files that are NOT YET STAGED, and that is deliberate:
 * a page written five minutes ago is exactly the one at risk of shipping unlinked, and a guard
 * that only sees committed work would go green on it and red one commit later, for reasons
 * nobody would connect. `--exclude-standard` still honours `.gitignore`, so `.next` stays out.
 */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/**
 * ⛔ Comments are stripped before any path is extracted, and this is not tidiness — it is the
 * difference between the guard working and the guard lying. `/attendance/lane` appears exactly once
 * outside its own directory, in a *comment* on `attendance/page.tsx`. Matching raw text would have
 * declared it linked and the live defect would have gone unreported.
 *
 * ⚠️ Also normalises CRLF first: this repo checks out CRLF, JavaScript's `.` does not match `\r`,
 * and a line-oriented scan that silently matches nothing looks exactly like a clean tree (DEF-179).
 */
function codeOnly(src: string): string {
  const withoutBlocks = src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const read = (repoRelative: string) => codeOnly(readFileSync(path.join(repoRoot, repoRelative), 'utf8'));

/** `apps/erp/src/app/reports/ap-aging/page.tsx` → `/reports/ap-aging`; the root page → `/`. */
function routeOf(pageFile: string): string {
  const rel = pageFile.slice(`${APP_ROOT}/`.length).replace(/\/?page\.tsx$/, '');
  return rel === '' ? '/' : `/${rel}`;
}

const isDynamic = (route: string) => route.includes('[');

const files = trackedFiles();
const pageFiles = files.filter((f) => f.startsWith(`${APP_ROOT}/`) && f.endsWith('page.tsx'));
const routes = pageFiles.map(routeOf).sort();
const routeSet = new Set(routes);

/** The `href: '/x'` literals in the `GROUPS` table. Only that form — nav is a data table, not JSX. */
function navHrefs(): string[] {
  const src = read(NAV_FILE);
  return [...src.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Every internal path a file actually *navigates* to. Deliberately narrow: an `href=`, a
 * `redirect(...)` or a `router.push(...)`. ⚠️ A bare string that happens to look like a path is not
 * a link — `requireActor('/staff/hire')` names a return-to path and `revalidatePath('/expenses')`
 * refreshes a cache; neither puts a control on a screen.
 */
const LINK = /(?:href=\{?['"`]|redirect\(\s*['"`]|push\(\s*['"`])(\/[A-Za-z0-9_/-]*)/g;

function linksIn(repoRelative: string): string[] {
  return [...read(repoRelative).matchAll(LINK)]
    .map((m) => m[1]!)
    .map((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p))
    .filter((p) => routeSet.has(p));
}

/**
 * Which route a file's links belong to: the nearest ancestor directory that has a `page.tsx`. So
 * `app/customers/actions.ts` speaks for `/customers`, and `app/reports/ap-aging/export/route.ts`
 * speaks for `/reports/ap-aging`.
 *
 * ⚠️ **The one accepted hole, stated rather than hidden.** Files under `src/components/**` and
 * `src/lib/**` are shared and belong to no route, so their links are treated as reachable — they do
 * render inside pages (`/reports/journal-lines` is linked only from `components/reports/
 * TrialBalanceTable.tsx`). If a shared component were itself orphaned, its links would be believed.
 * Widening this means resolving imports, which buys little against a failure that has never occurred.
 */
const SHARED = '<shared>';

function ownerOf(file: string): string | null {
  if (file.startsWith('apps/erp/src/components/') || file.startsWith('apps/erp/src/lib/')) return SHARED;
  if (!file.startsWith(`${APP_ROOT}/`)) return null;
  let dir = path.posix.dirname(file);
  for (;;) {
    const route = routeOf(`${dir}/page.tsx`);
    if (routeSet.has(route)) return route;
    if (dir === APP_ROOT) return null;
    dir = path.posix.dirname(dir);
  }
}

/** route (or `<shared>`) → the routes it links to. */
function linkGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    if (/\.test\.tsx?$/.test(file)) continue;
    if (file === NAV_FILE) continue; // nav is the root set, not an edge
    const owner = ownerOf(file);
    if (owner === null) continue;
    const targets = linksIn(file);
    if (targets.length === 0) continue;
    const bucket = graph.get(owner) ?? new Set<string>();
    for (const t of targets) bucket.add(t);
    graph.set(owner, bucket);
  }
  return graph;
}

/**
 * Reached without passing through the menu, and legitimately so. ⛔ Two entries, both argued:
 * a kiosk terminal and a sign-in page. Anything added here needs the same standard — *why would a
 * manager never be given a link to this?* — not *"it was easier than linking it"*.
 */
const UNLINKED_BY_DESIGN: Record<string, string> = {
  '/clock':
    'The terminal kiosk. Opened on a provisioned device, and bible §5.2 forbids it touching the ' +
    'server at all — it must never sit in a menu a signed-in manager sees.',
  '/sign-in':
    'Reached by redirect when there is no session. `nav.tsx` renders nothing without one, so a ' +
    'nav entry pointing here could never be shown to anybody who needed it.',
  '/setup':
    'The first-run screen. Reached only by redirect from /sign-in, carrying a verified Firebase ' +
    'identity, and only while zero organizations exist. `nav.tsx` renders from the session, and ' +
    'there is no session here, nor any person for one to belong to, so a nav entry could never ' +
    'be shown to the one person who needs it. It refuses itself the moment an org exists.',
};

describe('T-227 — nav and routes agree, in both directions', () => {
  it('⭐ finds nav entries, routes and links at all — a scan matching nothing passes silently (DEF-179)', () => {
    // ⚠️ Not ceremony. Each floor is a number that collapses to zero if the enumeration breaks:
    // a wrong `APP_ROOT`, a `git ls-files` that fails, a CRLF split that matches nothing.
    expect(navHrefs().length).toBeGreaterThan(20);
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => !isDynamic(r)).length).toBeGreaterThan(40);
    const edges = [...linkGraph().values()].reduce((n, s) => n + s.size, 0);
    expect(edges).toBeGreaterThan(20);
  });

  it('⛔ A — every nav href resolves to a page.tsx (DEF-107, DEF-192)', () => {
    const broken = navHrefs()
      .filter((href) => !routeSet.has(href))
      .map(
        (href) =>
          `${NAV_FILE} — href '${href}' has no page.tsx under ${APP_ROOT}. It is a 404 in the menu. ` +
          'Add the route or remove the entry; do not leave a link nobody can follow.',
      );
    expect(broken).toEqual([]);
  });

  it('⛔ B — every non-dynamic route is reachable from nav (DEF-139, DEF-181, DEF-197)', () => {
    const graph = linkGraph();
    const reachable = new Set<string>([SHARED, ...navHrefs().filter((h) => routeSet.has(h))]);
    // Transitive: a page linked from a reachable page is reachable. `/inventory` links
    // `/inventory/transfers`, which is in no menu and is genuinely reachable.
    const queue = [...reachable];
    while (queue.length > 0) {
      for (const target of graph.get(queue.pop()!) ?? []) {
        if (reachable.has(target)) continue;
        reachable.add(target);
        queue.push(target);
      }
    }

    const orphans = routes
      .filter((r) => !isDynamic(r))
      .filter((r) => !reachable.has(r))
      .filter((r) => UNLINKED_BY_DESIGN[r] === undefined)
      .map(
        (r) =>
          `${r} — no nav entry and nothing reachable links to it, so it exists only for whoever ` +
          'types the URL. Link it from a page that is reachable, add it to nav, or record it in ' +
          'UNLINKED_BY_DESIGN with the reason a manager would never be given a link to it.',
      );
    expect(orphans).toEqual([]);
  });

  it('⚠️ every UNLINKED_BY_DESIGN entry is a real route with a real reason', () => {
    // An exemption for a route that no longer exists makes the rule look narrower than it is —
    // the stale-entry lesson from `no-client-supplied-actor.test.ts` (bible §13 row 138).
    const bad = Object.entries(UNLINKED_BY_DESIGN).flatMap(([route, reason]) => [
      ...(routeSet.has(route) ? [] : [`${route} — exempted but no such route exists; delete the entry`]),
      ...(reason.trim().length > 40 ? [] : [`${route} — the reason is too thin to be a reason`]),
    ]);
    expect(bad).toEqual([]);
  });
});
