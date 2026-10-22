

'use client';

import {
  collection,
  doc,
  serverTimestamp,
  getDocs,
  getDoc,
  updateDoc,
  runTransaction,
  query,
  where,
  orderBy,
  deleteField,
  increment,
  type DocumentReference,
  type DocumentSnapshot,
  type DocumentData,
  type Firestore,
  type Transaction,
  type WriteBatch,
  arrayUnion,
  arrayRemove,
  setDoc,
  writeBatch,
} from 'firebase/firestore';

import { db, auth } from '@/lib/firebase/client';
import { selectTicketWriter } from '@/lib/offline/kitchenTicketWrites';
import { servedQtyFields } from '@/lib/kitchen/served-qty';
import { AppUser } from '@/context/auth-context';
import type {
  Store,
  StorePackage,
  Payment,
  ModeOfPayment,
  SessionBillLine,
  Discount,
  Adjustment,
  SessionLoyaltyRedemption,
  ReceiptAnalyticsV2,
  Receipt,
  KitchenTicket,
  LineAdjustment,
  PendingSession,
  OrderItemType,
} from '@/lib/types';

import { stripUndefined } from '@/lib/firebase/utils';
import { statutoryInputOf, receiptStatutoryDiners } from '@/lib/statutory/session';
import { maskDinersForClosedSession, statutoryPaymentBlockers } from '@/lib/statutory/capture';
import { assertStatutoryPaymentReady } from '@/lib/statutory/payment';
import { assertBillDiscountAllowed } from './statutory-presets';
import { printKitchenTicketBackup } from '@/lib/printing/kitchenBackupPrint';
import { makeKitchenBackupDeps } from '@/lib/printing/kitchenBackupDeps';
import { roundHalfUp, storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { buildOfflinePaymentSummary } from '@/lib/offline/offlinePaymentSummary';
import { markAcknowledged, markSkipped, reserveOnlineEvent } from '@/lib/outbox/ledger';
import { computeLinesHash } from '@/lib/outbox/linesHash';
import { getConnectivityStore } from '@/hooks/useConnectivity';
import { notifyOutboxChanged } from '@/lib/outbox/outboxStatus';
import { computeSessionLabel } from '@/lib/utils/session';
import { writeActivityLog } from '@/components/cashier/activity-log';
import { commitLocalFirst } from '@/lib/offline/commit';
import { sessionOwnershipFields } from '@/lib/offline/sessionOwnership';
import { getBrowserDeviceId } from '@/lib/offline/browserDevice';
import { getActiveLocalProfile } from '@/lib/server-profiles/activeLocalProfile';
import { calculateBillTotals } from '@/lib/tax';
import { bundleExtraPax } from '@/lib/billing/bundle';
import { v4 as uuidv4 } from 'uuid';
import { applyAnalyticsDeltaV2 } from '@/lib/analytics/applyAnalyticsDeltaV2';
import { applyReceiptDeltaServerFirst } from '@/lib/analytics/applyReceiptDeltaServerFirst';
import { applyKdsTicketDelta } from '@/lib/analytics/applyKdsTicketDelta';
import { applyKdsDeltaServerFirst } from '@/lib/analytics/applyKdsDeltaServerFirst';
import { computeKdsTargets } from '@/lib/analytics/kdsTargets';
import { toJsDate } from '@/lib/utils/date';
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";

export type ActorStamp = { uid: string; username: string; email?: string | null };

export function getActorStamp(user: AppUser): ActorStamp {
  // Prefer the device's signed-in local profile — the actual cashier/server operating
  // the POS — for the display name. Admin/manager bypass the local-user gate, so for
  // them this is null and we fall back to their own account name. The receipt's
  // CASHIER line and all action attribution should read the operator, not the
  // shared/admin login. uid stays the authenticated account for audit integrity.
  const localName = getActiveLocalProfile()?.name?.trim();
  const username =
    localName ||
    (user.displayName && user.displayName.trim()) ||
    ((user as any).name && String((user as any).name).trim()) ||
    (user.email ? user.email.split('@')[0] : '') ||
    user.uid.slice(0, 6);

  return { uid: user.uid, username, email: user.email ?? null };
}

export type StartSessionPayload = {
  tableId: string;
  tableNumber: string;
  displayName?: string;
  guestCount: number;
  customer?: { name?: string | null; tin?: string | null; address?: string | null };
  notes?: string;
  initialFlavorIds?: string[];
  package?: StorePackage; // Optional for ala carte
  sessionMode: 'package_dinein' | 'alacarte';
};


export async function getCurrentSessionBillingState(storeId: string, sessionId: string) {
  const sessionRef = doc(db, `stores/${storeId}/sessions`, sessionId);
  const linesRef = query(
    collection(db, `stores/${storeId}/sessions/${sessionId}/sessionBillLines`),
    orderBy("createdAt", "asc"),
  );
  const [sessionSnap, linesSnap] = await Promise.all([getDoc(sessionRef), getDocs(linesRef)]);
  const sessionData = sessionSnap.data() as PendingSession | undefined;
  if (!sessionData) throw new Error(`Session ${sessionId} does not exist.`);
  return {
    billingRevision: Number((sessionData as any).billingRevision ?? 0),
    session: sessionData,
    billDiscount: ((sessionData as any).billDiscount ?? null) as Discount | null,
    customAdjustments: Array.isArray((sessionData as any).customAdjustments)
      ? ((sessionData as any).customAdjustments as Adjustment[])
      : [],
    loyaltyRedemptions: (Array.isArray((sessionData as any).loyaltyRedemptions)
      ? (sessionData as any).loyaltyRedemptions
      : []) as SessionLoyaltyRedemption[],
    billLines: linesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as SessionBillLine)),
  };
}

/**
 * Starts a new dining session.
 * Creates session doc, table update, and initial kitchen/billing units.
 */
export async function startSession(storeId: string, payload: StartSessionPayload, user: AppUser) {
  const newSessionRef = doc(collection(db, `stores/${storeId}/sessions`));

  const isAlaCarte = payload.sessionMode === 'alacarte';
  const customerName = payload.customer?.name ?? null;
  const tableNumber = isAlaCarte ? null : payload.tableNumber;
  const tableDisplayName = payload.displayName || `Table ${payload.tableNumber}`;
  const sessionLabel = computeSessionLabel({ sessionMode: payload.sessionMode, customerName, tableDisplayName: tableDisplayName });

  // Bundle packages bill as a single flat-priced unit (qty 1 @ bundlePrice)
  // while the entered guestCount stays the headcount that drives PINs, covers,
  // kitchen prep, and analytics.
  const isBundle = !!payload.package?.isBundle;
  const bundlePrice = Number(payload.package?.bundlePrice ?? 0);
  const bundleMaxCap = Number(payload.package?.bundleMaxCap ?? 0);
  const bundleExtraHeadPrice = Number(payload.package?.bundleExtraHeadPrice ?? 0);
  const packageSnapshot = payload.package
    ? {
        name: payload.package.packageName,
        pricePerHead: payload.package.pricePerHead,
        ...(isBundle ? { isBundle: true, bundlePrice, bundleMaxCap, bundleExtraHeadPrice } : {}),
      }
    : null;

  const ownership = sessionOwnershipFields(getBrowserDeviceId());

  const sessionPayload = stripUndefined({
    id: newSessionRef.id,
    ...ownership,
    storeId,
    tableId: payload.tableId,
    tableNumber,
    tableDisplayName,
    customerName,
    sessionLabel,
    status: isAlaCarte ? 'active' : 'pending_verification',
    sessionMode: payload.sessionMode,
    isPaid: false,
    startedAt: serverTimestamp(),
    startedAtClientMs: Date.now(),
    startedByUid: user.uid,
    guestCountCashierInitial: payload.guestCount,
    guestCountServerVerified: null,
    guestCountFinal: isAlaCarte ? null : payload.guestCount,
    guestCountVerifyLocked: isAlaCarte,
    verifiedAt: null,
    verifiedByUid: null,
    packageOfferingId: payload.package?.packageId || null,
    packageSnapshot,
    initialFlavorIds: payload.initialFlavorIds || [],
    customer: payload.customer,
    notes: payload.notes || '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Captured when the package-ticket path below builds a ticket, so the
  // offline backup print (fired after commitLocalFirst) has a payload to
  // print without re-deriving it.
  let packageTicketPayload: Record<string, any> | null = null;

  const batch = writeBatch(db);
    // 1. Create the new session document
    batch.set(newSessionRef, sessionPayload);

    // 2. Update the table document and its projection if not ala carte
    if (!isAlaCarte) {
      const tableRef = doc(db, `stores/${storeId}/tables`, payload.tableId);
      batch.update(tableRef, {
        status: 'occupied',
        currentSessionId: newSessionRef.id,
        updatedAt: serverTimestamp(),
      });
      
      const tableProjectionRef = doc(db, `stores/${storeId}/storeConfig/current/tables`, payload.tableId);
      batch.update(tableProjectionRef, {
        status: 'occupied',
        currentSessionId: newSessionRef.id,
        customerName: customerName,
        packageLabel: payload.package?.packageName || null,
        sessionType: payload.sessionMode,
        guestCount: payload.guestCount,
        startedAtMs: sessionPayload.startedAtClientMs,
        updatedAt: serverTimestamp(),
      });
    }

    // 3. Write session projection to the new location
    const sessionProjectionRef = doc(db, `stores/${storeId}/activeSessions`, newSessionRef.id);
    const projectionPayload = {
      id: newSessionRef.id,
      ...ownership,
      status: isAlaCarte ? 'active' : 'pending_verification',
      sessionMode: payload.sessionMode,
      tableId: payload.tableId,
      tableNumber: isAlaCarte ? null : payload.tableNumber,
      tableDisplayName: isAlaCarte ? null : tableDisplayName,
      customerName: customerName,
      packageOfferingId: payload.package?.packageId || null,
      packageName: payload.package?.packageName || null, // Denormalize for server page
      packageSnapshot,
      guestCountCashierInitial: payload.guestCount,
      guestCountFinal: isAlaCarte ? null : payload.guestCount,
      startedAt: serverTimestamp(),
      startedAtClientMs: sessionPayload.startedAtClientMs,
      updatedAt: serverTimestamp(),
      initialFlavorIds: payload.initialFlavorIds || [],
    };
    batch.set(sessionProjectionRef, projectionPayload);


    // 4. Create package bill line and kitchen ticket if applicable
    if (payload.sessionMode === 'package_dinein' && payload.package) {
      const lineId = `package_${payload.package.packageId}`;
      const lineRef = doc(db, `stores/${storeId}/sessions/${newSessionRef.id}/sessionBillLines`, lineId);
      batch.set(lineRef, {
        id: lineId,
        type: 'package',
        itemId: payload.package.packageId,
        itemName: payload.package.packageName,
        // Bundle: one flat-priced unit. Per-head: pricePerHead × guestCount.
        unitPrice: isBundle ? bundlePrice : payload.package.pricePerHead,
        qtyOrdered: isBundle ? 1 : payload.guestCount,
        discountType: null,
        discountValue: 0,
        discountQty: 0,
        freeQty: 0,
        voidedQty: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedByUid: user.uid,
        updatedByName: getActorStamp(user).username,
      });

      // Bundle overflow: guests beyond the cap are billed per-head on a separate
      // "Extra Pax" addon line. Only when the bundle has an extra-head price.
      const extraQty = bundleExtraPax(payload.guestCount, bundleMaxCap);
      if (isBundle && bundleExtraHeadPrice > 0 && extraQty > 0) {
        const extraLineId = `bundleextra_${payload.package.packageId}`;
        const extraLineRef = doc(db, `stores/${storeId}/sessions/${newSessionRef.id}/sessionBillLines`, extraLineId);
        batch.set(extraLineRef, {
          id: extraLineId,
          type: 'addon',
          itemId: extraLineId,
          itemName: `Extra Pax — ${payload.package.packageName}`,
          category: 'Extra Pax',
          unitPrice: bundleExtraHeadPrice,
          qtyOrdered: extraQty,
          discountType: null,
          discountValue: 0,
          discountQty: 0,
          freeQty: 0,
          voidedQty: 0,
          kitchenLocationId: null,
          kitchenLocationName: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedByUid: user.uid,
          updatedByName: getActorStamp(user).username,
        });
      }

      const stationKey = payload.package.kitchenLocationId;
      if (!stationKey) {
        throw new Error(`Package with ID ${payload.package.packageId} does not have a kitchen location assigned.`);
      }
      const ticketRef = doc(collection(db, 'stores', storeId, 'sessions', newSessionRef.id, 'kitchentickets'));
      const ticketPayload = stripUndefined({
        id: ticketRef.id,
        sessionId: newSessionRef.id,
        storeId,
        tableId: payload.tableId,
        tableNumber: payload.tableNumber,
        tableDisplayName: tableDisplayName,
        type: 'package',
        itemId: payload.package.packageId,
        itemName: payload.package.packageName,
        guestCount: payload.guestCount,
        status: 'preparing',
        kitchenLocationId: stationKey,
        kitchenLocationName: payload.package.kitchenLocationName,
        notes: payload.notes || '',
        qty: 1,
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
        createdAtClientMs: Date.now(),
        sessionMode: 'package_dinein',
        customerName: payload.customer?.name,
        sessionLabel,
        initialFlavorIds: payload.initialFlavorIds,
      });
      batch.set(ticketRef, ticketPayload);
      packageTicketPayload = ticketPayload;

      // KDS PROJECTION WRITE
      const rtKdsDocRef = doc(db, "stores", storeId, "rtKdsTickets", stationKey);
      batch.set(rtKdsDocRef, {
        meta: { source: 'startSession', updatedAt: serverTimestamp() },
        kitchenLocationId: stationKey,
      }, { merge: true });
      batch.update(rtKdsDocRef, {
          [`tickets.${ticketRef.id}`]: ticketPayload,
          activeIds: arrayUnion(ticketRef.id),
          [`sessionIndex.${newSessionRef.id}`]: arrayUnion(ticketRef.id)
      });
    }

  commitLocalFirst(batch, (err) => {
    console.error('[startSession] batch sync failed', err);
  });

  // Fire-and-forget backup print to the shared kitchen Bluetooth printer.
  // startSession has no React `isOnline` (it's a plain data-layer function),
  // so it asks the connectivity store (a probe of the POS server, T-425). Never awaited into the order
  // flow; any dep (or the kitchenLocations fetch) throwing is swallowed.
  if (!getConnectivityStore().getState().online && packageTicketPayload) {
    const ticketToPrint = packageTicketPayload;
    void (async () => {
      const klSnap = await getDocs(collection(db, 'stores', storeId, 'kitchenLocations'));
      const kitchenLocations = klSnap.docs.map((d) => ({ id: d.id, printOnOutage: (d.data() as any).printOnOutage }));
      const deps = makeKitchenBackupDeps({
        kitchenLocations,
        stampTicket: (ticketId) => {
          const ref = doc(db, 'stores', storeId, 'sessions', newSessionRef.id, 'kitchentickets', ticketId);
          void updateDoc(ref, { printedOffline: true, printedOfflineAt: Date.now(), printedOfflineDevice: getBrowserDeviceId() }).catch(() => {});
          // Also patch the rtKdsTickets projection the KDS page actually reads
          // from, so the auto-ack effect there can see the stamp.
          const _stationId = ticketToPrint.kitchenLocationId;
          if (_stationId) {
            void updateDoc(doc(db, 'stores', storeId, 'rtKdsTickets', _stationId), {
              [`tickets.${ticketId}.printedOffline`]: true,
              [`tickets.${ticketId}.printedOfflineAt`]: Date.now(),
            }).catch(() => {});
          }
        },
        alert: (message) => console.warn(`[startSession] ${message}`),
      });
      await printKitchenTicketBackup(ticketToPrint as any, deps);
    })().catch(() => {});
  }

  const packageName = payload.package?.packageName || null;
  const guestCount = payload.guestCount ?? 0;
  const startedNote = payload.sessionMode === 'alacarte'
    ? `Session started (Ala Carte)`
    : `Started: ${packageName || 'Package'} · ${guestCount} pax (cashier)`;

  void writeActivityLog({
    storeId,
    sessionId: newSessionRef.id,
    user,
    action: 'SESSION_STARTED',
    note: startedNote,
    qty: guestCount,
    meta: {
      itemName: packageName ?? undefined,
      qty: guestCount,
      cashierGuestCount: guestCount,
    } as any,
    sessionContext: {
      sessionStatus: sessionPayload.status as any,
      sessionStartedAt: sessionPayload.startedAt,
      sessionMode: sessionPayload.sessionMode ?? undefined,
      customerName: sessionPayload.customerName,
      tableNumber: sessionPayload.tableNumber,
      tableDisplayName: tableDisplayName ?? null,
    }
  }).catch((err) => console.warn('[startSession] activity log sync failed', err));

  return newSessionRef.id;
}


/**
 * Completes a payment and closes the dining session idempotently using individual billing units.
 * Uses a Firestore transaction to ensure atomicity.
 */
export async function completePaymentFromUnits(
  storeId: string,
  sessionId: string,
  user: AppUser,
  payments: Payment[],
  store: Store,
  paymentMethods: ModeOfPayment[],
  expectedTotal?: number
) {
  let finalReceipt: Receipt | null = null;
  let receiptId = '';
  let sessionContextForLog: any = null;
  let finalReceiptNumber: string | null = null;

  const billingState = await getCurrentSessionBillingState(storeId, sessionId);
  const { billLines, billDiscount, customAdjustments, loyaltyRedemptions } = billingState;
  assertBillDiscountAllowed(billDiscount);
  await assertStatutoryPaymentReady({ storeId, session: billingState.session, lines: billLines, loyalty: loyaltyRedemptions });
  const statutory = statutoryInputOf(billingState.session);
  const loyaltyDiscountInput = (loyaltyRedemptions || []).map((r) => ({ type: r.type, value: r.value }));
  const finalTotals = calculateBillTotals(billLines, store, billDiscount, customAdjustments, loyaltyDiscountInput, statutory);
  const amountDue = finalTotals.grandTotal;
  const amountDueCents = storedPesosToCentavos(amountDue);
  if (typeof expectedTotal === "number" && Math.abs(storedPesosToCentavos(expectedTotal) - amountDueCents) > 1) {
    throw new Error(
      `Bill changed before payment could be finalized. Review the bill and collect ₱${amountDue.toFixed(2)}.`
    );
  }
  // Tender/change check before a receipt number is reserved, so a short payment does not burn a number.
  buildOfflinePaymentSummary({ payments, paymentMethods, amountDueCents });
  const now = Date.now();

  const kdsDeltas: { old: any; new: any }[] = [];
  const rtKdsUpdates: { stationId: string; ticketId: string; ticketState: any }[] = [];

  // Query active tickets BEFORE the transaction (getDocs not supported inside tx)
  const ticketsRef = collection(db, "stores", storeId, "sessions", sessionId, "kitchentickets");
  const activeTicketsQuery = query(ticketsRef, where("status", "in", ['preparing', 'ready']));
  const activeTicketsSnap = await getDocs(activeTicketsQuery);

  // T-423: ONE receipt number per payment from this tablet's own series, reserved BEFORE (and outside) the transaction
  // callback so a Firestore retry reuses it. A crash can skip a number, never reuse one. Refuses with no terminal claim.
  // T-425: through the sale ledger, so every number is explained: `reserved` now, `acknowledged` when the transaction committed, `skipped` when it
  // failed for good (no money). A crash in between leaves `reserved`, which reconcile resolves by reading the server.
  const ledgerEvent = await reserveOnlineEvent({
    kind: 'sale',
    storeCode: store.code,
    receiptId: sessionId,
    totalCentavos: amountDueCents,
    linesHash: computeLinesHash(billLines as unknown[]),
    tenders: payments.map((p) => ({
      method: paymentMethods.find((m) => m.id === p.methodId)?.name || p.methodId || 'unknown',
      centavos: storedPesosToCentavos(p.amount),
      toCheck: false,
      reference: typeof p.reference === 'string' && p.reference.trim() !== '' ? p.reference.trim() : null,
    })),
    createdAtClientMs: now,
  });
  notifyOutboxChanged();
  const reserved = { terminalNo: ledgerEvent.terminalNo, terminalSeq: ledgerEvent.terminalSeq, deviceId: ledgerEvent.deviceId };
  const receiptNumber = ledgerEvent.receiptNumber;

  try {
  await runTransaction(db, async (tx: Transaction) => {
    // --- READ PHASE ---
    const sessionRef = doc(db, `stores/${storeId}/sessions`, sessionId);
    const receiptRef = doc(db, `stores/${storeId}/receipts`, sessionId);
    const activeProjectionRef = doc(db, `stores/${storeId}/activeSessions`, sessionId);
    const terminalRef = doc(db, `stores/${storeId}/terminals`, String(reserved.terminalNo).padStart(2, '0'));
    const receiptNumberRef = doc(db, `stores/${storeId}/receiptNumbers`, receiptNumber);

    const [
      sessionSnap, receiptSnap, activeProjectionSnap, terminalSnap, receiptNumberSnap
    ] = await Promise.all([
      tx.get(sessionRef),
      tx.get(receiptRef),
      tx.get(activeProjectionRef),
      tx.get(terminalRef),
      tx.get(receiptNumberRef),
    ]);
    

    const sessionData = sessionSnap.data();
    if (!sessionData) throw new Error(`Session ${sessionId} does not exist.`);

    const currentBillingRevision = Number((sessionData as any).billingRevision ?? 0);
    if (currentBillingRevision !== billingState.billingRevision) {
      throw new Error("Bill changed during payment. Review the bill and try again.");
    }
    const currentStatutory = statutoryInputOf(sessionData);
    if (JSON.stringify(currentStatutory) !== JSON.stringify(statutory)) throw new Error('Bill changed during payment. Review the bill and try again.');
    if (currentStatutory) {
      const blocked = statutoryPaymentBlockers({ ...currentStatutory, lines: billLines, loyaltyRedemptions });
      if (blocked[0]) throw new Error(blocked[0].message);
    }

    sessionContextForLog = {
      sessionStatus: 'closed',
      sessionStartedAt: sessionData.startedAt,
      sessionMode: sessionData.sessionMode,
      customerName: sessionData.customer?.name ?? sessionData.customerName,
      tableNumber: sessionData.tableNumber,
      tableDisplayName: sessionData.tableDisplayName ?? null,
    };

    if (receiptSnap.exists() && receiptSnap.data()?.analyticsApplied) {
      console.warn(`Payment completion skipped: Analytics for session ${sessionId} already applied.`);
      receiptId = receiptRef.id;
      return;
    }
    if (sessionData.status === 'closed' || sessionData.isPaid === true) {
      console.warn(`Payment completion skipped: Session ${sessionId} is already closed.`);
      receiptId = receiptSnap.exists() ? receiptSnap.id : '';
      return;
    }

    // T-423 Ruling 6/7: this tablet must still hold its terminal, and the number must be unused.
    if (!terminalSnap.exists() || terminalSnap.data()?.deviceId !== reserved.deviceId) {
      throw new Error(
        `This tablet no longer holds terminal ${String(reserved.terminalNo).padStart(2, '0')}. Ask a manager to check the terminal in Settings before taking payment.`
      );
    }
    if (receiptNumberSnap.exists()) {
      throw new Error(`Receipt number ${receiptNumber} is already in use. Nothing was charged; try the payment again.`);
    }

    let tableRef: DocumentReference<DocumentData> | null = null;
    let tableSnap: DocumentSnapshot<DocumentData> | null = null;

    if (sessionData.tableId && sessionData.tableId !== 'alacarte') {
      tableRef = doc(db, `stores/${storeId}/tables`, sessionData.tableId);
      tableSnap = await tx.get(tableRef);
    }

    // Tender, change and the mode-of-payment split (one shared implementation with the offline path).
    const summary = buildOfflinePaymentSummary({ payments, paymentMethods, amountDueCents });

    const actor = getActorStamp(user);
    const serverTs = serverTimestamp();

    // Mark remaining active tickets as served
    for (const ticketDoc of activeTicketsSnap.docs) {
      const ticketRef = ticketDoc.ref;
      const oldTicketState = ticketDoc.data() as KitchenTicket;
      
      if (oldTicketState.status === 'served' || oldTicketState.status === 'cancelled') {
          continue;
      }
      
      const startMs = toJsDate(oldTicketState.createdAtClientMs ?? oldTicketState.createdAt)?.getTime();
      const durationMs = startMs ? Math.max(0, now - startMs) : 0;
      
      // Same quantity bookkeeping the KDS "Served" button writes. Without it
      // this sweep leaves `qtyServed` unset, which logs zero serves to KDS
      // analytics and used to read as "cancelled" in the customer app.
      const updatePayload: any = {
          status: 'served',
          servedAt: serverTs,
          servedAtClientMs: now,
          servedByUid: actor.uid,
          durationMs: durationMs,
          updatedAt: serverTs,
          ...servedQtyFields(oldTicketState),
      };

      const newTicketState: KitchenTicket = { ...oldTicketState, ...updatePayload };
      
      kdsDeltas.push({ old: oldTicketState, new: newTicketState });
      tx.update(ticketRef, updatePayload);
      
      const { kitchenLocationId } = oldTicketState;
      if (kitchenLocationId) {
          rtKdsUpdates.push({ stationId: kitchenLocationId, ticketId: ticketRef.id, ticketState: newTicketState });
      }
    }
    
    // write payments subcollection
    const paymentsCol = collection(db, `stores/${storeId}/sessions`, sessionId, 'payments');
    payments.forEach((payment) => {
      const paymentRef = doc(paymentsCol);
      tx.set(paymentRef, {
        ...payment,
        id: paymentRef.id,
        createdByUid: actor.uid,
        createdByUsername: actor.username,
        createdAt: serverTs,
      });
    });

    // close session
    tx.update(sessionRef, {
      status: 'closed',
      ...(statutory ? { statutoryDiners: maskDinersForClosedSession(statutory.diners) } : {}),
      isPaid: true,
      closedByUid: actor.uid,
      closedByUsername: actor.username,
      closedAt: serverTs,
      closedAtClientMs: now,
      updatedAt: serverTs,
    });
    
    // Move session projection
    const closedProjectionRef = doc(db, `stores/${storeId}/closedSessions`, sessionId);
    if (activeProjectionSnap.exists()) {
      const projectionData = activeProjectionSnap.data();
      tx.set(closedProjectionRef, {
        ...projectionData,
        ...(statutory ? { statutoryDiners: maskDinersForClosedSession(statutory.diners) } : {}),
        status: 'closed',
        customerAccessEnabled: false,
        updatedAt: serverTimestamp(),
        closedAt: serverTimestamp(),
        closedAtClientMs: now,
      });
      tx.delete(activeProjectionRef);
    } else {
        tx.set(closedProjectionRef, {
            ...sessionData,
            ...(statutory ? { statutoryDiners: maskDinersForClosedSession(statutory.diners) } : {}),
            status: 'closed',
            customerAccessEnabled: false,
            updatedAt: serverTimestamp(),
            closedAt: serverTimestamp(),
            closedAtClientMs: now,
        })
    }

    const mopMap = summary.mopMap;
    const totalPaid = summary.totalPaid;
    const change = summary.change;

    // Uniqueness backstop: the web SDK's Transaction has no create(), so this is a read (above) then a set.
    tx.set(receiptNumberRef, { receiptId: sessionId, terminalNo: reserved.terminalNo, terminalSeq: reserved.terminalSeq, createdAt: serverTs });

    const receiptPayload: Omit<Receipt, 'createdAt'> = stripUndefined({
      id: sessionId, storeId, sessionId, createdByUid: actor.uid, createdByUsername: actor.username,
      sessionMode: sessionData.sessionMode,
      tableId: sessionData.sessionMode === 'alacarte' ? null : sessionData.tableId ?? null,
      tableNumber: sessionData.sessionMode === 'alacarte' ? null : sessionData.tableNumber ?? null,
      customerName: sessionData.customer?.name ?? sessionData.customerName ?? null,
      total: amountDue, totalPaid, change, status: 'final',
      receiptSeq: reserved.terminalSeq, receiptNumber, receiptNoFormatUsed: 'TERMINAL',
      terminalNo: reserved.terminalNo, terminalSeq: reserved.terminalSeq, deviceId: reserved.deviceId,
      createdAtClientMs: Date.now(), lines: billLines, billDiscount: billDiscount ?? null, customAdjustments: customAdjustments ?? [], receiptId: sessionId,
      loyaltyRedemptions: loyaltyRedemptions ?? [],
      ...(statutory ? { statutoryDiners: receiptStatutoryDiners(statutory, finalTotals) } : {}),
    } as Omit<Receipt, 'createdAt'>);

    const salesAnalytics = billLines.reduce(
        (acc, line) => {
            if (line.type !== 'package' && line.type !== 'addon') return acc;
            const netQty = Math.max(0, line.qtyOrdered - (line.freeQty || 0) - (line.voidedQty || 0));
            if (netQty <= 0) return acc;
            // T-423: this block works in CENTAVOS and rounds once per line; amounts are turned back into pesos below.
            const unitCentavos = storedPesosToCentavos(line.unitPrice);
            const grossAmount = netQty * unitCentavos;
            const discountBaseUnit = store.taxType === 'VAT_INCLUSIVE' && store.taxRatePct && store.taxRatePct > 0 ? unitCentavos / (1 + store.taxRatePct / 100) : unitCentavos;
            const adjs = Object.values((line as any).lineAdjustments ?? {}) as LineAdjustment[];
            const discountAdjs = adjs.filter(a => a.kind === "discount").sort((a, b) => (a.createdAtClientMs || 0) - (b.createdAtClientMs || 0));
            let discountAmount = 0;
            if (discountAdjs.length > 0) {
              let remaining = netQty;
              for (const a of discountAdjs) {
                const q = Math.min(Number(a.qty || 0), remaining);
                if (q <= 0) continue;
                if (a.type === "percent") discountAmount += q * discountBaseUnit * ((Number(a.value || 0)) / 100);
                else discountAmount += Math.min(discountBaseUnit, storedPesosToCentavos(a.value)) * q;
                remaining -= q;
                if (remaining <= 0) break;
              }
            } else {
              const discountQty = Math.min(line.discountQty || 0, netQty);
              if (discountQty > 0) {
                if (line.discountType === 'percent') discountAmount = discountQty * discountBaseUnit * ((line.discountValue || 0) / 100);
                else discountAmount = Math.min(discountBaseUnit, storedPesosToCentavos(line.discountValue)) * discountQty;
              }
            }
            const netAmount = roundHalfUp(grossAmount - discountAmount);
            const categoryName = (line as any).category || 'Uncategorized';
            acc.salesByItem ??= {}; acc.salesByCategory ??= {};
            if (!acc.salesByItem[line.itemName]) acc.salesByItem[line.itemName] = { qty: 0, amount: 0, categoryName };
            acc.salesByItem[line.itemName].qty += netQty; acc.salesByItem[line.itemName].amount += netAmount;
            if (!acc.salesByCategory[categoryName]) acc.salesByCategory[categoryName] = { qty: 0, amount: 0 };
            acc.salesByCategory[categoryName].qty += netQty; acc.salesByCategory[categoryName].amount += netAmount;
            return acc;
        },
        {} as { salesByItem?: ReceiptAnalyticsV2['salesByItem']; salesByCategory?: ReceiptAnalyticsV2['salesByCategory']; }
    );
    for (const entry of [...Object.values(salesAnalytics.salesByItem ?? {}), ...Object.values(salesAnalytics.salesByCategory ?? {})]) {
      entry.amount = toWirePesos(entry.amount);
    }
    let guestCountSnapshot: ReceiptAnalyticsV2['guestCountSnapshot'] | undefined = undefined;
    if (sessionData.sessionMode === 'package_dinein') {
      const cashierInitial = sessionData.guestCountCashierInitial ?? 0;
      const serverVerified = sessionData.guestCountServerVerified ?? 0;
      const finalGuestCount = sessionData.guestCountFinal ?? Math.max(cashierInitial, serverVerified);
      const pkgLine = billLines.find((l) => l.type === 'package');
      const billableUnits = Math.max(0, (pkgLine?.qtyOrdered ?? 0) - (pkgLine?.voidedQty ?? 0) - (pkgLine?.freeQty ?? 0));
      const isBundle = !!sessionData.packageSnapshot?.isBundle;
      // Bundles bill flat units, not per-cover. Treat headcount as fully covered
      // so the package-count check shows no false discrepancy.
      const billedPackageCovers = isBundle ? finalGuestCount : billableUnits;
      const discrepancy = billedPackageCovers - finalGuestCount;
      const packageOfferingId = sessionData.packageOfferingId ?? null;
      const packageName = sessionData.packageSnapshot?.name ?? pkgLine?.itemName ?? null;
      guestCountSnapshot = { packageOfferingId, packageName, finalGuestCount, billedPackageCovers, discrepancy, computedAtClientMs: Date.now(), rule: 'MAX', ...(isBundle ? { isBundle: true, billedUnits: billableUnits } : {}) };
    }

    const analyticsV2: ReceiptAnalyticsV2 = {
      v: 2,
      sessionStartedAt: sessionData.startedAt ?? sessionData.createdAt ?? null, sessionStartedAtClientMs: sessionData.startedAtClientMs ?? null,
      sessionStartedAtHour: (new Date(sessionData.startedAtClientMs ?? Date.now())).getHours(),
      subtotal: finalTotals.subtotal, discountsTotal: finalTotals.totalDiscounts, chargesTotal: finalTotals.chargesTotal,
      taxAmount: finalTotals.taxTotal, vatableSales: finalTotals.vatableSales, vatExemptSales: finalTotals.vatExemptSales,
      grandTotal: finalTotals.grandTotal, totalPaid, change, mop: mopMap,
      statutoryDiscountTotal: finalTotals.statutoryDiscountTotal, statutoryVatRemovedTotal: finalTotals.statutoryVatRemovedTotal,
      salesByItem: salesAnalytics.salesByItem, salesByCategory: salesAnalytics.salesByCategory,
      servedRefillsByName: sessionData.servedRefillsByName || {},
      serveCountByType: sessionData.serveCountByType || {},
      serveTimeMsTotalByType: sessionData.serveTimeMsTotalByType || {},
      guestCountSnapshot,
    };
    
    finalReceipt = { ...receiptPayload, analytics: analyticsV2, createdAt: serverTs, analyticsApplied: false, analyticsApplyId: uuidv4() } as Receipt;
    
    // analytics applied separately below to avoid hitting 500-transform limit
    tx.set(receiptRef, finalReceipt);
    receiptId = receiptRef.id;
    finalReceiptNumber = receiptNumber;

    if (tableSnap && tableRef && tableSnap.exists()) {
      const t = tableSnap.data() as any;
      if (t.currentSessionId === sessionId) {
        tx.update(tableRef, { status: 'available', currentSessionId: null, updatedAt: serverTs });
        
        const tableProjectionRef = doc(db, `stores/${storeId}/storeConfig/current/tables`, sessionData.tableId);
        tx.update(tableProjectionRef, {
          status: 'available',
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
  });
  } catch (txErr) {
    // A definite failure: this number carries no money. A network failure is AMBIGUOUS (the commit may have landed): leave it `reserved`
    // and reconcile reads the server to decide.
    const code = String((txErr as { code?: unknown } | null)?.code ?? '');
    if (!['unavailable', 'deadline-exceeded', 'cancelled', 'unknown'].includes(code)) {
      await markSkipped(ledgerEvent.deviceId, ledgerEvent.terminalSeq, txErr instanceof Error ? txErr.message : String(txErr)).catch(() => {});
      notifyOutboxChanged();
    }
    throw txErr;
  }
  // The callback wrote a receipt only when it did not return early (already paid / already applied).
  if (finalReceipt) await markAcknowledged(ledgerEvent.deviceId, ledgerEvent.terminalSeq).catch((e) => console.error('[ledger] could not acknowledge the sale', e));
  else await markSkipped(ledgerEvent.deviceId, ledgerEvent.terminalSeq, 'This session was already paid.').catch(() => {});
  notifyOutboxChanged();

  if (rtKdsUpdates.length > 0) {
    try {
      const { writeBatch: wb0, deleteField: df, arrayRemove: ar } = await import("firebase/firestore");
      const rtKdsBatch = wb0(db);
      const byStation = new Map<string, { ticketIds: string[]; states: any[] }>();
      for (const u of rtKdsUpdates) {
        if (!byStation.has(u.stationId)) byStation.set(u.stationId, { ticketIds: [], states: [] });
        byStation.get(u.stationId)!.ticketIds.push(u.ticketId);
        byStation.get(u.stationId)!.states.push({ id: u.ticketId, state: u.ticketState });
      }
      for (const [stationId, { ticketIds, states }] of byStation.entries()) {
        const rtKdsDocRef = doc(db, "stores", storeId, "rtKdsTickets", stationId);
        const mergedUpdate: Record<string, any> = {
          activeIds: ar(...ticketIds),
          [`sessionIndex.${sessionId}`]: df(), // delete empty array key
          "meta.updatedAt": serverTimestamp(),
        };
        for (const tid of ticketIds) mergedUpdate[`tickets.${tid}`] = df();
        rtKdsBatch.update(rtKdsDocRef, mergedUpdate);
        for (const { id, state } of states) {
          const closedTicketRef = doc(db, "stores", storeId, "rtKdsTickets", stationId, "closedKdsTickets", id);
          rtKdsBatch.set(closedTicketRef, state);
        }
      }
      await rtKdsBatch.commit();
    } catch (kdsErr) {
      console.error("[KDS] Failed to update rtKdsTickets for session", sessionId, kdsErr);
    }
  }

  if (kdsDeltas.length > 0) {
    // Server-first KDS analytics (marker-based, idempotent). Fallback also writes
    // the ticket markers so a later server call doesn't double-count.
    const ticketIds = kdsDeltas.map((d) => String(d.new.id)).filter(Boolean);
    await applyKdsDeltaServerFirst(storeId, sessionId, ticketIds, undefined, async () => {
      const { writeBatch: wb2 } = await import("firebase/firestore");
      const kdsBatch = wb2(db);
      for (const d of kdsDeltas) {
        await applyKdsTicketDelta(db, storeId, d.old, d.new, { batch: kdsBatch });
        const tg = computeKdsTargets(d.new);
        kdsBatch.update(doc(db, "stores", storeId, "sessions", sessionId, "kitchentickets", d.new.id), {
          analyticsServedQty: tg.servedQty, analyticsCancelledQty: tg.cancelledQty,
          analyticsDurationMs: tg.durationMs, analyticsDurationCount: tg.durationCount,
        });
      }
      await kdsBatch.commit();
    });
  }

  if (finalReceipt && receiptId) {
    // Prefer the server endpoint (authoritative, server clock, idempotent on
    // analyticsApplied). If it fails for any reason, fall back to the existing
    // client delta so analytics is never silently dropped and payment is never
    // blocked. Both paths are non-fatal — the receipt itself is already committed.
    let appliedViaServer = false;
    try {
      const token = await auth.currentUser?.getIdToken();
      if (token) {
        const res = await fetch("/api/analytics/apply-delta", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ storeId, receiptId, op: "payment" }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j?.ok) {
          appliedViaServer = true;
          console.log("[Analytics] Delta applied server-side for receipt", receiptId, j?.skipped ? "(already applied)" : "");
        }
      }
    } catch (serverErr) {
      console.warn("[Analytics] Server apply-delta failed; falling back to client delta:", serverErr);
    }

    if (!appliedViaServer) {
      const MAX_ANALYTICS_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_ANALYTICS_RETRIES; attempt++) {
        try {
          const { writeBatch: wb, doc: docRef, updateDoc: ud, serverTimestamp: st, getDoc: gd } = await import("firebase/firestore");
          const rRef = docRef(db, `stores/${storeId}/receipts`, receiptId);
          // Guard against double-apply: the server may have committed even if the
          // request appeared to fail (e.g. a timeout after the transaction ran).
          const rSnap = await gd(rRef);
          if (rSnap.exists() && (rSnap.data() as any)?.analyticsApplied === true) {
            console.log("[Analytics] Already applied (server); skipping client fallback for", receiptId);
            break;
          }
          const analyticsBatch = wb(db);
          await applyAnalyticsDeltaV2(db, storeId, null, finalReceipt, { batch: analyticsBatch });
          await analyticsBatch.commit();
          await ud(rRef, { analyticsApplied: true, analyticsAppliedAt: st() });
          console.log("[Analytics] Delta applied (client fallback) for receipt", receiptId);
          break;
        } catch (analyticsErr) {
          console.error(`[Analytics] Client fallback attempt ${attempt + 1} failed for receipt ${receiptId}:`, analyticsErr);
          if (attempt === MAX_ANALYTICS_RETRIES) {
            console.error("[Analytics] All retries exhausted. Receipt", receiptId, "needs manual analytics reconciliation.");
          }
        }
      }
    }
  }

  if (receiptId) {
    try {
      await writeActivityLog({
        storeId, sessionId, user, action: 'PAYMENT_COMPLETED', note: 'Payment completed',
        sessionContext: sessionContextForLog,
        meta: { receiptId, receiptNumber: finalReceiptNumber ?? undefined, paymentTotal: amountDue },
      });
    } catch (logErr) {
      console.error("[ActivityLog] Failed to write payment log for session", sessionId, logErr);
    }
  }

  return receiptId;
}

/**
 * True if a bill-line patch could affect the void / free / discount summary
 * flags on the activeSessions projection. Used to skip the recompute round
 * trip for pure qty / price edits.
 */
function patchAffectsAdjustmentFlags(patch: Record<string, any>): boolean {
  for (const key of Object.keys(patch)) {
    if (key === "voidedQty" || key === "freeQty" || key === "discountQty" || key === "discountValue") return true;
    if (key === "lineAdjustments" || key.startsWith("lineAdjustments.")) return true;
  }
  return false;
}

/**
 * Reads every sessionBillLine for the session, recomputes the three summary
 * booleans, and writes them onto the activeSessions/{sessionId} projection.
 * Replaces the per-session sessionBillLines listener the cashier session-list
 * used to fan out across every active session.
 *
 * Call this after any commit that may have changed a line's void / free /
 * discount state. Safe no-op if the session is no longer in activeSessions
 * (already paid / voided).
 */
export async function recomputeSessionAdjustmentFlags(
  storeId: string,
  sessionId: string,
): Promise<void> {
  if (!storeId || !sessionId) return;
  try {
    const linesRef = collection(db, "stores", storeId, "sessions", sessionId, "sessionBillLines");
    const linesSnap = await getDocs(linesRef);

    let hasVoids = false;
    let hasFree = false;
    let hasDiscounts = false;
    linesSnap.forEach((d) => {
      const data = d.data() as any;
      if ((data.voidedQty ?? 0) > 0) hasVoids = true;
      if ((data.freeQty ?? 0) > 0) hasFree = true;
      if ((data.discountQty ?? 0) > 0 || (data.discountValue ?? 0) > 0) hasDiscounts = true;
      const adjs = data.lineAdjustments ?? {};
      for (const adj of Object.values(adjs) as any[]) {
        if (adj?.kind === "discount") hasDiscounts = true;
      }
    });

    const activeRef = doc(db, "stores", storeId, "activeSessions", sessionId);
    await updateDoc(activeRef, { hasVoids, hasFree, hasDiscounts });
  } catch (e: any) {
    // updateDoc throws if the doc no longer exists in activeSessions (session
    // was finalized in the same window). Badges are irrelevant in that case.
    if (e?.code !== "not-found") {
      console.warn("[recomputeSessionAdjustmentFlags] failed:", e);
    }
  }
}

export type GuestCountApprovalResult = {
  clearedVoidQty: number;
  clampedFreeQty: number;
  clampedDiscountQty: number;
  newBillable: number;
};

/**
 * Approve a pending guest-count change. The approved count is the authoritative
 * final billable headcount, so the package line is reconciled to bill exactly
 * `requestedCount` covers: qtyOrdered is set to the count and the (now
 * redundant) package-cover void is cleared, with free/discount clamped to fit.
 *
 * This closes a double-subtraction bug: voiding covers and approving a
 * guest-count change both reduce `qtyOrdered − voidedQty − freeQty`, so without
 * this reconciliation a prior void would stack on top of the new count (e.g.
 * qty 15, void 10 → approve count 5 left voidedQty 10 → billable max(0, 5-10)=0).
 */
export async function approveGuestCountChange({
  storeId,
  sessionId,
  requestedCount,
  actor,
}: {
  storeId: string;
  sessionId: string;
  requestedCount: number;
  actor: AppUser;
}): Promise<GuestCountApprovalResult> {
  const stamp = getActorStamp(actor);
  const count = Math.max(0, Math.floor(Number(requestedCount) || 0));

  const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
  const projectionRef = doc(db, 'stores', storeId, 'activeSessions', sessionId);

  const result = await runTransaction(db, async (tx: Transaction) => {
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists()) throw new Error('Session disappeared during transaction.');
    const sessionData = sessionSnap.data() as any;
    if (sessionData.status === 'closed' || sessionData.status === 'voided' || sessionData.isPaid) {
      throw new Error('This session has already been closed.');
    }

    // Bundles bill a flat unit, so an approved count only changes the headcount
    // (PINs/covers/analytics), never the package line qty. The approved count is
    // NOT capped: `bundleMaxCap` is the headcount the flat price covers, not a
    // seating limit, so guests beyond it are reconciled onto the Extra Pax line
    // by reconcileBundleLines below.
    const isBundle = !!sessionData.packageSnapshot?.isBundle;

    const packageOfferingId: string | undefined = sessionData.packageOfferingId || undefined;
    const pkgLineRef = packageOfferingId
      ? doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', `package_${packageOfferingId}`)
      : null;

    // All reads must precede all writes in a Firestore transaction.
    const pkgSnap = pkgLineRef ? await tx.get(pkgLineRef) : null;
    const projSnap = await tx.get(projectionRef);

    const summary: GuestCountApprovalResult = {
      clearedVoidQty: 0,
      clampedFreeQty: 0,
      clampedDiscountQty: 0,
      newBillable: count,
    };

    if (isBundle && pkgLineRef && pkgSnap?.exists()) {
      // Flat-billed bundle: leave the package line (qty 1) untouched.
      const line = pkgSnap.data() as any;
      summary.newBillable = Math.max(0, (line.qtyOrdered ?? 1) - (line.voidedQty ?? 0) - (line.freeQty ?? 0));
    } else if (pkgLineRef && pkgSnap?.exists()) {
      const line = pkgSnap.data() as any;
      const prevVoid = Math.max(0, line.voidedQty ?? 0);
      const prevFree = Math.max(0, line.freeQty ?? 0);
      const prevDiscount = Math.max(0, line.discountQty ?? 0);

      const newFree = Math.min(prevFree, count);
      const newDiscount = Math.min(prevDiscount, Math.max(0, count - newFree));

      summary.clearedVoidQty = prevVoid;
      summary.clampedFreeQty = prevFree - newFree;
      summary.clampedDiscountQty = prevDiscount - newDiscount;
      summary.newBillable = Math.max(0, count - newFree);

      const reqAt = sessionData.guestCountChange?.requestedAt;
      const linePatch: Record<string, any> = {
        qtyOrdered: count,
        voidedQty: 0,
        freeQty: newFree,
        discountQty: newDiscount,
        qtyLastSyncedApprovedAt: reqAt ? reqAt.toString() : serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedByUid: stamp.uid,
        updatedByName: stamp.username,
      };
      if (prevVoid > 0) {
        linePatch.voidReason = deleteField();
        linePatch.voidNote = deleteField();
      }
      if (newDiscount === 0) {
        linePatch.discountType = null;
        linePatch.discountValue = 0;
      }
      tx.update(pkgLineRef, linePatch);
    }

    tx.update(sessionRef, {
      guestCountFinal: count,
      'guestCountChange.status': 'approved',
      'guestCountChange.approvedByUid': stamp.uid,
      'guestCountChange.approvedAt': serverTimestamp(),
      billingRevision: increment(1),
      updatedAt: serverTimestamp(),
    });

    if (projSnap.exists()) {
      tx.update(projectionRef, {
        guestCountFinal: count,
        'guestCountChange.status': 'approved',
        updatedAt: serverTimestamp(),
      });
    }

    return summary;
  });

  // Void/free/discount on the package line may have changed; reconverge badges.
  await recomputeSessionAdjustmentFlags(storeId, sessionId);
  // Keep the bundle's flat line at qty 1 and its Extra Pax line in step with the
  // approved headcount immediately (don't wait for the cashier to open the bill).
  await reconcileBundleLines(storeId, sessionId, actor);
  return result;
}

/**
 * Reconcile a bundle session's bill lines to its current `guestCountFinal`:
 * force the flat package line to qty 1, and upsert/zero the "Extra Pax" overflow
 * line to `max(0, guests - cap)` (only when the bundle has an extra-head price and
 * a positive cap). No-op for non-bundle, closed, or paid sessions. Idempotent —
 * writes only when a value actually differs. Runs in its own transaction so it
 * can be called after any headcount-changing mutation (verify, approve) for
 * immediate, race-free correctness; the cashier-bill self-heal remains a backstop.
 */
export async function reconcileBundleLines(storeId: string, sessionId: string, actor: AppUser) {
  const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
  const stamp = getActorStamp(actor);
  type ExtraChange = { before: number; after: number; itemName: string; ctx: any };
  let extraChange: ExtraChange | null = null;
  await runTransaction(db, async (tx: Transaction) => {
    extraChange = null; // reset on transaction retry
    const sSnap = await tx.get(sessionRef);
    if (!sSnap.exists()) return;
    const s = sSnap.data() as any;
    if (!s.packageSnapshot?.isBundle) return;
    if (s.status === 'closed' || s.status === 'voided' || s.isPaid) return;
    const pkgId = s.packageOfferingId;
    if (!pkgId) return;

    const cap = Number(s.packageSnapshot.bundleMaxCap ?? 0);
    const extraPrice = Number(s.packageSnapshot.bundleExtraHeadPrice ?? 0);
    const guests = Number(s.guestCountFinal ?? 0);
    const desiredExtra = bundleExtraPax(guests, cap);
    const itemName = `Extra Pax — ${s.packageSnapshot.name ?? 'Bundle'}`;
    const ctx = {
      sessionStatus: s.status,
      sessionStartedAt: s.startedAt,
      sessionMode: s.sessionMode,
      customerName: s.customer?.name ?? s.customerName ?? null,
      tableNumber: s.tableNumber ?? null,
      tableDisplayName: s.tableDisplayName ?? null,
    };

    const pkgRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', `package_${pkgId}`);
    const extraRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', `bundleextra_${pkgId}`);
    const [pkgSnap, extraSnap] = await Promise.all([tx.get(pkgRef), tx.get(extraRef)]);

    if (pkgSnap.exists() && (pkgSnap.data() as any).qtyOrdered !== 1) {
      tx.update(pkgRef, { qtyOrdered: 1, updatedAt: serverTimestamp(), updatedByUid: stamp.uid, updatedByName: stamp.username });
    }

    if (extraSnap.exists()) {
      const before = Number((extraSnap.data() as any).qtyOrdered ?? 0);
      if (before !== desiredExtra) {
        tx.update(extraRef, { qtyOrdered: desiredExtra, updatedAt: serverTimestamp(), updatedByUid: stamp.uid, updatedByName: stamp.username });
        extraChange = { before, after: desiredExtra, itemName, ctx };
      }
    } else if (extraPrice > 0 && desiredExtra > 0) {
      tx.set(extraRef, {
        id: `bundleextra_${pkgId}`,
        type: 'addon',
        itemId: `bundleextra_${pkgId}`,
        itemName,
        category: 'Extra Pax',
        unitPrice: extraPrice,
        qtyOrdered: desiredExtra,
        discountType: null,
        discountValue: 0,
        discountQty: 0,
        freeQty: 0,
        voidedQty: 0,
        kitchenLocationId: null,
        kitchenLocationName: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedByUid: stamp.uid,
        updatedByName: stamp.username,
      });
      extraChange = { before: 0, after: desiredExtra, itemName, ctx };
    }
  });

  // Audit the overflow change (draft-stage, best-effort). The headcount change
  // itself is already logged by verify/approve; this records the derived effect.
  if (extraChange) {
    const c = extraChange as ExtraChange;
    await writeActivityLog({
      action: 'BUNDLE_EXTRA_PAX_SYNCED',
      storeId,
      sessionId,
      user: actor,
      meta: { itemName: c.itemName, beforeQty: c.before, afterQty: c.after } as any,
      note: `Extra Pax synced ${c.before} → ${c.after}`,
      sessionContext: c.ctx,
    });
  }
}

/**
 * Updates a sessionBillLine document with new values.
 * Uses a transaction to ensure safe updates.
 */
export async function updateSessionBillLine(
  storeId: string,
  sessionId: string,
  lineId: string,
  patch: Partial<SessionBillLine>,
  user: AppUser
) {
  if (!storeId || !sessionId || !lineId) {
    throw new Error('Missing storeId, sessionId, or lineId');
  }

  const lineRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', lineId);
  const actor = getActorStamp(user);

  const updatePayload = {
    ...patch,
    updatedAt: serverTimestamp(),
    updatedByUid: actor.uid,
    updatedByName: actor.username,
  };

  const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
  const batch = writeBatch(db);
  batch.update(lineRef, updatePayload);
  batch.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });
  const affectsFlags = patchAffectsAdjustmentFlags(patch as Record<string, any>);
  if (getConnectivityStore().getState().online) {
    await batch.commit();
    if (affectsFlags) await recomputeSessionAdjustmentFlags(storeId, sessionId);
  } else {
    // Offline: apply locally & sync later; never await the server ack (it never
    // resolves offline) and fire the flag refresh local-first so we don't hang.
    commitLocalFirst(batch, (err) => console.error("[updateSessionBillLine] offline sync failed", err));
    if (affectsFlags) void recomputeSessionAdjustmentFlags(storeId, sessionId).catch(() => {});
  }
}

export async function removeLineAdjustment(
  storeId: string,
  sessionId: string,
  lineId: string,
  adjId: string,
  user: AppUser
) {
  if (!storeId || !sessionId || !lineId || !adjId) {
    throw new Error("Missing required IDs to remove line adjustment.");
  }

  const lineRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', lineId);
  const actor = getActorStamp(user);

  const updatePayload = {
    [`lineAdjustments.${adjId}`]: deleteField(),
    updatedAt: serverTimestamp(),
    updatedByUid: actor.uid,
    updatedByName: actor.username,
  };

  const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
  const batch = writeBatch(db);
  batch.update(lineRef, updatePayload);
  batch.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });
  if (getConnectivityStore().getState().online) {
    await batch.commit();
    await recomputeSessionAdjustmentFlags(storeId, sessionId);
  } else {
    commitLocalFirst(batch, (err) => console.error("[removeLineAdjustment] offline sync failed", err));
    void recomputeSessionAdjustmentFlags(storeId, sessionId).catch(() => {});
  }
}


/**
 * Helper to create kitchen tickets for addon/refill items.
 * Can be used within a transaction or standalone.
 */
export async function createKitchenTickets(
  db: Firestore,
  storeId: string,
  sessionId: string,
  session: PendingSession,
  type: OrderItemType,
  line: { itemId: string; itemName: string; kitchenLocationId: string | null; kitchenLocationName?: string | null; billLineId: string | null },
  qty: number,
  actor: ActorStamp,
  opts: { tx: Transaction } | { batch: WriteBatch },
  notes?: string,
  extra?: Record<string, any>
): Promise<Record<string, any> | null> {
  const ticketsColRef = collection(db, `stores/${storeId}/sessions/${sessionId}/kitchentickets`);
  const now = Date.now();
  const serverTs = serverTimestamp();

  const stationId = line.kitchenLocationId;

  // No kitchen station ⇒ this item is exempt from KDS tickets (the caller still
  // bills it). Skip creating any ticket so a location-less item can't break the
  // order / KDS projection.
  if (!stationId) return null;

  const writer = selectTicketWriter(opts);

  // ONE ticket per line item using qtyOrdered for batch-serve flow
  const ticketRef = doc(ticketsColRef);
  const ticketPayload = stripUndefined({
    ...(extra || {}),
    id: ticketRef.id,
    type: type,
    itemId: line.itemId,
    itemName: line.itemName,
    billLineId: line.billLineId,
    qty: qty,
    qtyOrdered: qty,
    qtyServed: 0,
    qtyCancelled: 0,
    qtyRemaining: qty,
    serveLog: [],
    kitchenLocationId: line.kitchenLocationId,
    kitchenLocationName: line.kitchenLocationName,
    notes: notes || null,
    status: "preparing",
    createdByUid: actor.uid,
    createdAt: serverTs,
    createdAtClientMs: now,
    updatedAt: serverTs,
    sessionId: sessionId,
    storeId,
    tableNumber: session.tableNumber,
    tableDisplayName: session.tableDisplayName,
    customerName: session.customer?.name || session.customerName,
    sessionMode: session.sessionMode,
    sessionLabel: computeSessionLabel(session),
    guestCount: session.guestCountFinal || session.guestCountCashierInitial,
  });

  writer.set(ticketRef, ticketPayload);

  if (stationId) {
    const rtKdsDocRef = doc(db, "stores", storeId, "rtKdsTickets", stationId);
    writer.set(rtKdsDocRef, { meta: { source: 'createKitchenTickets', updatedAt: serverTimestamp() }, kitchenLocationId: stationId }, { merge: true });
    writer.update(rtKdsDocRef, {
      [`tickets.${ticketRef.id}`]: ticketPayload,
      activeIds: arrayUnion(ticketRef.id),
      [`sessionIndex.${sessionId}`]: arrayUnion(ticketRef.id),
    });
  }

  return ticketPayload;
}
