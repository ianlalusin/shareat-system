import { requirePageAccess } from '../../../lib/page-access';
import { copyDefaultsAction, sameForEveryStoreAction } from './actions';
import { gridCapabilityGroups, gridDataForStore, storesForActor } from './lib';
import { DesktopGrid, MobileSections } from './grid';
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
  const nonEmptyGroups = groups.filter((g) => g.areas.length > 0);
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
