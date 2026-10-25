/**
 * The shared date-range / org / store / year-close filter form for the report screens.
 * docs/tasks/110-reporting-views-and-screens.md Contract §5 ("Filterable by org, store,
 * and date range" / "whether the year-close entry is included").
 *
 * T-448 layout: one wrapping row of content-sized fields (FormGrid layout="fields"), each a
 * labelled <Field>, with Apply on the controls' baseline.
 *
 * A plain server-rendered GET `<form>` — submitting it is a normal navigation to
 * `basePath?org=...&store=...&from=...&to=...&yearClose=...`, re-rendering the Server
 * Component page with the new searchParams. No client JavaScript, no "use client",
 * nothing to hydrate — this is presentation, matching this file's Scope note.
 */
import { Button, Field, FormGrid, Input, Select } from '@/components/ui';

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
      className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <FormGrid layout="fields" className="[&.erp-form-fields]:items-end">
        <Field label="Organization" width="name">
          <Select name="org" defaultValue={currentOrgId} className="w-full">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Store" width="code">
          <Select name="store" defaultValue={currentStoreId ?? ''} className="w-full">
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" width="date">
          <Input type="date" name="from" defaultValue={fromDate} className="w-full" />
        </Field>
        <Field label="To" width="date">
          <Input type="date" name="to" defaultValue={toDate} className="w-full" />
        </Field>
        {/*
          A <select> with explicit include/exclude values, not a checkbox — an unchecked
          checkbox submits NO field at all, which is indistinguishable from "the form
          wasn't submitted" and would make the current state impossible to represent
          faithfully in the URL. An explicit value has no such ambiguity.
        */}
        <Field label="Year-close entry" width="code" hint={yearCloseHelp}>
          <Select name="yearClose" defaultValue={includeYearClose ? 'include' : 'exclude'} className="w-full">
            <option value="include">Included</option>
            <option value="exclude">Excluded</option>
          </Select>
        </Field>
        <div style={{ flex: 'none' }}>
          <Button type="submit" variant="primary">
            Apply
          </Button>
        </div>
      </FormGrid>
    </form>
  );
}
