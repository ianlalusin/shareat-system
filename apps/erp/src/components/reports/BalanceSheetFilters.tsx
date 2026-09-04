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
      className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Organization</span>
        <select
          name="org"
          defaultValue={currentOrgId}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
        <select
          name="store"
          defaultValue={currentStoreId ?? ''}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">As of</span>
        <input
          type="date"
          name="asOf"
          defaultValue={asOfDate}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Year-close entry</span>
        <select
          name="yearClose"
          defaultValue={includeYearClose ? 'include' : 'exclude'}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="include">Included</option>
          <option value="exclude">Excluded</option>
        </select>
        <span className="text-xs text-neutral-400 dark:text-neutral-600">
          Defaults to included — a balance sheet is an as-of view (ADR-006), same default as the
          trial balance.
        </span>
      </label>

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Apply
      </button>
    </form>
  );
}
