import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { createOrderAction } from './actions';
import { NewOrderForm } from './NewOrderForm';
import { STATUS_LABEL, listStores, orderFormData, orderRegister, peso, today } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Trade orders — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

export default async function TradeOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/trade/orders');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Trade orders</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [orders, form] = await Promise.all([orderRegister(actor.orgId, storeId), orderFormData(actor.orgId)]);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  return (
    <Page density="table">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Trade orders</h1>
        <Link href="/trade/returns" className="text-sm underline underline-offset-4">
          Customer returns →
        </Link>
      </div>
      <p className="max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
        One document for a wholesale sale and an internal transfer alike — the commissary packs the
        same crates whoever is receiving; only the books differ. ⭐ <strong>Dispatch is the event</strong>:
        a sale bills the customer and relieves stock with cost of sales; a transfer puts the goods in
        transit at cost, and both stores&rsquo; books move when the branch confirms what arrived.
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

      <form method="get" className="flex flex-wrap items-end gap-3 gap-y-2">
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
        ⭐ BOTH directions in one list, deliberately — every order this store is on, as the seller
        or as the branch a transfer is going to. Same rule as the branch-orders screen: two lists
        showing "my orders" from opposite ends is how the two sides end up disagreeing.
      */}
      {orders.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No trade orders at this store yet. Draft one below.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Route</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Lines</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2 tabular-nums">
                    <Link href={`/trade/orders/${o.id}`} className="underline underline-offset-4">
                      {o.orderDate}
                    </Link>
                    {o.referenceNo && <span className="ml-2 text-xs text-neutral-500">{o.referenceNo}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {o.customerName}
                    {o.counterpartyStoreId && (
                      <span className="ml-2 text-xs text-sky-700 dark:text-sky-400">internal</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                    {storeName.get(o.storeId) ?? '—'}
                    {' → '}
                    {o.counterpartyStoreId ? (storeName.get(o.counterpartyStoreId) ?? '—') : o.customerName}
                  </td>
                  <td className="px-3 py-2">{STATUS_LABEL[o.status]}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{o.lineCount}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(o.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">New trade order</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Saved as a <strong>draft</strong> — nothing posts until it is dispatched from the
          order&rsquo;s page. A wholesale line needs an item the selling store sells wholesale
          (set on the item&rsquo;s page); an internal transfer needs no such flag.
        </p>
        <NewOrderForm
          action={createOrderAction}
          stores={stores}
          storeId={storeId}
          customers={form.customers}
          items={form.items}
          quotes={form.quotes}
          branchPrices={form.branchPrices}
          today={today()}
        />
      </section>
    </Page>
  );
}
