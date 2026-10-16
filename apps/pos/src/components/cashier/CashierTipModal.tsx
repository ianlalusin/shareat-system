"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";

interface Props {
  open: boolean;
  message: string;
  onClose: () => void;
  /** Auto-dismiss after this many ms. Default 7000. */
  durationMs?: number;
}

/**
 * Centered tip modal — fades in with a scale-from-bottom animation so it
 * visually rises from the cashier progress card sitting at the bottom of
 * the page. Auto-dismisses after `durationMs`. Tap outside or X to close.
 *
 * Rendered through createPortal so the fixed positioning escapes any
 * parent transform/containing-block context.
 */
export function CashierTipModal({ open, message, onClose, durationMs = 7000 }: Props) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => onClose(), durationMs);
    return () => clearTimeout(t);
  }, [open, durationMs, onClose]);

  if (!open || !mounted || typeof document === "undefined") return null;

  const overlay = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-in fade-in-0 duration-200"
      onClick={onClose}
      role="status"
      aria-live="polite"
    >
      <div
        // Hand-rolled overlay, so it gets no containment from DialogContent —
        // bound it here. The tip body is model-generated and has no length
        // ceiling, so a long one would otherwise run off both ends of a short
        // cashier screen with the dismiss button unreachable.
        className="relative w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl bg-white shadow-2xl border-l-[6px] border-primary p-5 sm:p-6 animate-in zoom-in-75 slide-in-from-bottom-12 duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-1 rounded-full hover:bg-zinc-100 transition"
          aria-label="Dismiss tip"
        >
          <X className="h-4 w-4 text-zinc-400" />
        </button>
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-6 w-6 text-primary" strokeWidth={2.5} />
          </div>
          <div className="flex-1 pt-1">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              Sharelebrator Tip
            </p>
            <p className="text-base font-semibold text-zinc-900 mt-1 leading-snug">{message}</p>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
