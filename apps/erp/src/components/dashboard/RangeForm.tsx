import { Button, Input, Select } from '@/components/ui';

export interface DashboardStoreOption {
  id: string;
  label: string;
}

/** T-211. The dashboard's own filter — store + date range only. Deliberately not a fork of
 *  `ReportFilters` (org and year-close are report-specific; this page is always the signed-in
 *  actor's one org and never shows the year-close entry — see the page's own P&L call). */
export function RangeForm({
  stores,
  currentStoreId,
  fromDate,
  toDate,
}: {
  stores: DashboardStoreOption[];
  currentStoreId?: string;
  fromDate: string;
  toDate: string;
}) {
  return (
    <form
      method="GET"
      action="/"
      className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
        <Select name="store" defaultValue={currentStoreId ?? ''}>
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">From</span>
        <Input type="date" name="from" defaultValue={fromDate} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">To</span>
        <Input type="date" name="to" defaultValue={toDate} />
      </label>
      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}
