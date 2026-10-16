
'use client';

import {
  type Firestore,
  type WriteBatch,
  type Transaction,
  increment,
  serverTimestamp,
  doc,
} from 'firebase/firestore';
import type { Receipt, ReceiptAnalyticsV2, KitchenTicket, LineAdjustment } from '@/lib/types';
import {
  dailyAnalyticsDocRef,
  getPaymentContribution,
  getGuestCoversContribution,
  getSalesContribution,
  getPeakHourContribution,
  getRefillContribution,
  getClosedSessionsContribution,
  getKitchenTicketContribution,
  getItemAdjustmentContribution,
  getDayOfWeekContribution,
} from './daily';
import { toJsDate } from '@/lib/utils/date';

type ContributionSet = {
  payment: ReturnType<typeof getPaymentContribution>;
  guest: ReturnType<typeof getGuestCoversContribution>;
  sales: ReturnType<typeof getSalesContribution>;
  peak: ReturnType<typeof getPeakHourContribution>;
  refill: ReturnType<typeof getRefillContribution>;
  closed: ReturnType<typeof getClosedSessionsContribution>;
  itemAdj: ReturnType<typeof getItemAdjustmentContribution>;
  dow: ReturnType<typeof getDayOfWeekContribution>;
};

// --- Date Helpers for Presets ---
function atStartOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const date = new Date(d.valueOf());
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Determines which dashboard presets are affected by a given event date.
 * @param eventDate The date of the receipt/event.
 * @returns An array of preset ID strings (e.g., ["today", "last7"]).
 */
export function getApplicablePresets(eventDate: Date): string[] {
  const applicable: string[] = [];
  const now = new Date();

  const today = atStartOfDay(now);
  const yesterday = addDays(today, -1);
  const sevenDaysAgo = addDays(today, -6);
  const thirtyDaysAgo = addDays(today, -29);
  const startOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
  const startOfYear = new Date(today.getFullYear(), 0, 1);

  const eventDay = atStartOfDay(eventDate);
  const eventTime = eventDay.getTime();

  if (eventTime === today.getTime()) {
    applicable.push("today");
  }
  if (eventTime === yesterday.getTime()) {
    applicable.push("yesterday");
  }
  if (eventTime >= sevenDaysAgo.getTime() && eventTime <= today.getTime()) {
    applicable.push("last7");
  }
  if (eventTime >= thirtyDaysAgo.getTime() && eventTime <= today.getTime()) {
    applicable.push("last30");
  }
  if (eventTime >= startOfThisMonth.getTime() && eventTime <= today.getTime()) {
    applicable.push("thisMonth");
  }
  if (eventTime >= startOfLastMonth.getTime() && eventTime <= endOfLastMonth.getTime()) {
    applicable.push("lastMonth");
  }
  if (eventTime >= startOfYear.getTime() && eventTime <= today.getTime()) {
    applicable.push("ytd");
  }

  return applicable;
}


function getContributions(receipt: Receipt | null): ContributionSet {
  return {
    payment: getPaymentContribution(receipt),
    guest: getGuestCoversContribution(receipt),
    sales: getSalesContribution(receipt),
    peak: getPeakHourContribution(receipt),
    refill: getRefillContribution(receipt),
    closed: getClosedSessionsContribution(receipt),
    itemAdj: getItemAdjustmentContribution(receipt),
    dow: getDayOfWeekContribution(receipt),
  };
}

/**
 * Zero out the parts of a contribution set that don't belong to the given day.
 *
 * Most families bucket by the PAYMENT day. Peak-hour and day-of-week bucket by the
 * ARRIVAL day (session start) so their hour/dow key agrees with the day doc they land
 * in — a party arriving 11:30 PM Sat and paying 12:30 AM Sun is Saturday 11 PM traffic,
 * not Sunday 11 PM traffic. Gating per family lets one receipt contribute arrival data
 * to one day and payment data to the next. Mirrors delta-core.pickDayContribution.
 */
function pickDayContribution(contrib: ContributionSet, dayId: string): ContributionSet {
    const nil = getContributions(null);
    const paymentDay = contrib.payment.dayId === dayId;
    return {
        payment: paymentDay ? contrib.payment : nil.payment,
        guest: paymentDay ? contrib.guest : nil.guest,
        sales: paymentDay ? contrib.sales : nil.sales,
        refill: paymentDay ? contrib.refill : nil.refill,
        closed: paymentDay ? contrib.closed : nil.closed,
        itemAdj: paymentDay ? contrib.itemAdj : nil.itemAdj,
        // Arrival-day families:
        peak: contrib.peak.dayId === dayId ? contrib.peak : nil.peak,
        dow: contrib.dow.dayId === dayId ? contrib.dow : nil.dow,
    };
}

function safeKey(s: string) {
  return (s || "Uncategorized")
    .trim()
    .replace(/\./g, "·")     // dot is not allowed in field path
    .replace(/\//g, "∕");    // avoid slash confusion
}

type Writer =
  | { kind: "tx"; tx: Transaction }
  | { kind: "batch"; batch: WriteBatch };

function writerSet(w: Writer, ref: any, data: any, opts: any) {
  if (w.kind === "tx") return w.tx.set(ref, data, opts);
  return w.batch.set(ref, data, opts);
}

function writerUpdate(w: Writer, ref: any, data: any) {
  if (w.kind === "tx") return w.tx.update(ref, data);
  return w.batch.update(ref, data);
}

/**
 * Calculates and applies the change (delta) between an old and a new receipt
 * to the daily, monthly, yearly, AND preset analytics documents. This can be part of a larger batch.
 *
 * @param db The Firestore instance.
 * @param storeId The ID of the store to backfill.
 * @param oldReceipt The receipt data *before* the change (or the receipt being deleted).
 * @param newReceipt The receipt data *after* the change (or null if deleting).
 * @param opts Optional object containing a Transaction or WriteBatch to join.
 */
export async function applyAnalyticsDeltaV2(
  db: Firestore,
  storeId: string,
  oldReceipt: Receipt | null,
  newReceipt: Receipt | null,
  opts?: { tx?: Transaction; batch?: WriteBatch; dayExtraIncrements?: Record<string, number> }
) {
  const w: Writer | null =
    opts?.tx ? { kind: "tx", tx: opts.tx } :
    opts?.batch ? { kind: "batch", batch: opts.batch } :
    null;

  if (!w) throw new Error("applyAnalyticsDeltaV2 requires tx or batch.");

  const oldContrib = getContributions(oldReceipt);
  const newContrib = getContributions(newReceipt);

  // Payment days plus arrival days (peak-hour / DOW bucket by session start, which
  // falls on the previous day whenever a session crosses midnight).
  const affectedDayIds = new Set<string>();
  for (const c of [oldContrib, newContrib]) {
    if (c.payment.dayId) affectedDayIds.add(c.payment.dayId);
    if (c.peak.dayId) affectedDayIds.add(c.peak.dayId);
    if (c.dow.dayId) affectedDayIds.add(c.dow.dayId);
  }
  if (affectedDayIds.size === 0) {
    console.warn("[applyAnalyticsDeltaV2] No valid dayId found. Skipping.");
    return;
  }

  for (const dayId of affectedDayIds) {
    const dayOld = pickDayContribution(oldContrib, dayId);
    const dayNew = pickDayContribution(newContrib, dayId);

    // An arrival-only day (session crossed midnight) has no payment contribution, so
    // fall through to the peak/dow day start rather than writing dayStartMs: 0.
    const dayStartMs = [
      dayNew.payment.dayStartMs, dayNew.peak.dayStartMs, dayNew.dow.dayStartMs,
      dayOld.payment.dayStartMs, dayOld.peak.dayStartMs, dayOld.dow.dayStartMs,
    ].find(ms => ms > 0) ?? 0;

    const dayRef = dailyAnalyticsDocRef(db, storeId, dayId);
    const monthId = dayId.slice(0, 6);
    const yearId = dayId.slice(0, 4);
    const monthRef = doc(db, "stores", storeId, "analyticsMonths", monthId);
    const yearRef  = doc(db, "stores", storeId, "analyticsYears", yearId);

    // --- 1. Get Applicable Presets ---
    const eventDate = toJsDate(dayStartMs);
    const applicablePresets = eventDate ? getApplicablePresets(eventDate) : [];
    
    // --- 2. Ensure Docs Exist ---
    const metaPayload = { meta: { storeId, updatedAt: serverTimestamp() }};
    writerSet(w, dayRef, { meta: { ...metaPayload.meta, dayId, dayStartMs } }, { merge: true });
    writerSet(w, monthRef, { meta: { ...metaPayload.meta, monthId } }, { merge: true });
    writerSet(w, yearRef, { meta: { ...metaPayload.meta, yearId } }, { merge: true });
    
    // Ensure preset docs exist
    for (const presetId of applicablePresets) {
        const presetRef = doc(db, "stores", storeId, "dashPresets", presetId);
        writerSet(w, presetRef, { meta: { presetId, storeId, source: "delta-v2", updatedAt: serverTimestamp() } }, { merge: true });
    }

    // --- 3. Prepare and apply increments ---
    const payload: Record<string, any> = {
      "meta.updatedAt": serverTimestamp(),
    };
    
    // --- Payments Delta ---
    const paymentDelta = {
      totalGross: dayNew.payment.totalGross - dayOld.payment.totalGross,
      txCount: dayNew.payment.txCount - dayOld.payment.txCount,
      discountsTotal: dayNew.payment.discountsTotal - dayOld.payment.discountsTotal,
      chargesTotal: dayNew.payment.chargesTotal - dayOld.payment.chargesTotal,
    };
    if (paymentDelta.totalGross !== 0) payload['payments.totalGross'] = increment(paymentDelta.totalGross);
    if (paymentDelta.txCount !== 0) payload['payments.txCount'] = increment(paymentDelta.txCount);
    if (paymentDelta.discountsTotal !== 0) payload['payments.discountsTotal'] = increment(paymentDelta.discountsTotal);
    if (paymentDelta.chargesTotal !== 0) payload['payments.chargesTotal'] = increment(paymentDelta.chargesTotal);
    
    const allPaymentMethods = new Set([...Object.keys(dayOld.payment.byMethod), ...Object.keys(dayNew.payment.byMethod)]);
    allPaymentMethods.forEach(method => {
      const delta = (dayNew.payment.byMethod[method] || 0) - (dayOld.payment.byMethod[method] || 0);
      if (delta !== 0) payload[`payments.byMethod.${safeKey(method)}`] = increment(delta);
    });

    // --- Guests Delta ---
    const guestDelta = {
      guestCountFinalTotal: dayNew.guest.guestCountFinal - dayOld.guest.guestCountFinal,
      packageSessionsCount: dayNew.guest.packageSessionsCount - dayOld.guest.packageSessionsCount,
    };
    if (guestDelta.guestCountFinalTotal !== 0) payload['guests.guestCountFinalTotal'] = increment(guestDelta.guestCountFinalTotal);
    if (guestDelta.packageSessionsCount !== 0) payload['guests.packageSessionsCount'] = increment(guestDelta.packageSessionsCount);
    
    const allGuestPkgNames = new Set([...Object.keys(dayOld.guest.guestCountFinalByPackageName), ...Object.keys(dayNew.guest.guestCountFinalByPackageName)]);
    allGuestPkgNames.forEach(name => {
        const delta = (dayNew.guest.guestCountFinalByPackageName[name] || 0) - (dayOld.guest.guestCountFinalByPackageName[name] || 0);
        if (delta !== 0) payload[`guests.guestCountFinalByPackageName.${safeKey(name)}`] = increment(delta);
    });

    const allBilledPkgNames = new Set([...Object.keys(dayOld.guest.packageCoversBilledByPackageName), ...Object.keys(dayNew.guest.packageCoversBilledByPackageName)]);
    allBilledPkgNames.forEach(name => {
        const delta = (dayNew.guest.packageCoversBilledByPackageName[name] || 0) - (dayOld.guest.packageCoversBilledByPackageName[name] || 0);
        if (delta !== 0) payload[`guests.packageCoversBilledByPackageName.${safeKey(name)}`] = increment(delta);
    });

    // --- Sales Delta ---
    const salesDelta = {
        dineInAddonSalesAmount: (dayNew.sales.dineInAddonSalesAmount || 0) - (dayOld.sales.dineInAddonSalesAmount || 0),
        dineInSalesGross: (dayNew.sales.dineInSalesGross || 0) - (dayOld.sales.dineInSalesGross || 0),
        dineInDiscountsTotal: (dayNew.sales.dineInDiscountsTotal || 0) - (dayOld.sales.dineInDiscountsTotal || 0),
        dineInChargesTotal: (dayNew.sales.dineInChargesTotal || 0) - (dayOld.sales.dineInChargesTotal || 0),
    };
    if (salesDelta.dineInAddonSalesAmount !== 0) payload['sales.dineInAddonSalesAmount'] = increment(salesDelta.dineInAddonSalesAmount);
    if (salesDelta.dineInSalesGross !== 0) payload['sales.dineInSalesGross'] = increment(salesDelta.dineInSalesGross);
    if (salesDelta.dineInDiscountsTotal !== 0) payload['sales.dineInDiscountsTotal'] = increment(salesDelta.dineInDiscountsTotal);
    if (salesDelta.dineInChargesTotal !== 0) payload['sales.dineInChargesTotal'] = increment(salesDelta.dineInChargesTotal);

    const allSalesPkgNames = new Set([
      ...Object.keys(dayOld.sales.packageSalesAmountByName || {}),
      ...Object.keys(dayNew.sales.packageSalesAmountByName || {}),
    ]);
    allSalesPkgNames.forEach(name => {
        const amountDelta = (dayNew.sales.packageSalesAmountByName[name] || 0) - (dayOld.sales.packageSalesAmountByName[name] || 0);
        const qtyDelta = (dayNew.sales.packageSalesQtyByName[name] || 0) - (dayOld.sales.packageSalesQtyByName[name] || 0);
        if(amountDelta !== 0) payload[`sales.packageSalesAmountByName.${safeKey(name)}`] = increment(amountDelta);
        if(qtyDelta !== 0) payload[`sales.packageSalesQtyByName.${safeKey(name)}`] = increment(qtyDelta);
    });

    const catQtyDelta: Record<string, number> = {};
    const catAmtDelta: Record<string, number> = {};
    
    const allAddonItems = new Set([
      ...Object.keys(dayOld.sales.addonSalesByItem || {}),
      ...Object.keys(dayNew.sales.addonSalesByItem || {}),
    ]);

    allAddonItems.forEach((itemName) => {
      const oldItem = dayOld.sales.addonSalesByItem?.[itemName];
      const newItem = dayNew.sales.addonSalesByItem?.[itemName];

      const qtyDelta = (newItem?.qty || 0) - (oldItem?.qty || 0);
      const amtDelta = (newItem?.amount || 0) - (oldItem?.amount || 0);
      
      if (qtyDelta !== 0) {
          payload[`sales.addonSalesByItem.${safeKey(itemName)}.qty`] = increment(qtyDelta);
      }
      if (amtDelta !== 0) {
           payload[`sales.addonSalesByItem.${safeKey(itemName)}.amount`] = increment(amtDelta);
      }

      const cat = safeKey(newItem?.categoryName ?? oldItem?.categoryName ?? "Uncategorized");
      catQtyDelta[cat] = (catQtyDelta[cat] ?? 0) + qtyDelta;
      catAmtDelta[cat] = (catAmtDelta[cat] ?? 0) + amtDelta;
    });

    for (const [cat, qd] of Object.entries(catQtyDelta)) {
      if (qd !== 0) payload[`sales.addonSalesQtyByCategory.${safeKey(cat)}`] = increment(qd);
    }
    for (const [cat, ad] of Object.entries(catAmtDelta)) {
      if (ad !== 0) payload[`sales.addonSalesAmountByCategory.${safeKey(cat)}`] = increment(ad);
    }
    
    // --- Peak Hour Delta ---
    if (dayOld.peak.hourKey !== dayNew.peak.hourKey) {
        if(dayOld.peak.hourKey && dayOld.peak.count > 0) {
          payload[`sales.salesAmountByHour.${dayOld.peak.hourKey}`] = increment(-dayOld.peak.amount);
          payload[`sales.sessionCountByHour.${dayOld.peak.hourKey}`] = increment(-dayOld.peak.count);
        }
        if(dayNew.peak.hourKey && dayNew.peak.count > 0) {
          payload[`sales.salesAmountByHour.${dayNew.peak.hourKey}`] = increment(dayNew.peak.amount);
          payload[`sales.sessionCountByHour.${dayNew.peak.hourKey}`] = increment(dayNew.peak.count);
        }
    } else if (dayNew.peak.hourKey && (dayNew.peak.amount !== dayOld.peak.amount)) {
        const amountDelta = dayNew.peak.amount - dayOld.peak.amount;
        if(amountDelta !== 0) payload[`sales.salesAmountByHour.${dayNew.peak.hourKey}`] = increment(amountDelta);
    }

    // --- Peak Hour by Mode Delta ---
    // Bucket key: `${mode}.${hourKey}`. Subtract old bucket, add new bucket. Net out when buckets are equal.
    {
      const oldKey = (dayOld.peak.mode && dayOld.peak.hourKey && dayOld.peak.count > 0)
        ? `${dayOld.peak.mode}.${dayOld.peak.hourKey}` : null;
      const newKey = (dayNew.peak.mode && dayNew.peak.hourKey && dayNew.peak.count > 0)
        ? `${dayNew.peak.mode}.${dayNew.peak.hourKey}` : null;
      const amtBuckets: Record<string, number> = {};
      const cntBuckets: Record<string, number> = {};
      if (oldKey) {
        amtBuckets[oldKey] = (amtBuckets[oldKey] || 0) - dayOld.peak.amount;
        cntBuckets[oldKey] = (cntBuckets[oldKey] || 0) - dayOld.peak.count;
      }
      if (newKey) {
        amtBuckets[newKey] = (amtBuckets[newKey] || 0) + dayNew.peak.amount;
        cntBuckets[newKey] = (cntBuckets[newKey] || 0) + dayNew.peak.count;
      }
      for (const [k, v] of Object.entries(amtBuckets)) {
        if (v !== 0) payload[`sales.salesAmountByHourByMode.${k}`] = increment(v);
      }
      for (const [k, v] of Object.entries(cntBuckets)) {
        if (v !== 0) payload[`sales.sessionCountByHourByMode.${k}`] = increment(v);
      }
    }

    // --- Sales by Mode Totals Delta (gross + net) ---
    for (const m of ["dineIn", "walkIn"] as const) {
      const grossDelta = (dayNew.sales.salesGrossByMode?.[m] || 0) - (dayOld.sales.salesGrossByMode?.[m] || 0);
      const netDelta = (dayNew.sales.netSalesByMode?.[m] || 0) - (dayOld.sales.netSalesByMode?.[m] || 0);
      if (grossDelta !== 0) payload[`sales.salesAmountByMode.${m}`] = increment(grossDelta);
      if (netDelta !== 0) payload[`sales.netSalesByMode.${m}`] = increment(netDelta);
    }

    // --- Day-of-Week Delta ---
    {
      const oldKey = dayOld.dow.dowKey && dayOld.dow.count > 0 ? dayOld.dow.dowKey : null;
      const newKey = dayNew.dow.dowKey && dayNew.dow.count > 0 ? dayNew.dow.dowKey : null;
      const amtBuckets: Record<string, number> = {};
      const cntBuckets: Record<string, number> = {};
      if (oldKey) {
        amtBuckets[oldKey] = (amtBuckets[oldKey] || 0) - dayOld.dow.amount;
        cntBuckets[oldKey] = (cntBuckets[oldKey] || 0) - dayOld.dow.count;
      }
      if (newKey) {
        amtBuckets[newKey] = (amtBuckets[newKey] || 0) + dayNew.dow.amount;
        cntBuckets[newKey] = (cntBuckets[newKey] || 0) + dayNew.dow.count;
      }
      for (const [k, v] of Object.entries(amtBuckets)) {
        if (v !== 0) payload[`sales.salesAmountByDow.${k}`] = increment(v);
      }
      for (const [k, v] of Object.entries(cntBuckets)) {
        if (v !== 0) payload[`sales.sessionCountByDow.${k}`] = increment(v);
      }
    }

    // --- Closed Sessions Delta ---
    if (dayNew.closed.closedCount !== dayOld.closed.closedCount) payload['sessions.closedCount'] = increment(dayNew.closed.closedCount - dayOld.closed.closedCount);
    if (dayNew.closed.totalPaid !== dayOld.closed.totalPaid) payload['sessions.totalPaid'] = increment(dayNew.closed.totalPaid - dayOld.closed.totalPaid);

    // --- Closed Sessions by Mode Delta ---
    {
      const oldKey = dayOld.closed.mode && dayOld.closed.closedCount > 0 ? dayOld.closed.mode : null;
      const newKey = dayNew.closed.mode && dayNew.closed.closedCount > 0 ? dayNew.closed.mode : null;
      const buckets: Record<string, number> = {};
      if (oldKey) buckets[oldKey] = (buckets[oldKey] || 0) - dayOld.closed.closedCount;
      if (newKey) buckets[newKey] = (buckets[newKey] || 0) + dayNew.closed.closedCount;
      for (const [k, v] of Object.entries(buckets)) {
        if (v !== 0) payload[`sessions.closedCountByMode.${k}`] = increment(v);
      }
    }

    // --- Dine-in Session Duration Delta ---
    {
      const durDelta = dayNew.closed.dineInDurationMs - dayOld.closed.dineInDurationMs;
      const cntDelta = dayNew.closed.dineInDurationCount - dayOld.closed.dineInDurationCount;
      if (durDelta !== 0) payload['sessions.dineInDurationMsSum'] = increment(durDelta);
      if (cntDelta !== 0) payload['sessions.dineInDurationCount'] = increment(cntDelta);
    }

    // --- Payments TxCount by Mode Delta ---
    {
      const oldKey = dayOld.payment.mode && dayOld.payment.txCount > 0 ? dayOld.payment.mode : null;
      const newKey = dayNew.payment.mode && dayNew.payment.txCount > 0 ? dayNew.payment.mode : null;
      const buckets: Record<string, number> = {};
      if (oldKey) buckets[oldKey] = (buckets[oldKey] || 0) - dayOld.payment.txCount;
      if (newKey) buckets[newKey] = (buckets[newKey] || 0) + dayNew.payment.txCount;
      for (const [k, v] of Object.entries(buckets)) {
        if (v !== 0) payload[`payments.txCountByMode.${k}`] = increment(v);
      }
    }

    // --- Item Adjustment Delta ---
    const adjOld = dayOld.itemAdj;
    const adjNew = dayNew.itemAdj;
    if (adjNew.voidedQty !== adjOld.voidedQty) payload['items.voidedQty'] = increment(adjNew.voidedQty - adjOld.voidedQty);
    if (adjNew.voidedAmount !== adjOld.voidedAmount) payload['items.voidedAmount'] = increment(adjNew.voidedAmount - adjOld.voidedAmount);
    if (adjNew.freeQty !== adjOld.freeQty) payload['items.freeQty'] = increment(adjNew.freeQty - adjOld.freeQty);
    if (adjNew.freeAmount !== adjOld.freeAmount) payload['items.freeAmount'] = increment(adjNew.freeAmount - adjOld.freeAmount);
    if (adjNew.discountedQty !== adjOld.discountedQty) payload['items.discountedQty'] = increment(adjNew.discountedQty - adjOld.discountedQty);
    if (adjNew.discountedAmount !== adjOld.discountedAmount) payload['items.discountedAmount'] = increment(adjNew.discountedAmount - adjOld.discountedAmount);
    if (adjNew.refundCount !== adjOld.refundCount) payload['items.refundCount'] = increment(adjNew.refundCount - adjOld.refundCount);
    if (adjNew.refundTotal !== adjOld.refundTotal) payload['items.refundTotal'] = increment(adjNew.refundTotal - adjOld.refundTotal);
    
    // --- Refills Delta ---
    if(dayNew.refill.packageSessionsCount !== dayOld.refill.packageSessionsCount) payload['refills.packageSessionsCount'] = increment(dayNew.refill.packageSessionsCount - dayOld.refill.packageSessionsCount);
    if(dayNew.refill.servedRefillsTotal !== dayOld.refill.servedRefillsTotal) payload['refills.servedRefillsTotal'] = increment(dayNew.refill.servedRefillsTotal - dayOld.refill.servedRefillsTotal);

    const allRefillNames = new Set([
      ...Object.keys(dayOld.refill?.servedRefillsByName || {}),
      ...Object.keys(dayNew.refill?.servedRefillsByName || {}),
    ]);
    allRefillNames.forEach((refillName) => {
        const oldQty = (dayOld.refill?.servedRefillsByName?.[refillName] ?? 0) as number;
        const newQty = (dayNew.refill?.servedRefillsByName?.[refillName] ?? 0) as number;
      
        const qtyDelta = newQty - oldQty;
        if (qtyDelta === 0) return;

        payload[`refills.servedRefillsByName.${safeKey(refillName)}`] = increment(qtyDelta);
    });
    
    // --- Apply final updates to rollup docs ---
    // Day-only extras (e.g. payments.voidCashRetainedTotal) apply to the day doc
    // only — retained void cash is a daily-remittance concept, not a month/year
    // rollup metric. Mirrors applyAnalyticsDeltaServer.
    const dayPayload = opts?.dayExtraIncrements
      ? { ...payload, ...Object.fromEntries(
            Object.entries(opts.dayExtraIncrements).map(([k, v]) => [k, increment(v)]),
          ) }
      : payload;
    writerUpdate(w, dayRef, dayPayload);
    writerUpdate(w, monthRef, payload);
    writerUpdate(w, yearRef, payload);

    // --- Apply final updates to PRESET docs ---
    for (const presetId of applicablePresets) {
        const presetRef = doc(db, "stores", storeId, "dashPresets", presetId);
        writerUpdate(w, presetRef, payload);
    }
  }

  // NOTE: callers always pass a `tx` or `batch` (payment / refund / void / edit
  // paths). The former standalone-commit branch (which fell back to a client-side
  // rebuild) was removed when the analytics rollup collections became server-only
  // writes — the server endpoints + reconcile cron own that path now.
}

    