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
import { v4 as uuidv4 } from "uuid";
import { db } from "@/lib/firebase/client";
import { servedQtyFields } from "@/lib/kitchen/served-qty";
import type { AppUser } from "@/context/auth-context";
import type { Payment, Store, ModeOfPayment } from "@/lib/types";
import { stripUndefined } from "@/lib/firebase/utils";
import { calculateBillTotals } from "@/lib/tax";
import { statutoryInputOf, receiptStatutoryDiners } from '@/lib/statutory/session';
import { maskDinersForClosedSession } from '@/lib/statutory/capture';
import { assertStatutoryPaymentReady } from '@/lib/statutory/payment';
import { assertBillDiscountAllowed } from './statutory-presets';
import {
  getActorStamp,
  getCurrentSessionBillingState,
} from "@/components/cashier/firestore";
import { commitLocalFirst } from "@/lib/offline/commit";
import { storedPesosToCentavos } from "@/lib/money/centavos";
import { buildOfflinePaymentSummary } from "@/lib/offline/offlinePaymentSummary";
import { assertOfflineSessionOwner, buildOfflineTenders, tendersToCheck } from "@/lib/offline/offlineRules";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import {
  SERVER_TIMESTAMP_MARKER as TS,
  applyOpsToBatch,
  encodeLedgerValue,
  getEvent,
  reserveOfflineSaleIntent,
  type LedgerEvent,
  type LedgerOp,
} from "@/lib/outbox/ledger";
import { computeLinesHash } from "@/lib/outbox/linesHash";
import { ensureSaleEffectItem } from "@/lib/outbox/effects-store";
import { rejectIfRefused } from "@/lib/outbox/refusal";
import { notifyOutboxChanged } from "@/lib/outbox/outboxStatus";

async function ensureDeferredSaleEffects(event: LedgerEvent, storeId: string, sessionId: string): Promise<void> {
  const projection = event.ops?.find(o => o.path === `stores/${storeId}/closedSessions/${sessionId}`)?.data ?? {};
  const receipt = event.ops?.find(o => o.path === `stores/${storeId}/receipts/${sessionId}`)?.data;
  if (typeof receipt?.total !== 'number') return; // old online reservations have no replayable ops
  const pin = projection.customerPin ? String(projection.customerPin) : null;
  const phone = projection.linkedCustomerPhone ? String(projection.linkedCustomerPhone) : null;
  try {
    await ensureSaleEffectItem({
      storeId, sessionId, receiptId: sessionId, ctx: { pin, phone, amount: receipt.total },
      effects: { analytics: 'pending', loyaltyFinalize: 'pending', loyaltyEarn: phone ? 'pending' : 'skip',
        pinFinalize: pin ? 'pending' : 'skip', loyaltyReverse: 'skip' },
    });
  } catch (e) {
    console.error('[completePaymentOffline] could not queue the deferred effects', e);
  }
}

/**
 * Records a completed sale entirely from the local Firestore cache — no
 * network. Mirrors the CORE of completePaymentFromUnits (reads → checks →
 * receipt → close → free table → mark tickets served) but: (1) reads from
 * cache via getDoc/getDocs; (2) takes the receipt number from this tablet's
 * terminal series (IndexedDB counter, the same series as online); (3) writes via a single writeBatch committed local-first;
 * (4) defers ALL server-only effects (analytics, KDS rollups, loyalty, PINs)
 * to sync. Online sales still go through completePaymentFromUnits unchanged.
 *
 * T-425 (Ruling 1): the sale is LEDGER-FIRST. The COMPLETE write list is built as plain data (`ops`), the receipt number is reserved and the
 * event appended in ONE IndexedDB transaction, and only then is the Firestore batch BUILT FROM those stored ops (`applyOpsToBatch`), so the
 * ledger copy and the real write cannot differ and reconcile can replay them if the SDK loses its queue. Payment doc ids are FIXED
 * (`<sessionId>-p<index>`), never random, so a replay writes the same docs. Refusals (another tablet's table, a tender that needs the
 * internet, an e-wallet with no reference) throw BEFORE a number is reserved. Deferred effects go to the IndexedDB effects store.
 */
export async function completePaymentOffline(
  storeId: string,
  sessionId: string,
  user: AppUser,
  payments: Payment[],
  store: Store,
  paymentMethods: ModeOfPayment[],
  expectedTotal?: number,
): Promise<{ receiptId: string; receiptNumber: string }> {
  // 1. Billing state + totals (cache-served reads).
  const billingState = await getCurrentSessionBillingState(storeId, sessionId);
  const { billLines, billDiscount, customAdjustments, loyaltyRedemptions } = billingState;
  assertBillDiscountAllowed(billDiscount);
  await assertStatutoryPaymentReady({ storeId, session: billingState.session, lines: billLines, loyalty: loyaltyRedemptions, offline: true });
  const statutory = statutoryInputOf(billingState.session);
  const loyaltyDiscountInput = (loyaltyRedemptions || []).map((r) => ({ type: r.type, value: r.value }));
  const finalTotals = calculateBillTotals(billLines, store, billDiscount, customAdjustments, loyaltyDiscountInput, statutory);
  const amountDue = finalTotals.grandTotal;
  if (typeof expectedTotal === "number" && Math.abs(storedPesosToCentavos(expectedTotal) - storedPesosToCentavos(amountDue)) > 1) {
    throw new Error(`Bill changed before payment could be finalized. Review the bill and collect ₱${amountDue.toFixed(2)}.`);
  }

  const now = Date.now();
  const sessionRef = doc(db, `stores/${storeId}/sessions`, sessionId);
  const receiptRef = doc(db, `stores/${storeId}/receipts`, sessionId);
  const activeProjectionRef = doc(db, `stores/${storeId}/activeSessions`, sessionId);

  // Missing individual documents raise unavailable in the real offline SDK. Unknown is NOT server
  // absence: the durable intent transaction below is the duplicate backstop. All other errors propagate.
  const optionalCacheRead = async (ref: typeof receiptRef) => {
    try { return await getDoc(ref); }
    catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'unavailable') return null;
      throw e;
    }
  };
  const [sessionSnap, receiptSnap, activeProjectionSnap] = await Promise.all([
    getDoc(sessionRef),
    optionalCacheRead(receiptRef),
    optionalCacheRead(activeProjectionRef),
  ]);

  const sessionData = sessionSnap.data() as any;
  if (!sessionData) throw new Error(`Session ${sessionId} is not available offline. Open it while online first.`);

  // Idempotency: already finalized.
  if ((receiptSnap?.exists() && receiptSnap.data()?.analyticsApplied) || sessionData.status === "closed" || sessionData.isPaid === true) {
    const existingNumber = receiptSnap?.data()?.receiptNumber as string | undefined;
    if (!existingNumber) throw new Error('This session is already paid. Open its saved receipt before taking another payment.');
    const receipt = receiptSnap?.data();
    if (typeof receipt?.deviceId === 'string' && typeof receipt.terminalSeq === 'number') {
      const saved = await getEvent(receipt.deviceId, receipt.terminalSeq);
      if (saved?.storeId === storeId && saved.receiptId === sessionId && saved.kind === 'sale' && saved.status === 'unsent') {
        await ensureDeferredSaleEffects(saved, storeId, sessionId);
      }
    }
    return { receiptId: receiptSnap?.exists() ? receiptSnap.id : sessionId, receiptNumber: existingNumber };
  }

  // Billing-revision concurrency guard (same as online).
  const currentBillingRevision = Number(sessionData.billingRevision ?? 0);
  if (JSON.stringify(statutoryInputOf(sessionData)) !== JSON.stringify(statutory)) throw new Error('Bill changed during payment. Review the bill and try again.');
  if (currentBillingRevision !== billingState.billingRevision) {
    throw new Error("Bill changed during payment. Review the bill and try again.");
  }

  // One tablet bills a table (ADR-015 section 5): offline, only a session THIS tablet opened. Refused before anything is reserved.
  assertOfflineSessionOwner(sessionData, getBrowserDeviceId());

  // 2. Tender/change validation + MOP (pure, shared with tests), then the offline tender rules (cash; e-wallet with a reference).
  const amountDueCents = storedPesosToCentavos(amountDue);
  const summary = buildOfflinePaymentSummary({ payments, paymentMethods, amountDueCents });
  const tenders = buildOfflineTenders(payments, paymentMethods);

  // 3. Read everything the write list needs from the cache BEFORE the ledger transaction (it cannot await).
  const actor = getActorStamp(user);
  const ticketsRef = collection(db, "stores", storeId, "sessions", sessionId, "kitchentickets");
  const activeTicketsSnap = await getDocs(query(ticketsRef, where("status", "in", ["preparing", "ready"])));
  let freeTable = false;
  if (sessionData.tableId && sessionData.tableId !== "alacarte") {
    const tableSnap = await getDoc(doc(db, `stores/${storeId}/tables`, sessionData.tableId));
    freeTable = tableSnap.exists() && (tableSnap.data() as any).currentSessionId === sessionId;
  }
  const projectionSource = activeProjectionSnap?.data() ?? sessionData;
  const analyticsApplyId = uuidv4();
  const checks = tendersToCheck(tenders);

  // 4. The ledger event: number + the COMPLETE write list, in ONE IndexedDB transaction. A failure here refuses the sale and writes nothing.
  const { event } = await reserveOfflineSaleIntent({
    kind: "sale",
    storeId,
    storeCode: store.code,
    receiptId: sessionId,
    totalCentavos: amountDueCents,
    linesHash: computeLinesHash(billLines as unknown[]),
    intentFingerprint: computeLinesHash([
      billLines, billDiscount, customAdjustments, loyaltyRedemptions, statutory,
      finalTotals, billingState.billingRevision, actor.uid,
      payments.map(p => ({ methodId: p.methodId, amount: p.amount, reference: p.reference ?? null })),
    ]),
    tenders,
    createdAtClientMs: now,
    buildOps: (n): LedgerOp[] => {
      const ops: LedgerOp[] = [];

      // payments subcollection: FIXED ids, so a replay can never add a second copy
      payments.forEach((payment, index) => {
        const id = `${sessionId}-p${index}`;
        ops.push({
          op: "set",
          path: `stores/${storeId}/sessions/${sessionId}/payments/${id}`,
          data: { ...payment, id, createdByUid: actor.uid, createdByUsername: actor.username, createdAt: TS } as Record<string, unknown>,
        });
      });

      // mark active kitchen tickets served (local state; KDS rollups deferred)
      activeTicketsSnap.docs.forEach((t) => {
        const st = t.data() as any;
        if (st.status === "served" || st.status === "cancelled") return;
        // Same quantity bookkeeping the KDS "Served" button writes — see `servedQtyFields`. KDS rollups are deferred on this path, so the
        // fields have to be right on the ticket for the later reconcile to read them.
        ops.push({
          op: "update",
          path: t.ref.path,
          data: { status: "served", servedAt: TS, servedAtClientMs: now, servedByUid: actor.uid, updatedAt: TS, ...servedQtyFields(st) },
        });
      });

      // close session (increment ownership revision)
      ops.push({
        op: "update",
        path: `stores/${storeId}/sessions/${sessionId}`,
        data: {
          status: "closed",
          ...(statutory ? { statutoryDiners: maskDinersForClosedSession(statutory.diners) } : {}),
          isPaid: true,
          closedByUid: actor.uid,
          closedByUsername: actor.username,
          closedAt: TS,
          closedAtClientMs: now,
          revision: Number(sessionData.revision ?? 1) + 1,
          updatedAt: TS,
        },
      });

      // move projection active -> closed
      ops.push({
        op: "set",
        path: `stores/${storeId}/closedSessions/${sessionId}`,
        data: {
          ...(encodeLedgerValue(projectionSource) as Record<string, unknown>),
          ...(statutory ? { statutoryDiners: maskDinersForClosedSession(statutory.diners) } : {}),
          status: "closed",
          customerAccessEnabled: false,
          updatedAt: TS,
          closedAt: TS,
          closedAtClientMs: now,
        },
      });
      // Deleting an unknown/missing projection is idempotent; a cache miss is not proof it is absent remotely.
      ops.push({ op: "delete", path: `stores/${storeId}/activeSessions/${sessionId}` });

      // receipt doc — analytics DEFERRED (analyticsApplied:false, no baked analytics). Additive field: tendersToCheck (e-wallet lines a
      // manager checks against the wallet later).
      const receiptPayload = stripUndefined({
        id: sessionId,
        storeId,
        sessionId,
        receiptId: sessionId,
        createdByUid: actor.uid,
        createdByUsername: actor.username,
        sessionMode: sessionData.sessionMode,
        tableId: sessionData.sessionMode === "alacarte" ? null : sessionData.tableId ?? null,
        tableNumber: sessionData.sessionMode === "alacarte" ? null : sessionData.tableNumber ?? null,
        customerName: sessionData.customer?.name ?? sessionData.customerName ?? null,
        total: amountDue,
        totalPaid: summary.totalPaid,
        change: summary.change,
        status: "final",
        receiptSeq: n.terminalSeq,
        receiptNumber: n.receiptNumber,
        receiptNoFormatUsed: "TERMINAL",
        terminalNo: n.terminalNo,
        terminalSeq: n.terminalSeq,
        deviceId: n.deviceId,
        offlineOrigin: true,
        createdAtClientMs: now,
        lines: billLines,
        billDiscount: billDiscount ?? null,
        customAdjustments: customAdjustments ?? [],
        loyaltyRedemptions: loyaltyRedemptions ?? [],
        ...(statutory ? { statutoryDiners: receiptStatutoryDiners(statutory, finalTotals) } : {}),
        ...(checks.length > 0 ? { tendersToCheck: checks } : {}),
        // Print-critical analytics baked in immediately so the receipt renders correct money totals + MOP offline. Server-only aggregates
        // (salesByItem, salesByCategory, servedRefillsByName, serveCountByType, serveTimeMsTotalByType, guestCountSnapshot) are DEFERRED —
        // Plan 4's sync-time analytics delta computes and applies those.
        analytics: {
          v: 2,
          subtotal: finalTotals.subtotal,
          discountsTotal: finalTotals.totalDiscounts,
          chargesTotal: finalTotals.chargesTotal,
          taxAmount: finalTotals.taxTotal,
          vatableSales: finalTotals.vatableSales,
          vatExemptSales: finalTotals.vatExemptSales,
          statutoryDiscountTotal: finalTotals.statutoryDiscountTotal,
          statutoryVatRemovedTotal: finalTotals.statutoryVatRemovedTotal,
          grandTotal: finalTotals.grandTotal,
          totalPaid: summary.totalPaid,
          change: summary.change,
          mop: summary.mopMap,
        },
        analyticsApplied: false,
        analyticsApplyId,
        createdAt: TS,
      });
      ops.push({ op: "set", path: `stores/${storeId}/receipts/${sessionId}`, data: receiptPayload as Record<string, unknown> });

      // Uniqueness backstop (Ruling 7). Offline this is a plain set: the release gap in claim.ts is what prevents a collision.
      ops.push({
        op: "set",
        path: `stores/${storeId}/receiptNumbers/${n.receiptNumber}`,
        data: { receiptId: sessionId, terminalNo: n.terminalNo, terminalSeq: n.terminalSeq, createdAt: TS },
      });

      // free the table + its projection (only if it still points at this session, checked above against the cache)
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
  if (event.status === 'acknowledged') return { receiptId: sessionId, receiptNumber: event.receiptNumber };

  // 5. Build the Firestore batch FROM the stored ops (one code path) and commit it local-first (does not await the server ack that never
  // comes offline). A definite server refusal later marks the ledger row `rejected`; the SDK losing the write is reconcile's business.
  const batch = writeBatch(db);
  applyOpsToBatch(batch, event.ops ?? [], {
    doc: (path) => doc(db, path),
    serverTimestamp,
    deleteField,
    arrayRemove,
  });
  commitLocalFirst(batch, (err) => {
    console.error("[completePaymentOffline] batch sync failed", err);
    void rejectIfRefused(event, err).then(() => notifyOutboxChanged());
  });

  // 6. Recover the ORIGINAL context and keep one effects item, waiting for acknowledgement.
  await ensureDeferredSaleEffects(event, storeId, sessionId);

  return { receiptId: sessionId, receiptNumber: event.receiptNumber };
}
