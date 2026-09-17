import { Fragment } from 'react';
import { requirePageAccess } from '../../../lib/page-access';
import {
  copyDefaultsAction,
  retireStorePositionAction,
  sameForEveryStoreAction,
  toggleDefaultAction,
} from './actions';
import {
  gridCapabilityGroups,
  gridDataForStore,
  overlapDisclosure,
  storesForActor,
  type ActiveDefaultsByPosition,
  type GridPosition,
  type GridScopeGroup,
  type OverlapCountsByPosition,
} from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';

export const metadata = { title: 'Position access defaults — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const LINK_BTN =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

/**
 * `/admin/access-defaults` — T-290. `docs/tasks/290-access-defaults-screen.md`.
 *
 * Answers, per store: *"what can a Cashier do here?"* Positions across, capabilities down, one
 * toggle per (position, capability) writing a `position_capability_defaults` row and fanning it
 * out to every current holder through T-289's `reconcilePositionGrants`.
 *
 * ⭐ **Read is ungated; every write is gated in `actions.ts`** — see `lib.ts`'s header for why
 * (mirrors `admin/users/lib.ts`).
 *
 * ⚠️ **Two markups of the same cells, CSS-toggled, not JS-toggled** — a `sm:` comparison table and
 * a mobile per-position accordion (§C5: phone portrait is the canvas; the grid becomes one
 * position per section at narrow widths, never a horizontally-scrolling table). Both are always in
 * the DOM; only one is ever visible via `hidden sm:table` / `sm:hidden`. This is safe ONLY because
 * every cell is an immediate toggle BUTTON encoding "flip the current persisted state" — see
 * `actions.ts`'s `toggleDefaultAction` header for why a batched checkbox form cannot be duplicated
 * the same way.
 */
export default async function AccessDefaultsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/admin/access-defaults');
  // ⭐ T-288 — the READ gate, matching every other admin screen (Ian, 2026-09-12: "do both hide
  // the menu and gate the reads"). `/admin/access-defaults` is not yet in `route-capability.ts`'s
  // map (the orchestrator adds that row at commit time, after the T-288 lane lands), so `refusal`
  // is always null today — §C3's "ungated read" holds regardless of when that row lands.
  if (refusal) return refusal;

  const stores = await storesForActor(actor);

  if (stores.length === 0) {
    return (
      <Page density="form">
        <h1 className="text-2xl font-semibold">Position access defaults</h1>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
          You have no store scope, so there is nothing to configure here.
        </p>
      </Page>
    );
  }

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]!.id;
  const otherStores = stores.filter((s) => s.id !== storeId);

  const [{ positions, activeDefaults, overlapCounts }, groups] = await Promise.all([
    gridDataForStore(actor, storeId),
    Promise.resolve(gridCapabilityGroups()),
  ]);
  const nonEmptyGroups = groups.filter((g) => g.capabilities.length > 0);
  const canonicalPositions = positions.filter((p) => p.isCanonical);

  return (
    <Page density="wide" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Position access defaults</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          What can a Cashier do here? Set, per position and per store, which capabilities every
          holder of that job gets in addition to the role matrix. Additive only — nothing here can
          switch off a capability the role matrix already grants.
        </p>
      </div>

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={INPUT}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
      </FilterRow>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

      {positions.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This store has no positions yet. The canonical six are seeded when the organisation is
          created — if none appear here, that is worth reporting.
        </p>
      ) : (
        <>
          <DesktopGrid
            storeId={storeId}
            positions={positions}
            groups={nonEmptyGroups}
            activeDefaults={activeDefaults}
            overlapCounts={overlapCounts}
          />
          <MobileSections
            storeId={storeId}
            positions={positions}
            groups={nonEmptyGroups}
            activeDefaults={activeDefaults}
            overlapCounts={overlapCounts}
          />
        </>
      )}

      {canonicalPositions.length > 0 && (
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Same for every store</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Applies this position&rsquo;s currently-saved defaults at this store to every other
            active store. Canonical positions only — a store-invented position belongs to its own
            store.
          </p>
          <div className="flex flex-wrap gap-2">
            {canonicalPositions.map((p) => (
              <form key={p.id} action={sameForEveryStoreAction}>
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="positionId" value={p.id} />
                <button type="submit" className={LINK_BTN}>
                  Apply {p.name} to every store
                </button>
              </form>
            ))}
          </div>
        </section>
      )}

      {otherStores.length > 0 && (
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Copy defaults from&hellip;</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Copies every canonical-position default that is active at the source store into this
            one. A store-invented position never copies — it belongs to its own store. This is a
            copy, not a link: the two stores&rsquo; rows do not stay in sync afterwards.
          </p>
          <form action={copyDefaultsAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="storeId" value={storeId} />
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">From</span>
              <select name="sourceStoreId" required className={INPUT}>
                {otherStores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={LINK_BTN}>
              Copy
            </button>
          </form>
        </section>
      )}
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// One immediate toggle per cell. Safe to render twice (desktop + mobile) — see actions.ts.
// -------------------------------------------------------------------------------------------

function ToggleButton({
  storeId,
  positionId,
  capability,
  active,
}: {
  storeId: string;
  positionId: string;
  capability: string;
  active: boolean;
}) {
  return (
    <form action={toggleDefaultAction}>
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="positionId" value={positionId} />
      <input type="hidden" name="capability" value={capability} />
      <input type="hidden" name="on" value={active ? 'false' : 'true'} />
      <button
        type="submit"
        aria-pressed={active}
        className={`w-full rounded-md border px-2 py-2 text-xs font-medium ${
          active
            ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
            : 'border-neutral-300 bg-white text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400'
        }`}
      >
        {active ? 'On' : 'Off'}
      </button>
    </form>
  );
}

function InheritedBadge() {
  return (
    <span
      title="Every staff member already has this through the role matrix."
      className="flex w-full items-center justify-center rounded-md border border-neutral-200 bg-neutral-100 px-2 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
    >
      On (role)
    </span>
  );
}

// -------------------------------------------------------------------------------------------
// Desktop: a real comparison table — positions across, capabilities down (§C5). `hidden sm:table`.
// -------------------------------------------------------------------------------------------

function DesktopGrid({
  storeId,
  positions,
  groups,
  activeDefaults,
  overlapCounts,
}: {
  storeId: string;
  positions: readonly GridPosition[];
  groups: readonly GridScopeGroup[];
  activeDefaults: ActiveDefaultsByPosition;
  overlapCounts: OverlapCountsByPosition;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 sm:block dark:border-neutral-800">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
          <tr>
            <th className="px-3 py-2 font-medium">Capability</th>
            {positions.map((p) => (
              <th key={p.id} className="px-3 py-2 font-medium">
                {p.name}
                {!p.isCanonical && <span className="ml-1 text-[10px] text-neutral-400">(this store)</span>}
                <span className="block text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
                  {p.holderCount} holder{p.holderCount === 1 ? '' : 's'}
                </span>
                {!p.isCanonical && (
                  <form action={retireStorePositionAction} className="mt-1">
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="positionId" value={p.id} />
                    {/* T-262 / DEF-269 — a header control still has to clear the 24px touch floor;
                        the first draft was a 10px underlined word and the sweep caught it. Fixed
                        the control, never the baseline (T-290 §C10). */}
                    <button
                      type="submit"
                      className="rounded-md border border-red-300 px-2 py-1 text-xs font-normal text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      Retire
                    </button>
                  </form>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.scope}>
              <tr className="border-b border-neutral-100 bg-neutral-50/60 dark:border-neutral-900 dark:bg-neutral-900/40">
                <td colSpan={positions.length + 1} className="px-3 py-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="font-medium uppercase tracking-wide">{group.scope}-scoped</span> — {group.note}
                </td>
              </tr>
              {group.capabilities.map((cell) => (
                <tr key={cell.capability} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2 font-mono text-xs">
                    {cell.capability}
                    {cell.inherited && (
                      <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-sans text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                        inherited
                      </span>
                    )}
                  </td>
                  {positions.map((p) => {
                    const active = activeDefaults.get(p.id)?.has(cell.capability) ?? false;
                    const disclosure = active ? null : overlapDisclosure(overlapCounts.get(p.id)?.get(cell.capability) ?? 0);
                    return (
                      <td key={p.id} className="px-2 py-1.5">
                        {cell.inherited ? (
                          <InheritedBadge />
                        ) : (
                          <ToggleButton storeId={storeId} positionId={p.id} capability={cell.capability} active={active} />
                        )}
                        {disclosure && (
                          <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">{disclosure}</p>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Mobile: one position per section, each capability a full-width touch row (§C5, the
// `settings/sales-channels/page.tsx` Radio idiom). `sm:hidden`.
// -------------------------------------------------------------------------------------------

function MobileSections({
  storeId,
  positions,
  groups,
  activeDefaults,
  overlapCounts,
}: {
  storeId: string;
  positions: readonly GridPosition[];
  groups: readonly GridScopeGroup[];
  activeDefaults: ActiveDefaultsByPosition;
  overlapCounts: OverlapCountsByPosition;
}) {
  return (
    <div className="space-y-3 sm:hidden">
      {positions.map((p, i) => (
        <details key={p.id} open={i === 0} className="rounded-lg border border-neutral-200 dark:border-neutral-800">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            {p.name}
            {!p.isCanonical && <span className="ml-1 text-xs text-neutral-400">(this store)</span>}
            <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
              {p.holderCount} holder{p.holderCount === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="space-y-3 border-t border-neutral-200 p-3 dark:border-neutral-800">
            {groups.map((group) => (
              <div key={group.scope} className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  {group.scope}-scoped
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{group.note}</p>
                {group.capabilities.map((cell) => {
                  const active = activeDefaults.get(p.id)?.has(cell.capability) ?? false;
                  const disclosure = active ? null : overlapDisclosure(overlapCounts.get(p.id)?.get(cell.capability) ?? 0);
                  return (
                    <div key={cell.capability} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 font-mono text-xs">
                          {cell.capability}
                          {cell.inherited && (
                            <span className="ml-2 block font-sans text-[11px] text-neutral-500 dark:text-neutral-400">
                              Every staff member already has this through the role matrix.
                            </span>
                          )}
                        </span>
                        <div className="w-24 shrink-0">
                          {cell.inherited ? (
                            <InheritedBadge />
                          ) : (
                            <ToggleButton storeId={storeId} positionId={p.id} capability={cell.capability} active={active} />
                          )}
                        </div>
                      </div>
                      {disclosure && (
                        <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-400">{disclosure}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {!p.isCanonical && (
              <form action={retireStorePositionAction} className="pt-2">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="positionId" value={p.id} />
                <button type="submit" className={LINK_BTN}>
                  Retire {p.name}
                </button>
              </form>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
