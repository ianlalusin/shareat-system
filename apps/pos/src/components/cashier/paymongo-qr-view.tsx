"use client";

import { useEffect, useRef, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { QRCodeSVG } from "qrcode.react";
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { db, auth } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import type { PosPaymentIntentDoc } from "@/lib/types";

type Phase = "creating" | "awaiting" | "paid" | "expired" | "failed" | "error";

interface PaymongoQrViewProps {
  storeId: string;
  sessionId: string;
  methodId: string;
  amount: number; // pesos — the QR portion of the bill
  localUserId: string | null;
  /** Fired exactly once, only after the bridge doc confirms `status === "paid"`. */
  onPaid: (info: { amount: number; reference: string }) => void;
  /** Fired on cancel, expiry, or a create/poll error. Caller must add NOTHING to the tender set. */
  onCancel: () => void;
}

/**
 * Cashier-facing overlay for a single PayMongo QR Ph tender.
 *
 * Mints a QR intent on mount, renders the QR with a 10-minute countdown, and
 * listens to the top-level bridge doc
 * (`stores/{storeId}/paymentIntents/{intentDocId}`) for the webhook-driven
 * status flip. Only calls `onPaid` once the bridge doc itself reports
 * `status === "paid"` — never on a timer, poll response, or guess — so the
 * caller's single completion path stays authoritative and money-safe.
 */
export function PaymongoQrView({
  storeId,
  sessionId,
  methodId,
  amount,
  localUserId,
  onPaid,
  onCancel,
}: PaymongoQrViewProps) {
  const [phase, setPhase] = useState<Phase>("creating");
  const [qrData, setQrData] = useState<string | null>(null);
  // PayMongo may return a hosted/base64 QR image instead of a raw EMV string.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [expiresAtMs, setExpiresAtMs] = useState<number>(0);
  const [remainingMs, setRemainingMs] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const intentDocIdRef = useRef<string | null>(null);
  const paidRef = useRef(false);
  const paidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the "payment received" hold timer if we somehow unmount first.
  useEffect(() => () => { if (paidTimerRef.current) clearTimeout(paidTimerRef.current); }, []);

  // Keep the latest onPaid without re-subscribing the snapshot listener on
  // every parent re-render (the parent's callback identity can change).
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  // 1. Mint the QR once on mount.
  useEffect(() => {
    let aborted = false;
    (async () => {
      setPhase("creating");
      setErrorMessage(null);
      try {
        const token = await auth.currentUser?.getIdToken();
        const res = await fetch("/api/pos/paymongo/create-qr", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ storeId, sessionId, amount, methodId, localUserId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.reason || body?.error || "Could not start the PayMongo payment.");
        }
        const data = await res.json();
        if (aborted) return;
        intentDocIdRef.current = data.intentDocId;
        setQrData(data.qrData ?? null);
        setImageUrl(data.imageUrl ?? null);
        setExpiresAtMs(data.expiresAtMs);
        setPhase("awaiting");
      } catch (e: any) {
        if (!aborted) {
          setErrorMessage(e?.message ?? "Could not start the PayMongo payment.");
          setPhase("error");
        }
      }
    })();
    return () => {
      aborted = true;
    };
    // Intentionally excludes onCancel/onPaid — this effect only mints the QR.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, sessionId, methodId, amount, localUserId]);

  // 2. Listen to the bridge doc for the webhook-driven status flip.
  useEffect(() => {
    if (phase !== "awaiting" || !intentDocIdRef.current) return;
    // Bridge doc is TOP-LEVEL per store: stores/{storeId}/paymentIntents/{id}
    const ref = doc(db, `stores/${storeId}/paymentIntents/${intentDocIdRef.current}`);
    const unsub = onSnapshot(ref, (snap) => {
      const d = snap.data() as PosPaymentIntentDoc | undefined;
      if (!d || paidRef.current) return;
      if (d.status === "paid") {
        paidRef.current = true;
        setPhase("paid");
        // Hold on the "Payment received" state briefly so the cashier sees the
        // confirmation, THEN hand the tender back (onPaid unmounts this overlay).
        // handleQrPaid is guarded on qrTender, so a late fire is safe.
        const info = { amount, reference: d.paymongoPaymentId ?? d.paymongoIntentId };
        paidTimerRef.current = setTimeout(() => onPaidRef.current(info), 1800);
      } else if (d.status === "failed" || d.status === "canceled") {
        setPhase("failed");
      } else if (d.status === "expired") {
        setPhase("expired");
      }
    });
    return () => unsub();
  }, [phase, storeId, amount]);

  // 3. Countdown + client-side auto-expire (belt-and-suspenders with any
  // server-side expiry — whichever flips first wins, both land on "expired").
  useEffect(() => {
    if (phase !== "awaiting" || !expiresAtMs) return;
    const tick = () => {
      const left = expiresAtMs - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) setPhase("expired");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, expiresAtMs]);

  // 4. Manual "Check status" fallback. This never sets local state directly —
  // the onSnapshot listener above remains the single source of truth and
  // will pick up whatever flip this triggers server-side.
  const checkStatus = async () => {
    if (!intentDocIdRef.current || checkingStatus) return;
    setCheckingStatus(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      await fetch("/api/pos/paymongo/status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ storeId, sessionId, intentDocId: intentDocIdRef.current }),
      });
    } catch {
      // Non-fatal — the listener remains authoritative.
    } finally {
      setCheckingStatus(false);
    }
  };

  const mmss = `${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <div className="absolute inset-0 z-50 overflow-y-auto bg-background/95 rounded-lg animate-in fade-in-0 zoom-in-95 duration-300">
      {/* min-h-full + justify-center centers when it fits and SCROLLS (no clipping of
          the QR or the Check status / Cancel buttons) when the modal is short. */}
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {phase === "creating" && (
        <>
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Starting QR Ph…</p>
        </>
      )}

      {phase === "awaiting" && (qrData || imageUrl) && (
        // Wide screens: QR on the left, amount/timer/actions stacked on the right
        // (no scrolling). Narrow: stacks vertically.
        <div className="flex w-full flex-col items-center justify-center gap-4 sm:flex-row sm:gap-6">
          <div className="shrink-0 rounded-lg border bg-white p-3">
            {qrData ? (
              <QRCodeSVG value={qrData} size={220} />
            ) : (
              // PayMongo-hosted (or base64) QR image when no raw EMV string is returned.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl!} alt="PayMongo QR Ph code" width={220} height={220} />
            )}
          </div>
          <div className="flex flex-col items-center gap-2 text-center sm:items-start sm:text-left">
            <p className="text-sm text-muted-foreground">Scan with any QR Ph app to pay</p>
            <p className="text-3xl font-bold tabular-nums">₱{amount.toFixed(2)}</p>
            <p className="text-sm tabular-nums text-muted-foreground">Expires in {mmss}</p>
            <div className="mt-1 flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={checkStatus} disabled={checkingStatus}>
                {checkingStatus && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Check status
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === "paid" && (
        <>
          <div className="relative">
            <div className="absolute inset-0 rounded-full bg-green-500/20 animate-ping" />
            <CheckCircle2 className="h-16 w-16 text-green-500 relative" />
          </div>
          <p className="text-lg font-semibold text-green-600">Payment received</p>
          <p className="text-sm text-muted-foreground">₱{amount.toFixed(2)} via QR Ph</p>
        </>
      )}

      {phase === "expired" && (
        <>
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <p className="font-medium text-amber-600">QR expired</p>
          <p className="text-sm text-muted-foreground">No payment was received before the QR expired.</p>
          <Button type="button" variant="outline" size="sm" onClick={onCancel} className="mt-1">
            Back
          </Button>
        </>
      )}

      {(phase === "failed" || phase === "error") && (
        <>
          <XCircle className="h-10 w-10 text-red-500" />
          <p className="font-medium text-red-600">Payment could not be completed</p>
          {errorMessage && <p className="text-sm text-muted-foreground">{errorMessage}</p>}
          <Button type="button" variant="outline" size="sm" onClick={onCancel} className="mt-1">
            Back
          </Button>
        </>
      )}
      </div>
    </div>
  );
}
