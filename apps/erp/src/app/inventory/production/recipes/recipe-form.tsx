import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui';
import type { RecipeItemOption } from './lib';

/** A store the "Made at" boxes offer. */
export interface MadeAtStore {
  readonly id: string;
  readonly name: string;
}

/**
 * The recipe fields, shared by /new and the edit form on /[id] (T-413). The form sends no unit (R1): the domain writes each item's
 * base unit. The label of a saved row names its item's base unit; a blank row says the unit is the one shown beside the item.
 */
export interface FormLine {
  readonly itemId: string;
  readonly quantity: string;
  readonly baseUnit: string | null;
}

export function RecipeFields({
  items,
  name,
  outputItemId,
  outputQuantity,
  outputUnit,
  lines,
  blankRows,
  stores,
  storeIds,
  standardLabourCost,
}: {
  items: readonly RecipeItemOption[];
  name: string;
  outputItemId: string;
  outputQuantity: string;
  outputUnit: string | null;
  lines: readonly FormLine[];
  blankRows: number;
  /** T-650 S2: every store, and the ones this recipe is limited to (empty = every store). */
  stores: readonly MadeAtStore[];
  storeIds: readonly string[];
  /** T-650 S2: labour for one batch ('' = none). A plain box: the server rule INVENTORY_RECIPE_RULES (asserted in the recipe actions) decides. */
  standardLabourCost: string;
}) {
  const rows: FormLine[] = [...lines, ...Array.from({ length: blankRows }, () => ({ itemId: '', quantity: '', baseUnit: null }))];
  return (
    <>
      <FormGrid>
        <Field label="Recipe name" className="text-sm">
          <Input name="name" defaultValue={name} maxLength={80} className="w-full" />
        </Field>
        <Field label="Makes (the item)" className="text-sm">
          <Select name="outputItemId" defaultValue={outputItemId} className="w-full">
            <option value="">— item —</option>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {`${it.name} (${it.baseUnit})`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={outputUnit ? `Output quantity, in ${outputUnit}` : 'Output quantity'} className="text-sm">
          <Input name="outputQuantity" defaultValue={outputQuantity} inputMode="decimal" className="w-full" />
        </Field>
      </FormGrid>
      <FormGrid>
        <Field label="Labour per batch (optional)" className="text-sm" hint="What one batch costs in labour. A cook with its labour box left blank takes this, scaled to how much was made.">
          <Input name="standardLabourCost" defaultValue={standardLabourCost} placeholder="0.00" className="w-full" />
        </Field>
      </FormGrid>
      {stores.length > 0 ? (
        <fieldset>
          <legend className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Made at</legend>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Leave empty to let every store make it.</p>
          <div className="mt-1 flex flex-wrap gap-x-6">
            {stores.map((s) => (
              <Checkbox key={s.id} name="storeId" value={s.id} defaultChecked={storeIds.includes(s.id)} label={s.name} />
            ))}
          </div>
        </fieldset>
      ) : null}
      <div>
        <span className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Ingredients (what goes in)</span>
        <div className="mt-2 space-y-2">
          {rows.map((l, i) => (
            <FormGrid key={i}>
              <Field label={`Ingredient ${i + 1}`} className="text-sm">
                <Select name="lineItemId" defaultValue={l.itemId} className="w-full">
                  <option value="">— item —</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {`${it.name} (${it.baseUnit})`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={l.baseUnit ? `Quantity, in ${l.baseUnit}` : 'Quantity'} className="text-sm">
                <Input name="lineQuantity" defaultValue={l.quantity} inputMode="decimal" className="w-full" />
              </Field>
            </FormGrid>
          ))}
        </div>
      </div>
    </>
  );
}
