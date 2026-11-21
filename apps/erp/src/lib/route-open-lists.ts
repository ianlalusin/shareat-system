/**
 * T-616 / T-603 S5 - the two lists of routes that are allowed to have NO entry in `ROUTE_CAPABILITY`, declared ONCE.
 * `requirePageAccess` (runtime) and `tests/unit/route-capability-coverage.test.ts` (CI) both read them, so the two cannot drift.
 * Any other page with no map entry is refused at runtime (bible section 7 rule 11, deny-by-default).
 */
import { ROUTE_CAPABILITY } from './route-capability';

/**
 * Routes open to any signed-in person (or to nobody signed in) BY RECORDED DECISION. Each entry cites the decision.
 * ⛔ Add a route here only when a bible row / task says it is open - never to make a guard green. An unmapped page with no
 * decision is a defect to report, not an entry to add.
 */
export const APPROVED_OPEN_ROUTES: Readonly<Record<string, string>> = {
  '/': 'T-589 B3a: everyone lands here; the page shows a plain welcome',
  '/sign-in': 'T-232: no session exists yet',
  '/setup': 'T-232: first-run setup, no session exists yet',
  '/clock': 'Firebase kiosk terminal: no ERP session',
};

/**
 * T-617: EMPTY, on purpose. The 13 routes that awaited Ian's decision were mapped on 22 Nov 2026 ("approve the defaults"). The export stays so the
 * coverage test and `routeHasNoRule` keep one place to look; ⛔ do not add to it - an unmapped page with no decision is refused and is a defect to report.
 */
export const ROUTES_AWAITING_A_DECISION: readonly string[] = [];

/** `route` is `key` or sits under it (a `/` boundary, never a bare prefix; `/` itself matches only `/`). */
const under = (route: string, key: string): boolean => route === key || (key !== '/' && route.startsWith(`${key}/`));

/** Has the permission map an entry (any value, `null` included - an explicit open entry is still an entry) for this route? */
export function hasMapEntry(route: string): boolean {
  return Object.keys(ROUTE_CAPABILITY).some((k) => under(route, k));
}

/** True when `route` has no map entry AND is on neither list: it must be refused at runtime. */
export function routeHasNoRule(route: string): boolean {
  if (hasMapEntry(route)) return false;
  return !Object.keys(APPROVED_OPEN_ROUTES).some((k) => under(route, k)) && !ROUTES_AWAITING_A_DECISION.some((k) => under(route, k));
}
