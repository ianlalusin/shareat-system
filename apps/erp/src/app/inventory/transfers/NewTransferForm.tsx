'use client';

/** The "New transfer" form. From/To exclusivity is `TwoWayPicker`'s job — shared with
 *  money-transfers rather than reimplemented here (see that component's header). */
import { Button, Field, FormGrid, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { INVENTORY_TRANSFER_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { createTransferAction } from './actions';
import { TwoWayPicker, type PickerOption } from '../../../components/two-way-picker';

export function NewTransferForm({
  storeId,
  locations,
  items,
}: {
  storeId: string;
  locations: readonly PickerOption[];
  items: readonly { id: string; name: string }[];
}) {
  const fieldLabel = 'text-xs text-neutral-600 dark:text-neutral-400';
  const fieldSelect = 'mt-1 block w-full min-h-11 rounded-[10px] border border-field-border bg-field px-2 py-1.5 text-sm';

  return (
    <CheckedForm rules={INVENTORY_TRANSFER_RULES} action={createTransferAction} className="mt-3 space-y-3">
      <input type="hidden" name="storeId" value={storeId} />
      <FormGrid>

      <TwoWayPicker
        options={locations}
        fromName="fromLocationId"
        toName="toLocationId"
        labelClassName={fieldLabel}
        selectClassName={fieldSelect}
      />

      <Field label="Item" className={fieldLabel} rule={INVENTORY_TRANSFER_RULES.itemId}>
        <Select {...nativeAttrs(INVENTORY_TRANSFER_RULES.itemId)} className="mt-1 block w-full">
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Quantity" className={fieldLabel} rule={INVENTORY_TRANSFER_RULES.quantity}>
        <Input {...nativeAttrs(INVENTORY_TRANSFER_RULES.quantity)} placeholder="0.000" className="mt-1 block w-full tabular-nums" />
      </Field>
      <Field label="Mode" className={fieldLabel}>
        <Select name="mode" className="mt-1 block w-full">
          <option value="immediate">Transfer now (instant)</option>
          <option value="two_step">Dispatch, then receive later</option>
        </Select>
      </Field>
      <Field label="Note (optional)" className={fieldLabel}>
        <Input name="note" className="mt-1 block w-full" />
      </Field>
      </FormGrid>
      <Button type="submit" variant="primary">
        Transfer
      </Button>
    </CheckedForm>
  );
}
