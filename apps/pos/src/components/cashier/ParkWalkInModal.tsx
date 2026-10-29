"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Minus, Plus, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { postPos2 } from "@/lib/pos2/client";
import { lobbyFailure } from "@/lib/pos2/lobby";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  /** Called after the walk-in is on the line, so the card can refresh at once. */
  onParked?: () => void;
}

/** T-455 S5: the walk-in is written to the customer lobby line in Postgres through /api/pos2/lobby/park (no Firestore write). */
export function ParkWalkInModal({ open, onOpenChange, storeId, onParked }: Props) {
  const { toast } = useToast();
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

  const canSubmit = name.trim().length >= 1 && partySize >= 1 && partySize <= 30;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const r = await postPos2<{ code: string }>("lobby/park", {
        storeId,
        displayName: name.trim(),
        partySize,
        phone: phone.trim() || null,
        note: notes.trim() || null,
      });
      toast({ title: `Added to the line: ${r.code}`, description: `${name.trim()} · ${partySize} pax` });
      onOpenChange(false);
      onParked?.();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not add", description: lobbyFailure(err).message });
    } finally {
      setSaving(false);
    }
  };

  const bump = (delta: number) => setPartySize(p => Math.max(1, Math.min(30, p + delta)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            Add walk-in
          </DialogTitle>
          <DialogDescription>
            Add a customer to the waiting line. Seat them when a table opens.
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
                  setPartySize(isNaN(n) ? 0 : Math.max(0, Math.min(30, n)));
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
              onChange={(e) => setPhone(e.target.value.replace(/[^\d+\-\s]/g, "").slice(0, 30))}
              placeholder="09xx xxx xxxx"
              disabled={saving}
            />
          </div>

          <div className="space-y-1">
            <Label>Notes <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 60))}
              placeholder="birthday, window seat, etc."
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={saving || !canSubmit} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
            Add to the line
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
