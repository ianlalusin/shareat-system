/**
 * The gate for the financial reports — DEF-064.
 *
 * ## ⛔ What was wrong
 *
 * Both report pages called neither `requireSession()` nor `authorize()`, read straight off
 * `getDb()` (which sets no RLS principal) over a superuser connection, and took the ORG from the
 * query string — validated only as "an active org that exists", which is an existence check, not
 * an authorization check. `GET /reports/trial-balance?org=<uuid>` returned any organisation's full
 * trial balance to a visitor with no session at all, and the org picker enumerated every org's id
 * to make it easy.
 *
 * It survived T-138 and a daily review because the capabilities exist and LOOK enforced:
 * `view_trial_balance` and `view_financial_reports` are both in `CAPABILITY_MATRIX`, and
 * `tests/unit/no-client-supplied-actor.test.ts` passes — but that guard scans for a client-supplied
 * ACTOR, and these pages were reading a client-supplied ORG.
 *
 * ⭐ **The structural lesson.** Every MUTATION in this repo is gated because `authorize()` sits
 * inside the domain services a mutation must call. A READ has no such choke point — page →
 * `getDb()` → SQL touches no layer that has ever heard of an actor. That is why this file exists:
 * to be the choke point reads did not have. **A new read surface goes through `reportScope()`.**
 *
 * ## The model (Ian, 2026-08-26)
 *
 * > *"signed in user = own org; for multi-store org up one step to store access / storeId linked
 * > to profile"*
 *
 * The org comes from the session and is never accepted from the URL. Which STORES a person may
 * see comes from `person_store_scope` — the axis that already existed and that `authorize()`
 * already enforces for every store-scoped capability. Someone scoped to Lipa sees Lipa; someone
 * scoped to every store in the org sees the org-wide view.
 */
import { accessRepo, type Tx } from '@shareat/db';
import { authorize, can, type Actor, type Capability } from '@shareat/auth';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@shareat/db';
import { requireSession } from '../../lib/session';
import { withOrgPrincipal } from '../expenses/lib';

export { withOrgPrincipal } from '../expenses/lib';

export interface StoreOption {
  id: string;
  name: string;
  code: string;
}

export interface ReportScope {
  actor: Actor;
  orgName: string;
  orgCode: string;
  /** ONLY the stores this person may see. Never every store in the org unless they are scoped
   *  to every store in the org. */
  stores: StoreOption[];
  /** The store the report is limited to, or `undefined` for an org-wide view — which is only
   *  ever reachable by someone scoped to the whole org. */
  storeId: string | undefined;
  coversWholeOrg: boolean;
}

/**
 * Resolves who is asking, what they may see, and refuses if they may not.
 *
 * `capability` is the one this report needs — `view_trial_balance` (org-scoped) or
 * `view_financial_reports` (store-scoped).
 *
 * ⚠️ For a store-scoped capability the check runs **once per store being reported on**, not once
 * for the request. The org-wide view reports on every store the person holds, so it authorizes
 * every one of them — which is the honest reading of "you may see these stores' money", and it
 * means a person scoped to two of five stores cannot reach an org-wide total by omitting the
 * filter.
 */
export async function reportScope(
  path: string,
  capability: Capability,
  requestedStoreId: string | undefined,
): Promise<ReportScope> {
  const { actor } = await requireSession(path);

  return withOrgPrincipal(actor.orgId, async (tx) => {
    const [org] = await tx
      .select({ name: schema.organizations.name, code: schema.organizations.code })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, actor.orgId))
      .limit(1);

    const { stores, coversWholeOrg } = await scopedStores(tx, actor);

    // A requested store is honoured only if it is one of theirs. Anything else falls back — and
    // for someone who is NOT org-wide the fallback is their first store, never "all stores",
    // because "all" for them would silently widen the report past their scope.
    const storeId =
      requestedStoreId && stores.some((s) => s.id === requestedStoreId)
        ? requestedStoreId
        : coversWholeOrg
          ? undefined
          : stores[0]?.id;

    await authorizeForScope(tx, actor, capability, storeId, stores);

    return {
      actor,
      orgName: org?.name ?? 'Unknown organisation',
      orgCode: org?.code ?? '—',
      stores,
      storeId,
      coversWholeOrg,
    };
  });
}

/**
 * T-435 — the store list half of `reportScope`, extracted so every personal-data page uses the SAME rule (bible row 353).
 *
 * Active stores only (DEF-200: `personCoversWholeOrg` answers from ACTIVE stores, so a list that also held retired ones made
 * `authorize` hit a store nobody has a row for). The whole org's active stores if the actor covers the whole org, else the
 * actor's own scope rows. `includeRetired` (payroll final pay at a closed branch) adds retired stores ONLY where the actor
 * has a scope row, so `authorize` can pass; no admin bypass.
 */
export async function scopedStores(
  tx: Tx,
  actor: Actor,
  opts: { includeRetired?: boolean } = {},
): Promise<{ stores: StoreOption[]; coversWholeOrg: boolean }> {
  const orgStores = await tx
    .select({
      id: schema.stores.id,
      name: schema.stores.name,
      code: schema.stores.code,
      isActive: schema.stores.isActive,
    })
    .from(schema.stores)
    .where(eq(schema.stores.orgId, actor.orgId))
    .orderBy(asc(schema.stores.name));

  const coversWholeOrg = await accessRepo.personCoversWholeOrg(tx, actor.personId, actor.orgId);
  const heldIds = new Set(await accessRepo.storeIdsForPerson(tx, actor.personId));
  const stores = orgStores
    .filter((s) => (s.isActive ? coversWholeOrg || heldIds.has(s.id) : opts.includeRetired === true && heldIds.has(s.id)))
    .map(({ id, name, code }) => ({ id, name, code }));
  return { stores, coversWholeOrg };
}

async function authorizeForScope(
  tx: Tx,
  actor: Actor,
  capability: Capability,
  storeId: string | undefined,
  stores: StoreOption[],
): Promise<void> {
  const { CAPABILITY_SCOPE } = await import('@shareat/auth');

  if (CAPABILITY_SCOPE[capability] !== 'store') {
    await authorize(tx, actor, capability, {});
    return;
  }

  if (storeId) {
    await authorize(tx, actor, capability, { storeId });
    return;
  }

  // Org-wide view of a store-scoped capability: prove it for every store it will include.
  if (stores.length === 0) {
    await authorize(tx, actor, capability, {});
    return;
  }
  for (const s of stores) {
    await authorize(tx, actor, capability, { storeId: s.id });
  }
}

/** Runs a report query under the RLS principal, so the database is a real backstop rather than a
 *  setting nobody exercised. The reports were the ONE place in this app still reading off the
 *  unrestricted owner connection. */
export async function runReport<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOrgPrincipal(orgId, fn);
}


/**
 * T-435 / bible row 353 - customer names and balances in a report only for stores where the viewer holds
 * `record_ar_collection` (view_financial_reports alone is not a right to read customers). One store: that store. Org-wide view:
 * every store in the list must pass.
 */
export async function mayReadCustomerBalances(scope: Pick<ReportScope, 'actor' | 'stores' | 'storeId'>): Promise<boolean> {
  return withOrgPrincipal(scope.actor.orgId, async (tx) => {
    const ids = scope.storeId ? [scope.storeId] : scope.stores.map((s) => s.id);
    if (ids.length === 0) return false;
    for (const storeId of ids) {
      if (!(await can(tx, scope.actor, 'record_ar_collection', { storeId }))) return false;
    }
    return true;
  });
}
