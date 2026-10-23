import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { peso } from '../../../lib/format';
import { deliveryFormData, deliveryRegister, listStores } from './lib';
import { NewDeliveryForm } from './NewDeliveryForm';
import { createDeliveryAction } from './actions';
import { Page } from '@/components/shell/Page';
import { Badge, FlashBanner, FormModal, LinkRow, RowLink, Select } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Deliveries — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
  warning?: string;
}

const KIND_LABEL: Record<string, string> = { supplier: 'Supplier', purchase: 'Cash purchase', commissary: 'Commissary' };

export default async function DeliveriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
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
          <PageDescription className="mt-1">
            The document goods actually arrive on. Record what is coming, then receive what
            actually came. ⭐ Receiving is the ONLY door stock enters by — quantity, cost and the
            books all follow from that one action.
          </PageDescription>
        </div>
        <Link href={`/inventory?store=${storeId}`} className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId} className="mt-1">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Register</h2>
          {/* T-448: the new-delivery form opens from a button. */}
          <FormModal trigger="+ New delivery" title="New delivery" size="lg">
            <NewDeliveryForm
              action={createDeliveryAction}
              storeId={storeId}
              suppliers={formData.suppliers}
              items={formData.items}
              locations={formData.locations}
              today={toBusinessDate()}
            />
          </FormModal>
        </div>
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
                  <LinkRow key={d.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink href={`/inventory/deliveries/${d.id}`}>
                        {d.deliveredOn}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[d.kind] ?? d.kind}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{d.supplierName ?? '—'}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{d.referenceNo ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.lineCount}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(d.total)}</td>
                    <td className="px-3 py-2">
                      <Badge status={d.status} />
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}
