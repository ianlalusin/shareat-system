"use client";

import { useEffect } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

interface KdsFlashOverlayProps {
  type: "served" | "cancelled" | null;
  message: string;
  subtitle?: string;
  onDone: () => void;
}

export function KdsFlashOverlay({ type, message, subtitle, onDone }: KdsFlashOverlayProps) {
  useEffect(() => {
    if (!type) return;
    const timer = setTimeout(onDone, 1800);
    return () => clearTimeout(timer);
  }, [type, onDone]);

  if (!type) return null;

  const isServed = type === "served";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none animate-in fade-in-0 duration-200"
      onClick={onDone}
    >
      <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-2xl bg-background/95 border shadow-2xl px-10 py-8 animate-in zoom-in-90 duration-300">
        <div className="relative">
          <div className={`absolute inset-0 rounded-full ${isServed ? "bg-green-500/20" : "bg-red-500/20"} animate-ping`} />
          {isServed ? (
            <CheckCircle2 className="h-16 w-16 text-green-500 relative" />
          ) : (
            <XCircle className="h-16 w-16 text-red-500 relative" />
          )}
        </div>
        <p className={`text-lg font-semibold ${isServed ? "text-green-600" : "text-red-600"}`}>{message}</p>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}
