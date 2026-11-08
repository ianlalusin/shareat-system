/**
 * T-526 R3 (planner ruling, 7 Nov) - the ERP button shows only when the person can open at least one capability-GATED ERP screen outside /pos.
 * Open screens (no ROUTE_CAPABILITY entry, like /cash-requests) do not count: every signed-in person can open those, so they say nothing about
 * who belongs in the ERP. Same declaration as the sidebar (`navHrefAllowed`), so the button and the menu cannot disagree. Pure.
 */
import { GROUPS } from '@/components/nav';
import { capabilitiesForRoute, navHrefAllowed } from '@/lib/route-capability';

export function canOpenGatedErpScreen(held: ReadonlySet<string>): boolean {
  return GROUPS.some((g) =>
    g.links.some((l) => l.href !== '/pos' && !l.href.startsWith('/pos/') && capabilitiesForRoute(l.href).length > 0 && navHrefAllowed(l.href, held)),
  );
}
