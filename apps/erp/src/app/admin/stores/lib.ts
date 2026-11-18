/**
 * Server-only reads for the store management screens. T-222.
 *
 * ⭐ Mirrors `apps/erp/src/app/admin/users/lib.ts`: plain reads go straight to the repo with no
 * capability gate — the gate belongs to the WRITE, not to looking at a list — and every mutation
 * runs through `packages/domain/src/stores/service.ts`'s own `authorize()` via the actions file.
 */
import { daypartsRepo, manilaToday, personsRepo, posV2Repo, refuse, storesRepo, stockLocationsRepo, type StoreRow } from '@shareat/db';
import { assertMaySwitchStorePosMode, listKitchenSetup, posPreflight, posSoakChecks, storeReadiness, type KitchenSetup, type PreflightResult, type ReadinessCheck, type SoakCheck } from '@shareat/domain';
import { withOrgPrincipal } from '../../expenses/lib';
import { type Actor, can } from '@shareat/auth';
import type { DaypartView } from '../../menu/lib';

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

/** T-508 S2b: the kitchen panels' read. `null` = this viewer may not manage this store's settings, so the page draws no kitchen controls. */
export async function kitchenForStore(actor: Actor, storeId: string): Promise<KitchenSetup | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    if (!(await can(tx, actor, 'manage_store_settings', { storeId }))) return null;
    return listKitchenSetup(tx, actor, { storeId });
  });
}

/**
 * T-510 S3: a store's lunch and dinner hours, for anyone who can see the page. `canManage` only decides whether the controls are drawn
 * (presentation); every write is gated again in the domain.
 */
export async function daypartsForStore(actor: Actor, storeId: string): Promise<{ dayparts: DaypartView[]; canManage: boolean }> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const rows = await daypartsRepo.listDaypartsOfStore(tx, actor.orgId, storeId);
    const canManage = await can(tx, actor, 'manage_store_settings', { storeId });
    return {
      canManage,
      dayparts: rows.map((d) => ({ id: d.id, name: d.name, days: [...d.days], start: d.startTime.slice(0, 5), end: d.endTime.slice(0, 5), status: d.status })),
    };
  });
}

/** Whether the bridge key-file setting is configured: yes or no, never the value. The one probe the pre-flight and the mode switch share. */
export const keyFilePresent = (): boolean => Boolean(process.env.POS_FIREBASE_SA_KEY_FILE?.trim());

/**
 * T-533 S3: the POS pre-flight for one store. `posPreflight` authorizes `manage_stores` itself. The bridge key-file setting is asked as a yes or no
 * and its value is never read into the page.
 */
export async function posPreflightFor(actor: Actor, storeId: string): Promise<PreflightResult> {
  return withOrgPrincipal(actor.orgId, (tx) => posPreflight(tx, actor, { storeId }, { keyFilePresent }));
}

/** T-601 S1: the soak checklist for one store, beside the pre-flight. `posSoakChecks` authorizes `manage_stores` itself (through the pre-flight it calls first). */
export async function posSoakChecksFor(actor: Actor, storeId: string): Promise<SoakCheck[]> {
  return withOrgPrincipal(actor.orgId, (tx) => posSoakChecks(tx, actor, { storeId }, { keyFilePresent }));
}

export interface PosModeView {
  /** `off` when the store has no switch row yet. */
  readonly mode: 'off' | 'test' | 'live';
  readonly liveFrom: string | null;
  /** Null until the first change. */
  readonly changedAt: Date | null;
  readonly changedByName: string | null;
  readonly today: string;
  readonly preflight: PreflightResult;
}

/** T-533 S1: what the POS card on the store page shows: the stored mode, who set it and when, and the pre-flight counts. Admin only (the pre-flight authorizes). */
export async function posModeFor(actor: Actor, storeId: string): Promise<PosModeView> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const row = await posV2Repo.getPosStore(tx, actor.orgId, storeId);
    const who = row ? await personsRepo.getPersonById(tx, actor.orgId, row.changedBy) : undefined;
    return {
      mode: row?.mode ?? 'off',
      liveFrom: row?.liveFrom ?? null,
      changedAt: row?.changedAt ?? null,
      changedByName: who?.displayName ?? null,
      today: await manilaToday(tx),
      preflight: await posPreflight(tx, actor, { storeId }, { keyFilePresent }),
    };
  });
}

/** T-533 S1: what the confirm step needs to name the store and to know whether this is a roll-back from live. Admin or super-admin only (the same gate as the switch), so a manager is refused at step 1; it changes nothing. */
export async function posModeStepFor(actor: Actor, storeId: string): Promise<{ storeName: string; wasLive: boolean }> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await assertMaySwitchStorePosMode(tx, actor);
    const store = await storesRepo.getById(tx, actor.orgId, storeId);
    if (!store) throw refuse(`posModeStepFor: store ${storeId} not in org`, 'That store does not exist.');
    return { storeName: store.name, wasLive: (await posV2Repo.getPosStore(tx, actor.orgId, storeId))?.mode === 'live' };
  });
}
