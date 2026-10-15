import Link from 'next/link';
import { WASTAGE_REASONS, WASTAGE_REASON_LABEL, wastageReasonLabel } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { saveUsageDraftAction } from './actions';
import { listStores, usageScreenData } from './lib';
import { NewUsageForm } from './NewUsageForm';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, FlashBanner, LinkRow, RowLink, Select } from '@/components/ui';

export const metadata = { title: 'Usage & wastage — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

const KIND_LABEL: Record<string, string> = { usage: 'Usage', wastage: 'Wastage', adjustment: 'Adjustment', opening: 'Opening' };

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/usage');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { locations, departments, items, records } = await usageScreenData(actor.orgId, storeId);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
          <PageDescription className="mt-1">
            A floor worker records what was consumed or spoiled; a manager posts it. ⭐ Posting is
            the only step that moves stock and hits the books.
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
          <Select name="store" defaultValue={storeId}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {locations.length === 0 ? (
        <Banner tone="warning">
          This store has no active operating room yet — a usage can only be recorded from one. Add
          one under{' '}
          <Link href={`/inventory/locations?store=${storeId}`} className="text-sm underline underline-offset-4">
            Locations
          </Link>
          .
        </Banner>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">New record</h2>
          <NewUsageForm
            action={saveUsageDraftAction}
            storeId={storeId}
            locations={locations}
            departments={departments}
            items={items}
            reasons={WASTAGE_REASONS.map((value) => ({ value, label: WASTAGE_REASON_LABEL[value] }))}
            today={toBusinessDate()}
          />
        </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Records</h2>
        {records.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 text-right font-medium">Lines</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <LinkRow key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink href={`/inventory/usage/${r.id}`}>
                        {r.usedOn}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-3 py-2">{r.locationName}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {r.reasonCode ? wastageReasonLabel(r.reasonCode) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.lineCount}</td>
                    <td className="px-3 py-2">
                      <Badge status={r.status} />
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
