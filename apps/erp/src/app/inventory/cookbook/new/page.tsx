import Link from 'next/link';
import { requirePageAccess } from '../../../../lib/page-access';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner, Button, FlashBanner } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { createRecipeAction } from '../../production/recipes/actions';
import { COOKBOOK_PATH, canManageRecipes, recipeItemOptions } from '../../production/recipes/lib';
import { CookbookFields } from '../cookbook-form';

export const metadata = { title: 'New cookbook recipe - Shareat System' };
export const dynamic = 'force-dynamic';

const BLANK_ROWS = 8;

export default async function NewCookbookRecipePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`${COOKBOOK_PATH}/new`);
  if (refusal) return refusal;
  const canManage = await canManageRecipes(actor.orgId, actor);
  const items = canManage ? await recipeItemOptions(actor.orgId) : [];

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">New cookbook recipe</h1>
          <PageDescription className="mt-1">
            A way of cooking a dish we do not stock. Every quantity is in the item&apos;s own unit (kg for a kg item). Nothing is made into stock from it.
          </PageDescription>
        </div>
        <Link href={COOKBOOK_PATH} className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          ← Cookbook
        </Link>
      </div>

      <FlashBanner flash={sp} />

      {canManage ? (
        <form action={createRecipeAction} className="space-y-4">
          <CookbookFields items={items} name="" portions="" method="" lines={[]} blankRows={BLANK_ROWS} />
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      ) : (
        <Banner tone="warning">Only an admin can add a cookbook recipe.</Banner>
      )}
    </Page>
  );
}
