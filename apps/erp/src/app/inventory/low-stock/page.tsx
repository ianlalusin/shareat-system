import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { lowStockRepo, schema } from '@shareat/db';
import { listStores } from '../lib';
import { setThresholdAction } from './actions';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Low stock — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

export default async function LowStockPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/low-stock');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Low stock</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { low, missing, thresholds, items } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const [lowRows, missingRows, thresholdRows, itemRows] = await Promise.all([
      lowStockRepo.lowStock(tx, actor.orgId, storeId),
      lowStockRepo.itemsWithoutThreshold(tx, actor.orgId, storeId),
      tx
        .select({
          itemId: schema.storeItemThresholds.itemId,
          threshold: schema.storeItemThresholds.lowStockThreshold,
        })
        .from(schema.storeItemThresholds)
        .where(eq(schema.storeItemThresholds.storeId, storeId)),
      tx
        .select({ id: schema.items.id, name: schema.items.name, code: schema.items.code, baseUnit: schema.items.baseUnit })
        .from(schema.items)
        .where(eq(schema.items.orgId, actor.orgId))
        .orderBy(asc(schema.items.name)),
    ]);
    return { low: lowRows, missing: missingRows, thresholds: thresholdRows, items: itemRows };
  });

  const thresholdByItem = new Map(thresholds.map((t) => [t.itemId, t.threshold]));

  return (
    <Page density="table" className="">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Low stock</h1>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>
      <PageDescription className="mt-1">
        Recomputed on every load from the ledger — there is no cached alert list, because a stale
        low-stock alert is indistinguishable from a real one.
      </PageDescription>

      {sp.error && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <FilterRow className="mt-6">
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

      <h2 className="mt-8 text-lg font-medium">At or below threshold</h2>
      {low.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Nothing is low. ⚠️ That is only meaningful for items that HAVE a threshold — see below.
        </p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 text-right font-medium">On hand</th>
              <th className="py-2 pr-4 text-right font-medium">Threshold</th>
              <th className="py-2 text-right font-medium">Short by</th>
            </tr>
          </thead>
          <tbody>
            {low.map((row) => (
              <tr key={row.itemId} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4 font-medium">{row.itemName}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {row.onHand} {row.baseUnit}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{row.threshold}</td>
                <td className="py-2 text-right tabular-nums font-medium text-amber-700 dark:text-amber-500">
                  {row.shortfall}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        ⭐ **This block is the replacement for v1's forcing function.** v1 BLOCKS a usage post
        until somebody sets the threshold, which puts the demand on a cook at 11pm who cannot
        answer it. Surfacing it here reaches the manager who can. Nag the person who can act;
        never block the person who cannot.
      */}
      {missing.length > 0 && (
        <section className="mt-8 rounded-lg border border-amber-400 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
          <h2 className="text-sm font-medium">
            ⚠️ {missing.length} item{missing.length === 1 ? '' : 's'} moving in this store with no
            threshold
          </h2>
          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
            They can never appear on the list above, and nothing else will say so — the store simply
            runs out. Set one below.
          </p>
          <ul className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
            {missing.slice(0, 12).map((m) => (
              <li key={m.itemId}>· {m.itemName}</li>
            ))}
            {missing.length > 12 && <li className="text-neutral-500">…and {missing.length - 12} more</li>}
          </ul>
        </section>
      )}

      <h2 className="mt-10 text-lg font-medium">Thresholds</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        A threshold of <strong>0</strong> means “tell me the moment it runs out”. Clearing the box
        removes the threshold entirely — a different state, and the item then falls off the list.
      </p>
      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 font-medium">Unit</th>
            <th className="py-2 font-medium">Threshold</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-neutral-200 dark:border-neutral-800">
              <td className="py-2 pr-4">
                <span className="font-medium">{item.name}</span>
                <span className="ml-2 text-xs text-neutral-500">{item.code}</span>
              </td>
              <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">{item.baseUnit}</td>
              <td className="py-2">
                <form action={setThresholdAction} className="flex items-center gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="itemId" value={item.id} />
                  <input
                    name="threshold"
                    inputMode="decimal"
                    defaultValue={thresholdByItem.get(item.id) ?? ''}
                    placeholder="none"
                    className="w-28 rounded-md border border-neutral-300 px-2 py-1 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Save
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
