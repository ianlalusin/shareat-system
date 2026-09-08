import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { peso } from '../../../lib/format';
import { createDeliveryAction } from './actions';
import { deliveryFormData, deliveryRegister, listStores } from './lib';
import { NewDeliveryForm } from './NewDeliveryForm';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';

export const metadata = { title: 'Deliveries — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
  warning?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

const KIND_LABEL: Record<string, string> = { supplier: 'Supplier', purchase: 'Cash purchase', commissary: 'Commissary' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', received: 'Received', void: 'Void' };
const STATUS_TONE: Record<string, string> = {
  draft: 'text-neutral-600 dark:text-neutral-400',
  received: 'text-emerald-700 dark:text-emerald-400',
  void: 'text-red-700 dark:text-red-400',
};

export default async function DeliveriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/inventory/deliveries');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Deliveries</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [formData, deliveries] = await Promise.all([
    deliveryFormData(actor.orgId, storeId),
    deliveryRegister(actor.orgId, storeId),
  ]);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Deliveries</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            The document goods actually arrive on. Record what is coming, then receive what
            actually came. ⭐ Receiving is the ONLY door stock enters by — quantity, cost and the
            books all follow from that one action.
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
      {sp.warning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          ⚠️ {sp.warning}
        </div>
      )}

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={`mt-1 ${INPUT}`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
      </FilterRow>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">New delivery</h2>
        <NewDeliveryForm
          action={createDeliveryAction}
          storeId={storeId}
          suppliers={formData.suppliers}
          items={formData.items}
          locations={formData.locations}
          today={toBusinessDate()}
        />
      </section>

      <section>
        <h2 className="text-lg font-medium">Register</h2>
        {deliveries.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 text-right font-medium">Lines</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <Link href={`/inventory/deliveries/${d.id}`} className="underline underline-offset-4">
                        {d.deliveredOn}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[d.kind] ?? d.kind}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{d.supplierName ?? '—'}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{d.referenceNo ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.lineCount}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(d.total)}</td>
                    <td className={`px-3 py-2 font-medium ${STATUS_TONE[d.status] ?? ''}`}>
                      {STATUS_LABEL[d.status] ?? d.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}
