import { FormDisclosure } from '@/components/forms/FormDisclosure';
import Link from 'next/link';
import { requireSession } from '../../../../../lib/session';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner, Button, FlashBanner } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { createRecipeAction } from '../actions';
import { RECIPES_PATH, canManageRecipes, recipeItemOptions } from '../lib';
import { RecipeFields } from '../recipe-form';

export const metadata = { title: 'New recipe - Shareat System' };
export const dynamic = 'force-dynamic';

const BLANK_ROWS = 8;

export default async function NewRecipePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`${RECIPES_PATH}/new`);
  const canManage = await canManageRecipes(actor.orgId, actor);
  const items = canManage ? await recipeItemOptions(actor.orgId) : [];

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">New recipe</h1>
          <PageDescription className="mt-1">
            Every quantity is in the item&apos;s own unit (kg for a kg item). The most one quantity can be is 10,000.
          </PageDescription>
        </div>
        <Link href={RECIPES_PATH} className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          ← Recipes
        </Link>
      </div>

      <FlashBanner flash={sp} />

      {canManage ? (
        <FormDisclosure><form action={createRecipeAction} className="space-y-4">
          <RecipeFields items={items} name="" outputItemId="" outputQuantity="" outputUnit={null} lines={[]} blankRows={BLANK_ROWS} />
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form></FormDisclosure>
      ) : (
        <Banner tone="warning">Only an admin can add a recipe.</Banner>
      )}
    </Page>
  );
}
