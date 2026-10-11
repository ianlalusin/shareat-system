import { Button, Input, Select } from '@/components/ui';

export interface FilterOption {
  id: string;
  label: string;
}

/**
 * The balance sheet's own filter form — docs/tasks/209-reporting-read-model-and-statements.md.
 *
 * Not `ReportFilters`: a balance sheet is a snapshot ("as of one date"), not a date RANGE —
 * `ReportFilters` requires both a From and a To. Same GET-form, no-JS pattern otherwise.
 */
export function BalanceSheetFilters({
  basePath,
  orgs,
  currentOrgId,
  stores,
  currentStoreId,
  asOfDate,
  includeYearClose,
}: {
  basePath: string;
  orgs: FilterOption[];
  currentOrgId: string;
  stores: FilterOption[];
  currentStoreId?: string;
  asOfDate: string;
  includeYearClose: boolean;
}) {
  return (
    <form
      method="GET"
      action={basePath}
      className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500">Organization</span>
        <Select
          name="org"
          defaultValue={currentOrgId}
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500">Store</span>
        <Select
          name="store"
          defaultValue={currentStoreId ?? ''}
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500">As of</span>
        <Input
          type="date"
          name="asOf"
          defaultValue={asOfDate}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500">Year-close entry</span>
        <Select
          name="yearClose"
          defaultValue={includeYearClose ? 'include' : 'exclude'}
        >
          <option value="include">Included</option>
          <option value="exclude">Excluded</option>
        </Select>
        <span className="text-xs text-neutral-400 dark:text-neutral-600">
          Defaults to included — a balance sheet is an as-of view (ADR-006), same default as the
          trial balance.
        </span>
      </label>

      <Button type="submit" variant="primary">
        Apply
      </Button>
    </form>
  );
}
