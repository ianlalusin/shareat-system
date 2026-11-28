import Link from 'next/link';
import { menuRepo } from '@shareat/db';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner, FlashBanner } from '@/components/ui';
import { NAV_LINK } from '@/components/action-link';
import { isUuid, loadItemPage, withOrgPrincipal } from '../lib';
import { ArrangeList, type ArrangeRow } from './ArrangeList';
import { reorderCategoriesAction, reorderItemsAction, reorderOptionValuesAction, reorderVariantsAction } from './actions';

export const metadata = { title: 'Arrange menu - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  category?: string;
  menuItem?: string;
  error?: string;
  ok?: string;
}

/** T-651: arrange the menu once; the POS, the store menu and the prices page all show this order. */
export default async function ArrangeMenuPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/arrange');
  if (refusal) return refusal;
  const orgId = actor.orgId;

  const data = await withOrgPrincipal(orgId, async (tx) => {
    const categories = await menuRepo.orderedRows(tx, { kind: 'categories', orgId });
    const category = categories.find((c) => c.id === sp.category);
    const items = category ? await menuRepo.orderedRows(tx, { kind: 'items', orgId, categoryId: category.id }) : [];
    const item = items.find((i) => i.id === sp.menuItem);
    const variants = item ? await menuRepo.orderedRows(tx, { kind: 'variants', orgId, menuItemId: item.id }) : [];
    const page = item && isUuid(item.id) ? await loadItemPage(tx, actor, item.id) : null;
    const groups = [...new Map((page?.optionGroups ?? []).filter((g) => g.group.status === 'active').map((g) => [g.group.id, g.group.name])).entries()];
    const groupValues = await Promise.all(groups.map(async ([id, name]) => ({ id, name, values: await menuRepo.orderedRows(tx, { kind: 'optionValues', orgId, optionGroupId: id }) })));
    return { categories, category, items, item, variants, groupValues };
  });
  const { categories, category, items, item, variants, groupValues } = data;
  const here = (c?: string, i?: string) => `/menu/arrange${c ? `?category=${c}${i ? `&menuItem=${i}` : ''}` : ''}`;
  const rows = (list: { id: string; label: string }[], href: (id: string) => string, selected?: string): ArrangeRow[] =>
    list.map((r) => ({ id: r.id, label: r.label, href: href(r.id), selected: r.id === selected }));

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Arrange order</h1>
          <PageDescription className="mt-1">
            Put the menu in the order guests and cashiers should see it. Choose a category to arrange its items, then an item to arrange its sizes and options. The
            POS tablets pick up a new order within a few minutes.
          </PageDescription>
        </div>
        <Link href="/menu" className={NAV_LINK}>
          Back to the menu
        </Link>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
        <section className="min-w-0 space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Categories</h2>
          <ArrangeList
            key={`c:${categories.map((c) => c.id).join()}`}
            rows={rows(categories, (id) => here(id), category?.id)}
            action={reorderCategoriesAction}
            hidden={category ? { category: category.id } : {}}
            openLabel="Items"
            noun="category"
          />
        </section>

        {category ? (
          <section className="min-w-0 space-y-3 rounded-[14px] border border-surface-border p-4">
            <h2 className="text-lg font-semibold">{`Items in ${category.label}`}</h2>
            <ArrangeList
              key={`i:${items.map((i) => i.id).join()}`}
              rows={rows(items, (id) => here(category.id, id), item?.id)}
              action={reorderItemsAction}
              hidden={{ categoryId: category.id, ...(item ? { menuItem: item.id } : {}) }}
              openLabel="Sizes and options"
              noun="item"
            />
          </section>
        ) : null}

        {category && item ? (
          <section className="min-w-0 space-y-6 rounded-[14px] border border-surface-border p-4">
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{`Sizes of ${item.label}`}</h2>
              <ArrangeList
                key={`v:${variants.map((v) => v.id).join()}`}
                rows={variants.filter((v) => !v.isDefault).map((v) => ({ id: v.id, label: v.label }))}
                pinned={variants.filter((v) => v.isDefault).map((v) => ({ id: v.id, label: v.label || 'Regular' }))}
                action={reorderVariantsAction}
                hidden={{ menuItemId: item.id, category: category.id }}
                noun="size"
              />
            </div>
            {groupValues.map((g) => (
              <div key={g.id} className="space-y-3">
                <h2 className="text-lg font-semibold">{`Options in ${g.name}`}</h2>
                <ArrangeList
                  key={`o:${g.values.map((v) => v.id).join()}`}
                  rows={g.values.map((v) => ({ id: v.id, label: v.label }))}
                  action={reorderOptionValuesAction}
                  hidden={{ optionGroupId: g.id, category: category.id, menuItem: item.id }}
                  noun="option"
                />
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </Page>
  );
}
