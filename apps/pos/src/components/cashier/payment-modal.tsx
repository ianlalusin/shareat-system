"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PlusCircle, X, Loader2, CheckCircle2 } from "lucide-react";
import { Numpad } from "@/components/shared/Numpad";
import { useToast } from "@/hooks/use-toast";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useIsMobile } from "@/hooks/use-mobile";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { completePaymentFromUnits } from "@/components/cashier/firestore";
import { completePaymentOffline } from "@/components/cashier/offlinePayment";
import type { Payment, ModeOfPayment, Store, Reservation, PosPaymentIntentDoc } from "@/lib/types";
import type { AppUser } from "@/context/auth-context";
import type { User } from "firebase/auth";
import { reservationEvent, appendReservationEvent } from "@/lib/reservations/history";
import { isPaymongoQrMethod, shouldOfferPaymongoQr } from "@/lib/payments/paymongo/gateway";
import { useLocalProfile } from "@/context/local-profile-context";
import { PaymongoQrView } from "@/components/cashier/paymongo-qr-view";
import { SessionCardBanner } from "@/components/cashier/SessionCardBanner";
import { storedPesosToCentavos, toWirePesos } from "@/lib/money/centavos";
// T-425: what a tablet may take WITHOUT the internet (cash; e-wallet with a reference; card / QR Ph / other are off).
import { NEEDS_INTERNET, offlineTenderRule } from "@/lib/offline/offlineRules";
// A peso amount made exact (whole centavos back to the peso number the form holds).
import { roundMoney as normalizePesos } from "@/lib/money";

// --- Validation ---
function validatePayments(payments: Payment[], grandTotalCents: number, paymentMethods: ModeOfPayment[], isOnline = true): string | null {
  if (!payments || payments.length === 0) return "Add at least one payment method.";
  for (const p of payments) {
    if (!p.methodId) return "Select a payment method.";
    const amountCents = storedPesosToCentavos(p.amount);
    if (amountCents <= 0) return "Payment amounts must be greater than zero.";
    const methodDetails = paymentMethods.find(pm => pm.id === p.methodId);
    if (!methodDetails) return "Payment method not found. It may have been deleted.";
    if (methodDetails.hasRef && (!p.reference || String(p.reference).trim().length === 0)) {
      return `Reference is required for ${methodDetails.name}.`;
    }
    if (!isOnline) {
      const rule = offlineTenderRule(methodDetails);
      if (!rule.enabled) return `${methodDetails.name}: ${NEEDS_INTERNET}. Use Cash or an e-wallet with a reference number.`;
      if (rule.requiresReference && (!p.reference || String(p.reference).trim().length === 0)) return `Reference is required for ${methodDetails.name} while offline.`;
    }
    if (isPaymongoQrMethod(methodDetails) && (!p.reference || String(p.reference).trim().length === 0)) {
      return "Scan-to-pay tender isn't paid yet — generate the QR and wait for payment.";
    }
  }
  const totalPaidCents = payments.reduce((s, p) => s + storedPesosToCentavos(p.amount), 0);
  if (totalPaidCents < grandTotalCents - 1) {
    return `Payment is not enough. Balance: ₱${toWirePesos(grandTotalCents - totalPaidCents).toFixed(2)}`;
  }
  const changeCents = Math.max(0, totalPaidCents - grandTotalCents);
  if (changeCents > 1) {
    const cashIds = new Set(
      paymentMethods
        .filter(pm => String(pm.type || "").toLowerCase() === "cash" || String(pm.name || "").toLowerCase().includes("cash"))
        .map(pm => pm.id)
    );
    const cashPaidCents = payments
      .filter(p => cashIds.has(p.methodId))
      .reduce((s, p) => s + storedPesosToCentavos(p.amount), 0);
    if (cashPaidCents < changeCents) {
      return "Overpayment must be covered by Cash so change can be issued.";
    }
  }
  return null;
}

// --- Success Overlay ---
function SuccessOverlay({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2500);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 rounded-lg animate-in fade-in-0 zoom-in-95 duration-300">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-green-500/20 animate-ping" />
        <CheckCircle2 className="h-16 w-16 text-green-500 relative" />
      </div>
      <p className="mt-4 text-lg font-semibold text-green-600">Payment Successful</p>
      <p className="text-sm text-muted-foreground mt-1">Generating receipt...</p>
      <Button variant="ghost" size="sm" className="mt-4 text-muted-foreground" onClick={onDone}>
        Close
      </Button>
    </div>
  );
}

// --- Main Modal ---
interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grandTotal: number;
  sessionId: string;
  storeId: string;
  activeStore: Store;
  appUser: AppUser;
  firebaseUser: User | null;
  paymentMethods: ModeOfPayment[];
  /** When the session was seated from a reservation, allow pre-applying any
   *  reservation payments logged before bill-out. */
  reservationId?: string | null;
}

export function PaymentModal({
  open,
  onOpenChange,
  grandTotal,
  sessionId,
  storeId,
  activeStore,
  appUser,
  firebaseUser,
  paymentMethods,
  reservationId,
}: PaymentModalProps) {
  const router = useRouter();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const isMobile = useIsMobile();
  const { currentProfile } = useLocalProfile();

  const [payments, setPayments] = useState<Payment[]>([]);
  // Row currently being resolved via the PayMongo QR overlay. While this is
  // set, that tender is NOT part of `payments` (it's pulled out on
  // generation and only re-added — with a fresh id — once actually paid),
  // so the existing multi-tender total/validation/complete logic never has
  // to know about it.
  const [qrTender, setQrTender] = useState<{ id: string; methodId: string; amount: number } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);
  // Track which payment row the numpad controls
  const [activePaymentId, setActivePaymentId] = useState<string | null>(null);
  // Raw string buffer for the numpad-driven amount
  const [numpadBuffer, setNumpadBuffer] = useState<string>("");

  const [reservationApplied, setReservationApplied] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);

  // Initialize payment rows when modal opens. If the session was seated from
  // a reservation, pre-seed one line per non-voided reservation payment
  // (preserving original mode + reference) and add a cash row for any
  // remaining balance. Cashier can delete pre-seeded lines to override.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsInitializing(true);
    setReservationApplied(false);
    (async () => {
      let prepaidLines: Payment[] = [];
      if (reservationId) {
        try {
          const snap = await getDoc(doc(db, "stores", storeId, "reservations", reservationId));
          if (snap.exists()) {
            const r = snap.data() as Reservation;
            const alreadyApplied = r.paymentsAppliedToSessionId === sessionId;
            setReservationApplied(alreadyApplied);
            if (!alreadyApplied) {
              prepaidLines = (r.payments ?? [])
                .filter(p => !p.voidedAt)
                .map(rp => ({
                  id: `rp-${rp.id}`,
                  methodId: rp.methodId,
                  amount: normalizePesos(rp.amount),
                  reference: rp.reference ?? "",
                  fromReservationPaymentId: rp.id,
                }));
            }
          }
        } catch (e) {
          console.warn("[PaymentModal] Failed to load reservation payments:", e);
        }
      }

      // Recover PayMongo QR payments already confirmed paid (by the webhook) for this
      // session but not yet finalized — so closing the payment modal doesn't lose a
      // payment the customer already made. They come back as locked tenders on (re)open.
      try {
        const qrSnap = await getDocs(
          query(collection(db, "stores", storeId, "paymentIntents"), where("sessionId", "==", sessionId)),
        );
        const seenRefs = new Set(prepaidLines.map(p => p.reference).filter(Boolean));
        for (const dSnap of qrSnap.docs) {
          const data = dSnap.data() as PosPaymentIntentDoc;
          if (data.status !== "paid") continue;
          const reference = data.paymongoPaymentId ?? data.paymongoIntentId;
          if (seenRefs.has(reference)) continue;
          seenRefs.add(reference);
          prepaidLines.push({
            id: `qr-${dSnap.id}`,
            methodId: data.methodId,
            amount: normalizePesos(data.amount),
            reference,
          });
        }
      } catch (e) {
        console.warn("[PaymentModal] Failed to recover paid QR payments:", e);
      }

      if (cancelled) return;

      const seededCents = prepaidLines.reduce((s, p) => s + storedPesosToCentavos(p.amount), 0);
      const remainingCents = Math.max(0, storedPesosToCentavos(grandTotal) - seededCents);
      const remaining = toWirePesos(remainingCents);

      const cashMethod = paymentMethods.find(pm => pm.type === "cash");
      const defaultMethodId = cashMethod?.id || (paymentMethods.length > 0 ? paymentMethods[0].id : "");

      let lines: Payment[];
      if (prepaidLines.length === 0) {
        const initialId = `pay-${Date.now()}`;
        lines = [{ id: initialId, methodId: defaultMethodId, amount: normalizePesos(grandTotal), reference: "" }];
      } else if (remaining > 0) {
        const newId = `pay-${Date.now()}`;
        lines = [...prepaidLines, { id: newId, methodId: defaultMethodId, amount: remaining, reference: "" }];
      } else {
        lines = prepaidLines;
      }

      setPayments(lines);
      const focus = lines[lines.length - 1];
      setActivePaymentId(focus?.id ?? null);
      setNumpadBuffer(focus && focus.amount > 0 ? focus.amount.toFixed(2).replace(/\.?0+$/, "") : "");
      setIsProcessing(false);
      setShowSuccess(false);
      setPendingRedirect(null);
      setIsInitializing(false);
    })();
    return () => { cancelled = true; };
  }, [open, grandTotal, paymentMethods, reservationId, storeId, sessionId]);

  const grandTotalCents = storedPesosToCentavos(grandTotal);
  const totalPaidCents = useMemo(() => payments.reduce((sum, p) => sum + storedPesosToCentavos(p.amount), 0), [payments]);
  const totalPaid = toWirePesos(totalPaidCents);
  const remainingCents = grandTotalCents - totalPaidCents;
  const remainingBalance = toWirePesos(Math.max(0, remainingCents));
  const change = toWirePesos(Math.max(0, -remainingCents));
  const hasUnpaidGatewayRow = payments.some(p => {
    const methodDetails = paymentMethods.find(pm => pm.id === p.methodId);
    return !!methodDetails && isPaymongoQrMethod(methodDetails) && (!p.reference || String(p.reference).trim().length === 0);
  });
  const canComplete = grandTotalCents > 0 && remainingCents <= 1 && !hasUnpaidGatewayRow;

  const addPayment = () => {
    const cashMethod = paymentMethods.find(pm => pm.type === "cash");
    const defaultMethodId = cashMethod?.id || (paymentMethods.length > 0 ? paymentMethods[0].id : "");
    const newAmount = remainingBalance > 0 ? normalizePesos(remainingBalance) : 0;
    const newId = `pay-${Date.now()}`;
    setPayments(prev => [...prev, { id: newId, methodId: defaultMethodId, amount: newAmount, reference: "" }]);
    setActivePaymentId(newId);
    setNumpadBuffer(newAmount > 0 ? newAmount.toString() : "");
  };

  const removePayment = (id: string) => {
    setPayments(prev => {
      const next = prev.filter(p => p.id !== id);
      if (activePaymentId === id && next.length > 0) {
        setActivePaymentId(next[0].id);
        setNumpadBuffer(next[0].amount.toString());
      }
      return next;
    });
  };

  const updatePayment = (id: string, updates: Partial<Payment>) => {
    setPayments(prev => prev.map(p => (p.id === id ? { ...p, ...updates } : p)));
  };

  // Focus a payment row for numpad input — dismiss keyboard
  const focusPayment = (id: string) => {
    // Blur any focused input to dismiss the virtual keyboard
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setActivePaymentId(id);
    const p = payments.find(p => p.id === id);
    if (p) setNumpadBuffer(p.amount > 0 ? p.amount.toString() : "");
  };

  // Numpad handlers
  const handleNumpadKey = (key: string) => {
    if (!activePaymentId) return;
    setNumpadBuffer(prev => {
      // Prevent multiple dots
      if (key === "." && prev.includes(".")) return prev;
      // Limit to 2 decimal places
      if (prev.includes(".") && prev.split(".")[1].length >= 2 && key !== ".") return prev;
      const next = prev + key;
      const num = parseFloat(next);
      if (!isNaN(num) || next === "" || next === ".") {
        updatePayment(activePaymentId, { amount: isNaN(num) ? 0 : num });
      }
      return next;
    });
  };

  const handleNumpadBackspace = () => {
    if (!activePaymentId) return;
    setNumpadBuffer(prev => {
      const next = prev.slice(0, -1);
      const num = parseFloat(next);
      updatePayment(activePaymentId, { amount: isNaN(num) || next === "" ? 0 : num });
      return next;
    });
  };

  const handleNumpadClear = () => {
    if (!activePaymentId) return;
    setNumpadBuffer("");
    updatePayment(activePaymentId, { amount: 0 });
  };

  // --- PayMongo QR tender ---
  // Pulls the row out of `payments` (it isn't a real tender until it's
  // actually paid) and opens the QR overlay for that exact amount/method.
  const startQrTender = (payment: Payment) => {
    if (isProcessing || payment.amount <= 0) return;
    setQrTender({ id: payment.id, methodId: payment.methodId, amount: payment.amount });
    setPayments(prev => prev.filter(p => p.id !== payment.id));
    if (activePaymentId === payment.id) {
      setActivePaymentId(null);
      setNumpadBuffer("");
    }
  };

  // Bridge doc confirmed payment: add a fresh tender row carrying the
  // PayMongo payment id as its reference, then close the overlay so it sits
  // in the list like any other tender. Feeds the SAME completePaymentFromUnits
  // path via the normal Confirm Payment button — no second completion path.
  const handleQrPaid = useCallback(({ amount, reference }: { amount: number; reference: string }) => {
    if (!qrTender) return;
    const newId = `pay-qr-${Date.now()}`;
    setPayments(prev => [...prev, { id: newId, methodId: qrTender.methodId, amount, reference }]);
    setQrTender(null);
  }, [qrTender]);

  // Cancel / expiry / error: restore the exact row that was pulled out (same
  // id, no reference) so nothing is added and the session stays open.
  const handleQrCancel = useCallback(() => {
    if (!qrTender) return;
    setPayments(prev => [...prev, { id: qrTender.id, methodId: qrTender.methodId, amount: qrTender.amount, reference: "" }]);
    setActivePaymentId(qrTender.id);
    setNumpadBuffer(qrTender.amount > 0 ? qrTender.amount.toString() : "");
    setQrTender(null);
  }, [qrTender]);

  const handleSuccessDone = useCallback(() => {
    if (pendingRedirect) {
      router.push(pendingRedirect);
    }
  }, [pendingRedirect, router]);

  const handleComplete = async () => {
    if (isProcessing) return;

    const err = validatePayments(payments, grandTotalCents, paymentMethods, isOnline);
    if (err) {
      toast({ variant: "destructive", title: "Cannot Complete", description: err });
      return;
    }
    if (!canComplete) {
      toast({ variant: "destructive", title: "Cannot Complete", description: "Please ensure balance is paid." });
      return;
    }

    setIsProcessing(true);
    const normalizedPayments = payments.map(p => ({ ...p, amount: normalizePesos(p.amount) }));

    // --- OFFLINE ---
    if (!isOnline) {
      try {
        const { receiptId, receiptNumber } = await completePaymentOffline(
          storeId, sessionId, appUser, normalizedPayments,
          activeStore, paymentMethods, grandTotal,
        );
        console.info(`[PaymentModal] Offline sale recorded — receipt ${receiptNumber}`);

        // If this session pulled in reservation prepayments, mark the
        // reservation so reopening this modal can't double-apply them.
        if (reservationId && normalizedPayments.some(p => !!p.fromReservationPaymentId)) {
          const actorName = appUser?.displayName || appUser?.name || null;
          // Local-first: this write never gets a server ack while offline, so
          // awaiting it would hang the modal on "Processing..." forever.
          void updateDoc(doc(db, "stores", storeId, "reservations", reservationId), {
            paymentsAppliedToSessionId: sessionId,
            history: appendReservationEvent(reservationEvent(
              "payments_applied",
              { uid: appUser?.uid ?? null, name: actorName },
              `Applied to session ${sessionId}`,
            )),
            updatedAt: serverTimestamp(),
          }).catch((err) => console.warn("[offline] reservation payments-applied marking failed", err));
        }

        // Same print trigger as the online path: hand off to the existing
        // receipt page, which builds/prints the receipt (works offline too)
        // and already reads this store's autoprint setting.
        const settingsSnap = await getDoc(doc(db, "stores", storeId, "receiptSettings", "main"));
        const autoPrint = settingsSnap.exists() && !!settingsSnap.data()?.autoPrintAfterPayment;
        setShowSuccess(true);
        setPendingRedirect(`/receipt?id=${receiptId}${autoPrint ? "&autoprint=1" : ""}`);
      } catch (e: any) {
        toast({ variant: "destructive", title: "Payment failed", description: e?.message ?? "Something went wrong." });
        setIsProcessing(false);
      }
      return;
    }

    // --- ONLINE ---
    try {
      const activeProjectionSnap = await getDoc(doc(db, "stores", storeId, "activeSessions", sessionId));
      const currentPin = activeProjectionSnap.exists() ? String(activeProjectionSnap.data()?.customerPin || "") : "";
      const linkedPhone = activeProjectionSnap.exists() ? String(activeProjectionSnap.data()?.linkedCustomerPhone || "") : "";

      const receiptId = await completePaymentFromUnits(
        storeId, sessionId, appUser, normalizedPayments,
        activeStore, paymentMethods, grandTotal,
      );

      // If this session pulled in reservation prepayments, mark the
      // reservation so reopening this modal can't double-apply them.
      if (reservationId && normalizedPayments.some(p => !!p.fromReservationPaymentId)) {
        try {
          const actorName = appUser?.displayName || appUser?.name || null;
          await updateDoc(doc(db, "stores", storeId, "reservations", reservationId), {
            paymentsAppliedToSessionId: sessionId,
            history: appendReservationEvent(reservationEvent(
              "payments_applied",
              { uid: appUser?.uid ?? null, name: actorName },
              `Applied to session ${sessionId}`,
            )),
            updatedAt: serverTimestamp(),
          });
        } catch (e) {
          console.warn("[PaymentModal] Failed to mark reservation payments applied:", e);
        }
      }

      const settingsSnap = await getDoc(doc(db, "stores", storeId, "receiptSettings", "main"));
      const autoPrint = settingsSnap.exists() && !!settingsSnap.data()?.autoPrintAfterPayment;
      setShowSuccess(true);
      setPendingRedirect(`/receipt?id=${receiptId}${autoPrint ? "&autoprint=1" : ""}`);

      // PIN cleanup (fire-and-forget)
      if (firebaseUser && currentPin) {
        const token = await firebaseUser.getIdToken();
        fetch("/api/pins/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ storeId, sessionId, pin: currentPin, reason: "payment_closed" }),
        }).catch(() => {
          fetch("/api/pins/disable", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ storeId, sessionId }),
          }).catch(() => console.error("[PIN] Fallback disable also failed for session", sessionId));
        });
      }

      // Lock in any Sharelebrator vouchers/redemptions used on this bill now
      // that the session is paid. Until this runs an applied voucher could be
      // removed and returned to "active" (reusable); this commits its used
      // state. Fire-and-forget + idempotent — never blocks the receipt.
      if (firebaseUser) {
        try {
          const token = await firebaseUser.getIdToken();
          fetch("/api/loyalty/finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ storeId, sessionId, receiptId }),
          }).catch((err) => console.warn("[Loyalty] voucher finalize failed (non-fatal):", err));
        } catch (err) {
          console.warn("[Loyalty] voucher finalize token failed (non-fatal):", err);
        }
      }

      // Sharelebrator loyalty earn (awaited so cashier sees failures)
      if (firebaseUser && linkedPhone) {
        try {
          const token = await firebaseUser.getIdToken();
          const res = await fetch("/api/loyalty/earn", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ storeId, sessionId, phone: linkedPhone, amount: grandTotal, receiptId }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast({
              variant: "destructive",
              title: "Loyalty earn failed",
              description: data?.error || "Points were not awarded — please notify admin.",
            });
          }
        } catch (err: any) {
          console.error("[Loyalty] earn failed for session", sessionId, err);
          toast({
            variant: "destructive",
            title: "Loyalty earn failed",
            description: "Network error — points were not awarded. Admin can adjust manually.",
          });
        }
      }
    } catch (e: any) {
      toast({ variant: "destructive", title: "Payment failed", description: e?.message ?? "Something went wrong." });
      setIsProcessing(false);
    }
  };

  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const confirmLabel = isProcessing ? (
    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...</>
  ) : "Confirm Payment";

  // --- Payment form (shared between layouts) ---
  const paymentForm = (
    <div className="flex flex-col min-h-0 flex-1">
      <DialogHeader className="pb-2">
        <DialogTitle>Complete Payment</DialogTitle>
        <DialogDescription>
          Total due: <span className="font-semibold text-foreground text-base">₱{fmt(grandTotal)}</span>
        </DialogDescription>
      </DialogHeader>

      <SessionCardBanner
        storeId={storeId}
        sessionId={sessionId}
        grandTotal={grandTotal}
        loyaltyConfig={activeStore.loyaltyConfig}
        canLink={appUser?.role === "admin" || appUser?.role === "manager" || appUser?.role === "cashier"}
      />

      {/* Scrollable payment rows */}
      <div className="flex-1 overflow-y-auto space-y-2 py-2 min-h-0">
        {payments.map((payment) => {
          const method = paymentMethods.find(pm => pm.id === payment.methodId);
          const isActive = activePaymentId === payment.id;
          const fromReservation = !!payment.fromReservationPaymentId;
          const isGatewayRow = method ? isPaymongoQrMethod(method) : false;
          // A gateway row that carries a reference is PAID — real captured money.
          // Lock it: no amount edit, no delete, no method change. Other tenders can
          // still be added/edited freely.
          const isPaidGatewayRow = isGatewayRow && !!payment.reference;
          return (
            <div
              key={payment.id}
              className={`rounded-lg border p-2.5 ${isPaidGatewayRow ? "cursor-default" : "cursor-pointer"} transition-colors ${isActive ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border"} ${(method?.hasRef || isGatewayRow || (!isOnline && !!method && offlineTenderRule(method).requiresReference)) ? "space-y-2" : ""}`}
              onClick={() => { if (!isPaidGatewayRow) focusPayment(payment.id); }}
            >
              {fromReservation && (
                <div className="text-[10px] uppercase tracking-wide text-primary font-medium mb-1">From reservation</div>
              )}
              <div className="flex items-center gap-1.5">
                <Select value={payment.methodId} onValueChange={(val) => updatePayment(payment.id, { methodId: val })} disabled={isProcessing || isPaidGatewayRow}>
                  <SelectTrigger className="h-9 min-w-0 flex-1 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {paymentMethods.filter(m => shouldOfferPaymongoQr(m, isOnline) || !isOnline).map(m => {
                      const off = !isOnline && !offlineTenderRule(m).enabled;
                      return <SelectItem key={m.id} value={m.id} disabled={off}>{off ? `${m.name} — ${NEEDS_INTERNET}` : m.name}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
                {/* Amount display — driven by numpad, no virtual keyboard */}
                <div
                  className={`flex items-center h-9 rounded-md border px-2.5 text-sm tabular-nums cursor-pointer select-none w-[120px] shrink-0 ${isActive ? "border-primary bg-background" : "bg-muted/50"}`}
                  onFocus={(e) => e.preventDefault()}
                >
                  <span className="text-muted-foreground text-xs mr-0.5">₱</span>
                  <input
                    readOnly
                    inputMode="none"
                    tabIndex={-1}
                    value={isActive && !isPaidGatewayRow ? (numpadBuffer || "0") : payment.amount.toFixed(2)}
                    className="flex-1 bg-transparent outline-none caret-transparent pointer-events-none text-sm tabular-nums w-full"
                    onFocus={(e) => e.target.blur()}
                  />
                </div>
                {payments.length > 1 && !isPaidGatewayRow && (
                  <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8 text-muted-foreground" onClick={(e) => { e.stopPropagation(); removePayment(payment.id); }} disabled={isProcessing}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {isGatewayRow && !isPaidGatewayRow && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full h-9 text-sm"
                  onClick={(e) => { e.stopPropagation(); startQrTender(payment); }}
                  disabled={isProcessing || payment.amount <= 0 || !isOnline}
                >
                  Generate QR Ph — ₱{payment.amount.toFixed(2)}
                </Button>
              )}
              {isPaidGatewayRow && (
                <div className="flex items-center justify-center gap-1.5 h-9 text-sm font-medium text-green-600">
                  <CheckCircle2 className="h-4 w-4" /> Paid via QR Ph — locked
                </div>
              )}
              {!isGatewayRow && (method?.hasRef || (!isOnline && !!method && offlineTenderRule(method).requiresReference)) && (
                <Input
                  placeholder="Reference #"
                  value={payment.reference || ""}
                  onChange={(e) => updatePayment(payment.id, { reference: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  disabled={isProcessing}
                  className="h-9 text-sm"
                />
              )}
            </div>
          );
        })}

        {remainingBalance > 0.01 && !isProcessing && (
          <Button variant="outline" size="sm" onClick={addPayment} className="w-full">
            <PlusCircle className="mr-2 h-4 w-4" /> Split Payment
          </Button>
        )}
      </div>

      {/* Totals */}
      <div className="border-t pt-2 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total Paid</span>
          <span className="font-medium">₱{fmt(totalPaid)}</span>
        </div>
        <div className={`flex justify-between font-medium ${remainingBalance > 0.01 ? "text-destructive" : "text-green-600"}`}>
          <span>{remainingBalance > 0.01 ? "Balance" : "Change"}</span>
          <span>₱{fmt(remainingBalance > 0.01 ? remainingBalance : change)}</span>
        </div>
      </div>
    </div>
  );

  const numpad = (
    <Numpad
      onKey={handleNumpadKey}
      onBackspace={handleNumpadBackspace}
      onClear={handleNumpadClear}
      onConfirm={handleComplete}
      confirmDisabled={!canComplete}
      confirmLabel={confirmLabel}
      isProcessing={isProcessing}
    />
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isProcessing && !showSuccess && !qrTender) onOpenChange(v); }}>
      <DialogContent
        className={
          isMobile
            ? "sm:max-w-md max-h-[95dvh] flex flex-col overflow-hidden p-4"
            : "max-w-2xl max-h-[90dvh] flex flex-row overflow-hidden p-0 gap-0"
        }
      >
        {isMobile ? (
          /* ---- MOBILE: stacked layout ---- */
          <>
            {paymentForm}
            <div className="border-t pt-3 pb-1">
              {numpad}
            </div>
          </>
        ) : (
          /* ---- WIDESCREEN: side by side ---- */
          <>
            <div className="flex-1 flex flex-col p-6 overflow-hidden border-r">
              {paymentForm}
            </div>
            <div className="w-[280px] shrink-0 p-4 flex flex-col justify-end">
              <div className="mb-3 text-center">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Amount</p>
                <p className="text-3xl font-bold tabular-nums">₱{numpadBuffer || "0"}</p>
              </div>
              {numpad}
            </div>
          </>
        )}

        {/* PayMongo QR overlay — covers the form while a gateway tender is in flight */}
        {qrTender && (
          <PaymongoQrView
            storeId={storeId}
            sessionId={sessionId}
            methodId={qrTender.methodId}
            amount={qrTender.amount}
            localUserId={currentProfile?.profileId ?? null}
            onPaid={handleQrPaid}
            onCancel={handleQrCancel}
          />
        )}

        {/* Success overlay */}
        {showSuccess && <SuccessOverlay onDone={handleSuccessDone} />}
      </DialogContent>
    </Dialog>
  );
}
