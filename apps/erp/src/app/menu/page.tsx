import Link from 'next/link';
import { heldCapabilities } from '@shareat/auth';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { Page, PageHeader } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { NoMatches, SearchBox, SearchCount } from '@/components/SearchBox';
import { clearSearchHref, matchesQuery, readQ } from '@/lib/search';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { MENU_CATEGORY_RULES, MENU_ITEM_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Badge, Banner, Button, ConfirmDestructive, DialogActions, Field, FlashBanner, FormGrid, FormModal, HelpTip, Input, Select } from '@/components/ui';
import { createCategoryAction, createItemAction, editCategoryAction, retireCategoryAction, setNoStockForPackagesAndRefillsAction } from './actions';
import { countPackageRefillVariantsNeedingNoStock, listCategories, listOverviewItems, storesInScope, withOrgPrincipal } from './lib';
import { MENU_CATEGORY } from './typed-forms';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Menu - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  type?: string;
  status?: string;
  filter?: string;
  store?: string;
  q?: string;
}

const TYPE_LABEL: Record<string, string> = { a_la_carte: 'À la carte', package: 'Package', refill: 'Refill' };

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
    const needNoStock = held.has('set_menu_depletion') ? await countPackageRefillVariantsNeedingNoStock(tx, actor.orgId) : 0;
    return { held, stores, storeId, categories, items, needNoStock };
  });
  const { held, stores, storeId, categories, items, needNoStock } = data;
  const canManage = held.has('manage_menu');
  const canAddItem = held.has('add_menu_item');

  // T-651: "Position 3 of 12": where the category stands among the active ones (the arranged order; `listCategories` already sorts).
  const activePosition = new Map(categories.filter((c) => c.status === 'active').map((c, i) => [c.id, i + 1]));
  const activeCategoryCount = activePosition.size;
  const activeCount = new Map<string, number>();
  for (const i of items) if (i.status === 'active') activeCount.set(i.categoryId, (activeCount.get(i.categoryId) ?? 0) + 1);

  const wantStatus = sp.status === 'retired' ? 'retired' : 'active';
  const q = readQ(sp.q);
  const beforeSearch = items.filter(
    (i) =>
      i.status === wantStatus &&
      (!sp.type || i.itemType === sp.type) &&
      (sp.filter !== 'no_rule' || i.missingRule) &&
      (sp.filter !== 'not_offered' || i.offeredAtStore === false),
  );
  // T-645: item name, variant labels, category name. Searches the list the dropdowns left.
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const shown = beforeSearch.filter((i) => matchesQuery(q, i.name, catName.get(i.categoryId), ...i.variantLabels));

  return (
    <Page density="table" className="space-y-6">
      <PageHeader title="Menu" description={<>
            What the stores sell: categories, items and their variants, what each sale uses up from stock, and the options guests can pick.
            Prices are set per store.
          </>} actions={
        <>
          <div className="flex flex-wrap items-center gap-3">
          {/* T-448: the add forms open from header buttons. */}
          {canManage && (
            <FormModal trigger="+ Category" title="Add category" size="sm">
              <CheckedForm rules={MENU_CATEGORY_RULES} action={createCategoryAction} className="space-y-3">
                <FormGrid layout="fields">
                  <Field label="Name" width="name" rule={MENU_CATEGORY_RULES.name}>
                    <Input {...nativeAttrs(MENU_CATEGORY_RULES.name)} />
                  </Field>
                </FormGrid>
                <DialogActions>
                  <Button type="submit" variant="primary">
                    Save
                  </Button>
                </DialogActions>
              </CheckedForm>
            </FormModal>
          )}
          {canAddItem && (
            <FormModal trigger="+ Item" title="Add item" size="md">
              <CheckedForm rules={MENU_ITEM_ADD_RULES} action={createItemAction} className="space-y-3">
                <FormGrid layout="fields">
                  <Field label="Category" width="name" rule={MENU_ITEM_ADD_RULES.categoryId}>
                    <Select {...nativeAttrs(MENU_ITEM_ADD_RULES.categoryId)}>
                      {categories
                        .filter((c) => c.status === 'active')
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="Name" width="name" rule={MENU_ITEM_ADD_RULES.name}>
                    <Input {...nativeAttrs(MENU_ITEM_ADD_RULES.name)} />
                  </Field>
                  <Field label="Type" width="name">
                    <Select name="itemType" defaultValue="a_la_carte">
                      <option value="a_la_carte">À la carte</option>
                      <option value="package">Package</option>
                      <option value="refill">Refill</option>
                    </Select>
                  </Field>
                  <Field label="Description (optional)" width="long">
                    <Input name="description" />
                  </Field>
                </FormGrid>
                <DialogActions>
                  <Button type="submit" variant="primary">
                    Save
                  </Button>
                </DialogActions>
              </CheckedForm>
            </FormModal>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href="/menu/prices" className={NAV_LINK}>
            Prices
          </Link>
          {canManage && (
            <Link href="/menu/arrange" className={NAV_LINK}>
              Arrange order
            </Link>
          )}
          {storeId && (
            <Link href={`/menu/stores/${storeId}`} className={NAV_LINK}>
              What a store sells
            </Link>
          )}
          {held.has('manage_store_settings') && (
            <Link href="/menu/hours" className={NAV_LINK}>
              Menu hours
            </Link>
          )}
          <Link href="/menu/requests" className={NAV_LINK}>
            Request an item
          </Link>
          {(held.has('switch_usage_source') || held.has('manage_pos_map')) && (
            <Link href="/menu/usage-source" className={NAV_LINK}>
              Usage source
            </Link>
          )}
        </div>
        </>
      } />

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {/* T-648: package and refill usage is hand-entered, so a sale of them should take nothing from stock. Only for who may set rules, only when some still do. */}
      {held.has('set_menu_depletion') && needNoStock > 0 && (
        <form action={setNoStockForPackagesAndRefillsAction} className="flex flex-wrap items-center gap-3 rounded-[14px] border border-surface-border p-4 text-sm">
          <p className="min-w-0 flex-1">
            <strong>{needNoStock} package and refill {needNoStock === 1 ? 'variant still uses' : 'variants still use'} stock.</strong> Their usage is entered by hand, so a sale should use no stock.
          </p>
          <ConfirmDestructive
            tier="confirm"
            quiet
            label="Set all to Uses no stock"
            consequence={`Sets ${needNoStock} package and refill ${needNoStock === 1 ? 'variant' : 'variants'} to Uses no stock, from now. A sale of them takes nothing from stock; only the usage you enter counts. You can change any item back on its page.`}
          />
        </form>
      )}

      <FilterRow>
        <SearchBox q={q} placeholder="Item, variant or category…" />
        <label className="text-sm">
          <span className="block text-muted">Type</span>
          <Select name="type" defaultValue={sp.type ?? ''}>
            <option value="">All types</option>
            <option value="a_la_carte">À la carte</option>
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
          <span className="block text-muted">Store (for “Not offered at the store”)</span>
          <Select name="store" defaultValue={storeId ?? ''}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>
      <SearchCount q={q} shown={shown.length} total={beforeSearch.length} />
      {q && shown.length === 0 && (
        <NoMatches q={q} clearHref={clearSearchHref('/menu', { type: sp.type, status: sp.status, filter: sp.filter, store: sp.store })} />
      )}

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
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
                  {`Position ${activePosition.get(c.id)} of ${activeCategoryCount} ·`}
                  <Link href={`/menu/arrange?category=${c.id}`} className={NAV_LINK}>
                    Arrange order
                  </Link>
                </p>
                <div className="flex items-center gap-1 text-xs text-muted">
                  Retiring a category
                  <HelpTip label="Retiring a category">
                    Retiring a category hides it, and every item in it, from every store menu. It is refused while the category still holds active items.
                  </HelpTip>
                </div>
                <EditableRecord action={editCategoryAction} rules={MENU_CATEGORY_RULES} label={c.name} summary={[{ label: 'Name', value: c.name }]} hidden={{ id: c.id }} typed={typedFor(sp, MENU_CATEGORY, c.id, actor.personId)}>
                  <FormGrid layout="fields">
                    <Field label="Name" width="name" rule={MENU_CATEGORY_RULES.name}>
                      <Input {...nativeAttrs(MENU_CATEGORY_RULES.name)} defaultValue={c.name} />
                    </Field>
                  </FormGrid>
                </EditableRecord>
              </>
            )}

            {inCategory.length === 0 ? (
              <p className="text-sm text-muted">{q ? 'No items here match the search.' : 'No items to show here.'}</p>
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
    </Page>
  );
}
