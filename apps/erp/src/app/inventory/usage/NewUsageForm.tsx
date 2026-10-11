'use client';

/**
 * The "New record" form — T-168 / DEF-135. One document for a usage OR a wastage; the kind picked
 * here decides whether the reason field is shown (only meaningful for a wastage, `saveUsageDraft`
 * refuses one carried on a usage). Dynamic item + quantity rows, same shape `NewOrderForm.tsx`
 * (trade orders) and `NewTransferForm.tsx` already use in this codebase — every line the draft
 * starts with is created in ONE submission.
 */
import { useState } from 'react';
import { Banner, Button, Field, FormGrid, Input, Select } from '@/components/ui';

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

  const FULL = 'mt-1 block w-full';
  const FLABEL = 'text-xs text-neutral-600 dark:text-neutral-400';
  const label = 'flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';

  if (items.length === 0) {
    return (
      <Banner tone="warning" className="mt-3">
        No active items yet — add one under Inventory › Items first.
      </Banner>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-4">
      <input type="hidden" name="storeId" value={storeId} />

      <FormGrid>
        <Field label="Room" className={FLABEL}>
          <Select name="locationId" required className={FULL}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kind" className={FLABEL}>
          <Select
            name="kind"
            required
            value={kind}
            onChange={(e) => setKind(e.target.value === 'wastage' ? 'wastage' : 'usage')}
            className={FULL}
          >
            <option value="usage">Usage — consumed</option>
            <option value="wastage">Wastage — spoiled, damaged, lost</option>
          </Select>
        </Field>
        <Field label="Used on" className={FLABEL}>
          <Input name="usedOn" type="date" required defaultValue={today} className={FULL} />
        </Field>
        {kind === 'wastage' && (
          <Field label="Reason" className={FLABEL}>
            <Select name="reasonCode" required defaultValue="" className={FULL}>
              <option value="" disabled>
                Choose a reason
              </option>
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {departments.length > 0 && (
          <Field label="Department (optional)" className={FLABEL}>
            <Select name="departmentId" defaultValue="" className={FULL}>
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </FormGrid>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Lines</h3>
          <Button type="button" variant="secondary" onClick={addLine}>
            + Add line
          </Button>
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
                <Select name="itemId" required value={l.itemId} onChange={(e) => update(l.key, { itemId: e.target.value })}>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </Select>
              </label>
              <label className={label}>
                Quantity{item ? ` (${item.baseUnit})` : ''}
                <Input
                  name="quantity"
                  required
                  inputMode="decimal"
                  placeholder="0.000"
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                  className="tabular-nums"
                />
              </label>
              <Button
                type="button"
                variant="danger"
                onClick={() => removeLine(l.key)}
                disabled={lines.length === 1}
                aria-label="Remove line"
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>

      <Button type="submit" variant="primary">
        Save draft
      </Button>
    </form>
  );
}
