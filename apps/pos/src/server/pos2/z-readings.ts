import 'server-only';
/**
 * T-471 S2 - close the day (Z-reading) and read the day so far (X-reading). docs/tasks/471-pos-day-close-z-reading.md.
 *
 * The Z is the server's record (Ruling 4): the store comes from the verified token, the totals are computed here from Firestore with the pure
 * `lib/cash/z-reading.ts`, and ONE new document is created at stores/{s}/zReadings/{zNo}. Nothing else is written except the replay slot. v1 ignores the
 * collection (additive; the T-423 wire constraint holds). Idempotent by requestId + body hash, like Convert.
 *
 * MONEY IN THIS DOCUMENT IS INTEGER CENTAVOS (the `reading` map). This is v2's own document, not a v1 field, so the peso convention of v1 documents
 * does not apply; every other money field in it is also whole centavos. The pesos on the receipts/conversions/handovers it reads are converted at the edge.
 */
import { authenticate } from './identity';
import { requireRole } from './roles';
import { requireManagerApproval } from './approval';
import { bodyHash, fail, guarded, isNonBlank, isUuid, jsonResponse, Refusal } from './http';
import type { Pos2Deps } from './types';
import { computeZReading, formatZNo, zWindow, type ZReading, type ZWindow } from '@/lib/cash/z-reading';

const UNSENT = 'Send the unsent sales first.';
const REUSED = 'That request id was already used for a different day close.';
const RACE = 'Another tablet just closed the day. Check the last Z number and try again.';
/** A receipt can reach the server days after it was rung (tablet offline); look this far behind the window for late arrivals. */
const LATE_LOOKBACK_MS = 7 * 24 * 3_600_000;
const ROLES = ['admin', 'manager', 'cashier'] as const;

interface LastZ { zNo: string; zSeq: number; toMs: number; printedAtMs: number }

/** Reads everything a reading needs. `read` is tx.get inside the Z's transaction, a plain get for the X-reading. */
async function compute(deps: Pos2Deps, storeId: string, nowMs: number, read: (target: any) => Promise<any>): Promise<{ last: LastZ | null; window: ZWindow; reading: ZReading }> {
  const db = deps.db;
  const lastSnap = await read(db.collection(`stores/${storeId}/zReadings`).orderBy('zSeq', 'desc').limit(1));
  const lastDoc = lastSnap.docs[0]?.data() as Record<string, any> | undefined;
  const last: LastZ | null = lastDoc ? { zNo: String(lastDoc.zNo), zSeq: Number(lastDoc.zSeq), toMs: Number(lastDoc.toMs), printedAtMs: Number(lastDoc.printedAtMs ?? lastDoc.toMs) } : null;
  const window = zWindow({ lastZToMs: last ? last.toMs : null, nowMs });
  const receiptsFrom = last ? window.fromMs - LATE_LOOKBACK_MS : window.fromMs;
  const [receipts, conversions, handovers, methods] = await Promise.all([
    read(db.collection(`stores/${storeId}/receipts`).where('createdAtClientMs', '>=', receiptsFrom).where('createdAtClientMs', '<', nowMs)),
    read(db.collection(`stores/${storeId}/paymentConversions`).where('createdAtClientMs', '>=', window.fromMs).where('createdAtClientMs', '<', nowMs)),
    read(db.collection(`stores/${storeId}/cashHandovers`).where('createdAtClientMs', '>=', window.fromMs).where('createdAtClientMs', '<', nowMs)),
    read(db.collection(`stores/${storeId}/storeModesOfPayment`).limit(200)),
  ]);
  const data = (snap: any) => snap.docs.map((d: any) => ({ id: d.id, ...(d.data() as Record<string, any>) }));
  const cashNames = new Set<string>(data(methods).filter((m: Record<string, any>) => m.type === 'cash' && m.name).map((m: Record<string, any>) => String(m.name)));
  const reading = computeZReading({
    window, lastZPrintedAtMs: last ? last.printedAtMs : null,
    receipts: data(receipts), conversions: data(conversions), handovers: data(handovers), cashNames,
  });
  return { last, window, reading };
}

const windowOf = (z: Record<string, any>): ZWindow => ({ fromMs: z.fromMs, toMs: z.toMs, spansTwoDates: z.spansTwoDates === true, fromDate: z.fromDate, toDate: z.toDate });

function replayResponse(z: Record<string, any>): Response {
  return jsonResponse(200, { ok: true, zNo: z.zNo, replayed: true, window: windowOf(z), reading: z.reading, printedBy: z.printedBy, approvedByPersonId: z.approvedByPersonId });
}

export async function handleZReading(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const denied = requireRole(caller, ROLES);
    if (denied) return denied;
    const b = caller.body;
    if (!isUuid(b.requestId)) return fail(400, 'The request id is missing. Try again.');
    if (typeof b.unsentCount !== 'number' || !Number.isSafeInteger(b.unsentCount) || b.unsentCount < 0) return fail(400, 'The tablet did not say how many sales are unsent. Try again.');
    if (b.unsentCount > 0) return fail(409, UNSENT);
    const approval = await requireManagerApproval(deps, { storeId: caller.storeId, deviceId: b.deviceId, pin: b.pin });
    if (!approval.ok) return approval.response;
    const storeId = caller.storeId;
    const requestId = b.requestId.toLowerCase();
    const requestHash = await bodyHash({ storeId, deviceId: String(b.deviceId).toLowerCase() });
    const db = deps.db;
    const slotRef = db.doc(`stores/${storeId}/pos2Slots/zreq__${requestId}`);

    const replayFrom = async (slot: Record<string, any>): Promise<Response> => {
      if (slot.requestHash !== requestHash) throw new Refusal(409, REUSED);
      const stored = await db.doc(`stores/${storeId}/zReadings/${slot.zNo}`).get();
      if (!stored.exists) throw new Refusal(409, REUSED);
      return replayResponse(stored.data());
    };
    const prior = await slotRef.get();
    if (prior.exists) return replayFrom(prior.data());

    const nowMs = deps.nowMs();
    const printedBy = { uid: caller.uid, name: caller.name, role: caller.role };
    const record = () => db.runTransaction(async (tx: any) => {
      const slot = await tx.get(slotRef);
      if (slot.exists) return { slot: slot.data() as Record<string, any> };
      const { last, window, reading } = await compute(deps, storeId, nowMs, (target) => tx.get(target));
      const zSeq = (last?.zSeq ?? 0) + 1;
      const zNo = formatZNo(zSeq);
      const doc = {
        storeId, zNo, zSeq, fromMs: window.fromMs, toMs: window.toMs, printedAtMs: nowMs,
        spansTwoDates: window.spansTwoDates, fromDate: window.fromDate, toDate: window.toDate,
        reading, requestId, requestHash, printedBy, approvedByPersonId: approval.approverPersonId,
        source: 'pos2-z', createdAt: db.FieldValue.serverTimestamp(),
      };
      tx.create(db.doc(`stores/${storeId}/zReadings/${zNo}`), doc);
      tx.create(slotRef, { kind: 'z-reading', zNo, requestHash, createdAt: db.FieldValue.serverTimestamp() });
      return { done: { zNo, window, reading } };
    });
    let result: Awaited<ReturnType<typeof record>>;
    try { result = await record(); }
    catch (err) {
      if (err instanceof Refusal) throw err;
      const e = err as { code?: unknown; message?: unknown } | null;
      // Another tablet took the same Z number first (create() lost the race), or a lost acknowledgment: if OUR slot exists it is a replay.
      try {
        const confirmed = await slotRef.get();
        if (confirmed.exists) return replayFrom(confirmed.data());
      } catch (recovery) {
        if (recovery instanceof Refusal) throw recovery;
      }
      if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e.message ?? '')))) throw new Refusal(409, RACE);
      return fail(503, "We couldn't confirm whether the day was closed. Check the last Z number in Settings before closing it again.");
    }
    if ('slot' in result) return replayFrom(result.slot!);
    const { zNo, window, reading } = result.done!;
    return jsonResponse(200, { ok: true, zNo, replayed: false, window, reading, printedBy, approvedByPersonId: approval.approverPersonId });
  });
}

/** GET /api/pos2/x-reading?storeId= - the same figures for [last Z, now). Reads only. */
export async function handleXReading(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const storeId = (new URL(req.url).searchParams.get('storeId') ?? '').trim();
    // The shared identity step reads the store from a JSON body; give it the verified query value and the same Authorization header.
    const shaped = new Request(req.url, { method: 'POST', headers: { authorization: req.headers.get('authorization') ?? '', 'content-type': 'application/json' }, body: JSON.stringify(isNonBlank(storeId) ? { storeId } : {}) });
    const auth = await authenticate(shaped, deps);
    if (!auth.ok) return auth.response;
    const denied = requireRole(auth.caller, ROLES);
    if (denied) return denied;
    const { last, window, reading } = await compute(deps, auth.caller.storeId, deps.nowMs(), (target) => target.get());
    return jsonResponse(200, { ok: true, window, reading, lastZ: last ? { zNo: last.zNo, toMs: last.toMs } : null });
  });
}
