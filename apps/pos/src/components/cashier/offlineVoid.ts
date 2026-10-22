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
import { assertOfflineSessionOwner, assertOfflineVoidAllowed } from "@/lib/offline/offlineRules";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import {
  SERVER_TIMESTAMP_MARKER as TS,
  applyOpsToBatch,
  arrayRemoveMarker,
  deleteFieldMarker,
  encodeLedgerValue,
  reserveOfflineEvent,
  type LedgerOp,
} from "@/lib/outbox/ledger";
import { computeLinesHash } from "@/lib/outbox/linesHash";
import { rejectIfRefused } from "@/lib/outbox/refusal";
import { notifyOutboxChanged } from "@/lib/outbox/outboxStatus";

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
 *
 * T-425 (bible row 356): offline, ONLY a signed-in manager or admin may void, and only a table this tablet opened. The void is LEDGER-FIRST
 * like a sale: it reserves a terminal number (an event of kind `void`, so every number stays explained) and stores its COMPLETE write list
 * as plain data; the batch is then built FROM those ops. The session carries the additive `voidedOffline: true`; `pos2-audit.mjs` and the
 * "Review after outage" list show these voids.
 */
export async function voidSessionOffline(args: {
  storeId: string;
  sessionId: string;
  reason: string;
  actor: AppUser;
}): Promise<{ reversedRedemptionIds: string[]; pin: string | null }> {
  const { storeId, sessionId, reason, actor } = args;
  assertOfflineVoidAllowed((actor as { role?: string | null }).role);
  const safeReason = (reason ?? "").toString().trim();
  const sessionRef = doc(db, "stores", storeId, "sessions", sessionId);
  const nowMs = Date.now();

  const activeProjectionRef = doc(db, `stores/${storeId}/activeSessions`, sessionId);

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

  // One tablet bills a table (ADR-015 section 5): refused before anything is reserved.
  assertOfflineSessionOwner(sessionData, getBrowserDeviceId());

  const reversedRedemptionIds: string[] = Array.isArray(sessionData.loyaltyRedemptions)
    ? sessionData.loyaltyRedemptions.map((r: any) => r.redemptionId).filter(Boolean)
    : [];

  // Free the table + its projection. Unlike the online transaction (which reads the table inside the tx), offline we must GUARD the update:
  // a table doc absent from this device's cache — or re-seated by another device during the outage — would fail the ENTIRE void batch on
  // sync (silent loss) or LWW-clobber a live session's table. (Reconcile re-checks the same thing against the server.)
  let freeTable = false;
  if (sessionData.tableId && sessionData.tableId !== "alacarte") {
    const tableSnap = await getDoc(doc(db, "stores", storeId, "tables", sessionData.tableId));
    freeTable = tableSnap.exists() && (tableSnap.data() as any).currentSessionId === sessionId;
  }

  // The number's store code: the store doc from the cache, else the store id (a void has no printed receipt number).
  let storeCode = storeId;
  try {
    const storeSnap = await getDoc(doc(db, "stores", storeId));
    const code = storeSnap.exists() ? (storeSnap.data() as any)?.code : null;
    if (typeof code === "string" && code.trim()) storeCode = code;
  } catch {
    /* keep the store id */
  }

  const event = await reserveOfflineEvent({
    kind: "void",
    storeCode,
    receiptId: sessionId,
    totalCentavos: 0,
    linesHash: computeLinesHash([]),
    tenders: [],
    createdAtClientMs: nowMs,
    buildOps: (): LedgerOp[] => {
      const ops: LedgerOp[] = [];

      // Cancel any remaining active tickets (verbatim from online voidSession).
      for (const ticketDoc of activeTicketsSnap.docs) {
        const ticketRef = ticketDoc.ref;
        const oldTicketState = ticketDoc.data() as any;
        const updatePayload = {
          status: "cancelled" as const,
          cancelledAt: TS,
          cancelledAtClientMs: nowMs,
          cancelledByUid: actor.uid,
          cancelReason: "Session Voided",
          updatedAt: TS,
        };
        ops.push({ op: "update", path: ticketRef.path, data: updatePayload as Record<string, unknown> });

        const stationId = oldTicketState.kitchenLocationId;
        if (stationId) {
          ops.push({
            op: "update",
            path: `stores/${storeId}/rtKdsTickets/${stationId}`,
            data: {
              [`tickets.${ticketRef.id}`]: deleteFieldMarker(),
              activeIds: arrayRemoveMarker(ticketRef.id),
              [`sessionIndex.${sessionId}`]: deleteFieldMarker(), // delete empty array key
              "meta.updatedAt": TS,
            },
          });
          // Add to historical view
          ops.push({
            op: "set",
            path: `stores/${storeId}/rtKdsTickets/${stationId}/closedKdsTickets/${ticketRef.id}`,
            data: { ...(encodeLedgerValue(oldTicketState) as Record<string, unknown>), ...updatePayload },
          });
        }
      }

      // Void the session. NOTE: unlike online voidSession, offline bumps `revision` for ownership consistency with the offline payment path.
      ops.push({
        op: "update",
        path: `stores/${storeId}/sessions/${sessionId}`,
        data: {
          status: "voided",
          voidedAt: TS,
          voidedByUid: actor.uid,
          voidedByUsername: getActorStamp(actor).username,
          voidReason: safeReason,
          updatedAt: TS,
          revision: Number(sessionData.revision ?? 1) + 1,
          // Stamp the offline origin so a guardrail can reject a void of a session already finalized on the server (stale-cache void).
          offlineOrigin: true,
          // T-425 (additive): a manager reviews every void made without the internet.
          voidedOffline: true,
        },
      });

      // Move projection from active to closed (verbatim from online voidSession).
      if (projectionData) {
        ops.push({
          op: "set",
          path: `stores/${storeId}/closedSessions/${sessionId}`,
          data: { ...(encodeLedgerValue(projectionData) as Record<string, unknown>), status: "voided", customerAccessEnabled: false, updatedAt: TS, closedAt: TS },
        });
        ops.push({ op: "delete", path: `stores/${storeId}/activeSessions/${sessionId}` });
      }

      if (freeTable) {
        ops.push({ op: "update", path: `stores/${storeId}/tables/${sessionData.tableId}`, data: { status: "available", currentSessionId: null, updatedAt: TS } });
        ops.push({
          op: "update",
          path: `stores/${storeId}/storeConfig/current/tables/${sessionData.tableId}`,
          data: {
            status: "available",
            currentSessionId: null,
            customerName: null,
            packageLabel: null,
            sessionType: null,
            guestCount: null,
            itemCount: null,
            startedAtMs: null,
            updatedAt: TS,
          },
        });
      }
      return ops;
    },
  });
  notifyOutboxChanged();

  // Build the batch FROM the stored ops and commit it local-first: do not await a server ack that never comes offline.
  const batch = writeBatch(db);
  applyOpsToBatch(batch, event.ops ?? [], {
    doc: (path) => doc(db, path),
    serverTimestamp,
    deleteField,
    arrayRemove,
  });
  commitLocalFirst(batch, (err) => {
    console.error("[voidSessionOffline] offline sync failed", err);
    void rejectIfRefused(event, err).then(() => notifyOutboxChanged());
  });

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
