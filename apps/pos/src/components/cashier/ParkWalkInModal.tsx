"use client";

import { useEffect, useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Minus, Plus, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
}

export function ParkWalkInModal({ open, onOpenChange, storeId }: Props) {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const [name, setName] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setPartySize(2);
      setPhone("");
      setNotes("");
    }
  }, [open]);

  const canSubmit = name.trim().length >= 1 && partySize >= 1;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const now = Date.now();
      await addDoc(collection(db, "stores", storeId, "waitlist"), {
        name: name.trim(),
        partySize,
        phone: phone.trim() || null,
        notes: notes.trim() || null,
        status: "waiting",
        createdAt: serverTimestamp(),
        createdAtClientMs: now,
        parkedByUid: appUser?.uid ?? null,
      });
      toast({ title: "Added to waitlist", description: `${name.trim()} · ${partySize} pax` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message || "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const bump = (delta: number) => setPartySize(p => Math.max(1, Math.min(99, p + delta)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            Park walk-in
          </DialogTitle>
          <DialogDescription>
            Add a customer to the waitlist. Seat them when a table opens.
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
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
            Add to waitlist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
