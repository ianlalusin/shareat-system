import Link from 'next/link';
import { WASTAGE_REASONS } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { saveUsageDraftAction } from './actions';
import { listStores, usageScreenData } from './lib';
import { NewUsageForm } from './NewUsageForm';

export const metadata = { title: 'Usage & wastage — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN_SM =
  'rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

const KIND_LABEL: Record<string, string> = { usage: 'Usage', wastage: 'Wastage', adjustment: 'Adjustment', opening: 'Opening' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', posted: 'Posted', void: 'Void' };
const STATUS_TONE: Record<string, string> = {
  draft: 'text-neutral-600 dark:text-neutral-400',
  posted: 'text-emerald-700 dark:text-emerald-400',
  void: 'text-red-700 dark:text-red-400',
};

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/inventory/usage');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </main>
    );
  }

  const { locations, departments, items, records } = await usageScreenData(actor.orgId, storeId);

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            A floor worker records what was consumed or spoiled; a manager posts it. ⭐ Posting is
            the only step that moves stock and hits the books.
          </p>
        </div>
        <Link href={`/inventory?store=${storeId}`} className="text-sm underline underline-offset-4">
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

      <form method="get" className="flex items-end gap-3">
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

      {locations.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This store has no active operating room yet — a usage can only be recorded from one. Add
          one under{' '}
          <Link href={`/inventory/locations?store=${storeId}`} className="underline underline-offset-4">
            Locations
          </Link>
          .
        </p>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">New record</h2>
          <NewUsageForm
            action={saveUsageDraftAction}
            storeId={storeId}
            locations={locations}
            departments={departments}
            items={items}
            reasons={WASTAGE_REASONS}
            today={toBusinessDate()}
          />
        </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Records</h2>
        {records.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 text-right font-medium">Lines</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <Link href={`/inventory/usage/${r.id}`} className="underline underline-offset-4">
                        {r.usedOn}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-3 py-2">{r.locationName}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {r.reasonCode ? r.reasonCode.replace(/_/g, ' ') : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.lineCount}</td>
                    <td className={`px-3 py-2 font-medium ${STATUS_TONE[r.status] ?? ''}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
