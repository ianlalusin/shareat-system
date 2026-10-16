// Pure, SDK-agnostic analytics delta math. No firebase imports — safe to run on
// the server (admin SDK) and unit-testable. The client writer
// (applyAnalyticsDeltaV2.ts) keeps its own inline copy for now; it is slated for
// removal once the payment flow is switched to the server endpoint (Stage B).

import type { Receipt } from "@/lib/types";
import {
  getPaymentContribution,
  getGuestCoversContribution,
  getSalesContribution,
  getPeakHourContribution,
  getRefillContribution,
  getClosedSessionsContribution,
  getItemAdjustmentContribution,
  getDayOfWeekContribution,
} from "@/lib/analytics/daily";

export type ContributionSet = {
  payment: ReturnType<typeof getPaymentContribution>;
  guest: ReturnType<typeof getGuestCoversContribution>;
  sales: ReturnType<typeof getSalesContribution>;
  peak: ReturnType<typeof getPeakHourContribution>;
  refill: ReturnType<typeof getRefillContribution>;
  closed: ReturnType<typeof getClosedSessionsContribution>;
  itemAdj: ReturnType<typeof getItemAdjustmentContribution>;
  dow: ReturnType<typeof getDayOfWeekContribution>;
};

export function getContributions(receipt: Receipt | null): ContributionSet {
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
 * to one day and payment data to the next.
 */
export function pickDayContribution(contrib: ContributionSet, dayId: string): ContributionSet {
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

/** Manila midnight for a day doc, whichever family supplied it. */
export function dayStartMsOf(...sets: ContributionSet[]): number {
  for (const s of sets) {
    for (const ms of [s.payment.dayStartMs, s.peak.dayStartMs, s.dow.dayStartMs]) {
      if (ms > 0) return ms;
    }
  }
  return 0;
}

export function safeKey(s: string): string {
  return (s || "Uncategorized").trim().replace(/\./g, "·").replace(/\//g, "∕");
}

// --- Preset windows -------------------------------------------------------
// All day boundaries are anchored to Asia/Manila (UTC+8, no DST), NOT the host
// machine's local timezone. The old setHours()-based approach produced *host-
// local* midnight, so on the UTC production server a Manila-midnight timestamp
// (16:00Z the prior day) was bucketed into the previous day — sending "today"'s
// sales into the "yesterday" dashboard preset. Mirrors getDayStartMs in daily.ts.
const MS_PER_DAY = 86_400_000;

/** Asia/Manila calendar parts (year, month 1-12, day) for an instant. */
function manilaParts(d: Date): { y: number; m: number; day: number } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const [y, m, day] = ymd.split("-").map(Number);
  return { y, m, day };
}

/** Epoch ms of Manila midnight (start of the Manila calendar day) for an instant. */
function manilaDayStartMs(d: Date): number {
  const { y, m, day } = manilaParts(d);
  return Date.parse(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+08:00`);
}

/** Epoch ms of Manila midnight for the 1st of a given Manila year/month. */
function manilaMonthStartMs(y: number, m: number): number {
  return Date.parse(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+08:00`);
}

/**
 * Which dashboard presets an event date falls into. `now` is explicit so the
 * server can pass authoritative server time instead of the client wall-clock
 * (M-5: client-clock skew around midnight bucketed receipts into the wrong
 * preset). All windows are computed in Asia/Manila, so the result is identical
 * whether this runs in the UTC server or a PHT browser.
 */
export function getApplicablePresets(eventDate: Date, now: Date = new Date()): string[] {
  const applicable: string[] = [];

  const todayMs = manilaDayStartMs(now);
  const eventMs = manilaDayStartMs(eventDate);
  const yesterdayMs = todayMs - MS_PER_DAY; // Manila has no DST → exact day math
  const sevenDaysAgoMs = todayMs - 6 * MS_PER_DAY;
  const thirtyDaysAgoMs = todayMs - 29 * MS_PER_DAY;

  const { y, m } = manilaParts(now);
  const startOfThisMonthMs = manilaMonthStartMs(y, m);
  const startOfLastMonthMs = manilaMonthStartMs(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  const endOfLastMonthMs = startOfThisMonthMs - MS_PER_DAY; // Manila midnight of last month's final day
  const startOfYearMs = manilaMonthStartMs(y, 1);

  if (eventMs === todayMs) applicable.push("today");
  if (eventMs === yesterdayMs) applicable.push("yesterday");
  if (eventMs >= sevenDaysAgoMs && eventMs <= todayMs) applicable.push("last7");
  if (eventMs >= thirtyDaysAgoMs && eventMs <= todayMs) applicable.push("last30");
  if (eventMs >= startOfThisMonthMs && eventMs <= todayMs) applicable.push("thisMonth");
  if (eventMs >= startOfLastMonthMs && eventMs <= endOfLastMonthMs) applicable.push("lastMonth");
  if (eventMs >= startOfYearMs && eventMs <= todayMs) applicable.push("ytd");

  return applicable;
}

// --- Delta increments -----------------------------------------------------
/**
 * Plain field-path -> increment map for one day's old->new contribution delta.
 * The caller wraps each number in its SDK's increment() sentinel. Faithful port
 * of applyAnalyticsDeltaV2's payload logic, returning numbers instead of
 * client-SDK increment() sentinels so it is testable and SDK-agnostic.
 */
export function buildDeltaIncrements(dayOld: ContributionSet, dayNew: ContributionSet): Record<string, number> {
  const out: Record<string, number> = {};
  const inc = (key: string, val: number) => {
    if (val !== 0) out[key] = (out[key] || 0) + val;
  };

  // Payments
  inc("payments.totalGross", dayNew.payment.totalGross - dayOld.payment.totalGross);
  inc("payments.txCount", dayNew.payment.txCount - dayOld.payment.txCount);
  inc("payments.discountsTotal", dayNew.payment.discountsTotal - dayOld.payment.discountsTotal);
  inc("payments.chargesTotal", dayNew.payment.chargesTotal - dayOld.payment.chargesTotal);
  for (const method of new Set([...Object.keys(dayOld.payment.byMethod), ...Object.keys(dayNew.payment.byMethod)])) {
    inc(`payments.byMethod.${safeKey(method)}`, (dayNew.payment.byMethod[method] || 0) - (dayOld.payment.byMethod[method] || 0));
  }

  // Guests
  inc("guests.guestCountFinalTotal", dayNew.guest.guestCountFinal - dayOld.guest.guestCountFinal);
  inc("guests.packageSessionsCount", dayNew.guest.packageSessionsCount - dayOld.guest.packageSessionsCount);
  for (const name of new Set([...Object.keys(dayOld.guest.guestCountFinalByPackageName), ...Object.keys(dayNew.guest.guestCountFinalByPackageName)])) {
    inc(`guests.guestCountFinalByPackageName.${safeKey(name)}`, (dayNew.guest.guestCountFinalByPackageName[name] || 0) - (dayOld.guest.guestCountFinalByPackageName[name] || 0));
  }
  for (const name of new Set([...Object.keys(dayOld.guest.packageCoversBilledByPackageName), ...Object.keys(dayNew.guest.packageCoversBilledByPackageName)])) {
    inc(`guests.packageCoversBilledByPackageName.${safeKey(name)}`, (dayNew.guest.packageCoversBilledByPackageName[name] || 0) - (dayOld.guest.packageCoversBilledByPackageName[name] || 0));
  }

  // Sales totals
  inc("sales.dineInAddonSalesAmount", (dayNew.sales.dineInAddonSalesAmount || 0) - (dayOld.sales.dineInAddonSalesAmount || 0));
  inc("sales.dineInSalesGross", (dayNew.sales.dineInSalesGross || 0) - (dayOld.sales.dineInSalesGross || 0));
  inc("sales.dineInDiscountsTotal", (dayNew.sales.dineInDiscountsTotal || 0) - (dayOld.sales.dineInDiscountsTotal || 0));
  inc("sales.dineInChargesTotal", (dayNew.sales.dineInChargesTotal || 0) - (dayOld.sales.dineInChargesTotal || 0));
  for (const name of new Set([...Object.keys(dayOld.sales.packageSalesAmountByName || {}), ...Object.keys(dayNew.sales.packageSalesAmountByName || {})])) {
    inc(`sales.packageSalesAmountByName.${safeKey(name)}`, (dayNew.sales.packageSalesAmountByName[name] || 0) - (dayOld.sales.packageSalesAmountByName[name] || 0));
    inc(`sales.packageSalesQtyByName.${safeKey(name)}`, (dayNew.sales.packageSalesQtyByName[name] || 0) - (dayOld.sales.packageSalesQtyByName[name] || 0));
  }

  // Addon items + category rollups
  const catQtyDelta: Record<string, number> = {};
  const catAmtDelta: Record<string, number> = {};
  for (const itemName of new Set([...Object.keys(dayOld.sales.addonSalesByItem || {}), ...Object.keys(dayNew.sales.addonSalesByItem || {})])) {
    const oldItem = dayOld.sales.addonSalesByItem?.[itemName];
    const newItem = dayNew.sales.addonSalesByItem?.[itemName];
    const qtyDelta = (newItem?.qty || 0) - (oldItem?.qty || 0);
    const amtDelta = (newItem?.amount || 0) - (oldItem?.amount || 0);
    inc(`sales.addonSalesByItem.${safeKey(itemName)}.qty`, qtyDelta);
    inc(`sales.addonSalesByItem.${safeKey(itemName)}.amount`, amtDelta);
    const cat = safeKey(newItem?.categoryName ?? oldItem?.categoryName ?? "Uncategorized");
    catQtyDelta[cat] = (catQtyDelta[cat] ?? 0) + qtyDelta;
    catAmtDelta[cat] = (catAmtDelta[cat] ?? 0) + amtDelta;
  }
  for (const [cat, qd] of Object.entries(catQtyDelta)) inc(`sales.addonSalesQtyByCategory.${safeKey(cat)}`, qd);
  for (const [cat, ad] of Object.entries(catAmtDelta)) inc(`sales.addonSalesAmountByCategory.${safeKey(cat)}`, ad);

  // Peak hour
  if (dayOld.peak.hourKey !== dayNew.peak.hourKey) {
    if (dayOld.peak.hourKey && dayOld.peak.count > 0) {
      inc(`sales.salesAmountByHour.${dayOld.peak.hourKey}`, -dayOld.peak.amount);
      inc(`sales.sessionCountByHour.${dayOld.peak.hourKey}`, -dayOld.peak.count);
    }
    if (dayNew.peak.hourKey && dayNew.peak.count > 0) {
      inc(`sales.salesAmountByHour.${dayNew.peak.hourKey}`, dayNew.peak.amount);
      inc(`sales.sessionCountByHour.${dayNew.peak.hourKey}`, dayNew.peak.count);
    }
  } else if (dayNew.peak.hourKey && dayNew.peak.amount !== dayOld.peak.amount) {
    inc(`sales.salesAmountByHour.${dayNew.peak.hourKey}`, dayNew.peak.amount - dayOld.peak.amount);
  }

  // Peak hour by mode
  {
    const oldKey = dayOld.peak.mode && dayOld.peak.hourKey && dayOld.peak.count > 0 ? `${dayOld.peak.mode}.${dayOld.peak.hourKey}` : null;
    const newKey = dayNew.peak.mode && dayNew.peak.hourKey && dayNew.peak.count > 0 ? `${dayNew.peak.mode}.${dayNew.peak.hourKey}` : null;
    if (oldKey) { inc(`sales.salesAmountByHourByMode.${oldKey}`, -dayOld.peak.amount); inc(`sales.sessionCountByHourByMode.${oldKey}`, -dayOld.peak.count); }
    if (newKey) { inc(`sales.salesAmountByHourByMode.${newKey}`, dayNew.peak.amount); inc(`sales.sessionCountByHourByMode.${newKey}`, dayNew.peak.count); }
  }

  // Sales by mode totals (gross + net)
  for (const m of ["dineIn", "walkIn"] as const) {
    inc(`sales.salesAmountByMode.${m}`, (dayNew.sales.salesGrossByMode?.[m] || 0) - (dayOld.sales.salesGrossByMode?.[m] || 0));
    inc(`sales.netSalesByMode.${m}`, (dayNew.sales.netSalesByMode?.[m] || 0) - (dayOld.sales.netSalesByMode?.[m] || 0));
  }

  // Day of week
  {
    const oldKey = dayOld.dow.dowKey && dayOld.dow.count > 0 ? dayOld.dow.dowKey : null;
    const newKey = dayNew.dow.dowKey && dayNew.dow.count > 0 ? dayNew.dow.dowKey : null;
    if (oldKey) { inc(`sales.salesAmountByDow.${oldKey}`, -dayOld.dow.amount); inc(`sales.sessionCountByDow.${oldKey}`, -dayOld.dow.count); }
    if (newKey) { inc(`sales.salesAmountByDow.${newKey}`, dayNew.dow.amount); inc(`sales.sessionCountByDow.${newKey}`, dayNew.dow.count); }
  }

  // Closed sessions
  inc("sessions.closedCount", dayNew.closed.closedCount - dayOld.closed.closedCount);
  inc("sessions.totalPaid", dayNew.closed.totalPaid - dayOld.closed.totalPaid);
  {
    const oldKey = dayOld.closed.mode && dayOld.closed.closedCount > 0 ? dayOld.closed.mode : null;
    const newKey = dayNew.closed.mode && dayNew.closed.closedCount > 0 ? dayNew.closed.mode : null;
    if (oldKey) inc(`sessions.closedCountByMode.${oldKey}`, -dayOld.closed.closedCount);
    if (newKey) inc(`sessions.closedCountByMode.${newKey}`, dayNew.closed.closedCount);
  }
  inc("sessions.dineInDurationMsSum", dayNew.closed.dineInDurationMs - dayOld.closed.dineInDurationMs);
  inc("sessions.dineInDurationCount", dayNew.closed.dineInDurationCount - dayOld.closed.dineInDurationCount);

  // Payments txCount by mode
  {
    const oldKey = dayOld.payment.mode && dayOld.payment.txCount > 0 ? dayOld.payment.mode : null;
    const newKey = dayNew.payment.mode && dayNew.payment.txCount > 0 ? dayNew.payment.mode : null;
    if (oldKey) inc(`payments.txCountByMode.${oldKey}`, -dayOld.payment.txCount);
    if (newKey) inc(`payments.txCountByMode.${newKey}`, dayNew.payment.txCount);
  }

  // Item adjustments
  const a0 = dayOld.itemAdj, a1 = dayNew.itemAdj;
  inc("items.voidedQty", a1.voidedQty - a0.voidedQty);
  inc("items.voidedAmount", a1.voidedAmount - a0.voidedAmount);
  inc("items.freeQty", a1.freeQty - a0.freeQty);
  inc("items.freeAmount", a1.freeAmount - a0.freeAmount);
  inc("items.discountedQty", a1.discountedQty - a0.discountedQty);
  inc("items.discountedAmount", a1.discountedAmount - a0.discountedAmount);
  inc("items.refundCount", a1.refundCount - a0.refundCount);
  inc("items.refundTotal", a1.refundTotal - a0.refundTotal);

  // Refills
  inc("refills.packageSessionsCount", dayNew.refill.packageSessionsCount - dayOld.refill.packageSessionsCount);
  inc("refills.servedRefillsTotal", dayNew.refill.servedRefillsTotal - dayOld.refill.servedRefillsTotal);
  for (const name of new Set([...Object.keys(dayOld.refill?.servedRefillsByName || {}), ...Object.keys(dayNew.refill?.servedRefillsByName || {})])) {
    inc(`refills.servedRefillsByName.${safeKey(name)}`, (dayNew.refill?.servedRefillsByName?.[name] ?? 0) - (dayOld.refill?.servedRefillsByName?.[name] ?? 0));
  }

  return out;
}

/**
 * Day ids touched by an old->new receipt delta: the payment days plus the arrival
 * days (peak-hour / day-of-week), which differ when a session crosses midnight.
 */
export function affectedDayIds(oldContrib: ContributionSet, newContrib: ContributionSet): string[] {
  const ids = new Set<string>();
  for (const c of [oldContrib, newContrib]) {
    if (c.payment.dayId) ids.add(c.payment.dayId);
    if (c.peak.dayId) ids.add(c.peak.dayId);
    if (c.dow.dayId) ids.add(c.dow.dayId);
  }
  return [...ids];
}
