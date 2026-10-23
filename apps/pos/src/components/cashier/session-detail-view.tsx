
"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { isDiscountDateActive } from "@/lib/collections/globalCollections";
import { collection, onSnapshot, query, doc, orderBy, updateDoc, serverTimestamp, runTransaction, increment, writeBatch, setDoc, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { updateSessionBillLine, removeLineAdjustment, getActorStamp, createKitchenTickets, recomputeSessionAdjustmentFlags } from "@/components/cashier/firestore";
import { printKitchenTicketBackup } from "@/lib/printing/kitchenBackupPrint";
import { makeKitchenBackupDeps } from "@/lib/printing/kitchenBackupDeps";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import { Loader2, History, ArrowLeft, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SessionHeader } from "@/components/cashier/session-header";
import { LoyaltyRedeemCard } from "@/components/cashier/LoyaltyRedeemCard";
import { isCashierLinked } from "@/lib/loyalty/session-link";
import { BillableItems } from "@/components/cashier/billable-items";
import { BillTotals } from "@/components/cashier/bill-totals";
import { BillAdjustments, BillAppliedAdjustments } from "@/components/cashier/bill-adjustments";
import { statutoryInputOf } from '@/lib/statutory/session';
import { assertBillDiscountAllowed } from './statutory-presets';
import { StatutoryDinersPanel } from './StatutoryDinersPanel';
import { PaymentModal } from "@/components/cashier/payment-modal";
import { LinkCardDialog } from "@/components/cashier/LinkCardDialog";
import { CustomerInfoForm } from "@/components/cashier/customer-info-form";
import { SessionTimelineDrawer } from "@/components/session/session-timeline-drawer";
import { useConfirmDialog } from "../global/confirm-dialog";
import type { PendingSession, Charge, Discount, SessionBillLine, Adjustment, LineAdjustment, SessionLoyaltyRedemption } from "@/lib/types";
import { calculateBillTotals } from "@/lib/tax";
import { bundleExtraPax } from "@/lib/billing/bundle";
import { EditBillableItemDialog } from "./edit-billable-item-dialog";
import { writeActivityLog } from "./activity-log";
import { useStoreConfigDoc } from "@/hooks/useStoreConfigDoc";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDataAnalysis } from "@/hooks/use-data-analysis";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { commitLocalFirst } from "@/lib/offline/commit";
import { formatDurationVerbose } from "@/lib/utils/date";
import { sessionDialogLabel } from "@/lib/sessionLabel";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";


export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const { user, appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const { Dialog, confirm: askConfirm } = useConfirmDialog();
  const isMobile = useIsMobile();
  const isOnline = useOnlineStatus();

  const { config: storeConfig, isLoading: isConfigLoading } = useStoreConfigDoc(activeStore?.id);
  const sessionAnalysis = useDataAnalysis(activeStore?.id, { kind: "thisMonth" });

  const [session, setSession] = useState<PendingSession | null>(null);
  const [billLines, setBillLines] = useState<SessionBillLine[]>([]);
  
  const [billDiscount, setBillDiscount] = useState<Discount | null>(null);
  const [customAdjustments, setCustomAdjustments] = useState<Adjustment[]>([]);
  const [loyaltyRedemptions, setLoyaltyRedemptions] = useState<SessionLoyaltyRedemption[]>([]);
  // Shared lock: true whenever a customAdjustments/billDiscount write is in
  // flight via updateSessionBillingState. Gates BOTH BillAdjustments and
  // BillAppliedAdjustments so a charge/discount add can't race a remove (and
  // vice versa) against the same stale closured `customAdjustments`, which
  // would otherwise let one plain updateDoc silently clobber the other
  // (lost-update on a money field). Each component also keeps its own local
  // isSaving as a second layer.
  const [isMutatingBill, setIsMutatingBill] = useState(false);

  const [isLoadingSession, setIsLoadingSession] = useState(true);

  const [isTimelineOpen, setIsTimelineOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isLinkCardOpen, setIsLinkCardOpen] = useState(false);
  const canLinkCard = appUser?.role === "admin" || appUser?.role === "manager" || appUser?.role === "cashier";
  
  const [editingLineId, setEditingLineId] = useState<string | null>(null);

  const editingLine = useMemo(() => {
    if (!editingLineId) return null;
    return billLines.find(line => line.id === editingLineId) || null;
  }, [billLines, editingLineId]);

  const storeId = activeStore?.id;

  const paymentMethods = useMemo(() => {
    if (!storeConfig?.modesOfPayment) return [];
    return storeConfig.modesOfPayment.filter(m => m.isActive && !(m as any).isArchived);
  }, [storeConfig]);

  const charges = useMemo(() => {
    if (!storeConfig?.charges) return [];
    return storeConfig.charges.filter(c => c.isEnabled && !(c as any).isArchived);
  }, [storeConfig]);

  const billCharges = useMemo(
    () =>
      charges.filter(c => {
        const scope = (c as any).scope;
        if (!scope) return true; // legacy charges default to bill
        const arr = Array.isArray(scope) ? scope : [scope];
        return arr.includes("bill");
      }),
    [charges],
  );
  const itemCharges = useMemo(
    () =>
      charges.filter(c => {
        const scope = (c as any).scope;
        if (!scope) return false; // legacy defaults to bill-only → not in item list
        const arr = Array.isArray(scope) ? scope : [scope];
        return arr.includes("item");
      }),
    [charges],
  );

  const discounts = useMemo(() => {
    if (!storeConfig?.discounts) return [];
    return storeConfig.discounts.filter(d =>
      d.isEnabled && !(d as any).isArchived && isDiscountDateActive(d as any),
    );
  }, [storeConfig]);


  useEffect(() => {
    if (!storeId) return;
    const sessionRef = doc(db, "stores", storeId, "sessions", sessionId);
    const unsubscribe = onSnapshot(sessionRef, (doc) => {
        if (doc.exists()) {
            const data = doc.data();
            setSession({ id: doc.id, ...data } as PendingSession);
            setBillDiscount((data.billDiscount as Discount | null | undefined) ?? null);
            setCustomAdjustments(Array.isArray(data.customAdjustments) ? (data.customAdjustments as Adjustment[]) : []);
            setLoyaltyRedemptions(Array.isArray(data.loyaltyRedemptions) ? (data.loyaltyRedemptions as SessionLoyaltyRedemption[]) : []);
        } else {
            toast({ variant: 'destructive', title: 'Error', description: 'Session not found.' });
            router.replace('/cashier');
        }
        setIsLoadingSession(false);
    }, (error) => {
      console.error("Error fetching session:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not load session data.' });
      router.replace('/cashier');
      setIsLoadingSession(false);
    });
    return () => unsubscribe();
  }, [sessionId, storeId, router, toast]);

  useEffect(() => {
    if (!storeId) return;
    const linesQuery = query(collection(db, `stores/${storeId}/sessions/${sessionId}/sessionBillLines`), orderBy("createdAt", "asc"));
    const unsubLines = onSnapshot(linesQuery, (snapshot) => {
        setBillLines(snapshot.docs.map(d => ({id: d.id, ...d.data()} as SessionBillLine)));
    }, (e) => console.error("sessionBillLines listener failed:", e));

    return () => unsubLines();
  }, [sessionId, storeId]);

  // Sync package quantity based on approved guest count changes
  useEffect(() => {
    if (!session || !appUser || !storeId || billLines.length === 0) return;

    const packageLine = billLines.find(line => line.type === 'package');
    if (!packageLine) return;

    // Bundle packages bill a flat unit (qty 1) regardless of headcount — never
    // sync the line qty to the guest count, or a "good for N" bundle would be
    // billed N× its flat price. Self-heal any line that drifted off 1 (e.g. a
    // session created before this guard existed), then stop.
    if (session.packageSnapshot?.isBundle) {
      const editable = session.status === 'active' && !session.isPaid;
      if (!editable) return;
      // Keep the flat bundle line at qty 1.
      if (packageLine.qtyOrdered !== 1) {
        updateSessionBillLine(storeId, sessionId, packageLine.id, { qtyOrdered: 1 }, appUser)
          .catch(err => console.error("Failed to normalize bundle qty:", err));
      }
      // Reconcile the overflow "Extra Pax" line to guests beyond the cap. A qty-0
      // line is invisible everywhere, so we update rather than delete.
      const cap = Number(session.packageSnapshot.bundleMaxCap ?? 0);
      const extraPrice = Number(session.packageSnapshot.bundleExtraHeadPrice ?? 0);
      const desiredExtra = bundleExtraPax(session.guestCountFinal ?? 0, cap);
      const extraLineId = `bundleextra_${session.packageOfferingId}`;
      const extraLine = billLines.find(l => l.id === extraLineId);
      if (extraLine) {
        if (extraLine.qtyOrdered !== desiredExtra) {
          updateSessionBillLine(storeId, sessionId, extraLineId, { qtyOrdered: desiredExtra }, appUser)
            .catch(err => console.error("Failed to sync extra-pax qty:", err));
        }
      } else if (extraPrice > 0 && desiredExtra > 0) {
        const actor = getActorStamp(appUser);
        setDoc(doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', extraLineId), {
          id: extraLineId,
          type: 'addon',
          itemId: extraLineId,
          itemName: `Extra Pax — ${session.packageSnapshot.name ?? 'Bundle'}`,
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
          updatedByUid: actor.uid,
          updatedByName: actor.username,
        }).catch(err => console.error("Failed to create extra-pax line:", err));
      }
      return;
    }

    const guestChange = session.guestCountChange;
    const approvedAt = guestChange?.status === 'approved' ? guestChange.approvedAt : null;

    if (approvedAt) {
      // A new approval has occurred. Check if we've already synced for this approval.
      if (packageLine.qtyLastSyncedApprovedAt !== approvedAt.toString()) {
        console.debug(`[GuestSync] Re-syncing package qty to ${session.guestCountFinal}.`);
        const beforeQty = packageLine.qtyOrdered;
        const afterQty = session.guestCountFinal || packageLine.qtyOrdered;
        updateSessionBillLine(storeId, sessionId, packageLine.id, {
          qtyOrdered: afterQty,
          qtyOverrideActive: false,
          qtyLastSyncedApprovedAt: approvedAt.toString(),
        }, appUser).then(() => {
          writeActivityLog({
            action: "PACKAGE_QTY_RESYNC_APPROVED_CHANGE",
            meta: { itemName: packageLine.itemName, beforeQty, afterQty },
            note: `Package qty auto-synced from ${beforeQty} to ${afterQty} (guest count approved)`,
            storeId, sessionId, user: appUser,
            sessionContext: { sessionStatus: session.status, sessionStartedAt: session.startedAt, sessionMode: session.sessionMode, customerName: session.customer?.name ?? session.customerName, tableNumber: session.tableNumber, tableDisplayName: session.tableDisplayName ?? null },
          });
        }).catch(err => console.error("Failed to re-sync package qty after approval:", err));
      }
    } else {
      // No current approval. If no override is active, ensure qty matches final count.
      // This handles initial load and any other state corrections.
      if (!packageLine.qtyOverrideActive && session.guestCountFinal !== null && packageLine.qtyOrdered !== session.guestCountFinal) {
        console.debug(`[GuestSync] Aligning package qty to ${session.guestCountFinal}.`);
        updateSessionBillLine(storeId, sessionId, packageLine.id, {
          qtyOrdered: session.guestCountFinal
        }, appUser).catch(err => console.error("Failed to align package quantity:", err));
      }
    }
  }, [session, billLines, appUser, storeId, sessionId]);
  
  const billableDiscounts = useMemo(() => discounts.filter(d => Array.isArray(d.scope) ? d.scope.includes("bill") : d.scope === "bill"), [discounts]);
  const itemDiscounts = useMemo(() => discounts.filter(d => Array.isArray(d.scope) ? d.scope.includes("item") : d.scope === "item"), [discounts]);
  
  const isBillingLocked = session?.status !== 'active' || session?.isPaid;

  const billTotals = useMemo(() => {
    return calculateBillTotals(billLines, activeStore, billDiscount, customAdjustments,
      loyaltyRedemptions.map((r) => ({ type: r.type, value: r.value })), statutoryInputOf(session));
  }, [billLines, activeStore, billDiscount, customAdjustments, loyaltyRedemptions, session]);
  
  const { grandTotal } = billTotals;

  const updateSessionBillingState = async (patch: { billDiscount?: Discount | null; customAdjustments?: Adjustment[] }) => {
    if (!storeId || !sessionId) return;
    setIsMutatingBill(true);
    try {
      const sessionRef = doc(db, "stores", storeId, "sessions", sessionId);
      await updateDoc(sessionRef, {
        ...patch,
        billingRevision: increment(1),
        updatedAt: serverTimestamp(),
      });
    } finally {
      setIsMutatingBill(false);
    }
  };

  const handleUpdateLine = async (lineId: string, before: Partial<SessionBillLine>, after: Partial<SessionBillLine>) => {
    if (!appUser || !storeId || !sessionId || !session) return;
    // Best-effort server side-effects: awaited online, fired local-first when
    // offline (their internal batch.commit() never resolves with no internet;
    // the local write still applies and syncs on reconnect).
    const sideEffect = (run: () => Promise<unknown>): Promise<void> => {
      if (isOnline) return run().then(() => undefined);
      run().catch((err) => console.warn("[session-detail] offline side-effect deferred", err));
      return Promise.resolve();
    };
    try {
        if (isOnline) {
            await runTransaction(db, async (tx) => {
                const lineRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', lineId);
                const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
                const actor = getActorStamp(appUser);

                const updatePayload = {
                    ...after,
                    updatedAt: serverTimestamp(),
                    updatedByUid: actor.uid,
                    updatedByName: actor.username,
                };
                tx.update(lineRef, updatePayload);
                tx.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });

                const line = billLines.find(l => l.id === lineId);
                if (!line) throw new Error("Line item not found in local state.");

                const diffQty = (after.qtyOrdered ?? 0) - (before.qtyOrdered ?? 0);

                if (line.type === 'addon' && diffQty > 0) {
                    const klId = line.kitchenLocationId;
                    if (klId) {
                        await createKitchenTickets(db, storeId, sessionId, session, 'addon', {
                            billLineId: line.id,
                            itemId: line.itemId,
                            itemName: line.itemName,
                            kitchenLocationId: klId,
                            kitchenLocationName: line.kitchenLocationName,
                        }, diffQty, actor, { tx });
                    } else {
                        console.warn(`[Kitchen] No location set for addon "${line.itemName}" — kitchen ticket was NOT created.`);
                    }
                }
            });
        } else {
            const lineRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', lineId);
            const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
            const actor = getActorStamp(appUser);

            const updatePayload = {
                ...after,
                updatedAt: serverTimestamp(),
                updatedByUid: actor.uid,
                updatedByName: actor.username,
            };

            const batch = writeBatch(db);
            batch.update(lineRef, updatePayload);
            batch.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });

            const line = billLines.find(l => l.id === lineId);
            if (!line) throw new Error("Line item not found in local state.");

            const diffQty = (after.qtyOrdered ?? 0) - (before.qtyOrdered ?? 0);

            let ticketPayload: Record<string, any> | null = null;
            if (line.type === 'addon' && diffQty > 0) {
                const klId = line.kitchenLocationId;
                if (klId) {
                    ticketPayload = await createKitchenTickets(db, storeId, sessionId, session, 'addon', {
                        billLineId: line.id,
                        itemId: line.itemId,
                        itemName: line.itemName,
                        kitchenLocationId: klId,
                        kitchenLocationName: line.kitchenLocationName,
                    }, diffQty, actor, { batch });
                } else {
                    console.warn(`[Kitchen] No location set for addon "${line.itemName}" — kitchen ticket was NOT created.`);
                }
            }

            commitLocalFirst(batch, (err) => console.error("[session-detail] offline sync failed", err));

            // Fire-and-forget backup print to the shared kitchen Bluetooth printer.
            // Never awaited into the order flow; any dep (or the kitchenLocations
            // fetch) throwing is swallowed by the trailing .catch.
            if (ticketPayload) {
              void (async () => {
                const klSnap = await getDocs(collection(db, "stores", storeId, "kitchenLocations"));
                const kitchenLocations = klSnap.docs.map((d) => ({ id: d.id, printOnOutage: (d.data() as any).printOnOutage }));
                const deps = makeKitchenBackupDeps({
                  kitchenLocations,
                  stampTicket: (ticketId) => {
                    const ref = doc(db, "stores", storeId, "sessions", sessionId, "kitchentickets", ticketId);
                    void updateDoc(ref, { printedOffline: true, printedOfflineAt: Date.now(), printedOfflineDevice: getBrowserDeviceId() }).catch(() => {});
                    // Also patch the rtKdsTickets projection the KDS page actually
                    // reads from, so the auto-ack effect there can see the stamp.
                    const _stationId = ticketPayload?.kitchenLocationId;
                    if (_stationId) {
                      void updateDoc(doc(db, "stores", storeId, "rtKdsTickets", _stationId), {
                        [`tickets.${ticketId}.printedOffline`]: true,
                        [`tickets.${ticketId}.printedOfflineAt`]: Date.now(),
                      }).catch(() => {});
                    }
                  },
                  alert: (message) => toast({ variant: "destructive", title: "Kitchen printer", description: message }),
                });
                await printKitchenTicketBackup(ticketPayload as any, deps);
              })().catch(() => {});
            }
        }

        // Refresh adjustment-flag projection if the edit could have changed
        // void/free/discount state. Read by the cashier session-list badges.
        const flagFieldsTouched =
          "voidedQty" in after ||
          "freeQty" in after ||
          "discountQty" in after ||
          "discountValue" in after;
        if (flagFieldsTouched) {
          await sideEffect(() => recomputeSessionAdjustmentFlags(storeId, sessionId));
        }

        // Logging and UI feedback outside the transaction
        const line = billLines.find(l => l.id === lineId);
        if (!line) return;

        const diff = {
            qtyOrdered: (after.qtyOrdered ?? 0) - (before.qtyOrdered ?? 0),
            discount: (after.discountQty ?? 0) - (before.discountQty ?? 0),
            free: (after.freeQty ?? 0) - (before.freeQty ?? 0),
            void: (after.voidedQty ?? 0) - (before.voidedQty ?? 0),
        };
        
        const unitPrice = Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : 0;
        const sessionContext = {
            sessionStatus: session.status,
            sessionStartedAt: session.startedAt,
            sessionMode: session.sessionMode,
            customerName: session.customer?.name ?? session.customerName,
            tableNumber: session.tableNumber,
        };

        if (line.type === 'package' && diff.qtyOrdered > 0) {
            await sideEffect(() => writeActivityLog({ action: "PACKAGE_QTY_OVERRIDE_SET", meta: { itemName: line.itemName, beforeQty: before.qtyOrdered, afterQty: after.qtyOrdered }, storeId, sessionId, user: appUser, sessionContext }));
        }

        if (diff.discount > 0) {
            await sideEffect(() => writeActivityLog({ action: "DISCOUNT_APPLIED", qty: diff.discount, meta: { itemName: line.itemName }, storeId, sessionId, user: appUser, sessionContext }));
        } else if (diff.discount < 0) {
            await sideEffect(() => writeActivityLog({ action: "DISCOUNT_REMOVED", qty: -diff.discount, meta: { itemName: line.itemName }, storeId, sessionId, user: appUser, sessionContext }));
        }

        if (diff.free > 0) {
          await sideEffect(() => writeActivityLog({
            action: "MARK_FREE",
            qty: diff.free,
            note: "Marked item free",
            meta: {
              itemId: line.id,
              itemName: line.itemName,
              qty: Math.abs(diff.free),
              unitPriceAfter: unitPrice,
              amount: Math.abs(diff.free) * unitPrice,
            },
            storeId, sessionId, user: appUser, sessionContext
          }));
        } else if (diff.free < 0) {
          await sideEffect(() => writeActivityLog({
            action: "UNMARK_FREE",
            qty: -diff.free,
            note: "Removed free tag",
            meta: {
              itemId: line.id,
              itemName: line.itemName,
              qty: Math.abs(diff.free),
              unitPriceAfter: unitPrice,
              amount: Math.abs(diff.free) * unitPrice,
            },
            storeId, sessionId, user: appUser, sessionContext
          }));
        }

        if (diff.void > 0) {
          await sideEffect(() => writeActivityLog({
            action: "VOID_TICKETS",
            qty: diff.void,
            note: "Voided item",
            meta: {
              itemId: line.id,
              itemName: line.itemName,
              qty: Math.abs(diff.void),
              unitPriceAfter: unitPrice,
              amount: Math.abs(diff.void) * unitPrice,
            },
            storeId, sessionId, user: appUser, sessionContext
          }));
        } else if (diff.void < 0) {
          await sideEffect(() => writeActivityLog({
            action: "UNVOID",
            qty: -diff.void,
            note: "Unvoided item",
            meta: {
              itemId: line.id,
              itemName: line.itemName,
              qty: Math.abs(diff.void),
              unitPriceAfter: unitPrice,
              amount: Math.abs(diff.void) * unitPrice,
            },
            storeId, sessionId, user: appUser, sessionContext
          }));
        }

        toast({ title: "Line Item Updated"});
    } catch(e: any) {
        toast({ variant: 'destructive', title: 'Update Failed', description: e.message });
        throw e;
    }
  }

  const handleAddLineAdjustment = async (lineId: string, adj: LineAdjustment) => {
    if (!appUser || !storeId || !sessionId || !activeStore || !session) return;
    try {
        // Best-effort server side-effects: awaited online, fired local-first offline
        // (their internal batch.commit()/updateDoc never resolves with no internet).
        const sideEffect = (run: () => Promise<unknown>): Promise<void> => {
          if (isOnline) return run().then(() => undefined);
          run().catch((err) => console.warn("[handleAddLineAdjustment] offline side-effect deferred", err));
          return Promise.resolve();
        };
        const lineRef = doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', lineId);
        const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
        const batch = writeBatch(db);
        batch.update(lineRef, {
            [`lineAdjustments.${adj.id}`]: adj,
        });
        batch.update(sessionRef, {
            billingRevision: increment(1),
            updatedAt: serverTimestamp(),
        });
        if (isOnline) {
          await batch.commit();
        } else {
          commitLocalFirst(batch, (err) => console.error("[handleAddLineAdjustment] offline sync failed", err));
        }
        toast({ title: 'Adjustment Added'});

        if (adj.kind === "discount") {
          await sideEffect(() => recomputeSessionAdjustmentFlags(storeId, sessionId));
        }

        if (adj.kind === 'discount') {
            const line = billLines.find(l => l.id === lineId);
            if(line) {
                const billableQty = line.qtyOrdered - (line.voidedQty || 0) - (line.freeQty || 0);
                const qtyToApply = Math.min(adj.qty, billableQty);
                const unitPrice = line.unitPrice || 0;
                const taxRate = (activeStore.taxRatePct || 0) / 100;
                const isVatInclusive = activeStore.taxType === 'VAT_INCLUSIVE';
                const baseUnitPrice = isVatInclusive ? unitPrice / (1 + taxRate) : unitPrice;

                let calculatedAmount = 0;
                if (adj.type === 'percent') {
                    calculatedAmount = (qtyToApply * baseUnitPrice) * (adj.value / 100);
                } else {
                    calculatedAmount = Math.min(baseUnitPrice, adj.value) * qtyToApply;
                }

                await sideEffect(() => writeActivityLog({
                    action: "DISCOUNT_APPLIED",
                    storeId,
                    sessionId,
                    user: appUser,
                    note: `Applied to ${line.itemName}`,
                    sessionContext: {
                        sessionStatus: session.status,
                        sessionStartedAt: session.startedAt,
                        sessionMode: session.sessionMode,
                        customerName: session.customer?.name ?? session.customerName,
                        tableNumber: session.tableNumber,
                        tableDisplayName: session.tableDisplayName ?? null,
                    },
                    meta: {
                        itemId: line.id,
                        itemName: line.itemName,
                        discountName: adj.note,
                        scope: "item",
                        qty: adj.qty,
                        discountType: adj.type,
                        amount: calculatedAmount,
                    }
                }));
            }
        }
    } catch(e: any) {
        toast({ variant: 'destructive', title: 'Update Failed', description: e.message });
        throw e;
    }
  }

  const handleRemoveLineAdjustment = async (lineId: string, adjId: string) => {
    if (!activeStore?.id || !sessionId || !appUser || !session) return;
    const line = billLines.find(l => l.id === lineId);
    const adj = line ? Object.values((line as any).lineAdjustments ?? {}).find((a: any) => a.id === adjId) as any : null;
    await removeLineAdjustment(activeStore.id, sessionId, lineId, adjId, appUser);
    if (adj) {
      writeActivityLog({
        action: "DISCOUNT_REMOVED",
        note: `Removed ${adj.kind ?? "adjustment"}: ${adj.name || adj.type || ""}`,
        meta: { itemName: line?.itemName, discountName: adj.name || adj.type, discountType: adj.type, discountValue: adj.value },
        storeId: activeStore.id, sessionId, user: appUser,
        sessionContext: { sessionStatus: session.status, sessionStartedAt: session.startedAt, sessionMode: session.sessionMode, customerName: session.customer?.name ?? session.customerName, tableNumber: session.tableNumber, tableDisplayName: session.tableDisplayName ?? null },
      });
    }
  };


  const isLoading = isLoadingSession || isConfigLoading;

  // Bill-adjustment handlers — unchanged bodies, hoisted to named consts so the
  // same closures can be shared between the applied-adjustments list (left
  // bill-summary column) and the Bill Discount / Add Charge buttons (sticky
  // footer) without duplicating billing logic.
  const handleAddAdjustment = async (charge: Charge) => {
    const next = [...customAdjustments, {id: charge.id, note: charge.name, amount: charge.value, type: charge.type, source: 'charge' as const, sourceId: charge.id, appliesTo: charge.appliesTo}];
    await updateSessionBillingState({ customAdjustments: next });
    setCustomAdjustments(next);
    if (storeId && sessionId && appUser) writeActivityLog({ action: "CUSTOM_CHARGE_ADDED", storeId, sessionId, user: appUser, note: `Charge added: ${charge.name} ${charge.type === 'percent' ? charge.value + '%' : '₱' + charge.value}`, meta: { itemName: charge.name, amount: charge.value, discountType: charge.type } });
  };

  const handleAddCustomAdjustment = async (note: string, amount: number) => {
    const next = [...customAdjustments, {id: `custom_${Date.now()}`, note, amount, type: 'fixed' as const, source: 'custom' as const}];
    await updateSessionBillingState({ customAdjustments: next });
    setCustomAdjustments(next);
    if (storeId && sessionId && appUser) writeActivityLog({ action: "CUSTOM_CHARGE_ADDED", storeId, sessionId, user: appUser, note: `Custom charge: ${note} ₱${amount}`, meta: { itemName: note, amount } });
  };

  const handleRemoveAdjustment = async (id: string) => {
    const adj = customAdjustments.find(a => a.id === id);
    const next = customAdjustments.filter(a => a.id !== id);
    await updateSessionBillingState({ customAdjustments: next });
    setCustomAdjustments(next);
    if (storeId && sessionId && appUser && adj) writeActivityLog({ action: "CUSTOM_CHARGE_REMOVED", storeId, sessionId, user: appUser, note: `Charge removed: ${adj.note} ₱${adj.amount}`, meta: { itemName: adj.note, amount: adj.amount } });
  };

  const handleSetBillDiscount = async (d: Discount | null) => {
    assertBillDiscountAllowed(d);
    const wasDiscount = !!billDiscount;
    await updateSessionBillingState({ billDiscount: d });
    setBillDiscount(d);
    if (storeId && sessionId && appUser) {
      if (d) writeActivityLog({ action: "BILL_DISCOUNT_APPLIED", storeId, sessionId, user: appUser, note: `Bill discount: ${d.name} (${d.type === 'percent' ? d.value + '%' : '₱' + d.value})`, meta: { discountName: d.name, discountType: d.type, discountValue: d.value } });
      else if (wasDiscount) writeActivityLog({ action: "BILL_DISCOUNT_REMOVED", storeId, sessionId, user: appUser, note: "Bill discount removed" });
    }
  };

  const BillSummaryContent = (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {session && <CustomerInfoForm session={session} />}
        {session && activeStore && storeId && <div className="px-3 py-2"><StatutoryDinersPanel storeId={storeId} sessionId={sessionId} session={session} lines={billLines} store={activeStore} user={appUser} billDiscount={billDiscount} adjustments={customAdjustments} loyalty={loyaltyRedemptions} /></div>}
        <BillTotals
          session={session}
          lines={billLines}
          store={activeStore!}
          billDiscount={billDiscount}
          customAdjustments={customAdjustments}
          loyaltyRedemptions={loyaltyRedemptions}
          totalPaid={0}
          isLocked={isBillingLocked}
          onRemoveLineAdjustment={handleRemoveLineAdjustment}
        />
        <BillAppliedAdjustments
          adjustments={customAdjustments || []}
          onRemoveAdjustment={handleRemoveAdjustment}
          isLocked={isBillingLocked}
          busy={isMutatingBill}
        />
        {session && (session as any).linkedCustomerPhone && (
          <div className="px-4 pb-2">
            {isCashierLinked(session as any) ? (
              <p className="text-xs text-muted-foreground">
                Card linked by cashier — points earn only. Redemption needs the customer to link on their own phone.
              </p>
            ) : (
              <LoyaltyRedeemCard
                storeId={storeId!}
                sessionId={sessionId}
                linkedPhone={(session as any).linkedCustomerPhone}
                linkedName={(session as any).linkedCustomerName ?? null}
                redemptions={loyaltyRedemptions}
                disabled={isBillingLocked}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );

  const handlePayClick = async () => {
    const PREMATURE_BUFFER_MS = 10 * 60 * 1000;
    const startedMs: number | null =
      typeof session?.startedAt?.toMillis === "function"
        ? session.startedAt.toMillis()
        : session?.startedAtClientMs ?? null;
    const avgMs = sessionAnalysis.totals.avgDineInSessionMs;

    if (
      session?.sessionMode === "package_dinein" &&
      startedMs &&
      avgMs > 0 &&
      !sessionAnalysis.isLoading
    ) {
      const elapsedMs = Date.now() - startedMs;
      if (elapsedMs < avgMs - PREMATURE_BUFFER_MS) {
        const confirmed = await askConfirm({
          title: "Session looks short",
          description:
            `This session has only been active for ${formatDurationVerbose(elapsedMs)}, ` +
            `which is well below the recent average of ${formatDurationVerbose(avgMs)}. ` +
            `Are you sure this is the right session you are processing?`,
          confirmText: "Yes, process payment",
          cancelText: "Cancel",
          destructive: false,
        });
        if (!confirmed) return;
      }
    }
    setIsPaymentOpen(true);
  };

  if (isLoading || !session || !storeId || !activeStore) {
      return <div className="flex items-center justify-center h-screen"><Loader2 className="animate-spin" /> Loading session...</div>;
  }

  // Root fills the space BELOW the global 56px fixed nav (h-[calc(100dvh-3.5rem)]),
  // and the negative margins cancel the app-shell <main>'s p-4/md:p-8 padding — so this
  // screen is a self-contained bounded-height panel instead of forcing 100vh inside the
  // padded shell, which made the whole page scroll and pushed things off-screen. The
  // action bar (Bill Discount/Add Charge/Pay) is pinned under the right (Billable
  // Items) column only, not full-width — the left (bill preview) column is a plain
  // scrollable panel with nothing pinned to its bottom, on purpose (see the action
  // bar's own comment below).
  return (
    <div className="h-[calc(100dvh-3.5rem)] -m-4 md:-m-8 flex flex-col">
      <header className="flex items-center gap-4 border-b bg-muted/40 px-6 h-[72px]">
        <Button variant="outline" size="icon" onClick={() => router.push('/cashier')} className="h-9 w-9">
            <ArrowLeft className="h-5 w-5" />
        </Button>
        <SessionHeader
          session={{
            id: session.id, tableNumber: session.tableNumber, guestCount: session.guestCountFinal || 0,
            packageName: session.packageSnapshot?.name ?? "N/A", sessionMode: session.sessionMode, customerName: session.customer?.name ?? session.customerName,
            linkedCustomerName: (session as any).linkedCustomerName ?? null,
            linkedCustomerPhone: (session as any).linkedCustomerPhone ?? null,
            linkedBy: (session as any).linkedBy ?? null,
          }}
          onLinkCard={canLinkCard && !session.isPaid && !(session as any).linkedCustomerLockedAt ? () => setIsLinkCardOpen(true) : undefined}
        />
        <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setIsTimelineOpen(true)}>
                <History className="mr-2 h-4 w-4" /> View Timeline
            </Button>
            {session.isPaid && (
              <Button variant="outline" size="sm" onClick={() => router.push(`/receipt?id=${sessionId}`)}>
                  <Receipt className="mr-2 h-4 w-4" /> View Receipt
              </Button>
            )}
        </div>
      </header>
      
      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="flex-1 overflow-hidden min-h-0">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 h-full">
              <div className="md:col-span-1 xl:col-span-2 bg-muted/20 md:h-full flex flex-col overflow-hidden">
                  {isMobile ? (
                    <Accordion type="single" collapsible className="w-full" defaultValue="bill-summary">
                      <AccordionItem value="bill-summary" className="border-b-0">
                        <AccordionTrigger className="p-4 text-lg font-semibold">
                          Bill Summary
                        </AccordionTrigger>
                        <AccordionContent>
                          {BillSummaryContent}
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  ) : (
                    BillSummaryContent
                  )}
              </div>
              <div className="md:col-span-1 xl:col-span-3 h-full flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto p-4">
                    <BillableItems
                        lines={billLines}
                        storeId={storeId}
                        session={session}
                        discounts={itemDiscounts}
                        isLocked={isBillingLocked}
                        onUpdateLine={(line) => setEditingLineId(line.id)}
                        onAddLine={(newLine) => {
                            setBillLines((currentLines) => {
                                // Check if an identical addon line already exists
                                const existingLineIndex = currentLines.findIndex(
                                    (l) => l.type === 'addon' && l.itemId === newLine.itemId && l.unitPrice === newLine.unitPrice
                                );

                                if (existingLineIndex >= 0) {
                                    // If it exists, update the quantity
                                    const nextLines = [...currentLines];
                                    const existingLine = nextLines[existingLineIndex];
                                    nextLines[existingLineIndex] = {
                                        ...existingLine,
                                        qtyOrdered: (existingLine.qtyOrdered ?? 0) + (newLine.qtyOrdered ?? 0),
                                    };
                                    return nextLines;
                                } else {
                                    // If it doesn't exist, add the new line
                                    return [...currentLines, newLine];
                                }
                            });
                        }}
                    />
                  </div>

                  {/* Action bar: Bill Discount, Add Charge, Pay — grouped under
                      Billable Items only (not full-width), leaving the
                      bottom-left corner (Customer Info / bill preview column)
                      clear. */}
                  <div className="shrink-0 border-t bg-background/95 backdrop-blur-sm px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                    <div className="flex items-center gap-2">
                      <BillAdjustments
                        appUser={appUser}
                        charges={billCharges}
                        discounts={billableDiscounts}
                        onAddAdjustment={handleAddAdjustment}
                        onAddCustomAdjustment={handleAddCustomAdjustment}
                        onSetBillDiscount={handleSetBillDiscount}
                        billDiscount={billDiscount}
                        isLocked={isBillingLocked}
                        busy={isMutatingBill}
                      />
                      <Button type="button" className="flex-1" size="lg" disabled={isBillingLocked || grandTotal <= 0} onClick={handlePayClick}>
                          {isBillingLocked ? "Payment Finalized" : `Pay ₱${grandTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      </Button>
                    </div>
                  </div>
              </div>
          </div>
        </div>
      </main>

       {isTimelineOpen && (
        <SessionTimelineDrawer open={isTimelineOpen} onOpenChange={setIsTimelineOpen} storeId={storeId} sessionId={sessionId!} />
       )}
       
       {editingLine && (
        <EditBillableItemDialog
            isOpen={!!editingLine}
            onClose={() => setEditingLineId(null)}
            line={editingLine}
            discounts={itemDiscounts}
            charges={itemCharges}
            isLocked={isBillingLocked}
            lockQty={!!session?.packageSnapshot?.isBundle && editingLine.type === 'package'}
            onSave={handleUpdateLine}
            onAddLineAdjustment={handleAddLineAdjustment}
        />
      )}
      {Dialog}

      {session && appUser && activeStore && storeId && (
        <PaymentModal
          open={isPaymentOpen}
          onOpenChange={setIsPaymentOpen}
          grandTotal={grandTotal}
          sessionId={sessionId}
          storeId={storeId}
          activeStore={activeStore}
          appUser={appUser}
          firebaseUser={user ?? null}
          paymentMethods={paymentMethods}
          reservationId={session.reservationId ?? null}
        />
      )}

      {storeId && (
        <LinkCardDialog
          open={isLinkCardOpen}
          onOpenChange={setIsLinkCardOpen}
          storeId={storeId}
          sessionId={sessionId}
          sessionLabel={sessionDialogLabel(session)}
        />
      )}
    </div>
  )
}
