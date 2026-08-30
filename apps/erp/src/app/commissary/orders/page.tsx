import Link from 'next/link';
import { lowStockRepo, transaction } from '@shareat/db';
import { listStores } from '../../inventory/lib';
import { requireSession } from '../../../lib/session';

export const metadata = { title: 'Branch orders — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Submitted',
  dispatched: 'In transit',
  received: 'Received',
  void: 'Void',
};

export default async function BranchOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/commissary/orders');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-2xl font-semibold">Branch orders</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </main>
    );
  }

  const orders = await transaction((tx) => lowStockRepo.branchOrders(tx, actor.orgId, storeId));

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Branch orders</h1>
      {/*
        ⭐ BOTH directions in one list, deliberately. Two screens showing "my orders" from opposite
        ends is how the two sides end up disagreeing about what was sent.
      */}
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Every internal order this store is on — as the commissary filling one, or as the branch
        waiting for it.
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

      {orders.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-600 dark:text-neutral-400">
          No internal orders. A branch below its reorder threshold gets one drafted for it
          automatically — see <Link href="/inventory/low-stock" className="underline underline-offset-4">low stock</Link>.
        </p>
      ) : (
        <table className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">From → to</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 text-right font-medium">Lines</th>
              <th className="py-2 pr-4 text-right font-medium">Total</th>
              <th className="py-2 font-medium">Thread</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4 tabular-nums">
                  <Link href={`/commissary/orders/${o.id}`} className="underline underline-offset-4">
                    {o.orderDate}
                  </Link>
                </td>
                <td className="py-2 pr-4">
                  {o.commissaryName} → {o.branchName ?? '—'}
                </td>
                <td className="py-2 pr-4">{STATUS_LABEL[o.status] ?? o.status}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{o.lineCount}</td>
                <td className="py-2 pr-4 text-right tabular-nums">₱{o.totalAmount}</td>
                <td className="py-2 text-neutral-600 dark:text-neutral-400">
                  {o.messageCount === 0 ? '—' : `${o.messageCount} message${o.messageCount === 1 ? '' : 's'}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
