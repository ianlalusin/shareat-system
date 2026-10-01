/**
 * T-288 — which capability a route requires, declared ONCE and read by both consumers.
 *
 * **Ian, 2026-09-12:** *"do both hide the menu and gate the reads."* That overturns the posture
 * recorded against DEF-051 (*"hiding a link is presentation; the gate is the write"*) — see
 * `docs/tasks/288-*.md` for the amendment. ⛔ It does **not** repeal DEF-051's reasoning: hiding
 * alone is still worthless. What changes is that hiding now sits **on top of** a real read gate,
 * instead of being rejected as a substitute for one.
 *
 * ## ⛔ Why one map and not two lists
 *
 * The nav filter and the page gate must never be able to disagree. If they read different lists
 * they drift in the SILENT, dangerous direction: a link disappears, an operator concludes the
 * screen is protected, and the URL still renders everything. That is DEF-310's exact shape — two
 * guards described as twins, one widened, the other not, passing happily while blind.
 *
 * So this file is the only declaration. `AppShell` filters the sidebar from it;
 * `requirePageAccess` refuses from it; `tests/unit/route-capability-coverage.test.ts` proves every
 * route it names is actually guarded and every guarded route is named.
 *
 * ## ⚠️ What this is NOT
 *
 * It is not the authorization system. `authorize()` in `packages/auth` remains the control, is
 * unchanged, and still runs inside every domain service on every write. This adds a **second
 * layer for reads** (bible §15.11 — no layer may be the only one for a given risk). A route absent
 * from this map is readable by any signed-in person, which is correct for the staff-facing
 * surfaces and is why the map is deliberately not exhaustive.
 */
import type { Capability } from '@shareat/auth';

/**
 * Route → the capability required to READ it. Longest prefix wins, so `/admin/users/[id]` inherits
 * `/admin/users` without needing its own row.
 *
 * ⭐ **Only genuinely sensitive surfaces are listed, and that is a decision not an omission.**
 * `/clock`, `/till`, `/sales-days`, `/expenses`, `/inventory/*` and the rest are where a cashier
 * legitimately works; gating them would break the app for the role that uses it most. The test
 * that matters is *"would it be wrong for the person at the counter to read this"*, not
 * *"is there a capability that sounds related"*.
 */
export const ROUTE_CAPABILITY: Readonly<Record<string, Capability>> = {
  // --- Who may act, and where. The keys to the building. -------------------------------------
  '/admin/users': 'manage_users',
  '/admin/stores': 'manage_stores',
  // T-290 — position access defaults. `grant_capability` is org-scoped and is the capability the
  // screen's every write already checks inside the domain; the page gate reads the same word.
  '/admin/access-defaults': 'grant_capability',

  // --- Configuration that changes how money is classified for everyone ------------------------
  '/settings': 'manage_store_settings',

  // --- The books. A cashier's own day is theirs; the organisation's ledger is not. -------------
  '/reports/trial-balance': 'view_trial_balance',
  '/reports/income-statement': 'view_financial_reports',
  '/reports/balance-sheet': 'view_financial_reports',
  '/reports/cash-flow': 'view_financial_reports',
  '/reports/ap-aging': 'view_financial_reports',
  '/reports/ar-aging': 'view_financial_reports',
  '/reports/store-comparison': 'view_financial_reports',
  '/reports/sales-rollup': 'view_financial_reports',

  // --- What the business owes and owns, and what people are paid ------------------------------
  // ⚠️ `/payroll` is the one people react to most strongly when it is visible on a counter
  //    tablet: it names colleagues' pay. It was reachable by any signed-in person until T-288.
  '/payroll': 'run_payroll',
  // T-369 S1: names colleagues' money owed, like `/payroll`. The longer prefix wins over `/expenses`.
  '/expenses/reimbursements': 'record_ap_payment',
  '/owners': 'view_financial_reports',
  '/loans': 'view_financial_reports',
  '/liabilities': 'view_financial_reports',
  '/service-charge': 'view_financial_reports',
  '/fixed-assets': 'manage_fixed_assets',
  '/money-accounts': 'view_financial_reports',
  '/money-transfers': 'view_financial_reports',
  '/prepaid': 'view_financial_reports',
};

/**
 * The capability required to read `pathname`, or `null` when the route is open to any signed-in
 * person.
 *
 * ⚠️ **Longest prefix wins, and the boundary check is not decoration.** A bare `startsWith` would
 * make `/ownership-transfer` inherit `/owners`'s capability — a route that does not exist today,
 * which is exactly how this kind of helper acquires a wrong answer nobody notices. A prefix
 * matches only at a `/` boundary or on an exact match.
 */
export function capabilityForRoute(pathname: string): Capability | null {
  let best: { route: string; capability: Capability } | null = null;
  for (const [route, capability] of Object.entries(ROUTE_CAPABILITY)) {
    const matches = pathname === route || pathname.startsWith(`${route}/`);
    if (!matches) continue;
    if (!best || route.length > best.route.length) best = { route, capability };
  }
  return best?.capability ?? null;
}

/**
 * Presentation only — which nav hrefs this actor may be shown.
 *
 * ⛔ **`held` is a set of capabilities, and this function is NOT a control.** It decides what a
 * menu renders. `requirePageAccess` is what actually refuses, and `authorize()` is what actually
 * refuses a write. A caller that used this to decide whether an action may proceed has
 * re-created DEF-051.
 */
export function navHrefAllowed(href: string, held: ReadonlySet<string>): boolean {
  const required = capabilityForRoute(href);
  return required === null || held.has(required);
}
