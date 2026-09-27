'use client';

/**
 * The "New record" form — T-168 / DEF-135. One document for a usage OR a wastage; the kind picked
 * here decides whether the reason field is shown (only meaningful for a wastage, `saveUsageDraft`
 * refuses one carried on a usage). Dynamic item + quantity rows, same shape `NewOrderForm.tsx`
 * (trade orders) and `NewTransferForm.tsx` already use in this codebase — every line the draft
 * starts with is created in ONE submission.
 */
import { useState } from 'react';

interface LocationOption {
  id: string;
  code: string;
  name: string;
}
interface DepartmentOption {
  id: string;
  code: string;
  name: string;
}
interface ItemOption {
  id: string;
  code: string;
  name: string;
  baseUnit: string;
}
interface LineDraft {
  key: number;
  itemId: string;
  quantity: string;
}

export function NewUsageForm({
  action,
  storeId,
  locations,
  departments,
  items,
  reasons,
  today,
}: {
  action: (fd: FormData) => void | Promise<void>;
  storeId: string;
  locations: readonly LocationOption[];
  departments: readonly DepartmentOption[];
  items: readonly ItemOption[];
  reasons: readonly { value: string; label: string }[];
  today: string;
}) {
  const [kind, setKind] = useState<'usage' | 'wastage'>('usage');
  const [lines, setLines] = useState<LineDraft[]>([{ key: 1, itemId: items[0]?.id ?? '', quantity: '' }]);
  const [nextKey, setNextKey] = useState(2);

  function update(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { key: nextKey, itemId: items[0]?.id ?? '', quantity: '' }]);
    setNextKey((k) => k + 1);
  }
  function removeLine(key: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)));
  }

  const label = 'flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';
  const field =
    'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

  if (items.length === 0) {
    return (
      <p className="mt-3 text-sm text-amber-700 dark:text-amber-500">
        No active items yet — add one under Inventory › Items first.
      </p>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-4">
      <input type="hidden" name="storeId" value={storeId} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={label}>
          Room
          <select name="locationId" required className={field}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Kind
          <select
            name="kind"
            required
            value={kind}
            onChange={(e) => setKind(e.target.value === 'wastage' ? 'wastage' : 'usage')}
            className={field}
          >
            <option value="usage">Usage — consumed</option>
            <option value="wastage">Wastage — spoiled, damaged, lost</option>
          </select>
        </label>
        <label className={label}>
          Used on
          <input name="usedOn" type="date" required defaultValue={today} className={field} />
        </label>
        {kind === 'wastage' && (
          <label className={label}>
            Reason
            <select name="reasonCode" required defaultValue="" className={field}>
              <option value="" disabled>
                Choose a reason
              </option>
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {departments.length > 0 && (
          <label className={label}>
            Department (optional)
            <select name="departmentId" defaultValue="" className={field}>
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Lines</h3>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add line
          </button>
        </div>
        {lines.map((l) => {
          const item = items.find((i) => i.id === l.itemId);
          return (
            <div
              key={l.key}
              className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end dark:border-neutral-800"
            >
              <label className={`${label} col-span-2 sm:col-span-1`}>
                Item
                <select
                  name="itemId"
                  required
                  value={l.itemId}
                  onChange={(e) => update(l.key, { itemId: e.target.value })}
                  className={field}
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </select>
              </label>
              <label className={label}>
                Quantity{item ? ` (${item.baseUnit})` : ''}
                <input
                  name="quantity"
                  required
                  inputMode="decimal"
                  placeholder="0.000"
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                  className={`${field} tabular-nums`}
                />
              </label>
              <button
                type="button"
                onClick={() => removeLine(l.key)}
                disabled={lines.length === 1}
                aria-label="Remove line"
                className="rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="submit"
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Save draft
      </button>
    </form>
  );
}
