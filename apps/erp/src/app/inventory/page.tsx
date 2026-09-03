import Link from 'next/link';
import { listStores, stockSummary } from './lib';
import { requireSession } from '../../lib/session';

export const metadata = { title: 'Stock on hand — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  // ⭐ The org comes from the SESSION, never the URL — T-138, and `no-client-supplied-actor`
  // fails the build if that ever stops being true.
  const { actor } = await requireSession('/inventory');
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-2xl font-semibold">Stock on hand</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </main>
    );
  }

  const summary = await stockSummary(actor.orgId, storeId);
  const drift = (Number(summary.accountValue) - Number(summary.layerValue)).toFixed(2);
  const ties = drift === '0.00' || drift === '-0.00';

  return (
    <main className="mx-auto max-w-5xl p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Stock on hand</h1>
        {/* ⭐ DEF-135 (2026-09-03): rooms, deliveries, usage and counts each had a tested engine
            and no screen. They are the four doors stock actually passes through; this page is
            where their effect is read back, so it links to every one of them. */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/inventory/locations?store=${storeId}`} className="underline underline-offset-4">
            Rooms →
          </Link>
          <Link href={`/inventory/deliveries?store=${storeId}`} className="underline underline-offset-4">
            Deliveries →
          </Link>
          <Link href={`/inventory/usage?store=${storeId}`} className="underline underline-offset-4">
            Usage & wastage →
          </Link>
          <Link href={`/inventory/counts?store=${storeId}`} className="underline underline-offset-4">
            Counts →
          </Link>
          <Link href="/inventory/transfers" className="underline underline-offset-4">
            Transfers →
          </Link>
          <Link href="/inventory/returns" className="underline underline-offset-4">
            Returns →
          </Link>
          <Link href="/inventory/low-stock" className="underline underline-offset-4">
            Low stock →
          </Link>
        </div>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        On-hand is a query over every movement ever recorded — there is no balance column to drift.
      </p>

      <form method="get" className="mt-6 flex items-end gap-3">
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
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Show
        </button>
      </form>

      {/*
        ⭐ **Bible invariant 6's inventory arm, on a screen.** It asks that the control accounts
        equal the subledger "continuously, not at year end" — and until this page, nowhere in the
        product showed it. It lived only inside test assertions.
      */}
      <section
        className={`mt-6 rounded-lg border p-4 ${
          ties
            ? 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900'
            : 'border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950'
        }`}
      >
        <h2 className="text-sm font-medium">
          {ties ? 'Inventory ties to the ledger' : '⚠️ Inventory does NOT tie to the ledger'}
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-neutral-500">FIFO layers</dt>
            <dd className="tabular-nums">₱{summary.layerValue}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">1310 + 1320 + 1330</dt>
            <dd className="tabular-nums">₱{summary.accountValue}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Difference</dt>
            <dd className="tabular-nums">₱{drift}</dd>
          </div>
          <div>
            {/*
              ⚠️ Shown APART, never netted in. Goods on a truck are in no FIFO layer, because a
              layer is a thing on a shelf — conflating the two is DEF-098.
            */}
            <dt className="text-neutral-500">1340 in transit</dt>
            <dd className="tabular-nums">₱{summary.inTransitValue}</dd>
          </div>
        </dl>
      </section>

      {summary.rows.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-600 dark:text-neutral-400">
          No item in this store has a balance. Stock arrives through a{' '}
          <Link href={`/inventory/deliveries?store=${storeId}`} className="underline underline-offset-4">
            delivery
          </Link>{' '}
          or a commissary receipt.
        </p>
      ) : (
        <table className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 font-medium">Where</th>
              <th className="py-2 pr-4 text-right font-medium">On hand</th>
              <th className="py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => (
              <tr key={row.itemId} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-4">
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 text-xs text-neutral-500">{row.code}</span>
                </td>
                <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                  {row.byLocation.map((l) => (
                    <div key={l.locationName}>
                      {l.locationName} <span className="tabular-nums">{l.quantity}</span>
                    </div>
                  ))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {row.quantity} {row.baseUnit}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {/* ⚠️ A balance with no open layer is a real state worth seeing rather than
                      showing as ₱0 — it means stock exists that no receipt ever valued. */}
                  {row.value === null ? (
                    <span className="text-amber-700 dark:text-amber-500">no layer</span>
                  ) : (
                    `₱${row.value}`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
