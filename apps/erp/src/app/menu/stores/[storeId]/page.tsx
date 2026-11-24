import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { can } from '@shareat/auth';
import { loadStoreSells, type SellsItem, type SellsSlot, type SellsVariant } from '@shareat/domain';
import { MENU_OPTION_PRICE_RULES, MENU_PRICE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { NAV_LINK } from '@/components/action-link';
import { Badge, Banner, Button, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { isUuid, storesInScope, withOrgPrincipal } from '../../lib';
import { flavourAction, switchOffAction, switchOnAction } from './actions';

export const metadata = { title: 'What a store sells - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  show?: string;
}

type Show = 'all' | 'on' | 'off' | 'station';
const SHOWS: readonly Show[] = ['all', 'on', 'off', 'station'];
const TYPE_LABEL: Record<string, string> = { a_la_carte: 'À la carte', package: 'Package', refill: 'Refill' };

const slotKey = (s: SellsSlot): string => s.daypartId ?? 'all';
const slotName = (s: SellsSlot): string => s.daypartName ?? 'All day';

/** "Lunch 120.00 · Dinner 140.00", or "All day 120.00", or "Free refill". */
function priceText(v: SellsVariant, isRefill: boolean): string {
  if (isRefill) return 'Free refill';
  return v.formSlots
    .filter((s) => s.amount !== null)
    .map((s) => `${slotName(s)} ${s.amount}`)
    .join(' · ');
}

export default async function StoreSellsPage({ params, searchParams }: { params: Promise<{ storeId: string }>; searchParams: Promise<SearchParams> }) {
  const { storeId } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/menu/stores/${storeId}`);
  if (refusal) return refusal;
  if (!isUuid(storeId)) notFound();

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    const stores = await storesInScope(tx, actor);
    // A store outside the person's scope is never drawn.
    const store = stores.find((s) => s.id === storeId);
    if (!store) return null;
    const data = await loadStoreSells(tx, actor.orgId, store.id, stores);
    const canPrice = await can(tx, actor, 'set_menu_price', { storeId: store.id });
    // Presentation only: the domain gates every write. A dayparted price is a super admin's to create or remove (T-510 R8).
    const canPair = canPrice && (await can(tx, actor, 'pair_menu_dayparts', {}));
    const canKitchen = await can(tx, actor, 'manage_store_settings', { storeId: store.id });
    return { stores, store, data, canPrice, canPair, canKitchen };
  });
  if (!loaded) notFound();
  const { stores, store, data, canPrice, canPair, canKitchen } = loaded;

  const show: Show = SHOWS.find((s) => s === sp.show) ?? 'all';
  const on = data.items.filter((i) => i.on).length;
  const noStation = data.items.filter((i) => i.noStation).length;
  const keep = (i: SellsItem): boolean => show === 'all' || (show === 'on' && i.on) || (show === 'off' && !i.on) || (show === 'station' && i.noStation);

  return (
    <Page
      density="table"
      title={`What ${store.name} sells`}
      description="Every item on the company menu. Switch an item on to sell it here, off to stop. Switching off keeps every past sale. Prices are per store and per menu hour."
      actions={
        <Link href="/menu" className={NAV_LINK}>
          Back to the menu
        </Link>
      }
    >
      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {stores.length > 1 && (
        <nav aria-label="Store" className="flex flex-wrap gap-x-4">
          {stores.map((s) =>
            s.id === store.id ? (
              <span key={s.id} aria-current="page" className="inline-flex min-h-11 items-center text-sm font-semibold">
                {s.name}
              </span>
            ) : (
              <Link key={s.id} href={`/menu/stores/${s.id}`} className={NAV_LINK}>
                {s.name}
              </Link>
            ),
          )}
        </nav>
      )}

      <p className="text-sm tabular-nums">
        {`${on} on · ${data.items.length - on} off`}
        {noStation > 0 && ` · ${noStation} on with no kitchen station`}
      </p>
      {!canPrice && <p className="text-sm text-muted">You can see what this store sells but not change it.</p>}
      {canPrice && !canPair && data.hasDayparts && (
        <p className="text-sm text-muted">This store prices by menu hours, so only a super admin can switch an item on or off. You can still change a price.</p>
      )}

      <FilterRow>
        <label className="text-sm">
          <span className="block text-muted">Show</span>
          <Select name="show" defaultValue={show}>
            <option value="all">All items</option>
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="station">On, no kitchen station</option>
          </Select>
        </label>
        <Link href={`/menu/prices?store=${store.id}`} className={NAV_LINK}>
          Online prices: Menu &gt; Prices
        </Link>
      </FilterRow>

      {data.categories.map((c) => {
        const items = data.items.filter((i) => i.categoryId === c.id && keep(i));
        if (items.length === 0) return null;
        return (
          <section key={c.id} className="space-y-1">
            <h2 className="text-lg font-semibold">{c.name}</h2>
            <ul className="divide-y divide-surface-border rounded-[14px] border border-surface-border">
              {items.map((i) => (
                <ItemRow key={i.itemId} item={i} storeId={store.id} canPrice={canPrice} canPair={canPair} hasDayparts={data.hasDayparts} canKitchen={canKitchen} />
              ))}
            </ul>
          </section>
        );
      })}
      {data.items.filter(keep).length === 0 && <p className="text-sm text-muted">Nothing to show with this filter.</p>}
    </Page>
  );
}

interface RowProps {
  item: SellsItem;
  storeId: string;
  canPrice: boolean;
  canPair: boolean;
  hasDayparts: boolean;
}

function ItemRow({ item, storeId, canPrice, canPair, hasDayparts, canKitchen }: RowProps & { canKitchen: boolean }) {
  const solo = item.variants.length === 1 && !item.variants[0]?.label;
  const controls = (v: SellsVariant) => <VariantControls item={item} variant={v} storeId={storeId} canPrice={canPrice} canPair={canPair} hasDayparts={hasDayparts} />;
  return (
    <li className="space-y-2 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={`/menu/items/${item.itemId}`} className="inline-flex min-h-6 items-center font-medium underline underline-offset-4">
          {item.name}
        </Link>
        <span className="text-sm text-muted">{TYPE_LABEL[item.itemType] ?? item.itemType}</span>
        {item.noStation && (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge tone="warning" label="Not on the tablet: no kitchen station" />
            {canKitchen && (
              <Link href="/kitchen" className={NAV_LINK}>
                Set up the kitchen
              </Link>
            )}
          </span>
        )}
        {solo && item.variants[0] && <div className="flex flex-wrap items-center gap-3 sm:ml-auto">{controls(item.variants[0])}</div>}
      </div>
      {!solo && (
        <ul className="space-y-2">
          {item.variants.map((v) => (
            <li key={v.variantId} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-surface-border pt-2 sm:pl-4">
              <span className="font-medium">{v.label ?? item.name}</span>
              <div className="flex flex-wrap items-center gap-3 sm:ml-auto">{controls(v)}</div>
            </li>
          ))}
        </ul>
      )}
      {item.flavourGroups.length > 0 && <Flavours item={item} storeId={storeId} canPrice={canPrice} />}
    </li>
  );
}

function VariantControls({ item, variant: v, storeId, canPrice, canPair, hasDayparts }: RowProps & { variant: SellsVariant }) {
  const isRefill = item.itemType === 'refill';
  // A refill and an all-day variant never need a super admin; creating or removing a dayparted price does.
  const structural = v.on ? v.dayparted : hasDayparts && !isRefill;
  const mayFlip = canPrice && (canPair || !structural);
  const name = v.label ? `${item.name}, ${v.label}` : item.name;
  const prices = priceText(v, isRefill);
  const hidden = (
    <>
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="variantId" value={v.variantId} />
    </>
  );
  return (
    <>
      {v.on ? <Badge tone="success" label="On" /> : <Badge tone="closed" label="Off" />}
      {v.onlineOnly && <span className="text-sm text-muted">Online only</span>}
      {v.on && prices && <span className="text-sm tabular-nums">{prices}</span>}
      {v.on && mayFlip && (
        <FormModal trigger="Switch off" triggerIcon={null} triggerVariant="secondary" triggerLabel={`Switch off ${name}`} title={`Switch off ${name}?`} size="sm">
          <form action={switchOffAction} className="space-y-3">
            {hidden}
            <p className="text-sm">Guests and cashiers can no longer order it here, on the counter or online. Every sale already made is kept. You can switch it on again later.</p>
            <DialogActions>
              <Button type="submit" variant="secondary">
                Switch off
              </Button>
            </DialogActions>
          </form>
        </FormModal>
      )}
      {v.on && canPrice && !isRefill && (
        <FormModal trigger="Change prices" triggerIcon={null} triggerVariant="secondary" triggerLabel={`Change the prices of ${name}`} title={`Prices of ${name}`} size="md">
          <PriceForm item={item} variant={v} hidden={hidden} changing />
        </FormModal>
      )}
      {!v.on && mayFlip && (
        <FormModal trigger="Switch on" triggerIcon={null} triggerVariant="primary" triggerLabel={`Switch on ${name}`} title={`Switch on ${name}`} size="md">
          <PriceForm item={item} variant={v} hidden={hidden} />
        </FormModal>
      )}
    </>
  );
}

/** The price per menu hour (or all day). Nothing is saved until Save; a suggestion is only a starting value. */
function PriceForm({ item, variant: v, hidden, changing }: { item: SellsItem; variant: SellsVariant; hidden: ReactNode; changing?: boolean }) {
  const isRefill = item.itemType === 'refill';
  return (
    <CheckedForm rules={MENU_PRICE_RULES} action={switchOnAction} className="space-y-3">
      {hidden}
      {changing && <input type="hidden" name="changing" value="1" />}
      {isRefill ? (
        <>
          <input type="hidden" name="slot" value="all" />
          <input type="hidden" name="amount" value="" />
          <input type="hidden" name="bundle" value="" />
          <input type="hidden" name="extra" value="" />
          <p className="text-sm">A refill is a free serving a package entitles. It has no price.</p>
        </>
      ) : (
        <>
          <FormGrid>
            {v.formSlots.map((s) => (
              <Field key={slotKey(s)} label={slotName(s)} className="text-sm" rule={MENU_PRICE_RULES.amount}>
                <input type="hidden" name="slot" value={slotKey(s)} />
                <Input {...nativeAttrs(MENU_PRICE_RULES.amount)} defaultValue={s.amount ?? ''} className="w-full" />
                <input type="hidden" name="bundle" value={s.bundleHeads === null ? '' : String(s.bundleHeads)} />
                <input type="hidden" name="extra" value={s.bundleHeads === null ? '' : (s.extraHeadAmount ?? '0.00')} />
                {s.bundleHeads !== null && <span className="mt-1 block text-xs text-muted">{`Bundle price for ${s.bundleHeads} guests, ${s.extraHeadAmount ?? '0.00'} each extra.`}</span>}
              </Field>
            ))}
          </FormGrid>
          {!changing && v.formSlots.length > 1 && <p className="text-xs text-muted">Leave a time of day empty to not sell it then.</p>}
          {!changing && v.prefill?.from === 'last_here' && <p className="text-sm text-muted">Starting from the price it had here before. Nothing is saved until you press Save.</p>}
          {!changing && v.prefill?.from === 'other_store' && (
            <p className="text-sm text-muted">{`Suggested from ${v.prefill.storeName ?? 'another store'}. Nothing is saved until you press Save.`}</p>
          )}
        </>
      )}
      <DialogActions>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </DialogActions>
    </CheckedForm>
  );
}

function Flavours({ item, storeId, canPrice }: { item: SellsItem; storeId: string; canPrice: boolean }) {
  const all = item.flavourGroups.flatMap((g) => g.values);
  return (
    <details className="text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4">{`Flavours and options (${all.filter((x) => x.on).length} of ${all.length} on)`}</summary>
      <div className="space-y-3 pb-2">
        {item.flavourGroups.map((g) => (
          <div key={g.groupId}>
            <h3 className="font-medium">{g.name}</h3>
            <ul className="divide-y divide-surface-border">
              {g.values.map((f) => (
                <li key={f.optionValueId} className="py-1">
                  <CheckedForm rules={MENU_OPTION_PRICE_RULES} action={flavourAction} className="flex flex-wrap items-end gap-x-3 gap-y-2">
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="optionValueId" value={f.optionValueId} />
                    <input type="hidden" name="mode" value="on" />
                    <span className="min-w-32 self-center font-medium">{f.name}</span>
                    {f.on ? <Badge tone="success" label="On" /> : <Badge tone="closed" label="Off" />}
                    {canPrice ? (
                      <>
                        <Field label="Price change" className="text-sm sm:min-w-48 sm:flex-1" rule={MENU_OPTION_PRICE_RULES.priceDelta}>
                          <Input {...nativeAttrs(MENU_OPTION_PRICE_RULES.priceDelta)} defaultValue={f.priceDelta ?? '0.00'} className="w-full" />
                        </Field>
                        <Button type="submit" variant="secondary" icon={null} aria-label={`${f.on ? 'Save the price change of' : 'Switch on'} ${f.name}`}>
                          Save
                        </Button>
                      </>
                    ) : (
                      f.priceDelta !== null && <span className="tabular-nums">{f.priceDelta}</span>
                    )}
                  </CheckedForm>
                  {canPrice && f.on && (
                    <form action={flavourAction} className="mt-1">
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="optionValueId" value={f.optionValueId} />
                      <input type="hidden" name="mode" value="off" />
                      <Button type="submit" variant="ghost" icon={null} aria-label={`Switch off ${f.name}`}>
                        Switch off
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
