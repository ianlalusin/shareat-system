'use client';

/**
 * The "New delivery" form — T-166 / DEF-135. One document for a supplier delivery or a cash
 * purchase; the kind picked here decides whether the supplier select is required (`purchase` must
 * still submit with none — a cash buy may genuinely have no registered vendor). Dynamic item rows,
 * same shape `NewOrderForm.tsx` (trade orders) and `NewUsageForm.tsx` (usage/wastage) already use
 * in this codebase.
 *
 * ⭐ The photo input is a plain `<input type="file">` inside a server-action `<form>` — Next.js
 * form actions carry `File` values in the `FormData` they submit, the same way `ap/page.tsx`'s
 * invoice form already does.
 */
import { useState } from 'react';

interface ItemOption {
  id: string;
  code: string;
  name: string;
  baseUnit: string;
}
interface SupplierOption {
  id: string;
  name: string;
}
interface LocationOption {
  id: string;
  name: string;
}
interface LineDraft {
  key: number;
  itemId: string;
  orderedQuantity: string;
  purchaseUnit: string;
  conversionFactor: string;
  unitCost: string;
  locationId: string;
}

export function NewDeliveryForm({
  action,
  storeId,
  suppliers,
  items,
  locations,
  today,
}: {
  action: (fd: FormData) => void | Promise<void>;
  storeId: string;
  suppliers: readonly SupplierOption[];
  items: readonly ItemOption[];
  locations: readonly LocationOption[];
  today: string;
}) {
  const [kind, setKind] = useState<'supplier' | 'purchase'>('supplier');
  const firstItem = items[0];
  const [lines, setLines] = useState<LineDraft[]>([
    {
      key: 1,
      itemId: firstItem?.id ?? '',
      orderedQuantity: '',
      purchaseUnit: firstItem?.baseUnit ?? '',
      conversionFactor: '1',
      unitCost: '',
      locationId: '',
    },
  ]);
  const [nextKey, setNextKey] = useState(2);

  function update(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [
      ...prev,
      {
        key: nextKey,
        itemId: firstItem?.id ?? '',
        orderedQuantity: '',
        purchaseUnit: firstItem?.baseUnit ?? '',
        conversionFactor: '1',
        unitCost: '',
        locationId: '',
      },
    ]);
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
        No purchasable items yet — mark one purchasable under Items first.
      </p>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-4">
      <input type="hidden" name="storeId" value={storeId} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={label}>
          Kind
          <select
            name="kind"
            required
            value={kind}
            onChange={(e) => setKind(e.target.value === 'purchase' ? 'purchase' : 'supplier')}
            className={field}
          >
            <option value="supplier">Supplier delivery</option>
            <option value="purchase">Cash purchase</option>
          </select>
        </label>
        {kind === 'supplier' ? (
          <label className={label}>
            Supplier
            <select name="supplierId" required defaultValue="" className={field}>
              <option value="" disabled>
                Choose…
              </option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={label}>
            Supplier (optional)
            <select name="supplierId" defaultValue="" className={field}>
              <option value="">— none, cash purchase —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={label}>
          Reference no. (DR/invoice)
          <input name="referenceNo" placeholder="DR-0001" className={field} />
        </label>
        <label className={label}>
          Delivered on
          <input name="deliveredOn" type="date" required defaultValue={today} className={field} />
        </label>
      </div>

      <label className={label}>
        Photo of the paper
        <input
          type="file"
          name="proofPhoto"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          required
          className={field}
        />
      </label>
      <p className="text-xs text-neutral-500 dark:text-neutral-500">
        ⭐ Required — a real anti-fraud control, not a nicety. Upload the actual photo of the
        delivery receipt or invoice; a link or a typed reference is not evidence.
      </p>

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
        {lines.map((l) => (
          <div
            key={l.key}
            className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-3 lg:grid-cols-7 lg:items-end dark:border-neutral-800"
          >
            <label className={`${label} col-span-2 lg:col-span-2`}>
              Item
              <select
                name="itemId"
                required
                value={l.itemId}
                onChange={(e) => {
                  const item = items.find((i) => i.id === e.target.value);
                  // Only fills the purchase-unit default when it still matches the OLD item's base
                  // unit or is empty — never clobbers a value someone already typed.
                  const shouldDefaultUnit = !l.purchaseUnit || items.some((i) => i.baseUnit === l.purchaseUnit);
                  update(l.key, {
                    itemId: e.target.value,
                    purchaseUnit: shouldDefaultUnit ? (item?.baseUnit ?? l.purchaseUnit) : l.purchaseUnit,
                  });
                }}
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
              Quantity
              <input
                name="orderedQuantity"
                required
                inputMode="decimal"
                placeholder="0.000"
                value={l.orderedQuantity}
                onChange={(e) => update(l.key, { orderedQuantity: e.target.value })}
                className={`${field} tabular-nums`}
              />
            </label>
            <label className={label}>
              Purchase unit
              <input
                name="purchaseUnit"
                required
                value={l.purchaseUnit}
                onChange={(e) => update(l.key, { purchaseUnit: e.target.value })}
                className={field}
              />
            </label>
            <label className={label}>
              Conversion (÷ base)
              <input
                name="conversionFactor"
                required
                inputMode="decimal"
                value={l.conversionFactor}
                onChange={(e) => update(l.key, { conversionFactor: e.target.value })}
                className={`${field} tabular-nums`}
              />
            </label>
            <label className={label}>
              Unit cost ₱
              <input
                name="unitCost"
                required
                inputMode="decimal"
                placeholder="0.0000"
                value={l.unitCost}
                onChange={(e) => update(l.key, { unitCost: e.target.value })}
                className={`${field} tabular-nums`}
              />
            </label>
            <label className={label}>
              Room (blank = Receiving)
              <select
                name="locationId"
                value={l.locationId}
                onChange={(e) => update(l.key, { locationId: e.target.value })}
                className={field}
              >
                <option value="">— park in Receiving —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
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
        ))}
      </div>

      <button
        type="submit"
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Save delivery
      </button>
    </form>
  );
}
