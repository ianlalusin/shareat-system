import Link from 'next/link';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { resolveOfferPrice } from '@shareat/domain';
import type { OfferInForce } from '@shareat/db';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Badge, Banner, Button, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import {
  cancelScheduledOptionPriceAction,
  cancelScheduledPriceAction,
  setOptionPriceAction,
  setPriceAction,
  withdrawPriceAction,
} from './actions';
import { loadPricesPage, storesInScope, withOrgPrincipal, type PricesPageData, type ScheduledOffer } from '../lib';

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
  try {
    await authorize(tx, actor, 'set_menu_price', { storeId });
    return true;
  } catch (err) {
    if (err instanceof AuthorizationError) return false;
    throw err;
  }
}

export default async function MenuPricesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/prices');
  if (refusal) return refusal;

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    const stores = await storesInScope(tx, actor);
    // A store outside the person's scope is never drawn: an unknown or foreign ?store= falls back to their first store.
    const store = stores.find((s) => s.id === sp.store) ?? stores[0] ?? null;
    if (!store) return { stores, store: null, data: null, canPrice: false };
    const data = await loadPricesPage(tx, actor.orgId, store.id);
    const canPrice = await mayPrice(tx, actor, store.id);
    return { stores, store, data, canPrice };
  });
  const { stores, store, data, canPrice } = loaded;

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
          <Grid data={data} storeId={store.id} canPrice={canPrice} />
          <OptionPrices data={data} storeId={store.id} canPrice={canPrice} />
        </>
      )}
    </Page>
  );
}

function Grid({ data, storeId, canPrice }: { data: PricesPageData; storeId: string; canPrice: boolean }) {
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
                    <Panel key={ch} data={data} storeId={storeId} canPrice={canPrice} variantId={v.id} channel={ch} itemType={i.itemType} />
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

function Panel({
  data,
  storeId,
  canPrice,
  variantId,
  channel,
  itemType,
}: {
  data: PricesPageData;
  storeId: string;
  canPrice: boolean;
  variantId: string;
  channel: Channel;
  itemType: 'a_la_carte' | 'package' | 'refill';
}) {
  const row = data.inForce.find((r) => r.variantId === variantId && r.channel === channel);
  const later = data.scheduled.filter((r: ScheduledOffer) => r.variantId === variantId && r.channel === channel);
  const resolved = row ? resolvedText(row) : null;
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

      {later.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info" label="Scheduled" />
          <span>{`${formatBusinessDateTime(s.effectiveFrom)}: ${figureText(s)}`}</span>
          {canPrice && (
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

      {canPrice && (
        <form action={setPriceAction} className="space-y-3">
          {hidden}
          <FormGrid>
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
              <Field label={channel === 'online' ? 'Fixed price' : 'New price'} className="text-sm">
                <Input name="amount" inputMode="decimal" className="w-full" />
              </Field>
            )}
            {channel === 'online' && (
              <>
                <Field label="Percent over" className="text-sm">
                  <Input name="markupPercent" inputMode="decimal" className="w-full" />
                </Field>
                <Field label="Pesos over" className="text-sm">
                  <Input name="fixedMarkupAmount" inputMode="decimal" className="w-full" />
                </Field>
              </>
            )}
            {itemType === 'package' && channel === 'store' && (
              <>
                <Field label="Bundle covers (guests)" className="text-sm">
                  <Input name="bundleHeads" inputMode="numeric" className="w-full" />
                </Field>
                <Field label="Each extra guest" className="text-sm">
                  <Input name="extraHeadAmount" inputMode="decimal" className="w-full" />
                </Field>
              </>
            )}
            <Field label="From (Manila time, empty = now)" className="text-sm">
              <Input type="datetime-local" name="effectiveFrom" className="w-full" />
            </Field>
          </FormGrid>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </form>
      )}

      {canPrice && row && !row.withdrawn && (
        <form action={withdrawPriceAction}>
          {hidden}
          <Button type="submit" variant="ghost">
            Withdraw
          </Button>
        </form>
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
                    <form action={setOptionPriceAction} className="space-y-3">
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="optionValueId" value={o.id} />
                      <input type="hidden" name="channel" value={ch} />
                      <FormGrid>
                        <Field label="Price change" className="text-sm">
                          <Input name="priceDelta" inputMode="decimal" className="w-full" />
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
                    </form>
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
