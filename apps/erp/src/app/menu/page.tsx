import Link from 'next/link';
import { heldCapabilities } from '@shareat/auth';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { EditableRecord } from '@/components/forms';
import { Badge, Banner, Button, ConfirmDestructive, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { createCategoryAction, createItemAction, editCategoryAction, retireCategoryAction } from './actions';
import { listCategories, listOverviewItems, storesInScope, withOrgPrincipal } from './lib';
import { MENU_CATEGORY } from './typed-forms';

export const metadata = { title: 'Menu - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  type?: string;
  status?: string;
  filter?: string;
  store?: string;
}

const TYPE_LABEL: Record<string, string> = { a_la_carte: 'A la carte', package: 'Package', refill: 'Refill' };

export default async function MenuPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu');
  if (refusal) return refusal;

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    const stores = await storesInScope(tx, actor);
    const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : (stores[0]?.id ?? null);
    const categories = await listCategories(tx, actor.orgId);
    const items = await listOverviewItems(tx, actor.orgId, sp.filter === 'not_offered' ? storeId : null);
    return { held, stores, storeId, categories, items };
  });
  const { held, stores, storeId, categories, items } = data;
  const canManage = held.has('manage_menu');
  const canAddItem = held.has('add_menu_item');

  const activeCount = new Map<string, number>();
  for (const i of items) if (i.status === 'active') activeCount.set(i.categoryId, (activeCount.get(i.categoryId) ?? 0) + 1);

  const wantStatus = sp.status === 'retired' ? 'retired' : 'active';
  const shown = items.filter(
    (i) =>
      i.status === wantStatus &&
      (!sp.type || i.itemType === sp.type) &&
      (sp.filter !== 'no_rule' || i.missingRule) &&
      (sp.filter !== 'not_offered' || i.offeredAtStore === false),
  );

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Menu</h1>
          <PageDescription className="mt-1">
            What the stores sell: categories, items and their variants, what each sale uses up from stock, and the options guests can pick.
            Prices are set per store.
          </PageDescription>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href="/menu/prices" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Prices
          </Link>
          <Link href="/menu/requests" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Request an item
          </Link>
          {(held.has('switch_usage_source') || held.has('manage_pos_map')) && (
            <Link href="/menu/usage-source" className="inline-flex min-h-6 items-center underline underline-offset-4">
              Usage source
            </Link>
          )}
        </div>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      <FilterRow>
        <label className="text-sm">
          <span className="block text-muted">Type</span>
          <Select name="type" defaultValue={sp.type ?? ''}>
            <option value="">All types</option>
            <option value="a_la_carte">A la carte</option>
            <option value="package">Package</option>
            <option value="refill">Refill</option>
          </Select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Status</span>
          <Select name="status" defaultValue={wantStatus}>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </Select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Only</span>
          <Select name="filter" defaultValue={sp.filter ?? ''}>
            <option value="">Everything</option>
            <option value="no_rule">Missing a stock rule</option>
            <option value="not_offered">Not offered at the store</option>
          </Select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Store (for not offered)</span>
          <Select name="store" defaultValue={storeId ?? ''}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {categories.length === 0 && <p className="text-sm text-muted">There are no categories yet.</p>}

      {categories.map((c) => {
        const inCategory = shown.filter((i) => i.categoryId === c.id);
        const holds = activeCount.get(c.id) ?? 0;
        return (
          <section key={c.id} className="space-y-3 rounded-[14px] border border-surface-border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">{c.name}</h2>
              {c.status === 'retired' && <Badge status="retired" />}
              {c.status === 'active' && holds > 0 && <span className="text-sm text-muted">{`Holds ${holds} active ${holds === 1 ? 'item' : 'items'}`}</span>}
              {canManage && c.status === 'active' && (
                <form action={retireCategoryAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <ConfirmDestructive
                    tier="retype"
                    label="Retire category"
                    consequence="Retires this category."
                    expectedName={c.name}
                  />
                </form>
              )}
            </div>
            {canManage && c.status === 'active' && (
              <>
                <p className="text-xs text-muted">
                  Retiring a category hides it, and every item in it, from every store menu. It is refused while the category still holds active items.
                </p>
                <EditableRecord action={editCategoryAction} label={c.name} hidden={{ id: c.id }} typed={typedFor(sp, MENU_CATEGORY, c.id, actor.personId)}>
                  <FormGrid>
                    <Field label="Name" className="text-sm">
                      <Input name="name" defaultValue={c.name} required className="w-full" />
                    </Field>
                    <Field label="Sort order" className="text-sm">
                      <Input name="sortOrder" inputMode="numeric" defaultValue={String(c.sortOrder)} className="w-full" />
                    </Field>
                  </FormGrid>
                </EditableRecord>
              </>
            )}

            {inCategory.length === 0 ? (
              <p className="text-sm text-muted">No items to show here.</p>
            ) : (
              <ul className="divide-y divide-surface-border">
                {inCategory.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <Link href={`/menu/items/${i.id}`} className="inline-flex min-h-6 items-center font-medium underline underline-offset-4">
                      {i.name}
                    </Link>
                    <span className="text-muted">{TYPE_LABEL[i.itemType] ?? i.itemType}</span>
                    {i.missingRule && <Badge tone="warning" label="No stock rule" />}
                    {i.status === 'retired' && <Badge status="retired" />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {canManage && (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Add category</h2>
          <form action={createCategoryAction} className="space-y-3">
            <FormGrid>
              <Field label="Name" className="text-sm">
                <Input name="name" required className="w-full" />
              </Field>
              <Field label="Sort order (optional)" className="text-sm">
                <Input name="sortOrder" inputMode="numeric" className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </form>
        </section>
      )}

      {canAddItem && (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Add item</h2>
          <form action={createItemAction} className="space-y-3">
            <FormGrid>
              <Field label="Category" className="text-sm">
                <Select name="categoryId" required className="w-full">
                  {categories
                    .filter((c) => c.status === 'active')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Name" className="text-sm">
                <Input name="name" required className="w-full" />
              </Field>
              <Field label="Type" className="text-sm">
                <Select name="itemType" defaultValue="a_la_carte" className="w-full">
                  <option value="a_la_carte">A la carte</option>
                  <option value="package">Package</option>
                  <option value="refill">Refill</option>
                </Select>
              </Field>
              <Field label="Description (optional)" className="text-sm">
                <Input name="description" className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </form>
        </section>
      )}
    </Page>
  );
}
