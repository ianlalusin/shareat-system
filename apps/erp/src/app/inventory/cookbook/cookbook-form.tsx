import { Field, FormGrid, Input, Textarea } from '@/components/ui';
import { IngredientRows, type FormLine } from '../production/recipes/recipe-form';
import type { RecipeItemOption } from '../production/recipes/lib';

/**
 * The cookbook recipe fields (T-650 S3): a name, how many portions it makes, the ingredients and the method. A kitchen recipe makes no stock item,
 * so there is no "Makes (the item)", no labour per batch and no "Made at": every store reads it. The ingredient rows are the product recipe's own.
 * Plain boxes: the server rules in `recipe-shape.ts` (and the 4000-character method cap) decide, in words.
 */
export function CookbookFields({
  items,
  name,
  portions,
  method,
  lines,
  blankRows,
}: {
  items: readonly RecipeItemOption[];
  name: string;
  portions: string;
  method: string;
  lines: readonly FormLine[];
  blankRows: number;
}) {
  return (
    <>
      <input type="hidden" name="purpose" value="kitchen" />
      <FormGrid>
        <Field label="Recipe name" className="text-sm">
          <Input name="name" defaultValue={name} className="w-full" />
        </Field>
        <Field label="Makes (portions)" className="text-sm" hint="How many servings one batch of this recipe makes. The ingredients below are for that many.">
          <Input name="outputQuantity" defaultValue={portions} className="w-full" />
        </Field>
      </FormGrid>
      <IngredientRows items={items} lines={lines} blankRows={blankRows} />
      <Field label="Method" className="text-sm" hint="The steps, in your own words. Up to 4,000 characters.">
        <Textarea name="method" defaultValue={method} rows={8} className="w-full" />
      </Field>
    </>
  );
}
