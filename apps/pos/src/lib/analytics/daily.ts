
// Universal module: pure contribution math + a client doc-ref helper. No
// 'use client' so server (admin-SDK) code can reuse the contribution functions.
// `doc`/Firestore are only used by dailyAnalyticsDocRef (client callers).
import { doc, type Firestore } from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import type { Receipt, ReceiptAnalyticsV2, KitchenTicket, Store, LineAdjustment } from "@/lib/types";
import { toJsDate } from "@/lib/utils/date";

/**
 * Checks if a receipt object is null or represents a voided transaction.
 * @param r The receipt object to check.
 * @returns `true` if the receipt is considered void.
 */
function isVoidReceipt(r: any): boolean {
  return !r || r.status === "voided" || r.isVoided === true;
}

/**
 * Gets the start of the day (midnight) for a given timestamp in the 'Asia/Manila' timezone.
 *
 * @param ts The timestamp to convert.
 * @returns The millisecond epoch time for midnight.
 */
export function getDayStartMs(ts: Timestamp | Date | number): number {
    // Use "now" when the timestamp is invalid, to avoid crashing.
    const base = toJsDate(ts) ?? new Date();

    // Epoch ms of Manila midnight for this instant. We take the Manila calendar
    // date (PHT = UTC+8, no DST) then anchor it at the +08:00 offset. This is
    // correct regardless of the machine's local timezone — the old approach used
    // setHours(), which produced *local-machine* midnight, not Manila midnight,
    // on any device not set to UTC+8. Matches getDayIdFromTimestamp's day split.
    const manilaYmd = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(base);

    return new Date(`${manilaYmd}T00:00:00+08:00`).getTime();
}


/**
 * Hour of day (0..23) for an instant, read off the Asia/Manila wall clock.
 *
 * Never use Date#getHours() for analytics buckets: it reads the *host* timezone,
 * so prod (Cloud Run, UTC) shifted every hourly bucket by -8 while dev machines
 * (PHT) looked correct. Mirrors getDayStartMs's Manila-explicit approach.
 */
export function getManilaHour(ts: Timestamp | Date | number): number {
    const base = toJsDate(ts) ?? new Date();
    const hh = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Manila",
        hour: "2-digit",
        hourCycle: "h23",
    }).format(base);
    // Some ICU builds render midnight as "24" under h23; normalise to 0.
    return Number(hh) % 24;
}

/**
 * Day of week (0 = Sunday .. 6 = Saturday) for an instant, in Asia/Manila.
 *
 * Same rationale as getManilaHour — Date#getDay() reads the host timezone and
 * lands on the previous calendar day when the server runs in UTC.
 */
export function getManilaDayOfWeek(ts: Timestamp | Date | number): number {
    const base = toJsDate(ts) ?? new Date();
    const short = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        weekday: "short",
    }).format(base);
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}


/**
 * Converts a Firestore Timestamp, JavaScript Date, or millisecond epoch time
 * into a `YYYYMMDD` string formatted for the 'Asia/Manila' timezone.
 *
 * @param ts The timestamp to convert.
 * @returns A string in `YYYYMMDD` format, or today's date string as a fallback.
 */
export function getDayIdFromTimestamp(ts: Timestamp | Date | number | null | undefined): string {
    const date = toJsDate(ts);

    // If date is invalid or null, fallback to today's date in Asia/Manila.
    if (!date || isNaN(date.getTime())) {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: 'Asia/Manila',
        });
        return formatter.format(now).replace(/-/g, '');
    }
    
    const formatter = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: 'Asia/Manila',
    });

    const dayId = formatter.format(date).replace(/-/g, '');

    // Final safety check to prevent the "1970" bug from invalid timestamps.
    if (dayId.startsWith('1970') || dayId.startsWith('1969')) {
        const now = new Date();
        return formatter.format(now).replace(/-/g, '');
    }

    return dayId;
}


/**
 * Returns a DocumentReference to a daily analytics document for a specific store.
 * The canonical path is stores/{storeId}/analytics/{YYYYMMDD}.
 *
 * @param db The Firestore instance.
 * @param storeId The ID of the store.
 * @param dayId The day identifier string in `YYYYMMDD` format.
 * @returns A DocumentReference to the specified daily analytics document.
 */
export function dailyAnalyticsDocRef(db: Firestore, storeId: string, dayId: string) {
    return doc(db, "stores", storeId, "analytics", dayId);
}

export type SessionModeKey = "dineIn" | "walkIn";

export function modeKeyOf(receipt: Receipt | null | undefined): SessionModeKey {
  return receipt?.sessionMode === "package_dinein" ? "dineIn" : "walkIn";
}

// --- Payment Contribution ---
type PaymentContribution = {
  dayId: string;
  dayStartMs: number;
  totalGross: number;
  txCount: number;
  byMethod: Record<string, number>;
  discountsTotal: number;
  chargesTotal: number;
  mode: SessionModeKey | null;
};

export function getPaymentContribution(receipt: Receipt | null): PaymentContribution {
    const defaultReturn = { dayId: "", dayStartMs: 0, totalGross: 0, txCount: 0, byMethod: {}, discountsTotal: 0, chargesTotal: 0, mode: null as SessionModeKey | null };
    const r = receipt;
    if (!r || isVoidReceipt(r)) return defaultReturn;

    const eventMs = r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;

    const analytics = (r.analytics || {}) as ReceiptAnalyticsV2;
    const gross = Number(r.total ?? analytics?.grandTotal ?? 0);

    return {
        dayId: getDayIdFromTimestamp(eventMs),
        dayStartMs: getDayStartMs(eventMs),
        totalGross: gross,
        txCount: 1,
        byMethod: analytics?.mop ?? {},
        discountsTotal: analytics?.discountsTotal ?? 0,
        chargesTotal: analytics?.chargesTotal ?? 0,
        mode: modeKeyOf(r),
    };
}


// --- Guest & Package Count Contribution ---
type GuestCoversContribution = {
    dayId: string;
    dayStartMs: number;
    isPackageSession: boolean;
    guestCountFinal: number;
    billedPackageCovers: number;
    packageName: string | null;
    packageSessionsCount: number;
    guestCountFinalByPackageName: Record<string, number>;
    packageCoversBilledByPackageName: Record<string, number>;
};

export function getGuestCoversContribution(receipt: Receipt | null): GuestCoversContribution {
    const defaultReturn = { dayId: "", dayStartMs: 0, isPackageSession: false, guestCountFinal: 0, billedPackageCovers: 0, packageName: null, packageSessionsCount: 0, guestCountFinalByPackageName: {}, packageCoversBilledByPackageName: {} };
    const r = receipt;
    if (!r) return defaultReturn;
    
    if (isVoidReceipt(r) || r.sessionMode !== 'package_dinein' || r.analytics?.v !== 2) {
        return defaultReturn;
    }

    const snapshot = r.analytics.guestCountSnapshot;
    if (!snapshot) return defaultReturn;
    
    const eventMs = r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;
    
    const packageName = snapshot.packageName || "Unknown Package";
    const guestCountFinalByPackageName: Record<string, number> = {};
    const packageCoversBilledByPackageName: Record<string, number> = {};

    if (packageName) {
        guestCountFinalByPackageName[packageName] = snapshot.finalGuestCount || 0;
        packageCoversBilledByPackageName[packageName] = snapshot.billedPackageCovers || 0;
    }

    return {
        dayId: getDayIdFromTimestamp(eventMs),
        dayStartMs: getDayStartMs(eventMs),
        isPackageSession: true,
        guestCountFinal: snapshot.finalGuestCount || 0,
        billedPackageCovers: snapshot.billedPackageCovers || 0,
        packageName: packageName,
        packageSessionsCount: 1,
        guestCountFinalByPackageName: guestCountFinalByPackageName,
        packageCoversBilledByPackageName,
    };
}

// --- Sales Contribution ---
type SalesContribution = {
    dayId: string;
    dayStartMs: number;
    packageSalesAmountByName: Record<string, number>;
    packageSalesQtyByName: Record<string, number>;
    addonSalesAmountByCategory: Record<string, number>;
    addonSalesQtyByCategory: Record<string, number>;
    addonSalesByItem: Record<string, { qty: number; amount: number; categoryName: string; }>;
    dineInAddonSalesAmount: number;
    dineInSalesGross: number;
    dineInDiscountsTotal: number;
    dineInChargesTotal: number;
    mode: SessionModeKey | null;
    salesGrossByMode: { dineIn: number; walkIn: number };
    netSalesByMode: { dineIn: number; walkIn: number };
};

export function getSalesContribution(receipt: Receipt | null, store?: Store | null): SalesContribution {
    const defaultReturn: SalesContribution = { dayId: "", dayStartMs: 0, packageSalesAmountByName: {}, packageSalesQtyByName: {}, addonSalesAmountByCategory: {}, addonSalesQtyByCategory: {}, addonSalesByItem: {}, dineInAddonSalesAmount: 0, dineInSalesGross: 0, dineInDiscountsTotal: 0, dineInChargesTotal: 0, mode: null, salesGrossByMode: { dineIn: 0, walkIn: 0 }, netSalesByMode: { dineIn: 0, walkIn: 0 } };
    const r = receipt;
    if (!r) return defaultReturn;
    if (isVoidReceipt(r)) return defaultReturn;

    const eventMs = r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;

    const dayId = getDayIdFromTimestamp(eventMs);
    const dayStartMs = getDayStartMs(eventMs);

    const packageSalesAmountByName: Record<string, number> = {};
    const packageSalesQtyByName: Record<string, number> = {};
    const addonSalesAmountByCategory: Record<string, number> = {};
    const addonSalesQtyByCategory: Record<string, number> = {};
    const addonSalesByItem: Record<string, { qty: number; amount: number; categoryName: string; }> = {};

    const taxRate = (store?.taxRatePct || 0) / 100;
    const isVatInclusive = store?.taxType === 'VAT_INCLUSIVE';
    const isDineIn = r.sessionMode === 'package_dinein';
    const mode: SessionModeKey = isDineIn ? "dineIn" : "walkIn";
    let dineInSalesGross = 0;
    let lineGrossSum = 0;

    (r.lines || []).forEach(line => {
        const billableQty = (line.qtyOrdered || 0) - (line.voidedQty || 0) - (line.freeQty || 0);
        if (billableQty <= 0) return;

        const unitPrice = line.unitPrice || 0;
        const lineGross = billableQty * unitPrice;
        lineGrossSum += lineGross;

        let lineDiscount = 0;
        const baseUnitPrice = (isVatInclusive && taxRate > 0) ? (unitPrice / (1 + taxRate)) : unitPrice;

        const adjs = Object.values((line as any).lineAdjustments ?? {}) as LineAdjustment[];
        if (adjs.length > 0) {
            let remainingQty = billableQty;
            adjs.filter(a => a.kind === 'discount').forEach(adj => {
                const qtyToApply = Math.min(adj.qty, remainingQty);
                if (qtyToApply <= 0) return;

                if (adj.type === 'percent') {
                    lineDiscount += qtyToApply * baseUnitPrice * (adj.value / 100);
                } else { // fixed
                    lineDiscount += qtyToApply * Math.min(baseUnitPrice, adj.value);
                }
                remainingQty -= qtyToApply;
            });
        } else if (line.discountValue && line.discountQty > 0) { // Legacy discount fields
            const discountedQty = Math.min(line.discountQty, billableQty);
            if (line.discountType === 'percent') {
                lineDiscount = discountedQty * baseUnitPrice * (line.discountValue / 100);
            } else {
                lineDiscount = discountedQty * Math.min(baseUnitPrice, line.discountValue);
            }
        }

        const netAmount = lineGross - lineDiscount;

        if (line.type === 'package') {
            packageSalesAmountByName[line.itemName] = (packageSalesAmountByName[line.itemName] || 0) + netAmount;
            packageSalesQtyByName[line.itemName] = (packageSalesQtyByName[line.itemName] || 0) + billableQty;
            if (isDineIn) dineInSalesGross += lineGross;
        } else if (line.type === 'addon') {
            const categoryName = line.category || 'Uncategorized';

            addonSalesAmountByCategory[categoryName] = (addonSalesAmountByCategory[categoryName] || 0) + netAmount;
            addonSalesQtyByCategory[categoryName] = (addonSalesQtyByCategory[categoryName] || 0) + billableQty;

            if (!addonSalesByItem[line.itemName]) {
                addonSalesByItem[line.itemName] = { qty: 0, amount: 0, categoryName: categoryName };
            }
            addonSalesByItem[line.itemName].qty += billableQty;
            addonSalesByItem[line.itemName].amount += netAmount;
            if (isDineIn) dineInSalesGross += lineGross;
        }
    });

    const dineInAddonSalesAmount = isDineIn
        ? Object.values(addonSalesAmountByCategory).reduce((sum, amount) => sum + amount, 0)
        : 0;

    const analytics = (r.analytics || {}) as ReceiptAnalyticsV2;
    const dineInDiscountsTotal = isDineIn ? Number(analytics?.discountsTotal ?? 0) : 0;
    const dineInChargesTotal = isDineIn ? Number(analytics?.chargesTotal ?? 0) : 0;

    const receiptDiscounts = Number(analytics?.discountsTotal ?? 0);
    const receiptCharges = Number(analytics?.chargesTotal ?? 0);
    const receiptNet = lineGrossSum - receiptDiscounts - receiptCharges;

    const salesGrossByMode = { dineIn: 0, walkIn: 0 };
    const netSalesByMode = { dineIn: 0, walkIn: 0 };
    salesGrossByMode[mode] = lineGrossSum;
    netSalesByMode[mode] = receiptNet;

    return {
        dayId,
        dayStartMs,
        packageSalesAmountByName,
        packageSalesQtyByName,
        addonSalesAmountByCategory,
        addonSalesQtyByCategory,
        addonSalesByItem,
        dineInAddonSalesAmount,
        dineInSalesGross,
        dineInDiscountsTotal,
        dineInChargesTotal,
        mode,
        salesGrossByMode,
        netSalesByMode,
    };
}


// --- Peak Hour Contribution ---
type PeakHourContribution = {
    dayId: string;
    dayStartMs: number;
    hourKey: string | null; // "0".."23"
    amount: number;
    count: number; // 1 if valid, 0 if not
    mode: SessionModeKey | null;
};

export function getPeakHourContribution(receipt: Receipt | null): PeakHourContribution {
    const defaultReturn: PeakHourContribution = { dayId: "", dayStartMs: 0, hourKey: null, amount: 0, count: 0, mode: null };
    const r = receipt;
    if (!r) return defaultReturn;
    if (isVoidReceipt(r)) return defaultReturn;

    // Peak hour reflects when the customer arrived (session start), not when they paid.
    // Fall back to createdAt only for receipts that pre-date sessionStartedAt tracking.
    const sessionMs = r.analytics?.sessionStartedAtClientMs || toJsDate(r.analytics?.sessionStartedAt)?.getTime();
    const eventMs = sessionMs || r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;

    const date = new Date(eventMs);
    const dayId = getDayIdFromTimestamp(date);
    const dayStartMs = getDayStartMs(date);
    const hour = getManilaHour(date);

    return {
        dayId: dayId,
        dayStartMs,
        hourKey: String(hour),
        amount: r.total ?? r.analytics?.grandTotal ?? 0,
        count: 1,
        mode: modeKeyOf(r),
    };
}

// --- Day-of-Week Contribution ---
type DayOfWeekContribution = {
    dayId: string;
    dayStartMs: number;
    dowKey: string | null; // "0".."6" (0 = Sunday), Asia/Manila
    amount: number;
    count: number;
};

export function getDayOfWeekContribution(receipt: Receipt | null): DayOfWeekContribution {
    const defaultReturn: DayOfWeekContribution = { dayId: "", dayStartMs: 0, dowKey: null, amount: 0, count: 0 };
    const r = receipt;
    if (!r) return defaultReturn;
    if (isVoidReceipt(r)) return defaultReturn;

    // DOW reflects when the customer arrived (session start), matching peak-hour semantics.
    // Fall back to createdAt only for receipts that pre-date sessionStartedAt tracking.
    const sessionMs = r.analytics?.sessionStartedAtClientMs || toJsDate(r.analytics?.sessionStartedAt)?.getTime();
    const sessionEventMs = sessionMs || r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!sessionEventMs) return defaultReturn;

    // dayId/dayStartMs are keyed off the ARRIVAL day, not the payment day, so the bucket
    // agrees with dowKey. A party arriving 11:30 PM Sat and paying 12:30 AM Sun counts as
    // Saturday traffic in both. Writers route this contribution by its own dayId.
    const dayStartMs = getDayStartMs(sessionEventMs);
    const dayId = getDayIdFromTimestamp(sessionEventMs);
    const dow = getManilaDayOfWeek(sessionEventMs);

    const analytics = (r.analytics || {}) as ReceiptAnalyticsV2;
    const amount = Number(r.total ?? analytics?.grandTotal ?? 0);

    return {
        dayId,
        dayStartMs,
        dowKey: String(dow),
        amount,
        count: 1,
    };
}

// --- Kitchen Ticket Contribution ---
type KitchenTicketContribution = {
    dayId: string;
    dayStartMs: number;
    typeKey: string; // e.g., "package", "addon", "refill"
    servedCount: number;
    cancelledCount: number;
    durationMsSum: number;
    durationCount: number; // Count of tickets with a valid duration
};

export function getKitchenTicketContribution(ticket: KitchenTicket): KitchenTicketContribution {
    const defaultReturn = { dayId: "", dayStartMs: 0, typeKey: "unknown", servedCount: 0, cancelledCount: 0, durationMsSum: 0, durationCount: 0 };
    
    // Use client-side timestamp if available for dayId generation
    const eventMs = ticket.servedAtClientMs || toJsDate(ticket.servedAt || ticket.cancelledAt || ticket.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;
    
    const dayId = getDayIdFromTimestamp(eventMs);
    const dayStartMs = getDayStartMs(eventMs);
    const typeKey = ticket.type || "unknown";

    if (ticket.status === 'served') {
        let durationMs = ticket.durationMs ?? 0;
        if (durationMs <= 0 && ticket.servedAtClientMs) {
            const createdAtMs = toJsDate(ticket.createdAt)?.getTime();
            if (createdAtMs) {
                durationMs = ticket.servedAtClientMs - createdAtMs;
            }
        }
        
        return {
            dayId,
            dayStartMs,
            typeKey,
            servedCount: 1,
            cancelledCount: 0,
            durationMsSum: durationMs > 0 ? durationMs : 0,
            durationCount: durationMs > 0 ? 1 : 0,
        };
    }
    
    if (ticket.status === 'cancelled') {
        return {
            dayId,
            dayStartMs,
            typeKey,
            servedCount: 0,
            cancelledCount: 1,
            durationMsSum: 0,
            durationCount: 0,
        };
    }
    
    return defaultReturn;
}


// --- Closed Sessions Contribution ---
type ClosedSessionsContribution = {
  dayId: string;
  dayStartMs: number;
  closedCount: number;
  totalPaid: number;
  mode: SessionModeKey | null;
  dineInDurationMs: number;
  dineInDurationCount: number;
};

// Reject absurd durations (clock skew / stale sessions) so they don't skew the average.
const MAX_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export function getClosedSessionsContribution(receipt: Receipt | null): ClosedSessionsContribution {
    const defaultReturn: ClosedSessionsContribution = { dayId: "", dayStartMs: 0, closedCount: 0, totalPaid: 0, mode: null, dineInDurationMs: 0, dineInDurationCount: 0 };
    const r = receipt;
    if (!r) return defaultReturn;
    if (isVoidReceipt(r)) return defaultReturn;

    const eventMs = r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;

    const mode = modeKeyOf(r);
    let dineInDurationMs = 0;
    let dineInDurationCount = 0;
    if (mode === "dineIn") {
        const startMs = r.analytics?.sessionStartedAtClientMs ?? toJsDate(r.analytics?.sessionStartedAt)?.getTime() ?? null;
        if (startMs && eventMs > startMs) {
            const dur = eventMs - startMs;
            if (dur > 0 && dur <= MAX_SESSION_DURATION_MS) {
                dineInDurationMs = dur;
                dineInDurationCount = 1;
            }
        }
    }

    return {
        dayId: getDayIdFromTimestamp(eventMs),
        dayStartMs: getDayStartMs(eventMs),
        closedCount: 1,
        totalPaid: r.total ?? 0,
        mode,
        dineInDurationMs,
        dineInDurationCount,
    };
}


// --- Refill Contribution ---
type RefillContribution = {
    dayId: string;
    dayStartMs: number;
    servedRefillsTotal: number;
    servedRefillsByName: Record<string, number>;
    packageSessionsCount: number;
};

export function getRefillContribution(receipt: Receipt | null): RefillContribution {
    const defaultReturn = { dayId: "", dayStartMs: 0, servedRefillsTotal: 0, servedRefillsByName: {}, packageSessionsCount: 0 };
    const r = receipt;
    if (!r) return defaultReturn;
    if (isVoidReceipt(r) || r.sessionMode !== 'package_dinein' || r.analytics?.v !== 2) {
        return defaultReturn;
    }
    
    const eventMs = r.createdAtClientMs || toJsDate(r.createdAt)?.getTime();
    if (!eventMs) return defaultReturn;
    
    const analytics = r.analytics as ReceiptAnalyticsV2;
    const servedRefillsByName = analytics.servedRefillsByName ?? {};
    const servedRefillsTotal = Object.values(servedRefillsByName).reduce((sum, count) => sum + count, 0);

    return {
        dayId: getDayIdFromTimestamp(eventMs),
        dayStartMs: getDayStartMs(eventMs),
        servedRefillsTotal,
        servedRefillsByName,
        packageSessionsCount: 1,
    };
}

    
// --- Item Adjustment Contribution ---
export type ItemAdjustmentContribution = {
  dayId: string;
  voidedQty: number;
  voidedAmount: number;
  freeQty: number;
  freeAmount: number;
  discountedQty: number;
  discountedAmount: number;
  refundCount: number;
  refundTotal: number;
};

export function getItemAdjustmentContribution(receipt: Receipt | null): ItemAdjustmentContribution {
  const zero: ItemAdjustmentContribution = {
    dayId: '',
    voidedQty: 0, voidedAmount: 0,
    freeQty: 0, freeAmount: 0,
    discountedQty: 0, discountedAmount: 0,
    refundCount: 0, refundTotal: 0,
  };
  if (!receipt) return zero;

  const dayId = getDayIdFromTimestamp(receipt.createdAtClientMs ?? receipt.createdAt);

  // Refund receipt — count as refund stat, not item adjustment
  if ((receipt as any).isRefund) {
    return {
      ...zero,
      dayId,
      refundCount: 1,
      refundTotal: Math.abs(receipt.total || 0),
    };
  }

  if (isVoidReceipt(receipt)) return { ...zero, dayId };

  let voidedQty = 0, voidedAmount = 0;
  let freeQty = 0, freeAmount = 0;
  let discountedQty = 0, discountedAmount = 0;

  for (const line of (receipt.lines || [])) {
    const ordered = line.qtyOrdered || 0;
    const voided = line.voidedQty || 0;
    const free = line.freeQty || 0;

    voidedQty += voided;
    voidedAmount += voided * (line.unitPrice || 0);

    freeQty += free;
    freeAmount += free * (line.unitPrice || 0);

    // Discounted qty from lineAdjustments or legacy fields
    const adjs = Object.values((line as any).lineAdjustments ?? {}) as any[];
    const discAdjs = adjs.filter(a => a.kind === 'discount');
    if (discAdjs.length > 0) {
      discAdjs.forEach(a => {
        const qty = Math.min(Number(a.qty || 0), ordered);
        discountedQty += qty;
        const baseUnit = line.unitPrice || 0;
        if (a.type === 'percent') discountedAmount += qty * baseUnit * (Number(a.value || 0) / 100);
        else discountedAmount += qty * Math.min(baseUnit, Number(a.value || 0));
      });
    } else if ((line.discountQty || 0) > 0 && (line.discountValue ?? 0) > 0) {
      const dQty = Math.min(line.discountQty, ordered);
      discountedQty += dQty;
      const baseUnit = line.unitPrice || 0;
      if (line.discountType === 'percent') discountedAmount += dQty * baseUnit * ((line.discountValue || 0) / 100);
      else discountedAmount += dQty * Math.min(baseUnit, line.discountValue ?? 0);
    }
  }

  return { dayId, voidedQty, voidedAmount, freeQty, freeAmount, discountedQty, discountedAmount, refundCount: 0, refundTotal: 0 };
}
