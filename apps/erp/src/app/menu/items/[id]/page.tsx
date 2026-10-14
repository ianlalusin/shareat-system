import Link from 'next/link';
import { notFound } from 'next/navigation';
import { heldCapabilities } from '@shareat/auth';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash, type FlashFields } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { EditableRecord } from '@/components/forms';
import { Badge, Banner, Button, Checkbox, Field, FlashBanner, FormGrid, Input, Select, Table, Td, Textarea, Th } from '@/components/ui';
import {
  addOptionValueAction,
  addVariantAction,
  createOptionGroupAction,
  editItemAction,
  editOptionGroupAction,
  editOptionValueAction,
  linkOptionGroupAction,
  setDepletionRuleAction,
  setPackageRefillsAction,
  unlinkOptionGroupAction,
} from './actions';
import { MENU_ITEM, MENU_OPTION_GROUP, MENU_OPTION_VALUE } from './typed-forms';
import { listActiveRecipes, listActiveStockItems, loadItemPage, withOrgPrincipal, type ItemPageData, type OfferHistoryRow, type OptionGroupView } from '../../lib';

export const metadata = { title: 'Menu item - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

const TYPE_LABEL: Record<string, string> = { a_la_carte: 'A la carte', package: 'Package', refill: 'Refill' };
const MODE_LABEL: Record<string, string> = { direct: 'Uses a stock item', recipe: 'Uses a recipe', no_stock: 'Uses no stock' };
const CHANNEL_LABEL: Record<string, string> = { store: 'Store', online: 'Online' };
const STATE_LABEL: Record<OfferHistoryRow['state'], string> = { in_force: 'In force', scheduled: 'Scheduled', replaced: 'Replaced' };

/** A percent figure without its trailing zeros: 7.5000 reads 7.5. */
const plainPercent = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const signed = (v: string): string => (v.startsWith('-') ? v : `+${v}`);

function priceText(r: OfferHistoryRow): string {
  if (r.withdrawn) return 'Withdrawn';
  if (r.pricingMode === 'percent_markup') return `Store price ${signed(plainPercent(r.markupPercent ?? '0'))}%`;
  if (r.pricingMode === 'fixed_markup') return `Store price ${signed(r.fixedMarkupAmount ?? '0.00')}`;
  if (r.amount === null) return 'Offered (no price)';
  if (r.bundleHeads !== null) return `${r.amount} for ${r.bundleHeads} guests, ${r.extraHeadAmount ?? '0.00'} each extra`;
  return r.amount;
}

export default async function MenuItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/menu/items/${id}`);
  if (refusal) return refusal;

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    const data = await loadItemPage(tx, actor, id);
    if (!data) return null;
    const held = await heldCapabilities(tx, actor);
    const canRule = held.has('set_menu_depletion');
    const stockItems = canRule ? await listActiveStockItems(tx, actor.orgId) : [];
    const recipes = canRule ? await listActiveRecipes(tx, actor.orgId) : [];
    return { data, held, stockItems, recipes };
  });
  if (!loaded) notFound();
  const { data, held, stockItems, recipes } = loaded;
  const canManage = held.has('manage_menu');
  const canAddItem = held.has('add_menu_item');
  const canRule = held.has('set_menu_depletion');
  const { item } = data;
  const variantName = (variantId: string) => data.variants.find((v) => v.id === variantId)?.label ?? 'Default';
  const storeName = (storeId: string) => data.stores.find((s) => s.id === storeId)?.name ?? '';

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{item.name}</h1>
          <PageDescription className="mt-1">
            {`${TYPE_LABEL[item.itemType] ?? item.itemType} in ${data.category?.name ?? 'no category'}. ${item.description ?? ''}`}
          </PageDescription>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge status={item.status} />
          <Link href="/menu" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Back to the menu
          </Link>
          <Link href="/menu/prices" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Prices
          </Link>
        </div>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {canManage && (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Item details</h2>
          <EditableRecord action={editItemAction} label={item.name} hidden={{ menuItemId: item.id }} typed={typedFor(sp, MENU_ITEM, item.id, actor.personId)}>
            <FormGrid>
              <Field label="Name" className="text-sm">
                <Input name="name" defaultValue={item.name} required className="w-full" />
              </Field>
              <Field label="Description" className="text-sm">
                <Input name="description" defaultValue={item.description ?? ''} className="w-full" />
              </Field>
              <Field label="Category" className="text-sm">
                <Select name="categoryId" defaultValue={item.categoryId} className="w-full">
                  {data.categories
                    .filter((c) => c.status === 'active' || c.id === item.categoryId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Sort order" className="text-sm">
                <Input name="sortOrder" inputMode="numeric" defaultValue={String(item.sortOrder)} className="w-full" />
              </Field>
              <Field label="Status" className="text-sm">
                <Select name="status" defaultValue={item.status} className="w-full">
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </Select>
              </Field>
            </FormGrid>
          </EditableRecord>
        </section>
      )}

      <section className="space-y-4 rounded-[14px] border border-surface-border p-4">
        <h2 className="text-lg font-semibold">Variants and what a sale uses up</h2>
        {data.variants.map((v) => {
          const rules = data.rules.filter((r) => r.variantId === v.id);
          return (
            <div key={v.id} className="space-y-2 border-t border-surface-border pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="font-medium">{v.label ?? 'Default'}</h3>
                {v.status === 'retired' && <Badge status="retired" />}
                {rules.length === 0 && <Badge tone="warning" label="No stock rule" />}
              </div>
              {rules.length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <Th>From</Th>
                      <Th>Uses</Th>
                      <Th>What</Th>
                      <Th numeric>Per sale</Th>
                      <Th>State</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id}>
                        <Td>{formatBusinessDateTime(r.effectiveFrom)}</Td>
                        <Td>{MODE_LABEL[r.mode] ?? r.mode}</Td>
                        <Td>{r.mode === 'direct' ? (r.stockItemName ?? '') : r.mode === 'recipe' ? (r.recipeName ?? '') : ''}</Td>
                        <Td className="text-right tabular-nums">{r.quantityPerSale ?? ''}</Td>
                        <Td>{r.inForce ? <Badge tone="success" label="In force" /> : r.effectiveFrom > data.now ? <Badge tone="info" label="Scheduled" /> : <Badge tone="closed" label="Replaced" />}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {canRule && v.status === 'active' && (
                <form action={setDepletionRuleAction} className="space-y-3">
                  <input type="hidden" name="menuItemId" value={item.id} />
                  <input type="hidden" name="variantId" value={v.id} />
                  <FormGrid>
                    <Field label="A sale uses" className="text-sm">
                      <Select name="mode" defaultValue="direct" className="w-full">
                        <option value="direct">A stock item</option>
                        <option value="recipe">A recipe</option>
                        <option value="no_stock">Nothing from stock</option>
                      </Select>
                    </Field>
                    <Field label="Stock item" className="text-sm">
                      <Select name="stockItemId" defaultValue="" className="w-full">
                        <option value="">-</option>
                        {stockItems.map((s) => (
                          <option key={s.id} value={s.id}>
                            {`${s.code} - ${s.name} (${s.baseUnit})`}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Recipe" className="text-sm">
                      <Select name="recipeId" defaultValue="" className="w-full">
                        <option value="">-</option>
                        {recipes.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Quantity per sale" className="text-sm">
                      <Input name="quantityPerSale" inputMode="decimal" className="w-full" />
                    </Field>
                    <Field label="From (Manila time, empty = now)" className="text-sm">
                      <Input type="datetime-local" name="effectiveFrom" className="w-full" />
                    </Field>
                  </FormGrid>
                  <Button type="submit" variant="secondary">
                    Save
                  </Button>
                </form>
              )}
            </div>
          );
        })}
        {canAddItem && (
          <form action={addVariantAction} className="space-y-3 border-t border-surface-border pt-3">
            <input type="hidden" name="menuItemId" value={item.id} />
            <h3 className="font-medium">Add a variant</h3>
            <FormGrid>
              <Field label="Label (for example Large)" className="text-sm">
                <Input name="label" required className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
        )}
      </section>

      <OptionGroups data={data} canManage={canManage} sp={sp} actorId={actor.personId} />

      {item.itemType === 'package' && (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Refills this package allows</h2>
          {data.variants.map((v) => {
            const ticked = data.refillsByVariant.get(v.id) ?? new Set<string>();
            return (
              <div key={v.id} className="space-y-2">
                <h3 className="font-medium">{v.label ?? 'Default'}</h3>
                {!canManage ? (
                  <p className="text-sm">{data.refillChoices.filter((r) => ticked.has(r.id)).map((r) => r.name).join(', ') || 'No refills.'}</p>
                ) : data.refillChoices.length === 0 ? (
                  <p className="text-sm text-muted">There are no refill items yet.</p>
                ) : (
                  <form action={setPackageRefillsAction} className="flex flex-wrap items-center gap-4">
                    <input type="hidden" name="menuItemId" value={item.id} />
                    <input type="hidden" name="packageVariantId" value={v.id} />
                    {data.refillChoices.map((r) => (
                      <Checkbox key={r.id} name="refillItemIds" value={r.id} defaultChecked={ticked.has(r.id)} label={r.name} />
                    ))}
                    <Button type="submit" variant="secondary">
                      Save
                    </Button>
                  </form>
                )}
              </div>
            );
          })}
        </section>
      )}

      <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
        <h2 className="text-lg font-semibold">Prices by store</h2>
        {data.offers.length === 0 ? (
          <p className="text-sm text-muted">No price has been set for this item at your stores yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Store</Th>
                <Th>Variant</Th>
                <Th>Channel</Th>
                <Th>From</Th>
                <Th>Price</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {data.offers.map((r) => (
                <tr key={`${r.storeId}|${r.variantId}|${r.channel}|${r.effectiveFrom.toISOString()}`}>
                  <Td>{storeName(r.storeId)}</Td>
                  <Td>{variantName(r.variantId)}</Td>
                  <Td>{CHANNEL_LABEL[r.channel] ?? r.channel}</Td>
                  <Td>{formatBusinessDateTime(r.effectiveFrom)}</Td>
                  <Td>{priceText(r)}</Td>
                  <Td>{r.state === 'in_force' ? <Badge tone="success" label={STATE_LABEL[r.state]} /> : r.state === 'scheduled' ? <Badge tone="info" label={STATE_LABEL[r.state]} /> : <Badge tone="closed" label={STATE_LABEL[r.state]} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-sm">
          <Link href="/menu/prices" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Set or change prices
          </Link>
        </p>
      </section>
    </Page>
  );
}

function OptionGroups({ data, canManage, sp, actorId }: { data: ItemPageData; canManage: boolean; sp: FlashFields; actorId: string }) {
  const itemId = data.item.id;
  const where = (g: OptionGroupView) => (g.variantId === null ? 'the whole item' : `the ${data.variants.find((v) => v.id === g.variantId)?.label ?? 'Default'} variant`);
  return (
    <section className="space-y-4 rounded-[14px] border border-surface-border p-4">
      <h2 className="text-lg font-semibold">Option groups</h2>
      {data.optionGroups.length === 0 && <p className="text-sm text-muted">No option groups are attached.</p>}
      {data.optionGroups.map((g) => (
        <div key={g.linkId} className="space-y-2 border-t border-surface-border pt-3 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-medium">{g.group.name}</h3>
            <span className="text-sm text-muted">
              {`${g.group.selectionMode === 'single' ? 'Pick one' : 'Pick several'}, at least ${g.group.minSelections}, at most ${g.group.maxSelections}. Attached to ${where(g)}.`}
            </span>
            {g.group.status === 'retired' && <Badge status="retired" />}
            {canManage && (
              <form action={unlinkOptionGroupAction}>
                <input type="hidden" name="menuItemId" value={itemId} />
                <input type="hidden" name="linkId" value={g.linkId} />
                <Button type="submit" variant="ghost" aria-label={`Detach ${g.group.name} from this item`}>
                  Clear
                </Button>
              </form>
            )}
          </div>
          <ul className="space-y-2">
            {g.values.map((v) => (
              <li key={v.id} className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{v.name}</span>
                  {v.status === 'retired' && <Badge status="retired" />}
                  {canManage && (
                    <form action={editOptionValueAction}>
                      <input type="hidden" name="menuItemId" value={itemId} />
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="status" value={v.status === 'active' ? 'retired' : 'active'} />
                      <Button type="submit" variant="ghost" aria-label={`${v.status === 'active' ? 'Retire' : 'Restore'} ${v.name}`}>
                        {v.status === 'active' ? 'Retire' : 'Restore'}
                      </Button>
                    </form>
                  )}
                </div>
                {canManage && (
                  <EditableRecord action={editOptionValueAction} label={v.name} hidden={{ menuItemId: itemId, id: v.id }} typed={typedFor(sp, MENU_OPTION_VALUE, v.id, actorId)}>
                    <FormGrid>
                      <Field label="Option name" className="text-sm">
                        <Input name="name" defaultValue={v.name} required className="w-full" />
                      </Field>
                    </FormGrid>
                  </EditableRecord>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <>
              <EditableRecord action={editOptionGroupAction} label={g.group.name} hidden={{ menuItemId: itemId, id: g.group.id }} typed={typedFor(sp, MENU_OPTION_GROUP, g.group.id, actorId)}>
                <FormGrid>
                  <Field label="Group name" className="text-sm">
                    <Input name="name" defaultValue={g.group.name} required className="w-full" />
                  </Field>
                  <Field label="Guests pick" className="text-sm">
                    <Select name="selectionMode" defaultValue={g.group.selectionMode} className="w-full">
                      <option value="single">One</option>
                      <option value="multi">Several</option>
                    </Select>
                  </Field>
                  <Field label="At least" className="text-sm">
                    <Input name="minSelections" inputMode="numeric" defaultValue={String(g.group.minSelections)} className="w-full" />
                  </Field>
                  <Field label="At most" className="text-sm">
                    <Input name="maxSelections" inputMode="numeric" defaultValue={String(g.group.maxSelections)} className="w-full" />
                  </Field>
                </FormGrid>
              </EditableRecord>
              <form action={addOptionValueAction} className="space-y-3">
                <input type="hidden" name="menuItemId" value={itemId} />
                <input type="hidden" name="optionGroupId" value={g.group.id} />
                <FormGrid>
                  <Field label="New option" className="text-sm">
                    <Input name="name" required className="w-full" />
                  </Field>
                </FormGrid>
                <Button type="submit" variant="secondary">
                  Save
                </Button>
              </form>
            </>
          )}
        </div>
      ))}

      {canManage && (
        <div className="space-y-4 border-t border-surface-border pt-3">
          <form action={linkOptionGroupAction} className="space-y-3">
            <input type="hidden" name="menuItemId" value={itemId} />
            <h3 className="font-medium">Attach an existing group</h3>
            <FormGrid>
              <Field label="Group" className="text-sm">
                <Select name="optionGroupId" defaultValue="" className="w-full">
                  <option value="">-</option>
                  {data.allGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To" className="text-sm">
                <Select name="variantId" defaultValue="" className="w-full">
                  <option value="">The whole item</option>
                  {data.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {`Only the ${v.label ?? 'Default'} variant`}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormGrid>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
          <form action={createOptionGroupAction} className="space-y-3">
            <input type="hidden" name="menuItemId" value={itemId} />
            <h3 className="font-medium">Add option group</h3>
            <FormGrid>
              <Field label="Group name (for example Flavour)" className="text-sm">
                <Input name="name" required className="w-full" />
              </Field>
              <Field label="Guests pick" className="text-sm">
                <Select name="selectionMode" defaultValue="single" className="w-full">
                  <option value="single">One</option>
                  <option value="multi">Several</option>
                </Select>
              </Field>
              <Field label="At least" className="text-sm">
                <Input name="minSelections" inputMode="numeric" defaultValue="0" className="w-full" />
              </Field>
              <Field label="At most" className="text-sm">
                <Input name="maxSelections" inputMode="numeric" defaultValue="1" className="w-full" />
              </Field>
              <Field label="Options, one per line" span="full" className="text-sm">
                <Textarea name="values" rows={3} className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
