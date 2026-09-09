import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { recordCountAction } from '../actions';
import { countedValueFor, listStores, loadCountSheet, peso } from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';

export const metadata = { title: 'Opening count — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

export default async function CountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/cutover/count');
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="form" className="">
        <h1 className="text-2xl font-semibold">Opening count</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          There are no stores to count yet.
        </p>
      </Page>
    );
  }

  const [rows, countedValue] = await Promise.all([
    loadCountSheet(actor.orgId, storeId),
    countedValueFor(actor.orgId, storeId),
  ]);
  const store = stores.find((s) => s.id === storeId)!;
  const missing = rows.filter((r) => r.quantity === null);

  return (
    <Page density="form">
      <div>
        <Link
          href="/cutover"
          className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-500`}
        >
          ← Back to the conversion
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Opening count — {store.name}</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          What is physically on the shelf on 31 December, and what it cost. This becomes the
          opening inventory figure, so a guess here is a wrong number in every month that follows.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {/* Switching stores. ⭐ Four stores, four counts — a single tick would hide the one nobody
          visited, so each is entered and shown on its own. */}
      {stores.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/cutover/count?store=${s.id}`}
              className={`rounded border px-3 py-2 text-sm ${
                s.id === storeId
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                  : 'border-neutral-300 dark:border-neutral-700'
              }`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <span className="text-neutral-600 dark:text-neutral-400">Counted so far, at cost</span>
        <span className="font-mono text-lg font-medium tabular-nums">{peso(Number(countedValue))}</span>
      </div>

      {/*
        ⭐ AN ITEM SILENTLY ABSENT IS NOT AN ITEM COUNTED AS ZERO.

        The two look identical on a sheet of paper, and that is how stock quietly goes missing from
        an opening balance. So an uncounted item shows as "not counted" — a blank, not a zero — and
        a real zero has to be typed on purpose.
      */}
      {missing.length > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">
            {missing.length} item{missing.length === 1 ? '' : 's'} not counted yet.
          </strong>
          <p className="mt-1 text-xs">
            If the shelf is genuinely empty, enter <span className="font-mono">0</span> — that is a
            real answer and a different one from never having looked.
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Every active item has a count at this store.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((r) => (
          <form
            key={r.itemId}
            action={recordCountAction}
            className={`rounded-lg border p-3 ${
              r.quantity === null
                ? 'border-amber-300 dark:border-amber-800'
                : 'border-neutral-200 dark:border-neutral-800'
            }`}
          >
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="itemId" value={r.itemId} />

            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-500">
                {r.quantity === null ? 'Not counted' : `Counted ${r.quantity} ${r.baseUnit}`}
              </span>
            </div>

            {/* Touch-first: full-width inputs, a real submit button per row, nothing on hover. */}
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <label className="block">
                <span className="sr-only">Quantity in {r.baseUnit}</span>
                <input
                  type="number"
                  name="quantity"
                  step="0.001"
                  min="0"
                  required
                  defaultValue={r.quantity ?? ''}
                  placeholder={`Quantity (${r.baseUnit})`}
                  inputMode="decimal"
                  className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="block">
                <span className="sr-only">Cost per {r.baseUnit}</span>
                <input
                  type="number"
                  name="unitCost"
                  step="0.0001"
                  min="0"
                  defaultValue={r.unitCost ?? ''}
                  placeholder={`Cost per ${r.baseUnit}`}
                  inputMode="decimal"
                  className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                Save
              </button>
            </div>
          </form>
        ))}
      </div>

      {rows.length === 0 && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          There are no active items to count. Import the item master first.
        </p>
      )}
    </Page>
  );
}
