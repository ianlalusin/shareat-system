import Link from 'next/link';
import { requirePageAccess } from '../../../lib/page-access';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, FlashBanner, LinkRow, RowLink } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { COOKBOOK_PATH, RECIPES_PATH, canManageRecipes, fmtQty, recipeList } from '../production/recipes/lib';

export const metadata = { title: 'Cookbook - Shareat System' };
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

/** T-650 S3: how to cook the dishes we do not stock (fishcake and the like). Every store reads it; an admin writes it. */
export default async function CookbookPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(COOKBOOK_PATH);
  if (refusal) return refusal;
  const status = sp.status === 'retired' || sp.status === 'all' ? sp.status : 'active';
  const [rows, canManage] = await Promise.all([recipeList(actor.orgId, status, 'kitchen'), canManageRecipes(actor.orgId, actor)]);

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Cookbook</h1>
          <PageDescription className="mt-1">
            How to cook the dishes we serve but do not stock, like the fishcake: ingredients and method. Every store can read it. A sale of the dish takes its ingredients out of stock when the menu item points at its recipe. Only an admin changes a recipe.
          </PageDescription>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {canManage && (
            <Link href="/inventory/cookbook/new" className="inline-flex min-h-11 items-center rounded-[12px] bg-brand px-4 py-2.5 font-semibold text-white">
              New cookbook recipe
            </Link>
          )}
          <Link href={RECIPES_PATH} className="inline-flex min-h-11 items-center underline underline-offset-4">
            Products we make
          </Link>
        </div>
      </div>

      <FlashBanner flash={sp} />

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Show cookbook recipes">
        {FILTERS.map(([key, label]) => (
          <Link
            key={key}
            href={`${COOKBOOK_PATH}?status=${key}`}
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
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No cookbook recipes to show here.</p>
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
                    <RowLink href={`${COOKBOOK_PATH}/${r.id}`}>{r.name}</RowLink>
                  </td>
                  <td className="px-3 py-2">{`${fmtQty(r.outputQuantity)} portion${fmtQty(r.outputQuantity) === '1' ? '' : 's'}`}</td>
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
