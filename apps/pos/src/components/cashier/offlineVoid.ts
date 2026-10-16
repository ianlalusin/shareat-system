"use client";

import {
  doc,
  collection,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  serverTimestamp,
  deleteField,
  arrayRemove,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { AppUser } from "@/context/auth-context";
import { getActorStamp } from "@/components/cashier/firestore";
import { commitLocalFirst } from "@/lib/offline/commit";
import { writeActivityLog } from "@/components/cashier/activity-log";
import { computeSessionLabel } from "@/lib/utils/session";

/**
 * Records a session void entirely from the local Firestore cache — no
 * network. Mirrors the WRITES of the online `voidSession` transaction
 * (firestore.ts lines 872-1001) as a local-first `writeBatch`: reads the
 * session + active projection from the cache via `getDoc` (instead of a
 * transaction), cancels any still-active kitchen tickets, voids the session,
 * moves the projection active -> closed, and frees the table. Unlike the
 * online path, this function fires the SESSION_VOIDED activity log local-first
 * (fire-and-forget, syncs on reconnect) and returns the customer PIN + reversed
 * loyalty redemption ids so the caller can enqueue their deferred (server-side)
 * finalization once connectivity returns.
 */
export async function voidSessionOffline(args: {
  storeId: string;
  sessionId: string;
  reason: string;
  actor: AppUser;
}): Promise<{ reversedRedemptionIds: string[]; pin: string | null }> {
  const { storeId, sessionId, reason, actor } = args;
  const safeReason = (reason ?? "").toString().trim();
  const sessionRef = doc(db, "stores", storeId, "sessions", sessionId);
  const nowMs = Date.now();

  const activeProjectionRef = doc(db, `stores/${storeId}/activeSessions`, sessionId);
  const closedProjectionRef = doc(db, `stores/${storeId}/closedSessions`, sessionId);

  const ticketsRef = collection(db, "stores", storeId, "sessions", sessionId, "kitchentickets");
  const activeTicketsQuery = query(ticketsRef, where("status", "in", ["preparing", "ready"]));

  const [activeTicketsSnap, sessionSnap, activeProjectionSnap] = await Promise.all([
    getDocs(activeTicketsQuery),
    getDoc(sessionRef),
    getDoc(activeProjectionRef),
  ]);

  const sessionData = sessionSnap.exists() ? (sessionSnap.data() as any) : null;
  const projectionData: any = activeProjectionSnap.exists() ? activeProjectionSnap.data() : null;
  // Read the PIN from the active projection BEFORE the batch deletes it — the
  // online void deletes the projection outright, so this is the last chance.
  const pin: string | null = projectionData?.customerPin ? String(projectionData.customerPin) : null;

  // Idempotency: mirror the online guard exactly. No batch writes if the
  // session is missing or already finalized.
  if (
    !sessionData ||
    sessionData.status === "closed" ||
    sessionData.status === "voided" ||
    sessionData.isPaid
  ) {
    return { reversedRedemptionIds: [], pin };
  }

  const reversedRedemptionIds: string[] = Array.isArray(sessionData.loyaltyRedemptions)
    ? sessionData.loyaltyRedemptions.map((r: any) => r.redemptionId).filter(Boolean)
    : [];

  const batch = writeBatch(db);

  // Cancel any remaining active tickets (verbatim from online voidSession).
  for (const ticketDoc of activeTicketsSnap.docs) {
    const ticketRef = ticketDoc.ref;
    const oldTicketState = ticketDoc.data() as any;
    const updatePayload = {
      status: "cancelled" as const,
      cancelledAt: serverTimestamp(),
      cancelledAtClientMs: nowMs,
      cancelledByUid: actor.uid,
      cancelReason: "Session Voided",
      updatedAt: serverTimestamp(),
    };
    const newTicketState = { ...oldTicketState, ...updatePayload };

    batch.update(ticketRef, updatePayload);

    const stationId = oldTicketState.kitchenLocationId;
    if (stationId) {
      const rtKdsDocRef = doc(db, "stores", storeId, "rtKdsTickets", stationId);
      batch.update(rtKdsDocRef, {
        [`tickets.${ticketRef.id}`]: deleteField(),
        activeIds: arrayRemove(ticketRef.id),
        [`sessionIndex.${sessionId}`]: deleteField(), // delete empty array key
        "meta.updatedAt": serverTimestamp(),
      });
      // Add to historical view
      const closedTicketRef = doc(db, "stores", storeId, "rtKdsTickets", stationId, "closedKdsTickets", ticketRef.id);
      batch.set(closedTicketRef, newTicketState);
    }
  }

  // Void the session. NOTE: unlike online voidSession, offline bumps
  // `revision` for ownership consistency with the offline payment path.
  batch.update(sessionRef, {
    status: "voided",
    voidedAt: serverTimestamp(),
    voidedByUid: actor.uid,
    voidedByUsername: getActorStamp(actor).username,
    voidReason: safeReason,
    updatedAt: serverTimestamp(),
    revision: Number(sessionData.revision ?? 1) + 1,
    // Stamp the offline origin so a future guardrail rule (Plan 4B) can reject a
    // void of a session already finalized on the server (stale-cache void).
    offlineOrigin: true,
  });

  // Move projection from active to closed (verbatim from online voidSession).
  if (activeProjectionSnap.exists()) {
    batch.set(closedProjectionRef, {
      ...projectionData,
      status: "voided",
      customerAccessEnabled: false,
      updatedAt: serverTimestamp(),
      closedAt: serverTimestamp(),
    });
    batch.delete(activeProjectionRef);
  }

  // Free the table + its projection. Unlike the online transaction (which reads
  // the table inside the tx), offline we must GUARD the update: a batch.update on
  // a table doc absent from this device's cache — or re-seated by another device
  // during the outage — would fail the ENTIRE void batch on sync (silent loss) or
  // LWW-clobber a live session's table. Mirror the offlinePayment.ts guard.
  if (sessionData.tableId && sessionData.tableId !== "alacarte") {
    const tableRef = doc(db, "stores", storeId, "tables", sessionData.tableId);
    const tableSnap = await getDoc(tableRef);
    if (tableSnap.exists() && (tableSnap.data() as any).currentSessionId === sessionId) {
      batch.update(tableRef, { status: "available", currentSessionId: null, updatedAt: serverTimestamp() });

      const tableProjectionRef = doc(db, `stores/${storeId}/storeConfig/current/tables`, sessionData.tableId);
      batch.update(tableProjectionRef, {
        status: "available",
        currentSessionId: null,
        customerName: null,
        packageLabel: null,
        sessionType: null,
        guestCount: null,
        itemCount: null,
        startedAtMs: null,
        updatedAt: serverTimestamp(),
      });
    }
  }

  // Commit local-first: do not await a server ack that never comes offline.
  commitLocalFirst(batch, (err) => console.error("[voidSessionOffline] offline sync failed", err));

  // Record the void in the audit log, local-first (fire-and-forget). Voids are
  // the highest-value loss-prevention event, so an outage must not blind the log.
  // writeActivityLog's internal batch.commit() never resolves offline, so we must
  // NOT await it — the local writes apply immediately and sync on reconnect. This
  // mirrors the online voidSession's SESSION_VOIDED log (firestore.ts ~983-995).
  void writeActivityLog({
    storeId,
    sessionId,
    user: actor,
    action: "SESSION_VOIDED",
    reason: safeReason,
    sessionContext: {
      sessionStatus: "voided",
      sessionStartedAt: sessionData.startedAt,
      sessionMode: sessionData.sessionMode ?? undefined,
      customerName: sessionData.customer?.name ?? sessionData.customerName,
      tableNumber: sessionData.tableNumber,
      tableDisplayName: sessionData.tableDisplayName ?? null,
    },
    meta: { sessionLabel: computeSessionLabel(sessionData) },
  }).catch(() => {});

  return { reversedRedemptionIds, pin };
}
