"use client";

import { useEffect, useRef, useState } from "react";
import { Numpad } from "@/components/shared/Numpad";
import { cn } from "@/lib/utils";

interface PasscodePadProps {
  length?: number;
  onComplete: (passcode: string) => void;
  /** Change this value to clear the buffer externally (e.g., after a failed attempt). */
  resetToken?: number;
  /** Show shake animation (use with resetToken bump on failure). */
  shake?: boolean;
  isProcessing?: boolean;
  label?: string;
}

export function PasscodePad({
  length = 6,
  onComplete,
  resetToken = 0,
  shake = false,
  isProcessing = false,
  label,
}: PasscodePadProps) {
  const [buffer, setBuffer] = useState("");
  const firedForRef = useRef<string>("");
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  useEffect(() => {
    setBuffer("");
    firedForRef.current = "";
  }, [resetToken]);

  useEffect(() => {
    if (buffer.length === length && firedForRef.current !== buffer) {
      firedForRef.current = buffer;
      onCompleteRef.current(buffer);
    }
  }, [buffer, length]);

  const handleKey = (key: string) => {
    if (/^\d$/.test(key)) {
      setBuffer(prev => (prev.length >= length ? prev : prev + key));
    }
  };
  const handleBackspace = () => setBuffer(prev => prev.slice(0, -1));
  const handleClear = () => setBuffer("");

  return (
    <div className="space-y-3">
      {label && <p className="text-sm font-medium text-center">{label}</p>}
      <div className={cn("flex items-center justify-center gap-2", shake && "animate-shake")}>
        {Array.from({ length }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-3 w-3 rounded-full border-2 transition-colors",
              i < buffer.length ? "bg-primary border-primary" : "border-muted-foreground/40"
            )}
          />
        ))}
      </div>
      <Numpad
        onKey={handleKey}
        onBackspace={handleBackspace}
        onClear={handleClear}
        onConfirm={() => { /* auto-submit on complete */ }}
        confirmDisabled={true}
        confirmLabel="Enter passcode"
        isProcessing={isProcessing}
        allowDecimal={false}
      />
    </div>
  );
}
