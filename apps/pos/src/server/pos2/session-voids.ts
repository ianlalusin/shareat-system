import 'server-only';
/**
 * T-424 S8 - POST /api/pos2/session-voids. docs/tasks/424-pos-v2-server-approvals.md Ruling 8, Acceptance 8.
 *
 * Voids an UNPAID session with the Admin SDK, running T-423's transactional `voidSession` logic on the server: the session, its tickets and
 * the table are all re-read INSIDE the transaction, a ticket served in the meantime is left alone, and the table is freed only if it still
 * points at this session. Allowed for a caller whose staff role (from `staff/{uid}`, never the body) is manager or admin, or with a manager PIN.
 * A paid, closed or already-voided session is refused. The offline void stays on the tablet (PC-5).
 */
import { DEVICE_ID_MISSING, requireManagerApproval } from './approval';
import { Refusal, fail, guarded, isNonBlank, isUuid, jsonResponse } from './http';
import { authenticate } from './identity';
import { ALREADY_VOIDED } from '@/lib/pos2/voidOutcome';
import type { Pos2Deps } from './types';

const MANAGER_ROLES = ['manager', 'admin'];
export const VOID_NEEDS_MANAGER = "A store manager's PIN is needed to void this table.";

export async function handleSessionVoid(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const b = caller.body;
    const storeId = caller.storeId;

    if (!isNonBlank(b.sessionId) || b.sessionId.includes('/')) return fail(400, 'Choose the table to void.');
    const sessionId = b.sessionId;
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!reason) return fail(400, 'Say why this table is being voided.');

    // A device id that is present must be a uuid whoever is calling (a bad one is a 400 here, never a database error later).
    if (b.deviceId !== undefined && !isUuid(b.deviceId)) return fail(400, DEVICE_ID_MISSING);

    let approverPersonId: string | null = null;
    if (!MANAGER_ROLES.includes(caller.role)) {
      if (!isNonBlank(b.pin)) return fail(403, VOID_NEEDS_MANAGER);
      const approval = await requireManagerApproval(deps, { storeId, deviceId: b.deviceId, pin: b.pin });
      if (!approval.ok) return approval.response;
      approverPersonId = approval.approverPersonId;
    }

    const db = deps.db;
    const nowMs = deps.nowMs();
    const FV = db.FieldValue;
    const sessionPath = `stores/${storeId}/sessions/${sessionId}`;

    await db.runTransaction(async (tx) => {
      // ---- reads (session, projection, live tickets, table) ----
      const sessionRef = db.doc(sessionPath);
      const activeRef = db.doc(`stores/${storeId}/activeSessions/${sessionId}`);
      const closedRef = db.doc(`stores/${storeId}/closedSessions/${sessionId}`);
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists) throw new Refusal(404, 'That table was not found.');
      const session = sessionSnap.data() as Record<string, any>;
      if (session.status === 'voided') throw new Refusal(409, ALREADY_VOIDED);
      if (session.status === 'closed' || session.isPaid) {
        throw new Refusal(409, 'That table is already paid or closed, so it cannot be voided.');
      }
      const activeSnap = await tx.get(activeRef);
      const ticketsSnap = await tx.get(db.collection(`${sessionPath}/kitchentickets`).where('status', 'in', ['preparing', 'ready']));
      const tableId = typeof session.tableId === 'string' && session.tableId && session.tableId !== 'alacarte' ? session.tableId : null;
      const tableRef = tableId ? db.doc(`stores/${storeId}/tables/${tableId}`) : null;
      const tableSnap = tableRef ? await tx.get(tableRef) : null;
      const freeTable = !!tableSnap?.exists && (tableSnap.data() as Record<string, any>)?.currentSessionId === sessionId;

      // ---- writes ----
      const byStation = new Map<string, string[]>();
      for (const t of ticketsSnap.docs) {
        const state = t.data() as Record<string, any>;
        if (state.status !== 'preparing' && state.status !== 'ready') continue;
        const update = { status: 'cancelled', cancelledAt: FV.serverTimestamp(), cancelledAtClientMs: nowMs, cancelledByUid: caller.uid, cancelReason: 'Session Voided', updatedAt: FV.serverTimestamp() };
        tx.update(t.ref, update);
        const station = state.kitchenLocationId;
        if (station) {
          byStation.set(station, [...(byStation.get(station) ?? []), t.id]);
          tx.set(db.doc(`stores/${storeId}/rtKdsTickets/${station}/closedKdsTickets/${t.id}`), { ...state, ...update });
        }
      }
      for (const [station, ids] of byStation) {
        tx.set(
          db.doc(`stores/${storeId}/rtKdsTickets/${station}`),
          {
            tickets: Object.fromEntries(ids.map((id) => [id, FV.delete()])),
            activeIds: FV.arrayRemove(...ids),
            sessionIndex: { [sessionId]: FV.delete() },
            meta: { updatedAt: FV.serverTimestamp() },
          },
          { merge: true },
        );
      }

      tx.update(sessionRef, {
        status: 'voided',
        voidedAt: FV.serverTimestamp(),
        voidedByUid: caller.uid,
        voidedByUsername: caller.username ?? caller.name,
        voidReason: reason,
        updatedAt: FV.serverTimestamp(),
        ...(approverPersonId ? { voidApprovedByPersonId: approverPersonId } : {}),
      });

      if (activeSnap.exists) {
        tx.set(closedRef, { ...(activeSnap.data() as Record<string, any>), status: 'voided', customerAccessEnabled: false, updatedAt: FV.serverTimestamp(), closedAt: FV.serverTimestamp() });
        tx.delete(activeRef);
      }

      if (tableRef && freeTable) {
        tx.update(tableRef, { status: 'available', currentSessionId: null, updatedAt: FV.serverTimestamp() });
        tx.set(
          db.doc(`stores/${storeId}/storeConfig/current/tables/${tableId}`),
          { status: 'available', currentSessionId: null, customerName: null, packageLabel: null, sessionType: null, guestCount: null, itemCount: null, startedAtMs: null, updatedAt: FV.serverTimestamp() },
          { merge: true },
        );
      }
    });

    return jsonResponse(200, { ok: true, sessionId });
  });
}
