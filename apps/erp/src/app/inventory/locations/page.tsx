import Link from 'next/link';
import { LOCATION_ROLES } from '@shareat/db/schema';
import { requireSession } from '../../../lib/session';
import {
  createLocationAction,
  deactivateLocationAction,
  reactivateLocationAction,
  setDefaultAction,
  setupRoomsAction,
  updateLocationAction,
} from './actions';
import { listStores, locationsPageData } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Stock locations — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
const BTN_SM =
  'rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

const STOCK_MODEL_EXPLANATION: Record<'single_room' | 'multi_room', string> = {
  single_room:
    'This store keeps stock in ONE room (a branch or kiosk) — it may hold exactly one active room besides Receiving.',
  multi_room:
    'This store manages several rooms (a commissary) — it may hold as many active rooms as it needs.',
};

export default async function StockLocationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/inventory/locations');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Stock locations</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const data = await locationsPageData(actor.orgId, storeId);
  if (!data) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Stock locations</h1>
        <p className="mt-4 text-sm text-neutral-600">That store could not be found.</p>
      </Page>
    );
  }
  const { stockModel, locations, types } = data;

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Stock locations</h1>
          <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
            The rooms every stock movement is keyed to — Stockroom, Kitchen, Receiving, and so on.
            No movement in this store can happen without a room to name.
          </p>
        </div>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>

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

      <form method="get" className="flex flex-wrap items-end gap-3 gap-y-2">
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
        <button type="submit" className={BTN_SM}>
          Show
        </button>
      </form>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm">
          <span className="font-medium">How this store organises stock: </span>
          {stockModel === 'single_room' ? 'One room' : 'Multiple rooms'}.{' '}
          {STOCK_MODEL_EXPLANATION[stockModel]}
        </p>
      </section>

      {locations.length === 0 ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <p className="text-sm text-amber-900 dark:text-amber-300">
            This store has no rooms yet — nothing can be received, used, or counted until it does.
          </p>
          <form action={setupRoomsAction} className="mt-3">
            <input type="hidden" name="storeId" value={storeId} />
            <button type="submit" className={BTN}>
              Set up rooms
            </button>
          </form>
        </section>
      ) : (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Rooms</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Type / role</th>
                  <th className="px-3 py-2 font-medium">Purpose</th>
                  <th className="px-3 py-2 font-medium">Default</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((loc) => (
                  <tr key={loc.id} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <div className="font-medium">{loc.name}</div>
                      <div className="font-mono text-xs text-neutral-500">{loc.code}</div>
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {loc.typeName} · {loc.role}
                    </td>
                    <td className="px-3 py-2">{loc.purpose === 'receiving' ? 'Receiving' : 'Normal'}</td>
                    <td className="px-3 py-2">{loc.isDefault ? '★ default' : ''}</td>
                    <td className="px-3 py-2">{loc.status}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-2">
                        <form
                          action={updateLocationAction}
                          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                        >
                          <input type="hidden" name="storeId" value={storeId} />
                          <input type="hidden" name="id" value={loc.id} />
                          <input name="name" defaultValue={loc.name} className={`${INPUT} col-span-2 sm:col-span-1`} />
                          <select name="typeId" defaultValue={loc.typeId} className={INPUT}>
                            {types.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                          {loc.purpose === 'receiving' ? (
                            <span className="self-center text-xs text-neutral-500">storage (fixed)</span>
                          ) : (
                            <select name="role" defaultValue={loc.role} className={INPUT}>
                              {LOCATION_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          )}
                          <button type="submit" className={`${BTN_SM} col-span-2 sm:col-span-3`}>
                            Save
                          </button>
                        </form>
                        <div className="flex flex-wrap gap-2">
                          {loc.status === 'active' && !loc.isDefault && (
                            <form action={setDefaultAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="id" value={loc.id} />
                              <button type="submit" className={BTN_SM}>
                                Make default
                              </button>
                            </form>
                          )}
                          {loc.status === 'active' && loc.isDefault ? (
                            // ⚠️ The default room cannot be retired (the service refuses it —
                            // review 2026-09-03); say so instead of offering a button that fails.
                            <span className="text-xs text-neutral-500">default — pick another default to retire this room</span>
                          ) : loc.status === 'active' ? (
                            <form action={deactivateLocationAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="id" value={loc.id} />
                              <button type="submit" className={BTN_SM}>
                                Deactivate
                              </button>
                            </form>
                          ) : (
                            <form action={reactivateLocationAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="id" value={loc.id} />
                              <button type="submit" className={BTN_SM}>
                                Reactivate
                              </button>
                            </form>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form
            action={createLocationAction}
            className="grid grid-cols-2 gap-3 border-t border-neutral-200 pt-3 sm:grid-cols-3 dark:border-neutral-800"
          >
            <input type="hidden" name="storeId" value={storeId} />
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Code</span>
              <input name="code" required className={`${INPUT} w-full`} />
            </label>
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Name</span>
              <input name="name" required className={`${INPUT} w-full`} />
            </label>
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Type</span>
              <select name="typeId" required defaultValue="" className={`${INPUT} w-full`}>
                <option value="" disabled>
                  Select a type
                </option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Role</span>
              <select name="role" defaultValue="storage" className={`${INPUT} w-full`}>
                {LOCATION_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-1">
              <input type="checkbox" name="isReceiving" />
              This is the Receiving room
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isDefault" />
              Make it the default
            </label>
            <button type="submit" className={`${BTN} col-span-2 sm:col-span-3`}>
              Add room
            </button>
          </form>
        </section>
      )}
    </Page>
  );
}
