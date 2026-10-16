"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Numpad } from "@/components/shared/Numpad";
import { Users } from "lucide-react";

interface GuestCountModalProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tableLabel: string;
  onConfirm: (count: number) => void;
  isProcessing?: boolean;
}

export function GuestCountModal({ open, onOpenChange, tableLabel, onConfirm, isProcessing = false }: GuestCountModalProps) {
  const [buffer, setBuffer] = useState("2");
  const [pristine, setPristine] = useState(true);

  useEffect(() => {
    if (open) {
      setBuffer("2");
      setPristine(true);
    }
  }, [open]);

  const handleKey = (key: string) => {
    setBuffer(prev => {
      const base = pristine ? "" : prev;
      const next = (base + key).replace(/^0+(?=\d)/, "");
      return next.length > 3 ? prev : next;
    });
    setPristine(false);
  };

  const handleBackspace = () => {
    setBuffer(prev => prev.slice(0, -1));
    setPristine(false);
  };
  const handleClear = () => {
    setBuffer("");
    setPristine(false);
  };

  const count = buffer ? Number(buffer) : 0;
  const confirmDisabled = !buffer || count <= 0;

  const handleConfirm = () => {
    if (confirmDisabled) return;
    onConfirm(count);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            How many guests at {tableLabel}?
          </DialogTitle>
          <DialogDescription>
            Count the guests at the table yourself — don't rely on the cashier's number.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-muted/50 border py-6 flex items-center justify-center">
          <p className="text-6xl font-black tabular-nums">{buffer || "0"}</p>
        </div>

        <Numpad
          onKey={handleKey}
          onBackspace={handleBackspace}
          onClear={handleClear}
          onConfirm={handleConfirm}
          confirmDisabled={confirmDisabled}
          confirmLabel="Verify"
          isProcessing={isProcessing}
          allowDecimal={false}
        />
      </DialogContent>
    </Dialog>
  );
}
