import Link from 'next/link';
import { Button, Input, Select } from '@/components/ui';
import { RANGE_PRESETS, type RangePreset } from '@/app/dashboard/lib';

export interface DashboardStoreOption {
  id: string;
  label: string;
}

/** T-211, reshaped in T-387 S5. Preset links (a segmented control of 12px rectangles) plus the custom
 *  store + from/to form. Deliberately not a fork of `ReportFilters` (org and year-close are
 *  report-specific; this page is always the signed-in actor's one org). */
export function RangeForm({
  stores,
  currentStoreId,
  fromDate,
  toDate,
  activePreset = null,
}: {
  stores: DashboardStoreOption[];
  currentStoreId?: string;
  fromDate: string;
  toDate: string;
  activePreset?: RangePreset | null;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div
        role="group"
        aria-label="Period"
        className="inline-flex gap-0.5 rounded-[12px] border border-surface-border bg-surface p-1"
      >
        {RANGE_PRESETS.map((p) => {
          const on = activePreset === p.key;
          const href = '/?range=' + p.key + (currentStoreId ? '&store=' + encodeURIComponent(currentStoreId) : '');
          return (
            <Link
              key={p.key}
              href={href}
              aria-current={on ? 'true' : undefined}
              className={
                'inline-flex min-h-11 items-center rounded-[12px] px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ' +
                (on ? 'bg-ink text-canvas' : 'text-muted hover:text-ink')
              }
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      <form
        method="GET"
        action="/"
        className="flex flex-wrap items-end gap-4 rounded-[14px] border border-surface-border bg-surface p-4 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Store</span>
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
          <span className="text-xs font-medium text-muted">From</span>
          <Input type="date" name="from" defaultValue={fromDate} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">To</span>
          <Input type="date" name="to" defaultValue={toDate} />
        </label>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>
    </div>
  );
}
