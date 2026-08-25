'use server';

/**
 * Server actions for the sales-day screens — docs/tasks/123-sales-day.md.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. **No business rule is
 * re-implemented here** — `createSalesDay` / `submitSalesDay` / `verifySalesDay` / `voidSalesDay`
 * own every invariant, including the create-block and its carve-outs.
 */
import { redirect } from 'next/navigation';
import { createSalesDay, submitSalesDay, verifySalesDay, voidSalesDay, SalesDayBlockedError } from '@shareat/domain';
import { withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** A blank money input means zero, not "invalid". The domain and the schema both reject a
 *  genuinely bad figure, so this only has to normalise an empty box. */
function amount(fd: FormData, key: string): string {
  const raw = str(fd, key);
  return raw === '' ? '0' : raw;
}

function errorMessage(err: unknown): string {
  // A blocked create carries the day that blocks it — worth surfacing, since the user's next
  // action is to go and verify that day.
  if (err instanceof SalesDayBlockedError) {
    return `${err.message} (blocking day: ${err.blockingBusinessDate})`;
  }
  return err instanceof Error ? err.message : String(err);
}

function carryQs(fd: FormData): string {
  const params = new URLSearchParams();
  const org = str(fd, 'orgId');
  const store = str(fd, 'storeId');
  const as = str(fd, 'actingPersonId');
  if (org) params.set('org', org);
  if (store) params.set('store', store);
  if (as) params.set('as', as);
  return params.toString();
}

export async function createSalesDayAction(formData: FormData): Promise<void> {
  const orgId = str(formData, 'orgId');
  const storeId = str(formData, 'storeId');
  const actingPersonId = str(formData, 'actingPersonId');
  const qs = carryQs(formData);

  // Channel rows arrive as channel_<id> / nosales_<id> pairs — the id is in the field name, so
  // no index bookkeeping is needed and a missing row is simply absent.
  const channels: { channelId: string; amount: string; noSales: boolean }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('channel_') || typeof value !== 'string') continue;
    const channelId = key.slice('channel_'.length);
    const noSales = formData.get(`nosales_${channelId}`) === 'on';
    const raw = value.trim();
    // ⭐ Absent, zero, and "confirmed no sales" are three different things (T-134 B3's lesson,
    // and v1's own noSalesChannelIds). An untouched box writes no row at all.
    if (raw === '' && !noSales) continue;
    channels.push({ channelId, amount: noSales ? '0' : raw === '' ? '0' : raw, noSales });
  }

  let newId: string;
  try {
    if (!orgId || !storeId || !actingPersonId) {
      throw new Error('Organization, store and "acting as" are all required.');
    }
    const result = await withOrgPrincipal(orgId, (tx) =>
      createSalesDay(tx, { personId: actingPersonId, orgId }, {
        storeId,
        businessDate: str(formData, 'businessDate'),
        posSourced: formData.get('posSourced') === 'on',
        totalSales: amount(formData, 'totalSales'),
        unliSales: amount(formData, 'unliSales'),
        alaCarteSales: amount(formData, 'alaCarteSales'),
        seniorDiscount: amount(formData, 'seniorDiscount'),
        pwdDiscount: amount(formData, 'pwdDiscount'),
        otherDiscount: amount(formData, 'otherDiscount'),
        comps: amount(formData, 'comps'),
        serviceCharge: amount(formData, 'serviceCharge'),
        otherCharges: amount(formData, 'otherCharges'),
        cashCollected: amount(formData, 'cashCollected'),
        onlineCollected: amount(formData, 'onlineCollected'),
        creditSales: amount(formData, 'creditSales'),
        channels,
      }),
    );
    newId = result.id;
  } catch (err) {
    redirect(`/sales-days/new?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${newId}?${qs}`);
}

export async function submitSalesDayAction(formData: FormData): Promise<void> {
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(orgId, (tx) => submitSalesDay(tx, { personId: actingPersonId, orgId }, id));
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}

export async function verifySalesDayAction(formData: FormData): Promise<void> {
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(orgId, (tx) => verifySalesDay(tx, { personId: actingPersonId, orgId }, id));
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}

export async function voidSalesDayAction(formData: FormData): Promise<void> {
  const orgId = str(formData, 'orgId');
  const actingPersonId = str(formData, 'actingPersonId');
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(orgId, (tx) =>
      voidSalesDay(tx, { personId: actingPersonId, orgId }, id, str(formData, 'reason')),
    );
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}
