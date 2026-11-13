import Link from 'next/link';
import type { ReactNode } from 'react';
import { can, type Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import type { LiveOfferFault } from '@shareat/domain';
import { resolveOfferPrice } from '@shareat/domain';
import type { OfferInForce } from '@shareat/db';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Badge, Banner, Button, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { MENU_OPTION_PRICE_RULES, MENU_PRICE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import {
  cancelScheduledOptionPriceAction,
  cancelScheduledPriceAction,
  setOptionPriceAction,
  setPriceAction,
  withdrawPriceAction,
} from './actions';
import { loadPricesPage, storesInScope, withOrgPrincipal, type DaypartView, type PricesPageData, type ScheduledOffer } from '../lib';
import { dayName, windowText } from '../daypart-text';

export const metadata = { title: 'Menu prices - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

type Channel = 'store' | 'online';
const CHANNELS: readonly Channel[] = ['store', 'online'];
const CHANNEL_LABEL: Record<Channel, string> = { store: 'Store (counter and tables)', online: 'Online' };

/** A percent figure without its trailing zeros: 7.5000 reads 7.5. */
const plainPercent = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const signed = (v: string): string => (v.startsWith('-') ? v : `+${v}`);

interface PriceShape {
  withdrawn: boolean;
  pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
  amount: string | null;
  bundleHeads?: number | null;
  extraHeadAmount?: string | null;
  markupPercent: string | null;
  fixedMarkupAmount: string | null;
}

/** The figure a row carries, as a person reads it. A rule reads as the rule; the resolved price is shown beside it. */
function figureText(r: PriceShape): string {
  if (r.withdrawn) return 'Withdrawn';
  if (r.pricingMode === 'percent_markup') return `${signed(plainPercent(r.markupPercent ?? '0'))}% over the store price`;
  if (r.pricingMode === 'fixed_markup') return `${signed(r.fixedMarkupAmount ?? '0.00')} over the store price`;
  if (r.amount === null) return 'Offered (no price)';
  if (r.bundleHeads != null) return `${r.amount} for ${r.bundleHeads} guests, ${r.extraHeadAmount ?? '0.00'} each extra`;
  return r.amount;
}

/** The price fields an online rule follows: the store row live now. */
const basisOf = (r: OfferInForce): NonNullable<OfferInForce['basis']> => ({
  withdrawn: r.withdrawn,
  pricingMode: r.pricingMode,
  amount: r.amount,
  bundleHeads: r.bundleHeads,
  extraHeadAmount: r.extraHeadAmount,
  markupPercent: r.markupPercent,
  fixedMarkupAmount: r.fixedMarkupAmount,
});

function resolvedText(row: OfferInForce): string | null {
  if (row.pricingMode === 'fixed' || row.withdrawn) return null;
  const r = resolveOfferPrice(row);
  if ('notOffered' in r) {
    if (r.notOffered === 'rule_below_zero') return 'Not offered online: the rule gives a price below zero. Change the rule.';
    if (r.notOffered === 'no_basis') return 'Not offered online: no counter price (the store has no price to follow).';
    return 'Not offered online: the store price is withdrawn.';
  }
  const bundle = r.bundleHeads != null ? ` for ${r.bundleHeads} guests, ${r.extraHeadAmount ?? '0.00'} each extra` : '';
  return `Online price: ${r.amount ?? ''}${bundle}`;
}

/** Presentation only: whether to draw the price forms at this store. The domain's own `set_menu_price` gate is the control. */
async function mayPrice(tx: Tx, actor: Actor, storeId: string): Promise<boolean> {
  return can(tx, actor, 'set_menu_price', { storeId });
}

export default async function MenuPricesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/prices');
  if (refusal) return refusal;

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    const stores = await storesInScope(tx, actor);
    // A store outside the person's scope is never drawn: an unknown or foreign ?store= falls back to their first store.
    const store = stores.find((s) => s.id === sp.store) ?? stores[0] ?? null;
    if (!store) return { stores, store: null, data: null, canPrice: false, canPair: false, canHours: false };
    const data = await loadPricesPage(tx, actor.orgId, store.id);
    const canPrice = await mayPrice(tx, actor, store.id);
    // T-510 R8, presentation only: the pairing controls (which price belongs to lunch, dinner or all day). The domain gates every write.
    const canPair = canPrice && (await can(tx, actor, 'pair_menu_dayparts', {}));
    const canHours = await can(tx, actor, 'manage_store_settings', { storeId: store.id });
    return { stores, store, data, canPrice, canPair, canHours };
  });
  const { stores, store, data, canPrice, canPair, canHours } = loaded;

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Menu prices</h1>
          <PageDescription className="mt-1">
            What each variant sells for at one store, on the counter and online. A new price starts right now unless you pick a date and
            time (Manila time). An online price can follow the store price by a rule, so it moves when the store price moves.
          </PageDescription>
        </div>
        <Link href="/menu" className="inline-flex min-h-6 items-center text-sm underline underline-offset-4">
          Back to the menu
        </Link>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {!store || !data ? (
        <p className="text-sm text-muted">You are not assigned to any store, so there are no prices for you to see here.</p>
      ) : (
        <>
          <FilterRow>
            <label className="text-sm">
              <span className="block text-muted">Store</span>
              <Select name="store" defaultValue={store.id}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          </FilterRow>
          {!canPrice && <p className="text-sm text-muted">You can read these prices but not change them at this store.</p>}
          {canPrice && !canPair && data.slots.some((r) => r.daypartId !== null) && (
            <p className="text-sm text-muted">Only a super admin can change which prices belong to menu hours. You can still change a price.</p>
          )}
          {canHours && (
            <Link href={`/menu/hours?store=${store.id}`} className="inline-flex min-h-6 items-center text-sm underline underline-offset-4">
              Change the menu hours
            </Link>
          )}
          <Grid data={data} storeId={store.id} canPrice={canPrice} canPair={canPair} />
          <OptionPrices data={data} storeId={store.id} canPrice={canPrice} />
        </>
      )}
    </Page>
  );
}

function Grid({ data, storeId, canPrice, canPair }: { data: PricesPageData; storeId: string; canPrice: boolean; canPair: boolean }) {
  const byCategory = data.categories
    .map((c) => ({ c, items: data.items.filter((i) => i.categoryId === c.id && i.variants.length > 0) }))
    .filter((x) => x.items.length > 0);
  return (
    <>
      {byCategory.map(({ c, items }) => (
        <section key={c.id} className="space-y-3">
          <h2 className="text-lg font-semibold">{c.name}</h2>
          {items.flatMap((i) =>
            i.variants.map((v) => (
              <div key={v.id} className="space-y-3 rounded-[14px] border border-surface-border p-4">
                <div className="flex flex-wrap items-baseline gap-3">
                  <Link href={`/menu/items/${i.id}`} className="inline-flex min-h-6 items-center font-medium underline underline-offset-4">
                    {i.name}
                  </Link>
                  {v.label ? <span className="text-muted">{v.label}</span> : null}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {CHANNELS.map((ch) => (
                    <Panel key={ch} data={data} storeId={storeId} canPrice={canPrice} canPair={canPair} variantId={v.id} channel={ch} itemType={i.itemType} />
                  ))}
                </div>
              </div>
            )),
          )}
        </section>
      ))}
      {byCategory.length === 0 && <p className="text-sm text-muted">There are no active items to price yet.</p>}
    </>
  );
}

const FAULT_SENTENCE: Record<LiveOfferFault['reason'], string> = {
  mixed_all_day_and_daypart: 'This package has an all-day price and prices by time of day at the same time, so no price can be shown. A super admin needs to withdraw one of them.',
  overlapping_dayparts: 'Two time-of-day prices for this package cover the same hours, so no price can be shown. A super admin needs to withdraw one of them.',
  tied_offers: 'Two prices for this package were saved at the exact same moment, so no price can be shown. A super admin needs to set the price again.',
  unknown_daypart: 'A price here points to hours that are missing or retired, so no price can be shown. Check this store’s menu hours.',
  invalid_daypart: 'A price here points to hours that are not valid, so no price can be shown. Check this store’s menu hours.',
  invalid_time_zone: 'This store’s time zone cannot be read, so no price can be shown. Ask an administrator to correct it on the store page.',
  invalid_instant: 'The time could not be read, so no price can be shown. Reload the page; if it stays, tell an administrator.',
};

/** "Not offered now, from 17:00"; "from Monday 11:00" when the next opening is more than a day away. */
function notOfferedText(n: { availableFrom: string | null; availableAt: Date | null; availableDay: number | null }, now: Date): string {
  if (n.availableFrom === null) return 'Not offered now.';
  const far = n.availableAt !== null && n.availableDay !== null && n.availableAt.getTime() - now.getTime() > 24 * 3600 * 1000;
  return `Not offered now, from ${far ? `${dayName(n.availableDay as number)} ` : ''}${n.availableFrom}`;
}

/** The "When" box of the price form: All day, or one of the store's windows. */
function WhenSelect({ choices, initial }: { choices: DaypartView[]; initial: string }) {
  return (
    <Field label="When" className="text-sm" hint="All day, or only during one of the store's menu hours.">
      <Select name="daypartId" defaultValue={initial} className="w-full">
        <option value="">All day</option>
        {choices.map((d) => (
          <option key={d.id} value={d.id}>
            {`${d.name} (${windowText(d.start, d.end)})`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The price form. `fixedDaypartId` (a slot's own "Change price") posts that daypart; `whenChoices` (super admin only) draws the When select. */
function PriceForm({
  channel,
  itemType,
  hidden,
  trigger,
  triggerLabel,
  title,
  fixedDaypartId,
  whenChoices,
  defaultWhen,
}: {
  channel: Channel;
  itemType: 'a_la_carte' | 'package' | 'refill';
  hidden: ReactNode;
  trigger: string;
  /** The accessible name when it says more than the visible words. */
  triggerLabel?: string;
  title: string;
  fixedDaypartId?: string;
  whenChoices?: DaypartView[];
  /** The When select starts on this daypart id ('' = all day). */
  defaultWhen?: string;
}) {
  return (
    <FormModal trigger={trigger} triggerIcon={null} triggerVariant="secondary" triggerLabel={triggerLabel ?? trigger} title={title} size="md">
      <CheckedForm rules={MENU_PRICE_RULES} action={setPriceAction} className="space-y-3">
        {hidden}
        {fixedDaypartId !== undefined && <input type="hidden" name="daypartId" value={fixedDaypartId} />}
        <FormGrid>
          {whenChoices && whenChoices.length > 0 && <WhenSelect choices={whenChoices} initial={defaultWhen ?? ''} />}
          {channel === 'online' && (
            <Field label="Online price is" className="text-sm">
              <Select name="pricingMode" defaultValue="fixed" className="w-full">
                <option value="fixed">A fixed price</option>
                <option value="percent_markup">% over the store price</option>
                <option value="fixed_markup">Pesos over the store price</option>
              </Select>
            </Field>
          )}
          {itemType !== 'refill' && (
            <Field label={channel === 'online' ? 'Fixed price' : 'New price'} className="text-sm" rule={MENU_PRICE_RULES.amount}>
              <Input {...nativeAttrs(MENU_PRICE_RULES.amount)} className="w-full" />
            </Field>
          )}
          {channel === 'online' && (
            <>
              <Field label="Percent over" className="text-sm" rule={MENU_PRICE_RULES.markupPercent}>
                <Input {...nativeAttrs(MENU_PRICE_RULES.markupPercent)} className="w-full" />
              </Field>
              <Field label="Pesos over" className="text-sm" rule={MENU_PRICE_RULES.fixedMarkupAmount}>
                <Input {...nativeAttrs(MENU_PRICE_RULES.fixedMarkupAmount)} className="w-full" />
              </Field>
            </>
          )}
          {itemType === 'package' && channel === 'store' && (
            <>
              <Field label="Bundle covers (guests)" className="text-sm" rule={MENU_PRICE_RULES.bundleHeads}>
                <Input {...nativeAttrs(MENU_PRICE_RULES.bundleHeads)} className="w-full" />
              </Field>
              <Field label="Each extra guest" className="text-sm" rule={MENU_PRICE_RULES.extraHeadAmount}>
                <Input {...nativeAttrs(MENU_PRICE_RULES.extraHeadAmount)} className="w-full" />
              </Field>
            </>
          )}
          <Field label="From (Manila time, empty = now)" className="text-sm">
            <Input type="datetime-local" name="effectiveFrom" className="w-full" />
          </Field>
        </FormGrid>
        {(whenChoices || fixedDaypartId !== undefined) && (
          <p className="text-xs text-muted">
            A new price cannot start earlier than a change already saved or scheduled for this package, store and channel. Lunch, Dinner and all day count together.
            If you see &ldquo;a later change is already scheduled&rdquo;, clear the scheduled change or pick a later time.
            {whenChoices && ' To move a package from an all-day price to time-of-day prices, withdraw the all-day price first.'}
          </p>
        )}
        <DialogActions>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </DialogActions>
      </CheckedForm>
    </FormModal>
  );
}

function Panel({
  data,
  storeId,
  canPrice,
  canPair,
  variantId,
  channel,
  itemType,
}: {
  data: PricesPageData;
  storeId: string;
  canPrice: boolean;
  canPair: boolean;
  variantId: string;
  channel: Channel;
  itemType: 'a_la_carte' | 'package' | 'refill';
}) {
  const row = data.inForce.find((r) => r.variantId === variantId && r.channel === channel);
  const later = data.scheduled.filter((r: ScheduledOffer) => r.variantId === variantId && r.channel === channel);
  const resolved = row ? resolvedText(row) : null;
  // T-510: the raw live rows of this variant and channel. A variant with any dayparted row is drawn slot by slot; otherwise exactly as before.
  const dayOf = new Map(data.dayparts.map((d, i) => [d.id, { d, i }]));
  const slots = data.slots
    .filter((r) => r.variantId === variantId && r.channel === channel && r.daypartId !== null)
    .sort((a, b) => (dayOf.get(a.daypartId as string)?.i ?? 0) - (dayOf.get(b.daypartId as string)?.i ?? 0));
  const dayparted = slots.length > 0;
  const storeLive = channel === 'online' ? data.inForce.find((r) => r.variantId === variantId && r.channel === 'store') : undefined;
  const fault = data.faults.find((f) => f.variantId === variantId && f.channel === channel);
  const notNow = data.notOfferedNow.find((n) => n.variantId === variantId && n.channel === channel);
  const activeDayparts = data.dayparts.filter((d) => d.status === 'active');
  // Windows with no live price yet: the only ones an "Add price" can still fill (a window that has one is changed, not added).
  const freeWindows = activeDayparts.filter((d) => !slots.some((x) => x.daypartId === d.id && !x.withdrawn));
  // Slots exist but every one belongs to retired hours: only an all-day price can be set (anyone who may price can).
  const noActiveHours = dayparted && activeDayparts.length === 0;
  const canAdd = canPrice && (!dayparted ? true : noActiveHours || (canPair && freeWindows.length > 0));
  const whenChoices = canPair && activeDayparts.length > 0 ? (dayparted ? freeWindows : activeDayparts) : [];
  const scheduledLabel = (s: ScheduledOffer): string => (s.daypartId === null ? '' : `${dayOf.get(s.daypartId)?.d.name ?? 'Hours'}: `);
  const hidden = (
    <>
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="variantId" value={variantId} />
      <input type="hidden" name="channel" value={channel} />
    </>
  );
  return (
    <div className="space-y-3 rounded-[10px] bg-canvas p-3">
      <h3 className="text-sm font-semibold">{CHANNEL_LABEL[channel]}</h3>
      {fault ? (
        <div className="space-y-2">
          <Badge tone="danger" label="Check this price" />
          <p role="alert" className="text-sm text-danger">
            {FAULT_SENTENCE[fault.reason]}
          </p>
          {canPrice && canPair && (
            <ul className="space-y-1 text-sm">
              {data.slots
                .filter((r) => r.variantId === variantId && r.channel === channel && !r.withdrawn)
                .map((r) => {
                  const label = r.daypartId === null ? 'All day' : (dayOf.get(r.daypartId)?.d.name ?? 'Hours');
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{label}</span>
                      <form action={withdrawPriceAction}>
                        {hidden}
                        {r.daypartId !== null && <input type="hidden" name="daypartId" value={r.daypartId} />}
                        <Button type="submit" variant="ghost" aria-label={`Withdraw the ${label} price`}>
                          Withdraw
                        </Button>
                      </form>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      ) : dayparted ? (
        <ul className="divide-y divide-surface-border">
          {slots.map((slot) => {
            const info = dayOf.get(slot.daypartId as string)?.d;
            // An online rule follows the STORE price live now, not the raw per-window join: the on-now slot uses the domain-resolved row, a
            // closed window re-links to the store row live now (resolveStoreOffers' rule), and with no store row there is no line, never a wrong one.
            const slotResolved =
              channel !== 'online' ? null : row?.id === slot.id ? resolvedText(row) : storeLive ? resolvedText({ ...slot, basis: basisOf(storeLive) }) : null;
            return (
              <li key={slot.id} className="space-y-2 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{info ? `${info.name}${info.status === 'retired' ? ' (retired)' : ''}` : 'Hours'}</span>
                      {row?.id === slot.id && <Badge tone="success" label="On now" />}
                    </span>
                    {info && <span className="block text-xs text-muted tabular-nums">{windowText(info.start, info.end)}</span>}
                  </span>
                  <span className={`tabular-nums ${slot.withdrawn ? 'text-muted' : 'font-medium'}`}>{figureText(slot)}</span>
                </div>
                {slotResolved && <p className="text-sm">{slotResolved}</p>}
                {canPrice && !slot.withdrawn && info?.status !== 'retired' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <PriceForm
                      channel={channel}
                      itemType={itemType}
                      hidden={hidden}
                      trigger="Change price"
                      title={`Change ${info?.name ?? 'price'} price — ${CHANNEL_LABEL[channel]}`}
                      fixedDaypartId={slot.daypartId as string}
                    />
                    {canPair && (
                      <form action={withdrawPriceAction}>
                        {hidden}
                        <input type="hidden" name="daypartId" value={slot.daypartId as string} />
                        <Button type="submit" variant="ghost" aria-label={`Withdraw the ${info?.name ?? ''} price`}>
                          Withdraw
                        </Button>
                      </form>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div>
          {row ? (
            <>
              <span className="font-medium tabular-nums">{figureText(row)}</span>
              {resolved && <span className="block text-sm">{resolved}</span>}
            </>
          ) : (
            <span className="text-muted">Not set</span>
          )}
        </div>
      )}
      {!fault && notNow && <p className="text-sm text-muted">{notOfferedText(notNow, data.now)}</p>}

      {later.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info" label="Scheduled" />
          <span>{`${formatBusinessDateTime(s.effectiveFrom)}: ${scheduledLabel(s)}${figureText(s)}`}</span>
          {canPrice && (s.daypartId === null ? !dayparted || canPair : canPair) && (
            <form action={cancelScheduledPriceAction}>
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="offerId" value={s.id} />
              <Button type="submit" variant="ghost" aria-label="Cancel the scheduled price">
                Clear
              </Button>
            </form>
          )}
        </div>
      ))}

      {canPrice && noActiveHours && (
        <p className="text-sm text-muted">This store has no active menu hours, so only an all-day price can be set here. Add hours first to price by time of day.</p>
      )}
      {canPrice && canPair && dayparted && !noActiveHours && freeWindows.length === 0 && (
        <p className="text-sm text-muted">Every set of hours already has a price. Change a price above, or withdraw one first.</p>
      )}
      {canPrice && (canAdd || (!dayparted && row && !row.withdrawn)) && (
        <div className="flex flex-wrap items-center gap-2">
          {canAdd && (
            <PriceForm
              channel={channel}
              itemType={itemType}
              hidden={hidden}
              trigger={dayparted && !noActiveHours ? 'Add price' : 'Set price'}
              {...(dayparted && !noActiveHours ? { triggerLabel: 'Add price for another time' } : {})}
              title={dayparted && !noActiveHours ? `Add a price — ${CHANNEL_LABEL[channel]}` : `Set price — ${CHANNEL_LABEL[channel]}`}
              {...(whenChoices.length > 0 ? { whenChoices } : {})}
              // On a variant that already has time-of-day prices, "all day" would be refused: start on the first window with no price yet.
              {...(dayparted ? { defaultWhen: freeWindows[0]?.id ?? '' } : {})}
            />
          )}
          {!dayparted && row && !row.withdrawn && (
            <form action={withdrawPriceAction}>
              {hidden}
              <Button type="submit" variant="ghost">
                Withdraw
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function OptionPrices({ data, storeId, canPrice }: { data: PricesPageData; storeId: string; canPrice: boolean }) {
  if (data.optionValues.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Option prices</h2>
      <p className="text-sm text-muted">
        What picking an option adds to (or, with a minus sign, takes off) the price. An option with no price here is not offered at this store.
      </p>
      {data.optionValues.map((o) => (
        <div key={o.id} className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <p className="font-medium">{o.label}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {CHANNELS.map((ch) => {
              const row = data.optionInForce.find((r) => r.optionValueId === o.id && r.channel === ch);
              const later = data.optionScheduled.filter((r) => r.optionValueId === o.id && r.channel === ch);
              return (
                <div key={ch} className="space-y-3 rounded-[10px] bg-canvas p-3">
                  <h3 className="text-sm font-semibold">{CHANNEL_LABEL[ch]}</h3>
                  <span className={row ? 'font-medium tabular-nums' : 'text-muted'}>{row ? row.priceDelta : 'Not offered'}</span>
                  {later.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone="info" label="Scheduled" />
                      <span>{`${formatBusinessDateTime(s.effectiveFrom)}: ${s.withdrawn ? 'Withdrawn' : (s.priceDelta ?? '')}`}</span>
                      {canPrice && (
                        <form action={cancelScheduledOptionPriceAction}>
                          <input type="hidden" name="storeId" value={storeId} />
                          <input type="hidden" name="optionOfferId" value={s.id} />
                          <Button type="submit" variant="ghost" aria-label="Cancel the scheduled price">
                            Clear
                          </Button>
                        </form>
                      )}
                    </div>
                  ))}
                  {canPrice && (
                    <CheckedForm rules={MENU_OPTION_PRICE_RULES} action={setOptionPriceAction} className="space-y-3">
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="optionValueId" value={o.id} />
                      <input type="hidden" name="channel" value={ch} />
                      <FormGrid>
                        <Field label="Price change" className="text-sm" rule={MENU_OPTION_PRICE_RULES.priceDelta}>
                          <Input {...nativeAttrs(MENU_OPTION_PRICE_RULES.priceDelta)} className="w-full" />
                        </Field>
                        <Field label="From (Manila time, empty = now)" className="text-sm">
                          <Input type="datetime-local" name="effectiveFrom" className="w-full" />
                        </Field>
                      </FormGrid>
                      <div className="flex flex-wrap gap-3">
                        <Button type="submit" variant="secondary">
                          Save
                        </Button>
                        <Button type="submit" name="withdraw" value="1" variant="ghost">
                          Withdraw
                        </Button>
                      </div>
                    </CheckedForm>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
