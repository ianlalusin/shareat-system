import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { upsertStorePositionAction } from './actions';
import { listStores, positionsForStore, rosterForStore } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';

export const metadata = { title: 'Staff — Shareat System' };
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

export default async function StaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/staff');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Staff</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [roster, positions] = await Promise.all([
    rosterForStore(actor.orgId, storeId),
    positionsForStore(actor.orgId, storeId),
  ]);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            Who is on the roster at this store right now. ⭐ Every attendance, payroll and
            credential screen in this app needs an employment to point at — this is where one gets
            created (DEF-131).
          </p>
        </div>
        <Link href={`/staff/hire?store=${storeId}`} className={BTN}>
          Hire
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

      <section className="space-y-3">
        {roster.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nobody hired here yet. &ldquo;Hire&rdquo; above starts one.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Staff code</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Positions</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2 font-mono text-xs">{r.staffCode}</td>
                    <td className="px-3 py-2">
                      <Link href={`/staff/${r.id}`} className="underline hover:no-underline">
                        {r.displayName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{r.employmentStatus.replace(/-/g, ' ')}</td>
                    <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                      {r.positions.length === 0
                        ? '—'
                        : r.positions
                            .map((p) => (p.isPrimary ? `${p.name} ★` : p.name))
                            .join(', ')}
                    </td>
                    <td className="px-3 py-2">{r.startedOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">This store&rsquo;s positions</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The canonical six belong to the organisation and cannot be renamed here. A store may add
          its own beyond them.
        </p>
        <ul className="flex flex-wrap gap-2 text-sm">
          {positions.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
            >
              {p.name}
              {p.isCanonical && <span className="ml-1 text-xs text-neutral-400">(canonical)</span>}
            </li>
          ))}
        </ul>
        <form
          action={upsertStorePositionAction}
          className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800"
        >
          <input type="hidden" name="storeId" value={storeId} />
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Add a position</span>
            <input name="name" required placeholder="Barista" className={INPUT} />
          </label>
          <button type="submit" className={BTN}>
            Save
          </button>
        </form>
      </section>
    </Page>
  );
}
