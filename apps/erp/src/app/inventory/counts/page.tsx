import Link from 'next/link';
import { countsRegister, listStores } from './lib';
import { openCountSessionAction } from './actions';
import { requireSession } from '../../../lib/session';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';

export const metadata = { title: 'Physical counts — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open — no lines counted yet',
  counting: 'Counting',
  reviewing: 'Reviewing',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function when(d: Date): string {
  return new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

export default async function CountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/inventory/counts');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Physical counts</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { locations, sessions } = await countsRegister(actor.orgId, storeId);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Physical counts</h1>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Freeze a room, count it, and the difference between what was counted and what the ledger said
        posts to <strong>5400</strong> at FIFO cost — the gap v1 never closed.
      </p>

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
          <select
            name="store"
            defaultValue={storeId}
            className="mt-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
      </FilterRow>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Open a count</h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Every room ticked freezes the moment you submit — usage, wastage, transfers and receipts into
          it are refused until this count is committed or cancelled.
        </p>
        {locations.length === 0 ? (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-500">This store has no active rooms yet.</p>
        ) : (
          <form action={openCountSessionAction} className="mt-3 space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {locations.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="locationIds" value={l.id} disabled={l.frozen} />
                  <span>{l.name}</span>
                  {l.frozen && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                      frozen — already counting
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-neutral-600 dark:text-neutral-400">
                Counted on
                <input
                  name="countedOn"
                  type="date"
                  defaultValue={today()}
                  className="mt-1 block rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="grow text-xs text-neutral-600 dark:text-neutral-400">
                Note (optional)
                <input
                  name="note"
                  className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Open count
              </button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium">Sessions</h2>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No counts recorded for this store yet.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
                <th className="py-2 pr-4 font-medium">Rooms</th>
                <th className="py-2 pr-4 font-medium">Counted on</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Lines</th>
                <th className="py-2 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                  <td className="py-2 pr-4">
                    <Link href={`/inventory/counts/${s.id}`} className="underline underline-offset-4">
                      {s.locations.map((l) => l.name).join(', ') || '—'}
                    </Link>
                    {s.note && <div className="text-xs text-neutral-500">{s.note}</div>}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{s.countedOn}</td>
                  <td className="py-2 pr-4">{STATUS_LABEL[s.status] ?? s.status}</td>
                  <td className="py-2 pr-4 tabular-nums">{s.lineCount}</td>
                  <td className="py-2 text-xs text-neutral-500">
                    {s.openedByName} · {when(s.openedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Page>
  );
}
