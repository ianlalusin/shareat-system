import 'server-only';

import type { Pos2Db } from "../types";
import type { Receipt } from "@/lib/types";
import {
  getContributions,
  pickDayContribution,
  buildDeltaIncrements,
  getApplicablePresets,
  affectedDayIds,
  dayStartMsOf,
} from "./delta-core";

// Minimal structural writer satisfied by both admin Transaction and WriteBatch.
// (Typing it as the union breaks: TS can't call .set on a union of overloads.)
interface AnalyticsWriter {
  set(ref: any, data: any, options: any): unknown;
}

function setNested(target: Record<string, any>, dottedPath: string, value: any) {
  const parts = dottedPath.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Build a nested set-merge payload: ref-specific meta + incrementing fields. */
function nestedPayload(fv: Pos2Db["FieldValue"], meta: Record<string, any>, increments: Record<string, number>) {
  const nested: Record<string, any> = {};
  setNested(nested, "meta.updatedAt", fv.serverTimestamp());
  for (const [k, v] of Object.entries(meta)) setNested(nested, `meta.${k}`, v);
  for (const [k, v] of Object.entries(increments)) setNested(nested, k, fv.increment(v));
  return nested;
}

/**
 * Admin-SDK port of the analytics delta (T-424 S10: PORT of POS v1 src/lib/server/analytics/applyAnalyticsDeltaServer.ts @ e26d0c1;
 * the only change is that FieldValue comes from `db` instead of a module import, so the tests can inject the fake). Applies the old->new receipt delta to
 * the daily / monthly / yearly / preset projection docs via the supplied writer
 * (transaction or batch). Uses set(merge) with FieldValue.increment, which
 * create-or-increments, so no prior doc-existence read is required.
 *
 * NOTE: dormant groundwork — not yet wired into any live flow. Verify against
 * real receipts (Stage B) before switching the client payment path to it.
 */
export function applyAnalyticsDeltaServer(
  db: Pos2Db,
  storeId: string,
  oldReceipt: Receipt | null,
  newReceipt: Receipt | null,
  writer: AnalyticsWriter,
  now: Date = new Date(),
  // Extra increments applied to the DAY doc only (not month/year/presets).
  // Used for daily-remittance-only accumulators like payments.voidCashRetainedTotal.
  // Merged into the day write so we never touch the same doc twice in one tx.
  dayExtraIncrements?: Record<string, number>
): { affectedDayIds: string[] } {
  const oldContrib = getContributions(oldReceipt);
  const newContrib = getContributions(newReceipt);
  const dayIds = affectedDayIds(oldContrib, newContrib);

  for (const dayId of dayIds) {
    const dayOld = pickDayContribution(oldContrib, dayId);
    const dayNew = pickDayContribution(newContrib, dayId);
    // An arrival-only day (session crossed midnight) has no payment contribution, so
    // fall through to the peak/dow day start rather than writing dayStartMs: 0.
    const dayStartMs = dayStartMsOf(dayNew, dayOld);

    const monthId = dayId.slice(0, 6);
    const yearId = dayId.slice(0, 4);
    const dayRef = db.doc(`stores/${storeId}/analytics/${dayId}`);
    const monthRef = db.doc(`stores/${storeId}/analyticsMonths/${monthId}`);
    const yearRef = db.doc(`stores/${storeId}/analyticsYears/${yearId}`);

    const presets = dayStartMs > 0 ? getApplicablePresets(new Date(dayStartMs), now) : [];
    const increments = buildDeltaIncrements(dayOld, dayNew);

    // Day doc carries the daily-only extras (e.g. retained void cash) merged in.
    const dayIncrements = dayExtraIncrements ? { ...increments } : increments;
    if (dayExtraIncrements) {
      for (const [k, v] of Object.entries(dayExtraIncrements)) {
        dayIncrements[k] = (dayIncrements[k] ?? 0) + v;
      }
    }

    writer.set(dayRef, nestedPayload(db.FieldValue, { storeId, dayId, dayStartMs }, dayIncrements), { merge: true });
    writer.set(monthRef, nestedPayload(db.FieldValue, { storeId, monthId }, increments), { merge: true });
    writer.set(yearRef, nestedPayload(db.FieldValue, { storeId, yearId }, increments), { merge: true });
    for (const presetId of presets) {
      const presetRef = db.doc(`stores/${storeId}/dashPresets/${presetId}`);
      writer.set(presetRef, nestedPayload(db.FieldValue, { storeId, presetId, source: "delta-server" }, increments), { merge: true });
    }
  }

  return { affectedDayIds: dayIds };
}
