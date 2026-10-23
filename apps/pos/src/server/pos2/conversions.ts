import 'server-only';
/** T-427: Convert moves the payment mix, never sales; authorization and all refusals precede writes. */
import { getDayIdFromTimestamp, getDayStartMs } from '@/lib/analytics/daily';
import { storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { safeKey } from './analytics/delta-core';
import { authenticate } from './identity';
import { requireRole } from './roles';
import { bodyHash, fail, guarded, isNonBlank, isUuid, jsonResponse, Refusal } from './http';
import { writeByMethodDelta } from './payment-conversion';
import type { Pos2Deps } from './types';

const NO_SHIFT = 'Open the till shift in ERP before recording a cash-in or cash-out.';
const norm = (s: string) => s.trim().toLowerCase();
const warningFor = (wallet: string) => `Recorded. Today's ${wallet} total is below zero for now; the office will check this day if it stays that way.`;
const ADVISORY_PENDING = "Recorded. The payment totals could not be checked just now; the office must check this day's payment methods.";
const active = (m: Record<string, any>) => m.isActive !== false && m.isArchived !== true;

export async function handleConversion(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const denied = requireRole(caller, ['admin', 'manager', 'cashier']);
    if (denied) return denied;
    const b = caller.body;
    if (!isUuid(b.requestId)) return fail(400, 'The request id is missing. Try again.');
    if (b.direction !== 'cash_in' && b.direction !== 'cash_out') return fail(400, 'Choose cash-in or cash-out.');
    if (!isNonBlank(b.walletMethod)) return fail(400, 'Choose the e-wallet.');
    const cents = b.amountCentavos;
    if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents <= 0) return fail(400, 'The amount must be a whole number of centavos, more than zero.');
    if (cents > 5_000_000) return fail(400, 'That amount is too large for one conversion. Split it or check the number.');
    const storeId = caller.storeId;
    const requestId = b.requestId.toLowerCase();
    const direction = b.direction;
    const walletMethod = b.walletMethod.trim();
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    const requestHash = await bodyHash({ storeId, direction, walletMethod, amountCentavos: cents, note });
    const db = deps.db;
    const ref = db.doc(`stores/${storeId}/paymentConversions/${requestId}`);
    const recorded = (data: Record<string, any>, replayed: boolean) => jsonResponse(200, {
      ok: true, conversionId: requestId, replayed,
      ...(data.advisoryPending ? { warning: ADVISORY_PENDING }
        : data.warnedNegativeAtWrite ? { warning: warningFor(String(data.warningMethod ?? (data.direction === 'cash_in' ? data.fromMethod : data.toMethod))) } : {}),
    });
    const replay = (data: Record<string, any>) => {
      if (data.source !== 'pos2-convert' || data.requestHash !== requestHash) throw new Refusal(409, 'That request id was already used for a different conversion.');
      return recorded(data, true);
    };
    const prior = await ref.get();
    if (prior.exists) return replay(prior.data());
    const shift = await deps.openTillShift(storeId);
    if (!shift) return fail(409, NO_SHIFT);
    const nowMs = deps.nowMs();
    const dayId = getDayIdFromTimestamp(nowMs);
    const dayStartMs = getDayStartMs(nowMs);
    const record = () => db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return { previous: existing.data() as Record<string, any> };
      const methods = await tx.get(db.collection(`stores/${storeId}/storeModesOfPayment`).limit(200));
      const rows = methods.docs.map((d: any) => d.data() as Record<string, any>).filter(active);
      const cash = rows.filter((m: Record<string, any>) => m.type === 'cash')
        .sort((a: Record<string, any>, z: Record<string, any>) => (a.sortOrder ?? 0) - (z.sortOrder ?? 0) || String(a.name).localeCompare(String(z.name)))[0];
      const wallet = rows.find((m: Record<string, any>) => norm(String(m.name ?? '')) === norm(walletMethod) && m.type === 'online');
      if (!cash || !wallet) throw new Refusal(409, 'That payment method is not available.');
      const fromMethod = String(direction === 'cash_in' ? wallet.name : cash.name);
      const toMethod = String(direction === 'cash_in' ? cash.name : wallet.name);
      if (safeKey(fromMethod) === safeKey(toMethod)) throw new Refusal(409, 'The money has to move to a different payment method.');
      const amount = toWirePesos(cents);
      tx.create(ref, { storeId, dayId, dayStartMs, amount, fromMethod, toMethod, note: note || null,
        status: 'active', createdBy: { uid: caller.uid, name: caller.name, role: caller.role },
        createdAt: db.FieldValue.serverTimestamp(), createdAtClientMs: nowMs, voidedAt: null, voidedBy: null,
        source: 'pos2-convert', direction, amountCentavos: cents, requestHash, tillShiftOpenedAtMs: shift.openedAtMs,
        advisoryPending: true });
      writeByMethodDelta(tx, db, storeId, dayId, dayStartMs, fromMethod, toMethod, amount, 1, new Date(nowMs));
      return { fromMethod, walletName: String(wallet.name) };
    });
    let result: Awaited<ReturnType<typeof record>>;
    try { result = await record(); }
    catch (err) {
      if (err instanceof Refusal) throw err;
      // A network failure can lose the acknowledgment of an atomic commit. Confirm by the same request id, never write again.
      try {
        const confirmed = await ref.get();
        if (confirmed.exists) return replay(confirmed.data());
      } catch (recoveryError) {
        if (recoveryError instanceof Refusal) throw recoveryError;
      }
      return fail(503, "We couldn't confirm whether this conversion was recorded. Retry this same request or check today's conversions before entering it again.");
    }
    if ('previous' in result) return replay(result.previous!);
    // Advisory only: blind increments above never contend on the analytics document.
    try {
      const day = await db.doc(`stores/${storeId}/analytics/${dayId}`).get();
      const total = day.data()?.payments?.byMethod?.[safeKey(result.fromMethod!)];
      const negative = total != null && storedPesosToCentavos(total) < 0;
      const advisory = { advisoryPending: false, warnedNegativeAtWrite: negative, warningMethod: result.walletName };
      // Only advisory metadata: never repeat the money move. Persist both the clear and negative outcomes for replay.
      await db.runTransaction(async (tx) => { tx.update(ref, advisory); });
      return recorded(advisory, false);
    } catch {
      // Money is already committed. A lost metadata acknowledgment may still have saved the exact warning.
      console.warn('[pos2] conversion recorded; advisory check incomplete');
      try {
        const settled = await ref.get();
        if (settled.exists) return recorded(settled.data(), false);
      } catch { /* The original transaction durably marked this check pending. */ }
      return recorded({ advisoryPending: true }, false);
    }
  });
}

export async function handleConversionVoid(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const denied = requireRole(caller, ['admin', 'manager', 'cashier']);
    if (denied) return denied;
    const b = caller.body;
    if (!isUuid(b.requestId) || !isNonBlank(b.conversionId) || b.conversionId.includes('/')) return fail(400, 'Choose the conversion to void.');
    const shift = await deps.openTillShift(caller.storeId);
    if (!shift) return fail(409, NO_SHIFT);
    const db = deps.db;
    const nowMs = deps.nowMs();
    const ref = db.doc(`stores/${caller.storeId}/paymentConversions/${b.conversionId}`);
    const reverse = () => db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Refusal(404, 'That conversion was not found.');
      const c = snap.data() as Record<string, any>;
      if (c.source !== 'pos2-convert' || c.tillShiftOpenedAtMs !== shift.openedAtMs) throw new Refusal(409, 'Only a conversion from the current till shift can be voided here.');
      if (c.status === 'voided') return true;
      if (c.status !== 'active') throw new Refusal(409, 'That conversion is not active.');
      tx.update(ref, { status: 'voided', voidedVia: 'pos2', voidedAt: db.FieldValue.serverTimestamp(), voidedBy: { uid: caller.uid, name: caller.name } });
      writeByMethodDelta(tx, db, caller.storeId, c.dayId, c.dayStartMs, c.fromMethod, c.toMethod, c.amount, -1, new Date(nowMs));
      return false;
    });
    let skipped: boolean;
    try { skipped = await reverse(); }
    catch (err) {
      if (err instanceof Refusal) throw err;
      try {
        const confirmed = await ref.get();
        const c = confirmed.data();
        if (confirmed.exists && c?.source === 'pos2-convert' && c.tillShiftOpenedAtMs === shift.openedAtMs && c.status === 'voided') {
          return jsonResponse(200, { ok: true, conversionId: b.conversionId, skipped: true });
        }
      } catch { /* Unknown outcome: never claim no money changed and never issue another reversal here. */ }
      return fail(503, "We couldn't confirm whether this conversion was voided. Retry this same request or check today's conversions before trying another void.");
    }
    return jsonResponse(200, { ok: true, conversionId: b.conversionId, skipped });
  });
}
