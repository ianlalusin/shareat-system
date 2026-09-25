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
import {
  CAPABILITIES,
  CAPABILITY_AREA,
  CAPABILITY_AREAS,
  CAPABILITY_AREA_LABEL,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  type Actor,
  type Capability,
  type CapabilityArea,
} from '@shareat/auth';
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

export interface GridAreaGroup {
  readonly area: CapabilityArea;
  readonly label: string;
  readonly capabilities: readonly GridCapability[];
}

export interface GridScopeGroup {
  readonly scope: (typeof SCOPE_ORDER)[number];
  readonly note: string;
  readonly areas: readonly GridAreaGroup[];
}

/**
 * §T1.1/§T1.2 — the grid offers exactly the capabilities outside the three excluded sets
 * (T-289 §C10), grouped by `CAPABILITY_SCOPE` in `store` → `org` → `platform` order (T-283's
 * `GrantPicker` shape), THEN by `CAPABILITY_AREA` in `CAPABILITY_AREAS` order (T-337 — "group the
 * access like sales, inventory, customer, attendance etc., keep the store and org scope
 * groupings"). `capabilities` lives on the AREA group only, never flat on the scope group too —
 * one representation, so a reader cannot render from the stale one (T-337 §2).
 * ⚠️ **T-318 (2026-09-16):** the ~21 capabilities `staff` used to hold automatically are INCLUDED
 * here same as ever — this derivation never excluded them — but they no longer render `inherited`:
 * `CAPABILITY_MATRIX[c].staff` is false for all 96 now, so every one is a live, position-granted
 * TOGGLE like the other 75. `inherited` stays derived below rather than deleted (D2's ruling) — it
 * is correct logic that is currently vacuous, and the only thing standing between this screen and
 * a silent lie if a `staff` cell is ever set back to `true`.
 *
 * ⚠️ The `platform` group always ends up with zero areas on this screen (both platform-scoped
 * capabilities are already inside `SUPER_ADMIN_ONLY_CAPABILITIES`, so neither is offerable) —
 * `SCOPE_ORDER`'s three keys stay in the returned array regardless, so their order stays stable
 * and testable; the page skips rendering a scope with no areas. Same reasoning empties `franchise`
 * out of every scope's `areas` (T-337 §1: its two members are platform-scoped AND
 * super-admin-only).
 */
export function gridCapabilityGroups(): GridScopeGroup[] {
  return SCOPE_ORDER.map((scope) => {
    const offerableInScope = OFFERABLE_TO_POSITIONS.filter((c) => CAPABILITY_SCOPE[c] === scope);
    const areas: GridAreaGroup[] = CAPABILITY_AREAS.map((area) => ({
      area,
      label: CAPABILITY_AREA_LABEL[area],
      capabilities: offerableInScope
        .filter((c) => CAPABILITY_AREA[c] === area)
        .map((c) => ({ capability: c, inherited: CAPABILITY_MATRIX[c].staff })),
    })).filter((a) => a.capabilities.length > 0);
    return { scope, note: SCOPE_NOTE[scope], areas };
  });
}

/**
 * T-337 §3 — "on" = the cell renders `On` or `On (role)`: active in `activeSet`, OR `inherited`
 * (a `staff`-matrix cell shown ticked-and-disabled, never a real row in `activeSet`). Pure: no
 * database, so the render layer can call it once per (area × position) without a query each time.
 */
export function areaOnCount(capabilities: readonly GridCapability[], activeSet: ReadonlySet<Capability> | undefined): number {
  let n = 0;
  for (const c of capabilities) {
    if (c.inherited || (activeSet?.has(c.capability) ?? false)) n++;
  }
  return n;
}

/**
 * Amendment A1, contract point 2 — `cap`/`pos` off `toggleDefaultAction`'s redirect are UNTRUSTED
 * `searchParams`: validated here, never echoed into markup unchecked. `cap` passes only as a
 * member of `CAPABILITIES`; `pos` only as one of THIS request's rendered position ids (never
 * trusted against the whole org). A Next.js repeated query key comes through as `string[]`, which
 * is rejected outright rather than silently taking `[0]` — an attacker (or a stale bookmark)
 * controls how many times a key repeats.
 */
export function parseOpenParams(
  sp: { cap?: string | string[]; pos?: string | string[] },
  positionIds: readonly string[],
): { openCapability: Capability | undefined; openPositionId: string | undefined } {
  const cap = typeof sp.cap === 'string' && (CAPABILITIES as readonly string[]).includes(sp.cap) ? (sp.cap as Capability) : undefined;
  const pos = typeof sp.pos === 'string' && positionIds.includes(sp.pos) ? sp.pos : undefined;
  return { openCapability: cap, openPositionId: pos };
}

/**
 * T-318 D3 — the multi-position disclosure line, or nothing. `null` on zero: rendered only when
 * it is true, never as an ambient "0 people hold this through another position" on every OFF
 * cell — most cells have no overlap at all, and a reassurance repeated on 90% of the grid is
 * exactly what trains an administrator to stop reading it. When it does appear the render layer
 * (`page.tsx`) gives it a loud, distinct treatment rather than blending it into the grid's
 * neutral tone — a rare exception earns attention a constant caption would lose. Singular/plural
 * matches `bannerMessage`'s own voice.
 */
export function overlapDisclosure(count: number): string | null {
  if (count === 0) return null;
  return `Still held by ${count} ${count === 1 ? 'person' : 'people'} through another position.`;
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

/** One row per (employment, position) link at this store, open employments only — the same join
 *  `holderCountsForStore` already performs, ungrouped so `computeOverlapCounts` can see which
 *  positions share an employment. */
export interface EmploymentPositionLink {
  readonly employmentId: string;
  readonly positionId: string;
}

async function employmentPositionsForStore(tx: Tx, storeId: string): Promise<EmploymentPositionLink[]> {
  return tx
    .select({
      employmentId: schema.employmentPositions.employmentId,
      positionId: schema.employmentPositions.positionId,
    })
    .from(schema.employmentPositions)
    .innerJoin(schema.employments, eq(schema.employments.id, schema.employmentPositions.employmentId))
    .where(and(eq(schema.employments.storeId, storeId), isNull(schema.employments.endedOn)));
}

/** positionId -> capability -> holder count via another position. See `computeOverlapCounts`. */
export type OverlapCountsByPosition = ReadonlyMap<string, ReadonlyMap<Capability, number>>;

/** positionId -> capability -> how many PEOPLE holding that position at this store would still
 *  hold that capability through a DIFFERENT position on the same open employment — the T-318
 *  MULTI-POSITION RULING's union, made visible. Pure; no database — `employmentPositionsForStore`
 * and `activeDefaultsMapForStore` are fetched once each and handed in, so this stays a single
 * batched read plus an in-memory aggregation, never N+1 (§C5).
 *
 * ⚠️ **What this counts, and what it deliberately does not.** This counts ONLY the position path:
 * a second `employment_positions` row on the same employment whose OWN active default still
 * covers the capability. It does NOT see a per-person `person_grants` row with
 * `grant_source: 'grant'` or `'owner'` — those outrank `'position'` (`GRANT_SOURCE_RANK`) and
 * survive a position switch-off untouched, invisible to this function by construction (it never
 * reads `person_grants` at all). An admin can hit the identical "the switch did not work"
 * surprise from a direct grant, with nothing here to explain it — tracked as T-320, not built
 * here: a different query (person_grants, not employment_positions) and a different sentence
 * ("held some other way", not "held through another position"), and widening this function's
 * contract mid-slice is how a slice stops shipping.
 */
export function computeOverlapCounts(
  links: readonly EmploymentPositionLink[],
  activeDefaults: ActiveDefaultsByPosition,
): OverlapCountsByPosition {
  const positionsByEmployment = new Map<string, string[]>();
  for (const link of links) {
    const list = positionsByEmployment.get(link.employmentId) ?? [];
    list.push(link.positionId);
    positionsByEmployment.set(link.employmentId, list);
  }

  // positionId -> capability -> the SET of employments crediting it, so each person is counted
  // once even if two OTHER positions both supply the same capability.
  const overlapEmployments = new Map<string, Map<Capability, Set<string>>>();
  for (const [employmentId, positionIds] of positionsByEmployment) {
    if (positionIds.length < 2) continue; // one position only — no "another position" exists.
    for (const positionId of positionIds) {
      const ownCapabilities = activeDefaults.get(positionId);
      for (const otherPositionId of positionIds) {
        if (otherPositionId === positionId) continue;
        const otherCapabilities = activeDefaults.get(otherPositionId);
        if (!otherCapabilities) continue;
        for (const capability of otherCapabilities) {
          if (ownCapabilities?.has(capability)) continue; // held here too — not the disclosure case.
          const byCapability = overlapEmployments.get(positionId) ?? new Map<Capability, Set<string>>();
          const employments = byCapability.get(capability) ?? new Set<string>();
          employments.add(employmentId);
          byCapability.set(capability, employments);
          overlapEmployments.set(positionId, byCapability);
        }
      }
    }
  }

  const result = new Map<string, Map<Capability, number>>();
  for (const [positionId, byCapability] of overlapEmployments) {
    const counts = new Map<Capability, number>();
    for (const [capability, employments] of byCapability) counts.set(capability, employments.size);
    result.set(positionId, counts);
  }
  return result;
}

export interface GridData {
  readonly positions: readonly GridPosition[];
  readonly activeDefaults: ActiveDefaultsByPosition;
  /** T-318 D3 — see `computeOverlapCounts`'s own comment for exactly what this does and does not
   *  cover. Looked up as `overlapCounts.get(positionId)?.get(capability) ?? 0`. */
  readonly overlapCounts: OverlapCountsByPosition;
}

/** Everything the grid needs for one store, in one transaction: positions (ordered, §C5), each
 *  column's holder count (batched, never N+1), which cells are currently active defaults, and
 *  the multi-position overlap disclosure (T-318 D3). */
export async function gridDataForStore(actor: Actor, storeId: string): Promise<GridData> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const [rawPositions, holderCounts, activeDefaults, employmentPositionLinks] = await Promise.all([
      employmentRepo.listPositions(tx, actor.orgId, storeId),
      holderCountsForStore(tx, storeId),
      activeDefaultsMapForStore(tx, storeId),
      employmentPositionsForStore(tx, storeId),
    ]);
    const overlapCounts = computeOverlapCounts(employmentPositionLinks, activeDefaults);
    const positions = sortPositions(rawPositions).map((p) => ({
      id: p.id,
      name: p.name,
      isCanonical: p.isCanonical,
      holderCount: holderCounts.get(p.id) ?? 0,
    }));
    return { positions, activeDefaults, overlapCounts };
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
