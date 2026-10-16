"use client";

import { useEffect, useState } from "react";
import { addDoc, collection, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Minus, Plus, CalendarPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { reservationEvent, appendReservationEvent } from "@/lib/reservations/history";
import type { Reservation } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  /** When set, the modal edits this reservation instead of creating a new one. */
  editing?: Reservation | null;
  /** Default date (ms) to seed the datetime picker on a fresh booking. */
  defaultDateMs?: number;
}

// Format a ms timestamp into the value a <input type="datetime-local"> expects
// (local time, no timezone suffix): "YYYY-MM-DDTHH:mm".
function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReservationFormModal({ open, onOpenChange, storeId, editing, defaultDateMs }: Props) {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const [name, setName] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [whenLocal, setWhenLocal] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.customerName);
      setPartySize(editing.partySize);
      setPhone(editing.phone ?? "");
      setNotes(editing.notes ?? "");
      setWhenLocal(toDatetimeLocalValue(editing.reservedForMs));
    } else {
      // Seed to the chosen day at 18:00 (typical dinner slot) if nothing given.
      const base = defaultDateMs ? new Date(defaultDateMs) : new Date();
      if (!defaultDateMs) base.setHours(base.getHours() + 1, 0, 0, 0);
      else base.setHours(18, 0, 0, 0);
      setName("");
      setPartySize(2);
      setPhone("");
      setNotes("");
      setWhenLocal(toDatetimeLocalValue(base.getTime()));
    }
  }, [open, editing, defaultDateMs]);

  const reservedForMs = whenLocal ? new Date(whenLocal).getTime() : NaN;
  const canSubmit = name.trim().length >= 1 && partySize >= 1 && Number.isFinite(reservedForMs);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const payload = {
        customerName: name.trim(),
        partySize,
        phone: phone.trim() || null,
        notes: notes.trim() || null,
        reservedForMs,
        reservedForDayId: getDayIdFromTimestamp(reservedForMs),
        updatedAt: serverTimestamp(),
      };

      const actor = {
        uid: appUser?.uid ?? null,
        name: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      };

      if (editing) {
        const fmtT = (ms: number) =>
          new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const changes: string[] = [];
        if (editing.customerName !== payload.customerName) changes.push(`name → ${payload.customerName}`);
        if (editing.reservedForMs !== reservedForMs) changes.push(`time ${fmtT(editing.reservedForMs)} → ${fmtT(reservedForMs)}`);
        if (editing.partySize !== partySize) changes.push(`party ${editing.partySize} → ${partySize}`);
        if ((editing.phone ?? null) !== payload.phone) changes.push("phone updated");
        if ((editing.notes ?? null) !== payload.notes) changes.push("notes updated");

        const updatePayload: Record<string, unknown> = { ...payload };
        if (changes.length) {
          updatePayload.history = appendReservationEvent(reservationEvent("edited", actor, changes.join("; ")));
        }
        await updateDoc(doc(db, "stores", storeId, "reservations", editing.id), updatePayload);
        toast({ title: "Reservation updated", description: `${name.trim()} · ${partySize} pax` });
      } else {
        await addDoc(collection(db, "stores", storeId, "reservations"), {
          ...payload,
          status: "booked",
          source: "pos",
          tableId: null,
          tableNumber: null,
          sessionId: null,
          createdAt: serverTimestamp(),
          createdAtClientMs: Date.now(),
          createdByUid: appUser?.uid ?? null,
          createdByName: actor.name,
          history: [reservationEvent("created", actor, "Booked in POS")],
        });
        toast({ title: "Reservation booked", description: `${name.trim()} · ${partySize} pax` });
      }
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message || "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const bump = (delta: number) => setPartySize((p) => Math.max(1, Math.min(99, p + delta)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5 text-primary" />
            {editing ? "Edit reservation" : "New reservation"}
          </DialogTitle>
          <DialogDescription>
            {editing ? "Update this booking's details." : "Book a table for a future date and time."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ian Lalusin"
              maxLength={40}
              disabled={saving}
            />
          </div>

          <div className="space-y-1">
            <Label>Date &amp; time</Label>
            <Input
              type="datetime-local"
              value={whenLocal}
              onChange={(e) => setWhenLocal(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-1">
            <Label>Party size</Label>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={() => bump(-1)} disabled={saving}>
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                inputMode="numeric"
                value={partySize}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                  setPartySize(isNaN(n) ? 0 : Math.max(0, Math.min(99, n)));
                }}
                className="text-center text-lg h-10 tabular-nums"
                disabled={saving}
              />
              <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={() => bump(1)} disabled={saving}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Phone <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d+\-\s]/g, "").slice(0, 20))}
              placeholder="09xx xxx xxxx"
              disabled={saving}
            />
          </div>

          <div className="space-y-1">
            <Label>Notes <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 80))}
              placeholder="birthday, window seat, etc."
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={saving || !canSubmit} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CalendarPlus className="h-4 w-4 mr-2" />}
            {editing ? "Save changes" : "Book reservation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
