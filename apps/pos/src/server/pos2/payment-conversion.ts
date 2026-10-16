import 'server-only';
/**
 * T-424 S7 - PORT of POS v1's payment-conversion analytics writer (src/lib/server/analytics/applyPaymentConversionServer.ts @ e26d0c1,
 * `writeByMethodDeltaServer`). A conversion is a net-zero reshuffle of the payment mix: it moves `amount` from one method to another on the
 * day / month / year rollups and every applicable preset doc. `totalGross` and `txCount` are never touched. `safeKey` mapping included.
 * The vendored real v1 code (src/lib/__fixtures__/v1-analytics/applyPaymentConversionServer.ts) reverses this exactly (tender-corrections.test.ts).
 */
import { getApplicablePresets, safeKey } from './analytics/delta-core';
import type { Pos2Db } from './types';

/** `sign` = +1 to apply, -1 to reverse. `amount` is PESOS (v1's wire). */
export function writeByMethodDelta(
  tx: { set(ref: any, data: any, options?: any): unknown },
  db: Pos2Db,
  storeId: string,
  dayId: string,
  dayStartMs: number,
  fromMethod: string,
  toMethod: string,
  amount: number,
  sign: 1 | -1,
  now: Date,
): void {
  const fv = db.FieldValue;
  const monthId = dayId.slice(0, 6);
  const yearId = dayId.slice(0, 4);
  const dayRef = db.doc(`stores/${storeId}/analytics/${dayId}`);
  const monthRef = db.doc(`stores/${storeId}/analyticsMonths/${monthId}`);
  const yearRef = db.doc(`stores/${storeId}/analyticsYears/${yearId}`);
  const presets = dayStartMs > 0 ? getApplicablePresets(new Date(dayStartMs), now) : [];

  const fromKey = safeKey(fromMethod);
  const toKey = safeKey(toMethod);
  const isNoop = fromKey === toKey; // guarded upstream; stay safe

  const byMethod = isNoop ? undefined : { payments: { byMethod: { [fromKey]: fv.increment(sign * -amount), [toKey]: fv.increment(sign * amount) } } };
  const payload = (metaExtra: Record<string, any>) => ({
    meta: { storeId, updatedAt: fv.serverTimestamp(), ...metaExtra },
    ...(byMethod || {}),
  });

  tx.set(dayRef, payload({ dayId, dayStartMs }), { merge: true });
  tx.set(monthRef, payload({ monthId }), { merge: true });
  tx.set(yearRef, payload({ yearId }), { merge: true });
  for (const presetId of presets) {
    tx.set(db.doc(`stores/${storeId}/dashPresets/${presetId}`), payload({ presetId, source: 'payment-conversion' }), { merge: true });
  }
}
