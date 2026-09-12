/**
 * Server-only reads and pure decisions for `/admin/access-defaults`. T-290.
 * `docs/tasks/290-access-defaults-screen.md` §C3; `docs/plans/289-position-access-defaults-plan.md` §5.1.
 *
 * ⭐ **These reads carry no capability gate of their own — mirrors `apps/erp/src/app/admin/users/lib.ts:1-8`.**
 * Plain reads go straight to the repo layer; the control is the WRITE, gated in `actions.ts`
 * (inside T-289's `setPositionDefault` / `retireStorePosition`, which own the `authorize()`).
 * ⚠️ Since T-288 (bible row 199) the PAGE is additionally gated by `requirePageAccess` through
 * `ROUTE_CAPABILITY['/admin/access-defaults'] = 'grant_capability'`: a manager without that
 * capability sees the refusal card, not the grid (smoketested 2026-09-12). That gate reads the same
 * word the writes check, so the two cannot drift; it does not replace the write gate and this
 * file still does not re-check it. ⚠️ **DEF-064's rule does not apply here.** That guard is about
 * pages that read the **ledger** with no session at all; this page establishes the session, and
 * reads only this org's own access configuration under `withOrgPrincipal`.
 *
 * ⚠️ The T-290 build found that `OFFERABLE_TO_POSITIONS` did not cross `@shareat/domain`'s barrel
 * (T-289's file list missed the one re-export line). The planner added it in T-290's commit; this
 * file imports the real constant and carries no re-derivation (§C6: "import it, never re-derive").
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  accessRepo,
  employmentRepo,
  schema,
  type PositionRow,
  type Tx,
} from '@shareat/db';
import { CANONICAL_POSITIONS } from '@shareat/db/schema';
import { OFFERABLE_TO_POSITIONS } from '@shareat/domain';
import { CAPABILITY_MATRIX, CAPABILITY_SCOPE, type Actor, type Capability } from '@shareat/auth';
// ⛔ The chokepoint, never `@shareat/db` directly — `apps/erp/tests/withorgprincipal-chokepoint.test.ts`.
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

// -----------------------------------------------------------------------------------------
// Pure decisions — no database. T1.
// -----------------------------------------------------------------------------------------

/** T-283's `GrantPicker` shape, reused rather than reinvented (RULES §3). */
export const SCOPE_ORDER = ['store', 'org', 'platform'] as const;

export const SCOPE_NOTE: Record<(typeof SCOPE_ORDER)[number], string> = {
  store: 'Also needs the store in scope — holding the capability is never sufficient alone.',
  org: 'Applies across the whole organisation. No store scope is consulted.',
  platform: 'Crosses organisations. Super-admin territory.',
};

export interface GridCapability {
  readonly capability: Capability;
  /** `CAPABILITY_MATRIX[capability].staff` — every staff member already holds this through the
   *  role matrix. Rendered TICKED and DISABLED (§C6: "shown, not hidden"), never omitted. */
  readonly inherited: boolean;
}

export interface GridScopeGroup {
  readonly scope: (typeof SCOPE_ORDER)[number];
  readonly note: string;
  readonly capabilities: readonly GridCapability[];
}

/**
 * §T1.1/§T1.2 — the grid offers exactly the capabilities outside the three excluded sets
 * (T-289 §C10), grouped by `CAPABILITY_SCOPE` in `store` → `org` → `platform` order (T-283's
 * `GrantPicker` shape). The ~21 staff-matrix capabilities are INCLUDED, flagged `inherited`, per
 * §C6 — hiding them would make the screen lie by omission. Pure; no database.
 *
 * ⚠️ The `platform` group always ends up empty on this screen (both platform-scoped capabilities
 * are already inside `SUPER_ADMIN_ONLY_CAPABILITIES`) — kept in the returned array anyway so the
 * three keys stay in a stable, testable order; the page skips rendering an empty group.
 */
export function gridCapabilityGroups(): GridScopeGroup[] {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    note: SCOPE_NOTE[scope],
    capabilities: OFFERABLE_TO_POSITIONS.filter((c) => CAPABILITY_SCOPE[c] === scope).map((c) => ({
      capability: c,
      inherited: CAPABILITY_MATRIX[c].staff,
    })),
  }));
}

/**
 * §T1.3, plan §5.1's exact wording. Sum of `affected` across every `setPositionDefault` call this
 * submission made — a per-PERSON headcount, not a cell-write count (§C7: "the number an
 * administrator is actually asking about"). The second sentence appears only when `skippedSelf`
 * is true (decision 4) — self-grant stays refused, and the caller is told rather than left to
 * wonder why their own row did not change.
 */
export function bannerMessage(peopleAffected: number, skippedSelf: boolean): string {
  const base =
    peopleAffected === 0
      ? 'Nothing changed.'
      : `Applied to ${peopleAffected} ${peopleAffected === 1 ? 'person' : 'people'}.`;
  return skippedSelf ? `${base} Your own row was skipped — ask another administrator.` : base;
}

/**
 * The two bulk actions write DEFAULT rows first and reach PEOPLE second, and the two counts can
 * differ honestly: "Apply Cashier to every store" on an org whose other stores have no cashier
 * yet writes four rows and changes nobody's access today. `bannerMessage` alone would say
 * "Nothing changed." over four new rows — a true sentence about people that reads as a lie about
 * the rows. So the bulk banner names both, and hands the people-sentence to `bannerMessage` so the
 * skipped-self clause stays in one place.
 */
export function bulkBannerMessage(
  rowsWritten: number,
  storesReached: number,
  peopleAffected: number,
  skippedSelf: boolean,
): string {
  const rows =
    rowsWritten === 0
      ? 'No new default rows — every target already had them.'
      : `Wrote ${rowsWritten} default ${rowsWritten === 1 ? 'row' : 'rows'} across ${storesReached} ${storesReached === 1 ? 'store' : 'stores'}.`;
  return `${rows} ${bannerMessage(peopleAffected, skippedSelf)}`;
}

/**
 * §T1.4 — "Copy defaults from…" copies canonical positions only; a store-invented position
 * belongs to its own store and never copies (decision 2, §C7). Pure and generic so the unit test
 * needs no database fixture.
 */
export function copyableDefaults<T extends { isCanonical: boolean }>(defaults: readonly T[]): T[] {
  return defaults.filter((d) => d.isCanonical);
}

// -----------------------------------------------------------------------------------------
// Reads — every one goes through `withOrgPrincipal` (the chokepoint above), never a bare
// `transaction()` (`tests/unit/no-direct-transaction-in-erp.test.ts`).
// -----------------------------------------------------------------------------------------

/**
 * §C4 — the store selector comes from the ACTOR's own scope, never `listStores(orgId)` alone.
 * `accessRepo.storeIdsForPerson` intersected with this org's own stores (already what `listStores`
 * returns), ordered by name (the order `listStores` already applies, preserved by the filter).
 * An admin holds a scope row per active store (`assignRole` materialises them) — there is no
 * structural admin bypass in v2 — so for an admin this is every store, by rows rather than by
 * exception. Empty for an actor with no store scope at all; the page renders the empty state and
 * no grid, and never falls back to "all stores" (§C4, invariant 7).
 */
export async function storesForActor(actor: Actor): Promise<StoreOption[]> {
  const [orgStores, scopedIds] = await Promise.all([
    listStores(actor.orgId),
    withOrgPrincipal(actor.orgId, (tx) => accessRepo.storeIdsForPerson(tx, actor.personId)),
  ]);
  const held = new Set(scopedIds);
  return orgStores.filter((s) => held.has(s.id));
}

export interface GridPosition {
  readonly id: string;
  readonly name: string;
  readonly isCanonical: boolean;
  /** How many people hold an OPEN employment at this store in this position. One batched query,
   *  never N+1 (§C5). Matches `/staff`'s own roster for the same store. */
  readonly holderCount: number;
}

const CANONICAL_ORDER = new Map<string, number>(CANONICAL_POSITIONS.map((name, i) => [name, i]));

/**
 * §C5 — canonical six FIRST, in `CANONICAL_POSITIONS`' own order, then this store's own positions
 * by name. `employmentRepo.listPositions` already filters `is_active = true`; ⚠️ its own
 * `.orderBy(asc(isCanonical), asc(name))` puts non-canonical rows FIRST (Postgres sorts `false`
 * before `true`) — the OPPOSITE of what this screen needs, so the order is re-applied here rather
 * than trusted from the repo call.
 */
function sortPositions(rows: readonly PositionRow[]): PositionRow[] {
  return [...rows].sort((a, b) => {
    if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
    if (a.isCanonical) return (CANONICAL_ORDER.get(a.name) ?? 99) - (CANONICAL_ORDER.get(b.name) ?? 99);
    return a.name.localeCompare(b.name);
  });
}

async function holderCountsForStore(tx: Tx, storeId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      positionId: schema.employmentPositions.positionId,
      count: sql<number>`count(distinct ${schema.employments.personId})::int`,
    })
    .from(schema.employmentPositions)
    .innerJoin(schema.employments, eq(schema.employments.id, schema.employmentPositions.employmentId))
    .where(and(eq(schema.employments.storeId, storeId), isNull(schema.employments.endedOn)))
    .groupBy(schema.employmentPositions.positionId);
  return new Map(rows.map((r) => [r.positionId, Number(r.count)]));
}

/** positionId -> the set of capabilities with an ACTIVE default at this store. Feeds the grid's
 *  pre-checked cells. */
export type ActiveDefaultsByPosition = ReadonlyMap<string, ReadonlySet<Capability>>;

async function activeDefaultsMapForStore(tx: Tx, storeId: string): Promise<ActiveDefaultsByPosition> {
  const rows = await tx
    .select({
      positionId: schema.positionCapabilityDefaults.positionId,
      capability: schema.positionCapabilityDefaults.capability,
    })
    .from(schema.positionCapabilityDefaults)
    .where(
      and(
        eq(schema.positionCapabilityDefaults.storeId, storeId),
        isNull(schema.positionCapabilityDefaults.revokedAt),
      ),
    );
  const map = new Map<string, Set<Capability>>();
  for (const r of rows) {
    const set = map.get(r.positionId) ?? new Set<Capability>();
    set.add(r.capability as Capability);
    map.set(r.positionId, set);
  }
  return map;
}

export interface GridData {
  readonly positions: readonly GridPosition[];
  readonly activeDefaults: ActiveDefaultsByPosition;
}

/** Everything the grid needs for one store, in one transaction: positions (ordered, §C5), each
 *  column's holder count (batched, never N+1), and which cells are currently active defaults. */
export async function gridDataForStore(actor: Actor, storeId: string): Promise<GridData> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const [rawPositions, holderCounts, activeDefaults] = await Promise.all([
      employmentRepo.listPositions(tx, actor.orgId, storeId),
      holderCountsForStore(tx, storeId),
      activeDefaultsMapForStore(tx, storeId),
    ]);
    const positions = sortPositions(rawPositions).map((p) => ({
      id: p.id,
      name: p.name,
      isCanonical: p.isCanonical,
      holderCount: holderCounts.get(p.id) ?? 0,
    }));
    return { positions, activeDefaults };
  });
}

export interface StoredDefault {
  readonly positionId: string;
  readonly positionName: string;
  readonly isCanonical: boolean;
  readonly capability: Capability;
}

/** Every ACTIVE default at `storeId`, with its position's name and canonical flag — feeds both
 *  bulk actions: "same for every store" (filtered to one position) and "copy defaults from…"
 *  (filtered to canonical via `copyableDefaults`). */
export async function activeDefaultsAtStore(actor: Actor, storeId: string): Promise<StoredDefault[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const rows = await tx
      .select({
        positionId: schema.positionCapabilityDefaults.positionId,
        positionName: schema.positions.name,
        isCanonical: schema.positions.isCanonical,
        capability: schema.positionCapabilityDefaults.capability,
      })
      .from(schema.positionCapabilityDefaults)
      .innerJoin(schema.positions, eq(schema.positions.id, schema.positionCapabilityDefaults.positionId))
      .where(
        and(
          eq(schema.positionCapabilityDefaults.storeId, storeId),
          isNull(schema.positionCapabilityDefaults.revokedAt),
        ),
      );
    return rows.map((r) => ({ ...r, capability: r.capability as Capability }));
  });
}
