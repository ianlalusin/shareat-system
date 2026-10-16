"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Delete } from "lucide-react";

interface NumpadProps {
  onKey: (key: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onConfirm: () => void;
  confirmDisabled: boolean;
  confirmLabel: React.ReactNode;
  isProcessing: boolean;
  /** Include "." key (default true). Set false for integer-only inputs like guest counts. */
  allowDecimal?: boolean;
}

export function Numpad({
  onKey,
  onBackspace,
  onClear,
  onConfirm,
  confirmDisabled,
  confirmLabel,
  isProcessing,
  allowDecimal = true,
}: NumpadProps) {
  const keys = allowDecimal
    ? ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]
    : ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

  return (
    <div className="grid grid-cols-3 gap-1.5 select-none">
      {keys.map((key, i) => {
        if (key === "") {
          return <div key={`blank-${i}`} />;
        }
        return (
          <Button
            key={key}
            type="button"
            variant="outline"
            className="h-12 text-lg font-medium tabular-nums"
            disabled={isProcessing}
            onClick={() => {
              if (key === "⌫") onBackspace();
              else onKey(key);
            }}
          >
            {key === "⌫" ? <Delete className="h-5 w-5" /> : key}
          </Button>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        className="h-12 text-sm text-muted-foreground"
        disabled={isProcessing}
        onClick={onClear}
      >
        Clear
      </Button>
      <Button
        type="button"
        className="h-12 col-span-2 text-base font-semibold"
        disabled={confirmDisabled || isProcessing}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
