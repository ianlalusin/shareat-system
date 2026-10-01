'use server';

/**
 * Server actions for the sales-day screens — docs/tasks/123-sales-day.md.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. **No business rule is
 * re-implemented here** — `createSalesDay` / `submitSalesDay` / `verifySalesDay` / `voidSalesDay`
 * own every invariant, including the create-block and its carve-outs.
 *
 * ⭐ **The actor comes from `requireActor()`, never from the form** (T-138, bible §7.1). Until
 * 2026-08-25 these actions read an `actingPersonId` the browser supplied, which meant
 * `verify_sales_day` being a different capability from `submit_sales_day` proved nothing — anyone
 * could claim to be anyone. **The segregation only became real when this line changed.**
 */
import { redirect } from 'next/navigation';
import { createSalesDay, editSalesDay, submitSalesDay, verifySalesDay, voidSalesDay } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

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

/** Only the FILTER state travels in the URL now. The org and the person come from the session,
 *  and a store here names which store a day belongs to — not who is acting. */
function carryQs(fd: FormData): string {
  const params = new URLSearchParams();
  const store = str(fd, 'storeId');
  if (store) params.set('store', store);
  return params.toString();
}

/**
 * The figures, channels and tenders a sales-day form carries, parsed ONCE for create and edit.
 *
 * Channel rows arrive as channel_<id> / nosales_<id> pairs and tenders as tender_<id> - the id is in
 * the field name, so no index bookkeeping is needed and a missing row is simply absent.
 */
function parseDayFigures(formData: FormData) {
  // ⭐ DEF-068 — where the online money landed. Same field-name-carries-the-id trick the channel
  // rows use, so a missing wallet is simply absent rather than an index to keep in step.
  const tenders: { moneyAccountId: string; amount: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('tender_') || typeof value !== 'string') continue;
    const amount = value.trim();
    // Every wallet the form offered is named. Blank reads as zero ("nothing landed here"): no row on a
    // create, and on an edit it clears that wallet's row. A negative is passed on so the domain refuses
    // it in words; nothing typed is dropped silently.
    tenders.push({ moneyAccountId: key.slice('tender_'.length), amount: amount || '0' });
  }

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

  return {
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
    tenders,
  };
}

export async function createSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const qs = carryQs(formData);

  let newId: string;
  try {
    if (!storeId) throw new Error('Choose a store.');
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createSalesDay(tx, actor, {
        storeId,
        businessDate: str(formData, 'businessDate'),
        ...parseDayFigures(formData),
      }),
    );
    newId = result.id;
  } catch (err) {
    redirect(`/sales-days/new?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${newId}?${qs}`);
}

/**
 * T-369 S3 (DEF-479): fix an unverified day. Reads the same fields as create plus `salesDayId`; the
 * store and the date are NOT read - the domain never edits them (R1). The domain re-checks who may
 * edit which status, so a forged POST is refused there; every outcome returns to the day's own page.
 */
export async function editSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      editSalesDay(tx, actor, { salesDayId: id, ...parseDayFigures(formData) }),
    );
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}

export async function submitSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => submitSalesDay(tx, actor, id));
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}

export async function verifySalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => verifySalesDay(tx, actor, id));
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}

export async function voidSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const qs = carryQs(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => voidSalesDay(tx, actor, id, str(formData, 'reason')));
  } catch (err) {
    redirect(`/sales-days/${id}?${qs}&error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect(`/sales-days/${id}?${qs}`);
}
