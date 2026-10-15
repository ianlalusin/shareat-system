import { Field, FormGrid, Input, Select } from '@/components/ui';
import type { RecipeItemOption } from './lib';

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
}: {
  items: readonly RecipeItemOption[];
  name: string;
  outputItemId: string;
  outputQuantity: string;
  outputUnit: string | null;
  lines: readonly FormLine[];
  blankRows: number;
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
        <Field label={outputUnit ? `Output quantity, in ${outputUnit}` : "Output quantity, in the item's unit shown above"} className="text-sm">
          <Input name="outputQuantity" defaultValue={outputQuantity} inputMode="decimal" className="w-full" />
        </Field>
      </FormGrid>
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
              <Field label={l.baseUnit ? `Quantity, in ${l.baseUnit}` : 'Quantity, in the unit shown beside the item'} className="text-sm">
                <Input name="lineQuantity" defaultValue={l.quantity} inputMode="decimal" className="w-full" />
              </Field>
            </FormGrid>
          ))}
        </div>
      </div>
    </>
  );
}
