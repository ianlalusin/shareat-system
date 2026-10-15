import Link from 'next/link';
import { notFound } from 'next/navigation';
import { convertUnit, quantity } from '@shareat/domain';
import { requireSession } from '../../../../../lib/session';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Button, FlashBanner } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { editRecipeAction, restoreRecipeAction, retireRecipeAction } from '../actions';
import { RECIPES_PATH, canManageRecipes, fmtQty, recipeDetail, recipeItemOptions, type RecipeItemOption } from '../lib';
import { RecipeFields, type FormLine } from '../recipe-form';

export const metadata = { title: 'Recipe - Shareat System' };
export const dynamic = 'force-dynamic';

const SPARE_ROWS = 3;

export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`${RECIPES_PATH}/${id}`);
  const recipe = await recipeDetail(actor.orgId, id);
  if (!recipe) notFound();
  const canManage = await canManageRecipes(actor.orgId, actor);

  // A saved line in another unit is shown converted to the item's base unit; one that cannot be converted is not opened in words.
  const formLines: FormLine[] = [];
  const stuck: string[] = [];
  for (const l of recipe.lines) {
    const q = convertUnit(quantity(l.quantity), l.unit, l.baseUnit);
    if (q === null) {
      stuck.push(`${l.itemName} is saved in ${l.unit}, which cannot be turned into ${l.baseUnit}`);
      continue;
    }
    formLines.push({ itemId: l.itemId, quantity: fmtQty(q), baseUnit: l.baseUnit });
  }

  let items: RecipeItemOption[] = [];
  if (canManage) {
    items = await recipeItemOptions(actor.orgId);
    // A saved item that has since been retired is still this recipe's item: keep it selectable so saving does not drop it silently.
    const known = new Set(items.map((i) => i.id));
    const extra = [
      { id: recipe.outputItemId, code: '', name: `${recipe.outputName} (retired)`, baseUnit: recipe.outputUnit },
      ...recipe.lines.map((l) => ({ id: l.itemId, code: '', name: `${l.itemName} (retired)`, baseUnit: l.baseUnit })),
    ].filter((i) => !known.has(i.id));
    items = [...items, ...extra.filter((e, i) => extra.findIndex((x) => x.id === e.id) === i)];
  }
  const retired = recipe.status !== 'active';

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{recipe.name}</h1>
          <PageDescription className="mt-1">
            {`Makes ${fmtQty(recipe.outputQuantity)} ${recipe.outputUnit} of ${recipe.outputName}`} <Badge status={recipe.status} />
          </PageDescription>
        </div>
        <Link href={RECIPES_PATH} className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          ← Recipes
        </Link>
      </div>

      <FlashBanner flash={sp} />

      {canManage && stuck.length > 0 ? (
        <Banner tone="warning">
          {`This recipe cannot be edited here yet: ${stuck.join('; ')}. Ask for help before changing it.`}
        </Banner>
      ) : null}

      {canManage && stuck.length === 0 ? (
        <>
          <form action={editRecipeAction} className="space-y-4">
            <input type="hidden" name="recipeId" value={recipe.id} />
            <RecipeFields
              items={items}
              name={recipe.name}
              outputItemId={recipe.outputItemId}
              outputQuantity={fmtQty(recipe.outputQuantity)}
              outputUnit={recipe.outputUnit}
              lines={formLines}
              blankRows={SPARE_ROWS}
            />
            <Button type="submit" variant="primary">
              Save recipe
            </Button>
          </form>
          <StatusForm recipeId={recipe.id} retired={retired} />
        </>
      ) : null}

      {canManage && stuck.length > 0 ? (
        <StatusForm recipeId={recipe.id} retired={retired} />
      ) : null}

      {!canManage ? (
        <section>
          <h2 className="text-lg font-medium">Ingredients</h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[320px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Ingredient</th>
                  <th className="px-3 py-2 font-medium">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {recipe.lines.map((l) => (
                  <tr key={l.itemId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">{l.itemName}</td>
                    <td className="px-3 py-2">{`${fmtQty(l.quantity)} ${l.unit}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Page>
  );
}

/** Retire a live recipe, or bring a retired one back. Two literal buttons, one shown. */
function StatusForm({ recipeId, retired }: { recipeId: string; retired: boolean }) {
  return retired ? (
    <form action={restoreRecipeAction}>
      <input type="hidden" name="recipeId" value={recipeId} />
      <Button type="submit" variant="secondary">
        Restore recipe
      </Button>
    </form>
  ) : (
    <form action={retireRecipeAction}>
      <input type="hidden" name="recipeId" value={recipeId} />
      <Button type="submit" variant="danger">
        Retire recipe
      </Button>
    </form>
  );
}
