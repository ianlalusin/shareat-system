export interface FilterOption {
  id: string;
  label: string;
}

/**
 * The AP/AR aging screens' shared filter form — docs/tasks/209-reporting-read-model-and-statements.md
 * (T-209b). Same "as of one date, not a range" shape as `BalanceSheetFilters`, minus its
 * year-close toggle: AR/AP control accounts (1210/2110) are never touched by a year-close entry,
 * so the toggle would be a control with no effect.
 */
export function AgingFilters({
  basePath,
  orgs,
  currentOrgId,
  stores,
  currentStoreId,
  asOfDate,
}: {
  basePath: string;
  orgs: FilterOption[];
  currentOrgId: string;
  stores: FilterOption[];
  currentStoreId?: string;
  asOfDate: string;
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

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Apply
      </button>
    </form>
  );
}
