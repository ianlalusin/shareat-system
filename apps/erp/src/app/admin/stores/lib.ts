/**
 * Server-only reads for the store management screens. T-222.
 *
 * ⭐ Mirrors `apps/erp/src/app/admin/users/lib.ts`: plain reads go straight to the repo with no
 * capability gate — the gate belongs to the WRITE, not to looking at a list — and every mutation
 * runs through `packages/domain/src/stores/service.ts`'s own `authorize()` via the actions file.
 */
import { manilaToday, storesRepo, stockLocationsRepo, type StoreRow } from '@shareat/db';
import { storeReadiness, type ReadinessCheck } from '@shareat/domain';
import { withOrgPrincipal } from '../../expenses/lib';
import { type Actor, can } from '@shareat/auth';

export { withOrgPrincipal };
export type { StoreRow, ReadinessCheck };

export interface StoreListRow extends StoreRow {
  readonly roomCount: number;
  /** T-346 Amendment R3.3 — computed once here via `isPreOpening`, so the list badge's three
   *  states (`Not yet open` / `Opens {d}` / `Opened {d}`) never re-derive the comparison. */
  readonly preOpening: boolean;
}

export async function listStoresForAdmin(orgId: string): Promise<StoreListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const stores = await storesRepo.listForOrg(tx, orgId);
    const today = await manilaToday(tx);
    const out: StoreListRow[] = [];
    for (const s of stores) {
      const rooms = await stockLocationsRepo.listActiveLocations(tx, s.id);
      out.push({ ...s, roomCount: rooms.length, preOpening: storesRepo.isPreOpening(s.openingDate, today) });
    }
    return out;
  });
}

export interface StoreDetail {
  readonly store: StoreRow;
  /**
   * ⛔ Recomputed on every read — nothing about readiness is persisted (bible row 123).
   * `null` when the viewer may not `manage_stores`; the page renders a refusal instead of forms.
   */
  readonly readiness: readonly ReadinessCheck[] | null;
}

/**
 * ⚠️ **The refusal is turned into a value HERE, on the server, and that placement is the point.**
 *
 * The list page is deliberately ungated (see this file's header, and `/admin/users`'s identical
 * precedent in `nav.tsx`), and the nav link is not hidden per-role — so a manager reaches this page
 * by clicking a store code in a list they are allowed to read. `storeReadiness` then calls
 * `authorize()`, which throws, and the smoketest caught what that produced: **HTTP 500**, not a
 * refusal. "The server refuses them properly" was a claim with a stack trace behind it.
 *
 * ⛔ It cannot be fixed in `app/error.tsx`: that boundary deliberately does NOT branch on the error
 * type, because Next replaces a Server Component error's message with a generic one plus a `digest`
 * in production precisely to stop that detail crossing the boundary. Server-side, `instanceof` is
 * still reliable — so the distinction has to be drawn here, while it still exists.
 */
export async function storeDetail(actor: Actor, storeId: string): Promise<StoreDetail | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const store = await storesRepo.getById(tx, actor.orgId, storeId);
    if (!store) return null;
    // T-402 S2 (A2): asked with the non-logging `can()`, so a plain viewer opening a store is not a logged denial.
    // ⛔ Only a "no" becomes a page. Anything else is a real fault and must keep throwing - swallowing it here would
    // hide a broken query behind "you lack access".
    if (!(await can(tx, actor, 'manage_stores', {}))) return { store, readiness: null };
    return { store, readiness: await storeReadiness(tx, actor, store) };
  });
}
