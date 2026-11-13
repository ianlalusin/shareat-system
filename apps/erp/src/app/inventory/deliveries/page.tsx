import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { peso } from '../../../lib/format';
import { deliveryFormData, deliveryRegister, listStores } from './lib';
import { NewDeliveryForm } from './NewDeliveryForm';
import { createDeliveryAction } from './actions';
import { Page } from '@/components/shell/Page';
import { Badge, EmptyState, FlashBanner, FormModal, LinkRow, NumTd, RowLink, Select, Table, Td, Th } from '@/components/ui';
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

const KIND_LABEL: Record<string, string> = { supplier: 'Supplier', purchase: 'Cash purchase', commissary: 'Commissary', inter_entity: 'From another company' };

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
            actually came. Receiving is the only door stock enters by — quantity, cost and the books
            all follow from that one action.
          </PageDescription>
        </div>
        <div className="flex flex-wrap items-baseline gap-4">
          <Link href="/inventory/deliveries/inbound" className="inline-flex min-h-6 items-center text-sm underline underline-offset-4">
            Shipments to receive
          </Link>
          <Link href={`/inventory?store=${storeId}`} className="text-sm underline underline-offset-4">
            ← Stock on hand
          </Link>
        </div>
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
          <EmptyState
            illustration="truck"
            title="Nothing recorded yet"
            body="A delivery is the document goods arrive on. Record what is coming, then receive what actually came."
          />
        ) : (
          <div className="mt-3">
            <Table card={{ title: 'Kind', subtitle: 'Date', keys: ['Total', 'Status'] }}>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Kind</Th>
                  <Th>Supplier</Th>
                  <Th>Reference</Th>
                  <Th numeric>Lines</Th>
                  <Th numeric>Total</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <LinkRow key={d.id}>
                    <Td>
                      <RowLink href={`/inventory/deliveries/${d.id}`}>
                        {d.deliveredOn}
                      </RowLink>
                    </Td>
                    <Td>{KIND_LABEL[d.kind] ?? d.kind}</Td>
                    <Td className="text-muted">{d.supplierName ?? '—'}</Td>
                    <Td className="text-muted">{d.referenceNo ?? '—'}</Td>
                    <NumTd>{d.lineCount}</NumTd>
                    <NumTd className="font-mono">{peso(d.total)}</NumTd>
                    <Td>
                      <Badge status={d.status} />
                    </Td>
                  </LinkRow>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </section>
    </Page>
  );
}
