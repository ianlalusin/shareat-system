'use client';

/** The "New transfer" form. From/To exclusivity is `TwoWayPicker`'s job — shared with
 *  money-transfers rather than reimplemented here (see that component's header). */
import { TwoWayPicker, type PickerOption } from '../../../components/two-way-picker';

export function NewTransferForm({
  action,
  orgId,
  storeId,
  locations,
  items,
}: {
  action: (fd: FormData) => void | Promise<void>;
  orgId: string;
  storeId: string;
  locations: readonly PickerOption[];
  items: readonly { id: string; name: string }[];
}) {
  const fieldLabel = 'text-xs text-neutral-600 dark:text-neutral-400';
  const fieldSelect =
    'mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <form action={action} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="storeId" value={storeId} />

      <TwoWayPicker
        options={locations}
        fromName="fromLocationId"
        toName="toLocationId"
        labelClassName={fieldLabel}
        selectClassName={fieldSelect}
      />

      <label className={fieldLabel}>
        Item
        <select name="itemId" required className={fieldSelect}>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label className={fieldLabel}>
        Quantity
        <input
          name="quantity"
          required
          inputMode="decimal"
          placeholder="0.000"
          className={`${fieldSelect} tabular-nums`}
        />
      </label>
      <label className={fieldLabel}>
        Mode
        <select name="mode" className={fieldSelect}>
          <option value="immediate">Transfer now (instant)</option>
          <option value="two_step">Dispatch, then receive later</option>
        </select>
      </label>
      <label className={fieldLabel}>
        Note (optional)
        <input name="note" className={fieldSelect} />
      </label>
      <div className="col-span-full">
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Transfer
        </button>
      </div>
    </form>
  );
}
