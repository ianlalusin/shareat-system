import Link from 'next/link';
import { formatBusinessDayLong, toBusinessDate } from '@shareat/core/datetime';
import { storePageScope } from '../../../lib/store-scope';
import { peso } from '../../../lib/format';
import { deliveryFormData, deliveryRegister } from './lib';
import { NewDeliveryForm } from './NewDeliveryForm';
import { createDeliveryAction } from './actions';
import { Page, PageHeader } from '@/components/shell/Page';
import { Badge, EmptyState, FlashBanner, FormModal, LinkRow, NumTd, RowLink, Select, Table, Td, Th } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { withFlash } from '@/lib/flash';
import { NAV_LINK } from '@/components/action-link';

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
  const scope = await storePageScope('/inventory/deliveries', sp.store);
  if ('refusal' in scope) return scope.refusal;
  const { actor, stores, storeId } = scope;

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
      <PageHeader title="Deliveries" description={<>
            Record what is coming, then receive what actually arrived. Receiving is how stock enters the store.
          </>} actions={
        <div className="flex flex-wrap items-baseline gap-4">
          <Link href="/inventory/deliveries/inbound" className={NAV_LINK}>
            Shipments to receive
          </Link>
          <Link href={`/inventory?store=${storeId}`} className={NAV_LINK}>
            ← Stock on hand
          </Link>
        </div>
      } />

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
            body="Use New delivery to record goods that are on the way."
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
                        {formatBusinessDayLong(d.deliveredOn)}
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
