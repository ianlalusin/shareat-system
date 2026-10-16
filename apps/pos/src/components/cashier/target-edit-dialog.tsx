"use client";

import { useEffect, useState } from "react";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Target, Save } from "lucide-react";

export function fmtPeso(n: number): string {
  if (n >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₱${(n / 1_000).toFixed(1)}k`;
  return `₱${Math.round(n).toLocaleString()}`;
}

function getTodayDate(): string {
  const manila = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const y = manila.getFullYear();
  const m = String(manila.getMonth() + 1).padStart(2, "0");
  const d = String(manila.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  userUid: string | null;
  currentTargetAmount: number | null;
}

export function TargetEditDialog({ open, onOpenChange, storeId, userUid, currentTargetAmount }: Props) {
  const { toast } = useToast();
  const [date, setDate] = useState(getTodayDate());
  const [amountStr, setAmountStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (open) {
      setDate(getTodayDate());
      setAmountStr("");
    }
  }, [open]);

  function onAmountChange(raw: string) {
    setAmountStr(raw.replace(/[^\d]/g, ""));
  }

  const previewNumber = amountStr ? Number(amountStr) : NaN;
  const previewLabel =
    !amountStr || isNaN(previewNumber) || previewNumber <= 0
      ? "—"
      : fmtPeso(previewNumber);
  const commaFmt =
    !amountStr || isNaN(previewNumber) ? "" : previewNumber.toLocaleString();

  async function handleSave() {
    const amount = Number(amountStr);
    if (!amount || amount <= 0) {
      toast({ title: "Invalid amount", description: "Enter a positive number.", variant: "destructive" });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast({ title: "Invalid date", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const ref = doc(db, "stores", storeId, "salesTargets", date);
      await setDoc(ref, {
        date,
        amount,
        setByUid: userUid ?? null,
        setAt: serverTimestamp(),
      }, { merge: true });
      toast({ title: "Target saved", description: `${fmtPeso(amount)} for ${date}.` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "Failed to save.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearToday() {
    setClearing(true);
    try {
      const today = getTodayDate();
      const ref = doc(db, "stores", storeId, "salesTargets", today);
      await setDoc(ref, { amount: 0, clearedAt: serverTimestamp() }, { merge: true });
      toast({ title: "Target cleared", description: "Cashier will show the AI forecast." });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setClearing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            Set Sales Target
          </DialogTitle>
          <DialogDescription>
            Override the AI forecast with a manual target for the cashier display. Leave blank or clear to revert to the forecast.
          </DialogDescription>
        </DialogHeader>

        {currentTargetAmount != null && (
          <div className="rounded-lg bg-primary/5 border border-primary/30 p-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Today's target</p>
              <p className="text-xl font-black text-primary">{fmtPeso(currentTargetAmount)}</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleClearToday} disabled={clearing}>
              {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Clear"}
            </Button>
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={saving} />
          </div>
          <div className="space-y-1">
            <Label>Target amount (₱)</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="e.g. 36325"
              value={commaFmt || amountStr}
              onChange={(e) => onAmountChange(e.target.value)}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              Preview:{" "}
              <span className="font-mono font-bold">{previewLabel}</span>
              {amountStr && !isNaN(previewNumber) && (
                <span className="text-muted-foreground/60"> · ₱{commaFmt}</span>
              )}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || !amountStr} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Target
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
