import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { convertUnit, quantity } from '@shareat/domain';
import { requirePageAccess } from '../../../../lib/page-access';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Button, ConfirmDestructive, FlashBanner } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { editRecipeAction, restoreRecipeAction, retireRecipeAction } from '../../production/recipes/actions';
import { COOKBOOK_PATH, RECIPES_PATH, canManageRecipes, fmtQty, recipeDetail, recipeItemOptions, type RecipeItemOption } from '../../production/recipes/lib';
import type { FormLine } from '../../production/recipes/recipe-form';
import { CookbookFields } from '../cookbook-form';

export const metadata = { title: 'Cookbook recipe - Shareat System' };
export const dynamic = 'force-dynamic';

const SPARE_ROWS = 3;

export default async function CookbookRecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`${COOKBOOK_PATH}/${id}`);
  if (refusal) return refusal;
  const recipe = await recipeDetail(actor.orgId, id);
  if (!recipe) notFound();
  // A product recipe lives under "Products we make".
  if (recipe.purpose !== 'kitchen') redirect(`${RECIPES_PATH}/${recipe.id}`);
  const canManage = await canManageRecipes(actor.orgId, actor);

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
    // A saved ingredient that has since been retired is still this recipe's: keep it selectable so saving does not drop it silently.
    const known = new Set(items.map((i) => i.id));
    const extra = recipe.lines.map((l) => ({ id: l.itemId, code: '', name: `${l.itemName} (retired)`, baseUnit: l.baseUnit })).filter((i) => !known.has(i.id));
    items = [...items, ...extra.filter((e, i) => extra.findIndex((x) => x.id === e.id) === i)];
  }
  const retired = recipe.status !== 'active';
  const portions = fmtQty(recipe.outputQuantity);

  return (
    <Page view="detail" sectioned density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{recipe.name}</h1>
          <PageDescription className="mt-1">
            {`Makes ${portions} portion${portions === '1' ? '' : 's'}`} <Badge status={recipe.status} />
          </PageDescription>
        </div>
        <Link href={COOKBOOK_PATH} className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          ← Cookbook
        </Link>
      </div>

      <FlashBanner flash={sp} />

      {canManage && stuck.length > 0 ? (
        <Banner tone="warning">{`This recipe cannot be edited here yet: ${stuck.join('; ')}. Ask for help before changing it.`}</Banner>
      ) : null}

      {canManage && stuck.length === 0 ? (
        <>
          <form action={editRecipeAction} className="space-y-4">
            <input type="hidden" name="recipeId" value={recipe.id} />
            <CookbookFields items={items} name={recipe.name} portions={portions} method={recipe.method ?? ''} lines={formLines} blankRows={SPARE_ROWS} />
            <Button type="submit" variant="primary">
              Save recipe
            </Button>
          </form>
          <StatusForm recipeId={recipe.id} recipeName={recipe.name} retired={retired} />
        </>
      ) : null}

      {canManage && stuck.length > 0 ? <StatusForm recipeId={recipe.id} recipeName={recipe.name} retired={retired} /> : null}

      {!canManage ? (
        <>
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
          <section>
            <h2 className="text-lg font-medium">Method</h2>
            <p className="mt-2 whitespace-pre-line text-sm">{recipe.method ?? 'No method written yet.'}</p>
          </section>
        </>
      ) : null}
    </Page>
  );
}

/** Retire a live recipe, or bring a retired one back. Two literal buttons, one shown. */
function StatusForm({ recipeId, recipeName, retired }: { recipeId: string; recipeName: string; retired: boolean }) {
  return retired ? (
    <form action={restoreRecipeAction}>
      <input type="hidden" name="recipeId" value={recipeId} />
      <input type="hidden" name="purpose" value="kitchen" />
      <Button type="submit" variant="secondary">
        Restore recipe
      </Button>
    </form>
  ) : (
    <form action={retireRecipeAction}>
      <input type="hidden" name="recipeId" value={recipeId} />
      <input type="hidden" name="purpose" value="kitchen" />
      <ConfirmDestructive tier="retype" label="Retire recipe" consequence="Retires this cookbook recipe. A menu item can no longer point at it." expectedName={recipeName} />
    </form>
  );
}
