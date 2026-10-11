import { Button, Input, Select } from '@/components/ui';

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

      <Button type="submit" variant="primary">
        Apply
      </Button>
    </form>
  );
}
