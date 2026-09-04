import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { saveProductionDraftAction } from './actions';
import { listStores, productionScreenData } from './lib';

export const metadata = { title: 'Production — Shareat System' };
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
const BTN_PRIMARY = 'rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900';

const KIND_LABEL: Record<string, string> = { slice: 'Slice (slab -> pieces)', cook: 'Cook (recipe batch)', convert: 'Convert (re-cut, no GL impact)' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', posted: 'Posted', void: 'Void' };
const STATUS_TONE: Record<string, string> = {
  draft: 'text-neutral-600 dark:text-neutral-400',
  posted: 'text-emerald-700 dark:text-emerald-400',
  void: 'text-red-700 dark:text-red-400',
};

const LINE_ROWS = 5;

export default async function ProductionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/inventory/production');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-2xl font-semibold">Production</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </main>
    );
  }

  const { locations, items, records } = await productionScreenData(actor.orgId, storeId);

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Production</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            A slicing run or a prep batch posts as ONE stock transaction — inputs out, outputs in,
            cost carried across. A floor worker records the run; a manager posts it.
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
          This store has no active operating room yet — a production run can only be recorded from
          one. Add one under{' '}
          <Link href={`/inventory/locations?store=${storeId}`} className="underline underline-offset-4">
            Locations
          </Link>
          .
        </p>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">New record</h2>
          <form action={saveProductionDraftAction} className="mt-3 space-y-4">
            <input type="hidden" name="storeId" value={storeId} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <label className="text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Kind</span>
                <select name="kind" defaultValue="slice" className={`${INPUT} w-full`}>
                  {Object.entries(KIND_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Room</span>
                <select name="locationId" defaultValue={locations[0]?.id} className={`${INPUT} w-full`}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Date</span>
                <input type="date" name="producedOn" defaultValue={toBusinessDate()} className={`${INPUT} w-full`} />
              </label>
              <label className="text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Labour cost (optional)</span>
                <input type="text" name="labourCost" placeholder="0.00" className={`${INPUT} w-full`} />
              </label>
            </div>

            <LineRows label="Inputs (what goes out)" prefix="input" items={items} />
            <LineRows label="Outputs (what comes in)" prefix="output" items={items} />

            <button type="submit" className={BTN_PRIMARY}>
              Save draft
            </button>
          </form>
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
                  <th className="px-3 py-2 font-medium">Revision</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <Link href={`/inventory/production/${r.id}`} className="underline underline-offset-4">
                        {r.producedOn}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.revision}</td>
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

function LineRows({
  label,
  prefix,
  items,
}: {
  label: string;
  prefix: 'input' | 'output';
  items: { id: string; code: string; name: string; baseUnit: string }[];
}) {
  return (
    <div>
      <span className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
      <div className="mt-2 space-y-2">
        {Array.from({ length: LINE_ROWS }).map((_, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <select name={`${prefix}ItemId`} defaultValue="" className={`${INPUT} w-full`}>
              <option value="">— item —</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.code} — {it.name}
                </option>
              ))}
            </select>
            <input name={`${prefix}Quantity`} placeholder="quantity" className={`${INPUT} w-full`} />
            <input name={`${prefix}Unit`} placeholder="unit (kg, g, ...)" className={`${INPUT} w-full`} />
          </div>
        ))}
      </div>
    </div>
  );
}
