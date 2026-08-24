/**
 * The shared date-range / org / store / year-close filter form for both report screens.
 * docs/tasks/110-reporting-views-and-screens.md Contract §5 ("Filterable by org, store,
 * and date range" / "whether the year-close entry is included").
 *
 * A plain server-rendered GET `<form>` — submitting it is a normal navigation to
 * `basePath?org=...&store=...&from=...&to=...&yearClose=...`, re-rendering the Server
 * Component page with the new searchParams. No client JavaScript, no "use client",
 * nothing to hydrate — this is presentation, matching this file's Scope note.
 */
export interface FilterOption {
  id: string;
  label: string;
}

export function ReportFilters({
  basePath,
  orgs,
  currentOrgId,
  stores,
  currentStoreId,
  fromDate,
  toDate,
  includeYearClose,
  yearCloseHelp,
}: {
  basePath: string;
  orgs: FilterOption[];
  currentOrgId: string;
  stores: FilterOption[];
  currentStoreId?: string;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
  yearCloseHelp: string;
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
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">From</span>
        <input
          type="date"
          name="from"
          defaultValue={fromDate}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">To</span>
        <input
          type="date"
          name="to"
          defaultValue={toDate}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Year-close entry</span>
        {/*
          A <select> with explicit include/exclude values, not a checkbox — an unchecked
          checkbox submits NO field at all, which is indistinguishable from "the form
          wasn't submitted" and would make the current state impossible to represent
          faithfully in the URL. An explicit value has no such ambiguity.
        */}
        <select
          name="yearClose"
          defaultValue={includeYearClose ? 'include' : 'exclude'}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="include">Included</option>
          <option value="exclude">Excluded</option>
        </select>
        <span className="text-xs text-neutral-400 dark:text-neutral-600">{yearCloseHelp}</span>
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
