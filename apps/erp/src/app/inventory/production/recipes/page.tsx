import Link from 'next/link';
import { requireSession } from '../../../../lib/session';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, FlashBanner, LinkRow, RowLink } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { RECIPES_PATH, canManageRecipes, fmtQty, recipeList } from './lib';

export const metadata = { title: 'Recipes - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  status?: string;
  error?: string;
  ok?: string;
}

const FILTERS = [
  ['active', 'Active'],
  ['retired', 'Retired'],
  ['all', 'All'],
] as const;

export default async function RecipesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(RECIPES_PATH);
  const status = sp.status === 'retired' || sp.status === 'all' ? sp.status : 'active';
  const [rows, canManage] = await Promise.all([recipeList(actor.orgId, status), canManageRecipes(actor.orgId, actor)]);

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Recipes</h1>
          <PageDescription className="mt-1">
            The batch recipes the business cooks from. A cook works out its ingredients from the recipe. Only an admin changes a recipe.
          </PageDescription>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {canManage && (
            <Link href="/inventory/production/recipes/new" className="inline-flex min-h-11 items-center rounded-[12px] bg-brand px-4 py-2.5 font-semibold text-white">
              New recipe
            </Link>
          )}
          <Link href="/inventory/production" className="inline-flex min-h-11 items-center underline underline-offset-4">
            ← Production
          </Link>
        </div>
      </div>

      <FlashBanner flash={sp} />

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Show recipes">
        {FILTERS.map(([key, label]) => (
          <Link
            key={key}
            href={`${RECIPES_PATH}?status=${key}`}
            aria-current={key === status ? 'page' : undefined}
            className={
              key === status
                ? 'inline-flex min-h-11 items-center rounded-md border border-neutral-900 px-3 py-1 font-medium dark:border-neutral-100'
                : 'inline-flex min-h-11 items-center rounded-md border border-neutral-200 px-3 py-1 underline-offset-4 hover:underline dark:border-neutral-800'
            }
          >
            {label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No recipes to show here.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Recipe</th>
                <th className="px-3 py-2 font-medium">Makes</th>
                <th className="px-3 py-2 font-medium">Ingredients</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LinkRow key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2">
                    <RowLink href={`${RECIPES_PATH}/${r.id}`}>
                      {r.name}
                    </RowLink>
                  </td>
                  <td className="px-3 py-2">{`Makes ${fmtQty(r.outputQuantity)} ${r.outputUnit} of ${r.outputName}`}</td>
                  <td className="px-3 py-2">{`${r.ingredientCount} ingredient${r.ingredientCount === 1 ? '' : 's'}`}</td>
                  <td className="px-3 py-2">
                    <Badge status={r.status} />
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
