/**
 * Where a sign-in lands when `next` says nothing usable. DEF-809 follow-up.
 *
 * `/sales-days` is gated by `submit_sales_day` (position-granted for staff, T-318), so sending EVERYONE there
 * put a staff member without the grant on a refusal page. An explicit safe `next` still wins; otherwise a person
 * who may submit a sales day at ANY store they can see lands on `/sales-days`, and everyone else on `STAFF_HOME`.
 *
 * ⚠️ `/` is NOT a safe fallback: it is gated by `view_financial_reports` (manager and up). `/cash-requests` is a
 * top-level page that needs only a session. The question goes through `can()`, the same decision `authorize` makes,
 * so position grants count.
 */
import { can, type Actor } from '@shareat/auth';
import { actorForToken } from '../../lib/session';
import { scopedStores } from '../reports/lib';
import { withOrgPrincipal } from '../expenses/lib';
import { capabilitiesForRoute } from '@/lib/route-capability';
import { safeNext } from './lib';

export const SALES_DAYS_HOME = '/sales-days';
export const STAFF_HOME = '/cash-requests';

/** The `next` the visitor asked for, if it is a safe in-app path; otherwise null (never the default). */
export function explicitNext(raw: string): string | null {
  const safe = safeNext(raw);
  // safeNext returns SALES_DAYS_HOME for anything unusable; a real request for it is told apart by the raw text.
  if (safe === SALES_DAYS_HOME && raw !== SALES_DAYS_HOME) return null;
  return safe;
}

/**
 * T-526 R2 - a sign-in on a PAIRED tablet lands in the full-screen POS: the till if the person may sell at the pairing's store, else the
 * kitchen screen, else refills. Asked through `can()` at that one store, the same decision `authorize` makes. Null when none applies.
 */
const POS_LANDINGS = [
  ['record_sale', '/pos'],
  ['serve_pos_ticket', '/pos/kitchen'],
  ['request_pos_refill', '/pos/refills'],
] as const;

async function posLanding(actor: Actor, storeId: string): Promise<string | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    for (const [capability, route] of POS_LANDINGS) if (await can(tx, actor, capability, { storeId })) return route;
    return null;
  });
}

/** `opts.tabletStoreId`: the store of the live pairing, passed ONLY by the paired-tablet sign-in. Absent means a laptop or phone: today's landing. */
export interface LandingOpts {
  tabletStoreId?: string | null;
}

const isPosPath = (p: string) => /^\/pos(?:[/?#]|$)/.test(p);

/**
 * T-526b P0 - a tablet that opens /pos signed out is sent to `/sign-in?next=/pos`, so EVERY kitchen or refill person arrived with an "explicit safe next"
 * of `/pos` and was sent straight back to the screen that refuses them. On a paired tablet a POS `next` therefore counts only when the person may open
 * it at the pairing's store (its own route requirement); otherwise their first allowed POS tab applies. Any non-POS `next` still wins untouched.
 */
async function nextWins(actor: Actor, explicit: string, opts?: LandingOpts): Promise<boolean> {
  if (!opts?.tabletStoreId || !isPosPath(explicit)) return true;
  const wanted = capabilitiesForRoute(explicit.split(/[?#]/)[0]!);
  const storeId = opts.tabletStoreId;
  return withOrgPrincipal(actor.orgId, async (tx) => {
    for (const cap of wanted) if (await can(tx, actor, cap, { storeId })) return true;
    return false;
  });
}

export async function landingForActor(actor: Actor, raw: string, opts?: LandingOpts): Promise<string> {
  const explicit = explicitNext(raw);
  if (explicit && (await nextWins(actor, explicit, opts))) return explicit;
  if (opts?.tabletStoreId) {
    const pos = await posLanding(actor, opts.tabletStoreId);
    if (pos) return pos;
  }
  const allowed = await withOrgPrincipal(actor.orgId, async (tx) => {
    const { stores } = await scopedStores(tx, actor);
    for (const s of stores) {
      if (await can(tx, actor, 'submit_sales_day', { storeId: s.id })) return true;
    }
    return false;
  });
  return allowed ? SALES_DAYS_HOME : STAFF_HOME;
}

/** For the actions: the session cookie is not readable in the same request, so resolve the fresh token. */
export async function landingForToken(token: string, raw: string, opts?: LandingOpts): Promise<string> {
  const explicit = explicitNext(raw);
  // A POS `next` on a paired tablet needs the person's grants to be judged, so only the other nexts skip resolving the actor.
  if (explicit && !(opts?.tabletStoreId && isPosPath(explicit))) return explicit;
  return landingForActor(await actorForToken(token), raw, opts);
}
