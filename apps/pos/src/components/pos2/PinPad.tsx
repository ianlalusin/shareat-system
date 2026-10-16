"use client";

import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * T-424 S9 - the manager PIN pad (plain; restyled after Ian approves the PC-7 mock-up). A 6-digit PIN, typed on screen so a cashier at
 * the counter can hand the tablet to a manager. The PIN is held only in the caller's state, sent once, and never stored.
 */
export const PIN_LENGTH = 6;

export function PinPad({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  const press = (d: string) => {
    if (!disabled && value.length < PIN_LENGTH) onChange(value + d);
  };
  return (
    <div className="mx-auto w-56 space-y-3" aria-label="Manager PIN">
      <div className="flex justify-center gap-2" aria-live="polite">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`h-3 w-3 rounded-full border ${i < value.length ? "bg-foreground" : "bg-transparent"}`} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Button key={d} type="button" variant="outline" className="h-12 text-lg" disabled={disabled} onClick={() => press(d)}>
            {d}
          </Button>
        ))}
        <Button type="button" variant="ghost" className="h-12" disabled={disabled || value.length === 0} onClick={() => onChange("")}>
          Clear
        </Button>
        <Button type="button" variant="outline" className="h-12 text-lg" disabled={disabled} onClick={() => press("0")}>
          0
        </Button>
        <Button type="button" variant="ghost" className="h-12" disabled={disabled || value.length === 0} onClick={() => onChange(value.slice(0, -1))} aria-label="Delete last digit">
          <Delete className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
