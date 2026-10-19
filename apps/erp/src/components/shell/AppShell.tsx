/**
 * T-234 slice 1 — the shell root: reads the session and the sidebar cookie, renders `TopBar` +
 * `Sidebar` + the single `<main>` this app owns (lane B's `Page`, slice 2, renders a plain `<div>`
 * inside it — not its own `<main>`, or the document gets two landmarks). Returns bare `{children}`
 * whenever there is no session, exactly as `Nav()` did before this task — and now also whenever
 * `../../proxy` has tagged the request as the kiosk (DEF-233 / T-246).
 *
 * ⭐ **DEF-233, fixed by T-246.** `/clock`'s Firebase auth is entirely separate from this app's own
 * `__session` cookie (`apps/erp/src/lib/session.ts`), so the session check alone let the ERP's
 * chrome render on `/clock` whenever a manager held an ERP session in the same browser. A Server
 * Component cannot read the current pathname in Next 16
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-pathname.md`), so
 * `../../proxy` (matcher-scoped to `/clock`) tags the request with `KIOSK_HEADER` on the way in;
 * this reads it via `headers()`. ⛔ Presentation only — it decides chrome, never access.
 */
import { cookies, headers } from 'next/headers';
// ⛔ From the CHOKEPOINT, not from `@shareat/db` — T-261 §B6. That module is where the
//    constraint-refusal counter lives; a direct import silently bypasses it.
import { withOrgPrincipal } from '../../app/expenses/lib';
import { heldCapabilities } from '@shareat/auth';
import { currentSession } from '../../lib/session';
import { GROUPS } from '../nav';
import { navHrefAllowed } from '../../lib/route-capability';
import { KIOSK_HEADER } from './kiosk';
import { SIDEBAR_COOKIE_NAME, parseSidebarState } from './sidebar-state';
import { Sidebar, SidebarProvider } from './Sidebar';
import { TopBar } from './TopBar';

export async function AppShell({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  const headerList = await headers();
  if (!session || headerList.has(KIOSK_HEADER)) return <>{children}</>;

  const cookieStore = await cookies();
  const initialState = parseSidebarState(cookieStore.get(SIDEBAR_COOKIE_NAME)?.value);

  /**
   * ⭐ **T-288 — Ian, 2026-09-12: *"do both hide the menu and gate the reads."***
   *
   * Until now this sidebar did no filtering of any kind: a cashier signing in with a store PIN on
   * a counter tablet was shown Users, Stores, Payroll and the whole ledger. Nothing could be
   * CHANGED — every write is gated in the domain — but everything could be read.
   *
   * ⛔ **Hiding is not the control and never becomes one.** The same `ROUTE_CAPABILITY` map drives
   * `requirePageAccess`, which refuses the route itself, so typing the URL gets a refusal card
   * rather than the data. One declaration, two consumers — because a nav filter and a page gate
   * reading separate lists drift silently in the dangerous direction (DEF-310's shape).
   *
   * ⚠️ Two queries per authenticated request, not one per link: `heldCapabilities` reads the role
   * and the grant rows once.
   */
  // ⛔ Principalled — see `page-access.tsx`'s note. T-231.
  const held = await withOrgPrincipal(session.actor.orgId, (tx) =>
    heldCapabilities(tx, session.actor),
  );
  const allowedHrefs = GROUPS.flatMap((g) => g.links.map((l) => l.href)).filter((href) =>
    navHrefAllowed(href, held as ReadonlySet<string>),
  );

  return (
    <SidebarProvider initialState={initialState}>
      <div className="flex min-h-dvh">
        <Sidebar allowedHrefs={allowedHrefs} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="erp-workspace min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}
