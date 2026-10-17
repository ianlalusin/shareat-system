
import { FieldValue, type Firestore, type Transaction } from "./admin-shim";
import { getApplicablePresets } from "./delta-core";
import { getDayIdFromTimestamp, getDayStartMs } from "@/lib/analytics/daily";

// Admin-SDK port of src/lib/analytics/applyPaymentConversion.ts. A payment
// conversion is a net-zero reshuffle of the payment mix (no totalGross / txCount
// change) — it moves `amount` from one method to another on the day/month/year
// rollups and the applicable preset docs. Moved server-side so the analytics
// collections can be locked to server writes only.

function safeKey(s: string) {
  return (s || "Uncategorized").trim().replace(/\./g, "·").replace(/\//g, "∕");
}
function normalizeMethod(s: string) {
  return (s || "").trim();
}

/**
 * Apply the byMethod delta to day/month/year + preset docs via a single
 * set(merge) per ref (create-or-increment, no prior read). `sign` = +1 to apply,
 * -1 to reverse.
 */
function writeByMethodDeltaServer(
  tx: Transaction,
  db: Firestore,
  storeId: string,
  dayId: string,
  dayStartMs: number,
  fromMethod: string,
  toMethod: string,
  amount: number,
  sign: 1 | -1,
  now: Date,
) {
  const monthId = dayId.slice(0, 6);
  const yearId = dayId.slice(0, 4);
  const dayRef = db.doc(`stores/${storeId}/analytics/${dayId}`);
  const monthRef = db.doc(`stores/${storeId}/analyticsMonths/${monthId}`);
  const yearRef = db.doc(`stores/${storeId}/analyticsYears/${yearId}`);
  const presets = dayStartMs > 0 ? getApplicablePresets(new Date(dayStartMs), now) : [];

  const fromKey = safeKey(fromMethod);
  const toKey = safeKey(toMethod);
  const isNoop = fromKey === toKey; // guarded upstream; stay safe

  const byMethod = isNoop
    ? undefined
    : { payments: { byMethod: { [fromKey]: FieldValue.increment(sign * -amount), [toKey]: FieldValue.increment(sign * amount) } } };

  const payload = (metaExtra: Record<string, any>) => ({
    meta: { storeId, updatedAt: FieldValue.serverTimestamp(), ...metaExtra },
    ...(byMethod || {}),
  });

  tx.set(dayRef, payload({ dayId, dayStartMs }), { merge: true });
  tx.set(monthRef, payload({ monthId }), { merge: true });
  tx.set(yearRef, payload({ yearId }), { merge: true });
  for (const presetId of presets) {
    tx.set(db.doc(`stores/${storeId}/dashPresets/${presetId}`), payload({ presetId, source: "payment-conversion" }), { merge: true });
  }
}

export type CreateConversionInput = {
  amount: number;
  fromMethod: string;
  toMethod: string;
  note?: string | null;
};
export type ConversionActor = { uid: string; name: string; role?: string | null };

/** Create a conversion doc and apply its byMethod delta in one transaction. */
export async function createPaymentConversionServer(
  db: Firestore,
  storeId: string,
  input: CreateConversionInput,
  actor: ConversionActor,
  now: Date = new Date(),
): Promise<string> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive number.");
  const from = normalizeMethod(input.fromMethod);
  const to = normalizeMethod(input.toMethod);
  if (!from || !to) throw new Error("From and To methods are required.");
  if (from.toLowerCase() === to.toLowerCase()) throw new Error("From and To methods must differ.");

  const dayId = getDayIdFromTimestamp(now);
  const dayStartMs = getDayStartMs(now);
  const newDocRef = db.collection(`stores/${storeId}/paymentConversions`).doc();

  await db.runTransaction(async (tx) => {
    tx.set(newDocRef, {
      storeId,
      dayId,
      dayStartMs,
      amount,
      fromMethod: from,
      toMethod: to,
      note: input.note?.trim() || null,
      status: "active",
      createdBy: { uid: actor.uid, name: actor.name, role: actor.role ?? null },
      createdAt: FieldValue.serverTimestamp(),
      createdAtClientMs: now.getTime(),
      voidedAt: null,
      voidedBy: null,
    });
    writeByMethodDeltaServer(tx, db, storeId, dayId, dayStartMs, from, to, amount, 1, now);
  });

  return newDocRef.id;
}

/** Void a conversion and reverse its byMethod delta. Idempotent on status. */
export async function voidPaymentConversionServer(
  db: Firestore,
  storeId: string,
  conversionId: string,
  actor: { uid: string; name: string },
  now: Date = new Date(),
): Promise<{ skipped: boolean }> {
  const ref = db.doc(`stores/${storeId}/paymentConversions/${conversionId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Conversion not found.");
    const data = snap.data() as any;
    if (data.status === "voided") return { skipped: true };

    tx.update(ref, {
      status: "voided",
      voidedAt: FieldValue.serverTimestamp(),
      voidedBy: { uid: actor.uid, name: actor.name },
    });
    writeByMethodDeltaServer(
      tx,
      db,
      storeId,
      String(data.dayId),
      Number(data.dayStartMs),
      String(data.fromMethod),
      String(data.toMethod),
      Number(data.amount),
      -1,
      now,
    );
    return { skipped: false };
  });
}
