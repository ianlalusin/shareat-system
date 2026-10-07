import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { upsertPosItemMapAction, decideMapRequestAction } from './actions';
import { listStores, posMapScreenData } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'POS item mapping — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
  needsConfirmation?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN_SM =
  'rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

const MODE_LABEL: Record<string, string> = { direct: 'Direct → stock item', recipe: 'Recipe → ingredients', no_stock: 'Sells, no stock consumed' };

export default async function PosMapPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/pos-map');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">POS item mapping</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { maps, requests, items, recipes, locations } = await posMapScreenData(actor.orgId, storeId);
  const openRequests = requests.filter((r) => r.status === 'requested');

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">POS item mapping</h1>
          <PageDescription className="mt-1">
            A standing decision: what a POS item means for stock — one item, a recipe, or an
            explicit &ldquo;sells, consumes nothing.&rdquo;
          </PageDescription>
        </div>
        <Link href={`/inventory/pos-usage?store=${storeId}`} className="text-sm underline underline-offset-4">
          Daily usage pull →
        </Link>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
          {sp.needsConfirmation && ' Tick "confirm sharing" below and save again if that is intended.'}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

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

      {openRequests.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <h2 className="text-sm font-medium">Requests waiting on a decision ({openRequests.length})</h2>
          <div className="mt-3 space-y-3">
            {openRequests.map((r) => (
              <form key={r.id} action={decideMapRequestAction} className="flex flex-wrap items-center gap-2 text-sm">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="requestId" value={r.id} />
                <span className="font-medium">{r.posItemName}</span>
                <span className="text-neutral-500">({r.posItemKey})</span>
                {r.note && <span className="text-neutral-600 dark:text-neutral-400">— {r.note}</span>}
                <input name="note" placeholder="decision note (optional)" className={`${INPUT} flex-1 min-w-[10rem]`} />
                <button type="submit" name="decision" value="approved" className={BTN_SM}>
                  Approve (no stock)
                </button>
                <button type="submit" name="decision" value="rejected" className={BTN_SM}>
                  Reject
                </button>
              </form>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">New / edit mapping</h2>
        <form action={upsertPosItemMapAction} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input type="hidden" name="storeId" value={storeId} />
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">POS item key</span>
            <input name="posItemKey" required className={`${INPUT} w-full`} />
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">POS item name</span>
            <input name="posItemName" required className={`${INPUT} w-full`} />
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Mode</span>
            <select name="mode" className={`${INPUT} w-full`} defaultValue="direct">
              <option value="direct">Direct → one stock item</option>
              <option value="recipe">Recipe → ingredients</option>
              <option value="no_stock">Sells, consumes no stock</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Stock item (direct)</span>
            <select name="itemId" className={`${INPUT} w-full`}>
              <option value="">—</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} — {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Quantity per sale (direct)</span>
            <input name="quantityPerSale" defaultValue="1" className={`${INPUT} w-full`} />
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Recipe</span>
            <select name="recipeId" className={`${INPUT} w-full`}>
              <option value="">—</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Location override (optional)</span>
            <select name="locationId" className={`${INPUT} w-full`}>
              <option value="">— use the pull&apos;s own location —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirmShared" value="true" />
            <span>Confirm sharing this stock item across POS items</span>
          </label>
          <div className="flex flex-wrap items-end gap-y-2">
            <button type="submit" className={BTN_SM}>
              Save mapping
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-medium">Active maps ({maps.filter((m) => m.status === 'active').length})</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">POS item</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {maps.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-neutral-600 dark:text-neutral-400">
                    No maps yet.
                  </td>
                </tr>
              ) : (
                maps.map((m) => (
                  <tr key={m.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      {m.posItemName} <span className="text-neutral-500">({m.posItemKey})</span>
                    </td>
                    <td className="px-3 py-2">{MODE_LABEL[m.mode] ?? m.mode}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {m.mode === 'direct'
                        ? (items.find((i) => i.id === m.itemId)?.name ?? m.itemId)
                        : m.mode === 'recipe'
                          ? (recipes.find((r) => r.id === m.recipeId)?.name ?? m.recipeId)
                          : '—'}
                    </td>
                    <td className="px-3 py-2">{m.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </Page>
  );
}
