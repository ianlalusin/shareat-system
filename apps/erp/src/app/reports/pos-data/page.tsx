import { toBusinessDate } from '@shareat/core/datetime';
import { POS_EXPORT_MAX_DAYS } from '@shareat/domain';
import { reportScope } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Button, Field, FormGrid, Input, Select } from '@/components/ui';

export const metadata = { title: 'POS data download — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

/** T-569: the file name people see, in the order the receipt is built. The key is the export route's `table=` value. */
const FILES: { table: string; label: string }[] = [
  { table: 'receipts', label: 'Receipts' },
  { table: 'receipt-lines', label: 'Receipt lines' },
  { table: 'receipt-line-discounts', label: 'Line discounts' },
  { table: 'payments', label: 'Payments' },
  { table: 'day-closes', label: 'Day closes' },
  { table: 'day-close-tenders', label: 'Day close tenders' },
  { table: 'table-sessions', label: 'Table sessions' },
  { table: 'device-events', label: 'Device log' },
];

interface SearchParams {
  store?: string;
  from?: string;
  to?: string;
}

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

export default async function PosDataPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = await reportScope('/reports/pos-data', 'view_financial_reports', sp.store);
  // A download is for ONE store: someone who covers the whole org still starts on their first store, never "all".
  const storeId = scope.storeId ?? scope.stores[0]?.id;
  const today = toBusinessDate();
  const from = sp.from ?? firstOfMonth(today);
  const to = sp.to ?? today;

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">POS data download</h1>
        <PageDescription>
          Download every POS v2 record for one store and date range before the 2027 clean-up. One file per table; open them in Excel. Close the day (Z) before downloading, so every receipt is on its business day.
        </PageDescription>
      </div>

      <form
        method="GET"
        action="/reports/pos-data"
        className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <FormGrid layout="fields" className="[&.erp-form-fields]:items-end">
          <Field label="Store" width="name">
            <Select name="store" defaultValue={storeId ?? ''} className="w-full">
              {scope.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" width="date">
            <Input type="date" name="from" defaultValue={from} className="w-full" />
          </Field>
          <Field label="To" width="date">
            <Input type="date" name="to" defaultValue={to} className="w-full" />
          </Field>
          <div style={{ flex: 'none' }}>
            <Button type="submit" variant="primary">
              Apply
            </Button>
          </div>
        </FormGrid>
      </form>

      {storeId ? (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {scope.stores.find((s) => s.id === storeId)?.name} · {from} to {to} · at most {POS_EXPORT_MAX_DAYS} days at a time
          </p>
          <ul className="flex flex-wrap gap-3">
            {FILES.map((f) => (
              <li key={f.table}>
                <a
                  href={`/reports/pos-data/export?${new URLSearchParams({ store: storeId, from, to, table: f.table }).toString()}`}
                  className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
                >
                  {f.label}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">You have no store to download from.</p>
      )}
    </Page>
  );
}
