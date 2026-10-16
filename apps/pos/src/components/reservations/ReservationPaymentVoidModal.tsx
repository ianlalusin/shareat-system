"use client";

import { useEffect, useState } from "react";
import { doc, runTransaction, serverTimestamp, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Ban } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { reservationEvent } from "@/lib/reservations/history";
import type { Reservation, ReservationPayment } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  reservationId: string;
  payment: ReservationPayment | null;
}

export function ReservationPaymentVoidModal({ open, onOpenChange, storeId, reservationId, payment }: Props) {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason("");
  }, [open]);

  const canSubmit = !!payment && reason.trim().length > 0;

  const handleSubmit = async () => {
    if (!payment || !canSubmit) return;
    setSaving(true);
    try {
      const actor = {
        uid: appUser?.uid ?? null,
        name: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      };
      const refDoc = doc(db, "stores", storeId, "reservations", reservationId);
      const voidedAtMs = Date.now();
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(refDoc);
        if (!snap.exists()) throw new Error("Reservation not found.");
        const data = snap.data() as Reservation;
        const list = Array.isArray(data.payments) ? data.payments : [];
        const nextList = list.map((p) =>
          p.id === payment.id
            ? {
                ...p,
                voidedAt: Timestamp.now(),
                voidedAtClientMs: voidedAtMs,
                voidedByUid: actor.uid,
                voidedByName: actor.name,
                voidReason: reason.trim(),
              }
            : p,
        );
        const evt = reservationEvent("payment_voided", actor, `${payment.methodName} ₱${payment.amount.toFixed(2)} — ${reason.trim()}`);
        const history = Array.isArray(data.history) ? [...data.history, evt] : [evt];
        tx.update(refDoc, { payments: nextList, history, updatedAt: serverTimestamp() });
      });
      toast({ title: "Payment voided", description: `${payment.methodName} ₱${payment.amount.toFixed(2)}` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message || "Could not void payment." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Ban className="h-5 w-5" />
            Void payment
          </DialogTitle>
          <DialogDescription>
            {payment
              ? `Voiding ${payment.methodName} ₱${payment.amount.toFixed(2)}${payment.reference ? ` · ref ${payment.reference}` : ""}.`
              : "Select a payment to void."}
            {" "}This will be hidden from the running total but kept in the audit log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Reason</Label>
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 120))}
              placeholder="e.g. wrong amount, customer cancelled"
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={saving || !canSubmit}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Ban className="h-4 w-4 mr-2" />}
            Void payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
