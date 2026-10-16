// src/components/cashier/CardPill.tsx
"use client";

import { Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { cardPillModel } from "@/lib/loyalty/session-link";

type PillSession = {
  linkedCustomerPhone?: string | null;
  linkedCustomerName?: string | null;
  linkedBy?: string | null;
};

/**
 * Sharelebrator card status for a session. Linked = black pill, white text,
 * ★ first. Unlinked = grey "No card"; becomes a button when `onLinkClick` is
 * given (cashier can attach a card).
 */
export function CardPill({
  session,
  onLinkClick,
  className,
}: {
  session: PillSession;
  onLinkClick?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const m = cardPillModel(session);

  if (m.linked) {
    return (
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1 rounded-full bg-black px-2 py-0.5 text-[11px] font-semibold text-white dark:ring-1 dark:ring-white/40",
          className,
        )}
        title={m.viaCashier ? "Linked by cashier" : "Linked by customer"}
      >
        <span aria-hidden className="shrink-0">★</span>
        <span className="truncate">{m.label}</span>
        {m.viaCashier && <span className="shrink-0 text-[9px] font-normal text-white/70">via cashier</span>}
      </span>
    );
  }

  const base =
    "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground";
  if (!onLinkClick) return <span className={cn(base, className)}>{m.label}</span>;
  return (
    <button
      type="button"
      onClick={onLinkClick}
      className={cn(base, "hover:bg-muted/70 hover:text-foreground", className)}
      title="Link a Sharelebrator card"
    >
      <Link2 className="h-3 w-3" /> {m.label}
    </button>
  );
}
