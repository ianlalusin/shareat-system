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
import { accessRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor, type Capability } from '@shareat/auth';
import { and, asc, eq } from 'drizzle-orm';
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

    const orgStores = await tx
      .select({
        id: schema.stores.id,
        name: schema.stores.name,
        code: schema.stores.code,
      })
      .from(schema.stores)
      // ⛔ DEF-200 — ACTIVE stores only, and the `is_active` half is not a nicety, it is the whole
      // bug. `personCoversWholeOrg` (`repo/access.ts`) answers "do you hold every store?" from
      // `activeStoreIdsForOrg` — **active** stores. This query had no such filter, so a person who
      // held every active store was told `coversWholeOrg = true` and then handed a store list that
      // ALSO contained the retired ones. `authorizeForScope` proves the capability per store, hit a
      // store nobody has a scope row for, and threw: **seven report screens returned HTTP 500 for
      // every role**, super-admin included, from the moment one store was deactivated.
      //
      // ⭐ Two functions disagreeing about what "the org's stores" means — the same shape as every
      // other two-sources-of-truth defect in this project. `personCoversWholeOrg` is the authority
      // because it is the one the gate actually consults; this query now matches its definition.
      //
      // ⚠️ And a retired store has no business in a report scope anyway: it can post nothing new,
      // and offering it as the default filter (it sorted last, so it was the one that broke) shows
      // a period no one is trading in.
      .where(and(eq(schema.stores.orgId, actor.orgId), eq(schema.stores.isActive, true)))
      .orderBy(asc(schema.stores.name));

    const coversWholeOrg = await accessRepo.personCoversWholeOrg(tx, actor.personId, actor.orgId);
    const heldIds = new Set(await accessRepo.storeIdsForPerson(tx, actor.personId));
    const stores = coversWholeOrg ? orgStores : orgStores.filter((s) => heldIds.has(s.id));

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

export { transaction };
