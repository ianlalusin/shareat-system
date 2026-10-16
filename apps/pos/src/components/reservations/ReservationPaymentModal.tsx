"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, serverTimestamp, updateDoc, arrayUnion, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Wallet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { useStoreConfigDoc } from "@/hooks/useStoreConfigDoc";
import { reservationEvent, appendReservationEvent } from "@/lib/reservations/history";
import type { ModeOfPayment, Reservation, ReservationPayment } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  reservation: Reservation;
}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ReservationPaymentModal({ open, onOpenChange, storeId, reservation }: Props) {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const { config: storeConfig } = useStoreConfigDoc(storeId);

  const methods = useMemo<ModeOfPayment[]>(() => {
    const all = storeConfig?.modesOfPayment ?? [];
    return all.filter((m) => m.isActive && !(m as any).isArchived);
  }, [storeConfig]);

  const [methodId, setMethodId] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Default label suggestion: first payment → "Reservation fee"; otherwise blank.
  const hasExistingPayment = (reservation.payments ?? []).some((p) => !p.voidedAt);

  useEffect(() => {
    if (!open) return;
    const cash = methods.find((m) => (m.type ?? "").toLowerCase() === "cash");
    setMethodId(cash?.id || methods[0]?.id || "");
    setAmount("");
    setReference("");
    setLabel(hasExistingPayment ? "" : "Reservation fee");
    setNote("");
  }, [open, methods, hasExistingPayment]);

  const selectedMethod = useMemo(() => methods.find((m) => m.id === methodId) ?? null, [methods, methodId]);
  const numericAmount = Number(amount);
  const canSubmit =
    !!methodId &&
    Number.isFinite(numericAmount) &&
    numericAmount > 0 &&
    (!selectedMethod?.hasRef || reference.trim().length > 0);

  const handleSubmit = async () => {
    if (!canSubmit || !selectedMethod) return;
    setSaving(true);
    try {
      const actor = {
        uid: appUser?.uid ?? null,
        name: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      };
      const entry: ReservationPayment = {
        id: genId(),
        methodId: selectedMethod.id,
        methodName: selectedMethod.name,
        amount: Math.round(numericAmount * 100) / 100,
        reference: selectedMethod.hasRef ? reference.trim() : null,
        label: label.trim() || null,
        note: note.trim() || null,
        recordedAt: Timestamp.now(),
        recordedAtClientMs: Date.now(),
        recordedByUid: actor.uid,
        recordedByName: actor.name,
        voidedAt: null,
        voidedAtClientMs: null,
        voidedByUid: null,
        voidedByName: null,
        voidReason: null,
      };
      const refDoc = doc(db, "stores", storeId, "reservations", reservation.id);
      const summary = `₱${entry.amount.toFixed(2)} via ${selectedMethod.name}${entry.label ? ` (${entry.label})` : ""}`;
      await updateDoc(refDoc, {
        payments: arrayUnion(entry),
        history: appendReservationEvent(reservationEvent("payment_recorded", actor, summary)),
        updatedAt: serverTimestamp(),
      });
      toast({ title: "Payment recorded", description: summary });
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message || "Could not record payment." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            Record payment
          </DialogTitle>
          <DialogDescription>
            For {reservation.customerName} · {reservation.partySize} pax
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Mode of payment</Label>
            <Select value={methodId} onValueChange={setMethodId} disabled={saving || methods.length === 0}>
              <SelectTrigger><SelectValue placeholder={methods.length === 0 ? "No active modes" : "Select mode"} /></SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>Amount</Label>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              disabled={saving}
            />
          </div>

          {selectedMethod?.hasRef && (
            <div className="space-y-1">
              <Label>Reference #</Label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. GCash ref no."
                disabled={saving}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label>Label <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value.slice(0, 40))}
              placeholder="e.g. Reservation fee, Ocular deposit"
              disabled={saving}
            />
          </div>

          <div className="space-y-1">
            <Label>Note <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 120))}
              placeholder="Anything to remember"
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={saving || !canSubmit} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wallet className="h-4 w-4 mr-2" />}
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
