"use client";

import { collection, doc, getDocFromServer, getDocs, getDocsFromServer, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { storedPesosToCentavos, toWirePesos } from "@/lib/money/centavos";
import { isCashMethod } from './cash-method';
import { convertNetPesos, negativeMethods, type ConversionLike } from './convert-net';
import { getDayIdFromTimestamp } from '@/lib/analytics/daily';

/**
 * Start-of-shift-day in ms, anchored at 4 AM Asia/Manila (mirrors getShiftDayId
 * in the cashier page). Before 4 AM, rolls back to the previous calendar day.
 * Used as the default period start for the first cash handover of the day.
 */
export function getShiftDayStartMs(now: Date = new Date()): number {
  const manila = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  if (manila.getHours() < 4) manila.setDate(manila.getDate() - 1);
  manila.setHours(4, 0, 0, 0);
  // Convert the Manila-local 4 AM back to a real epoch ms. The offset between
  // the faux-local clone and the true now gives the correction.
  const offset = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" })).getTime();
  return manila.getTime() + offset;
}

/**
 * Resolve the set of payment-method NAMES that count as cash for this store.
 * Receipt analytics store `mop` keyed by method name (net of change given), so
 * matching cash sales means matching those names. Falls back to any name
 * containing the word "cash" (never GCash).
 */
export async function getCashMethodNames(storeId: string, fresh = false): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const snap = await (fresh ? getDocsFromServer : getDocs)(
      query(collection(db, "stores", storeId, "storeModesOfPayment"), where("type", "==", "cash")),
    );
    snap.forEach((d) => {
      const name = (d.data() as any)?.name;
      if (name) names.add(String(name));
    });
  } catch (error) {
    if (fresh) throw error; // A closing calculation cannot guess configured cash identities from an outage.
    // ignore — fallback below still catches "cash"-named keys
  }
  return names;
}

/**
 * Bible row 391: cash paid back for refunds in the window. A refund receipt keeps its tender in `refundTender.methodName` (never in analytics.mop) and its
 * amount in `refundTotalCentavos` (else |total|); a voided refund paid nothing back. Same createdAtClientMs window as sales.
 */
export async function computeCashSalesAndRefunds(
  storeId: string,
  fromMs: number,
  toMs: number,
  knownCashNames?: ReadonlySet<string>,
  fresh = false,
): Promise<{ cashSales: number; cashRefunds: number }> {
  const cashNames = knownCashNames ?? await getCashMethodNames(storeId, fresh);
  const isCashKey = (k: string) =>
    isCashMethod(k, cashNames);

  const snap = await (fresh ? getDocsFromServer : getDocs)(
    query(
      collection(db, "stores", storeId, "receipts"),
      where("createdAtClientMs", ">=", fromMs),
      where("createdAtClientMs", "<=", toMs),
    ),
  );

  let totalCents = 0, refundCents = 0;
  snap.forEach((d) => {
    const r = d.data() as any;
    if (r?.isRefund === true) {
      if (r?.status !== "voided" && isCashKey(String(r?.refundTender?.methodName ?? ""))) {
        refundCents += Number.isSafeInteger(r?.refundTotalCentavos) ? r.refundTotalCentavos : storedPesosToCentavos(Math.abs(Number(r?.total ?? 0)));
      }
      return;
    }
    // A voided receipt's SALE is excluded — but if cash was collected and NOT
    // refunded on the void, that retained cash is physically in the drawer and
    // must stay in expected cash sales (else it shows as a phantom overage).
    if (r?.status === "voided") {
      // Once a re-ring is linked, the retained cash is covered by the new sale —
      // don't add it again (the re-ring receipt already counts as normal cash).
      if (r?.voidCashRetainedReversed === true) return;
      const retained = Number(r?.voidCashRetained || 0);
      if (retained > 0) totalCents += storedPesosToCentavos(retained);
      return;
    }
    const mop = (r?.analytics?.mop ?? {}) as Record<string, number>;
    for (const [k, v] of Object.entries(mop)) {
      if (isCashKey(k)) totalCents += storedPesosToCentavos(v);
    }
  });
  return { cashSales: toWirePesos(totalCents), cashRefunds: toWirePesos(refundCents) };
}

/** One explicit server window for handover; a failed read aborts the save instead of treating missing totals as zero. */
export async function computeHandoverCash(storeId: string, fromMs: number, toMs: number) {
  const cashNames = await getCashMethodNames(storeId, true);
  const [{ cashSales, cashRefunds }, conversions, day] = await Promise.all([
    computeCashSalesAndRefunds(storeId, fromMs, toMs, cashNames, true),
    getDocsFromServer(query(collection(db, 'stores', storeId, 'paymentConversions'), where('createdAtClientMs', '>=', fromMs), where('createdAtClientMs', '<=', toMs))),
    getDocFromServer(doc(db, 'stores', storeId, 'analytics', getDayIdFromTimestamp(toMs))),
  ]);
  const movements: ConversionLike[] = [];
  conversions.forEach((row) => movements.push(row.data() as ConversionLike));
  return {
    cashSales, cashRefunds, convertNet: convertNetPesos(movements, fromMs, toMs, (name) => isCashMethod(name, cashNames)),
    negativeMethodNames: negativeMethods(day.data()?.payments?.byMethod ?? {}),
  };
}
