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
import { PhotoInput } from '@/components/PhotoInput';
import { useState } from 'react';
import { Button, FormGrid, Field, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { INVENTORY_DELIVERY_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { createDeliveryAction } from './actions';

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
  storeId,
  suppliers,
  items,
  locations,
  today,
}: {
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

  const FULL = 'mt-1 block w-full';
  const FLABEL = 'text-xs text-neutral-600 dark:text-neutral-400';
  const label = 'flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';
  const photo = 'rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm';

  if (items.length === 0) {
    return (
      <p className="mt-3 text-sm text-warning-ink">
        No purchasable items yet — mark one purchasable under Items first.
      </p>
    );
  }

  return (
    <CheckedForm rules={INVENTORY_DELIVERY_RULES} action={createDeliveryAction} className="mt-3 space-y-4">
      <input type="hidden" name="storeId" value={storeId} />

      <FormGrid>
        <Field label="Kind" className={FLABEL} rule={INVENTORY_DELIVERY_RULES.kind}>
          <Select
            {...nativeAttrs(INVENTORY_DELIVERY_RULES.kind)}
            value={kind}
            onChange={(e) => setKind(e.target.value === 'purchase' ? 'purchase' : 'supplier')}
            className={FULL}
          >
            <option value="supplier">Supplier delivery</option>
            <option value="purchase">Cash purchase</option>
          </Select>
        </Field>
        {kind === 'supplier' ? (
          <Field label="Supplier" className={FLABEL} rule={INVENTORY_DELIVERY_RULES.supplierId}>
            <Select {...nativeAttrs(INVENTORY_DELIVERY_RULES.supplierId)} required defaultValue="" className={FULL}>
              <option value="" disabled>
                Choose…
              </option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Supplier (optional)" className={FLABEL} rule={INVENTORY_DELIVERY_RULES.supplierId}>
            <Select {...nativeAttrs(INVENTORY_DELIVERY_RULES.supplierId)} defaultValue="" className={FULL}>
              <option value="">— none, cash purchase —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Reference no. (DR/invoice)" className={FLABEL}>
          <Input name="referenceNo" placeholder="DR-0001" className={FULL} />
        </Field>
        <Field label="Delivered on" className={FLABEL} rule={INVENTORY_DELIVERY_RULES.deliveredOn}>
          <Input {...nativeAttrs(INVENTORY_DELIVERY_RULES.deliveredOn)} type="date" defaultValue={today} className={FULL} />
        </Field>
        <Field label="Photo of the paper" span="full" className={FLABEL}>
          {/* ⭐ T-296 — compressed to under 1 MB before submit; a PDF passes through untouched. */}
          <PhotoInput
            name="proofPhoto"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            required
            className={`${photo} ${FULL}`}
          />
        </Field>
      </FormGrid>
      <p className="text-xs text-neutral-500 dark:text-neutral-500">
        ⭐ Required — a real anti-fraud control, not a nicety. Upload the actual photo of the
        delivery receipt or invoice; a link or a typed reference is not evidence.
      </p>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Lines</h3>
          <Button type="button" variant="secondary" onClick={addLine} className="text-xs">
            + Add line
          </Button>
        </div>
        {lines.map((l) => (
          <div
            key={l.key}
            className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-3 lg:grid-cols-7 lg:items-end dark:border-neutral-800"
          >
            <label className={`${label} col-span-2 lg:col-span-2`}>
              Item
              <Select
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
              >
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.baseUnit})
                  </option>
                ))}
              </Select>
            </label>
            <label className={label}>
              Quantity
              <Input
                name="orderedQuantity"
                required
                inputMode="decimal"
                placeholder="0.000"
                value={l.orderedQuantity}
                onChange={(e) => update(l.key, { orderedQuantity: e.target.value })}
                className="tabular-nums"
              />
            </label>
            <label className={label}>
              Purchase unit
              <Input
                name="purchaseUnit"
                required
                value={l.purchaseUnit}
                onChange={(e) => update(l.key, { purchaseUnit: e.target.value })}
              />
            </label>
            <label className={label}>
              Conversion (÷ base)
              <Input
                name="conversionFactor"
                required
                inputMode="decimal"
                value={l.conversionFactor}
                onChange={(e) => update(l.key, { conversionFactor: e.target.value })}
                className="tabular-nums"
              />
            </label>
            <label className={label}>
              Unit cost ₱
              <Input
                name="unitCost"
                required
                inputMode="decimal"
                placeholder="0.0000"
                value={l.unitCost}
                onChange={(e) => update(l.key, { unitCost: e.target.value })}
                className="tabular-nums"
              />
            </label>
            <label className={label}>
              Room (blank = Receiving)
              <Select
                name="locationId"
                value={l.locationId}
                onChange={(e) => update(l.key, { locationId: e.target.value })}
              >
                <option value="">— park in Receiving —</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              type="button"
              variant="danger"
              onClick={() => removeLine(l.key)}
              disabled={lines.length === 1}
              aria-label="Remove line"
              className="text-xs"
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      <Button type="submit" variant="primary">
        Save
      </Button>
    </CheckedForm>
  );
}
