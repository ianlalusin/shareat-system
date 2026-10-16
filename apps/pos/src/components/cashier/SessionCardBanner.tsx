// src/components/cashier/SessionCardBanner.tsx
"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { CardPill } from "./CardPill";
import { LinkCardDialog } from "./LinkCardDialog";
import { cardPillModel, estimateEarnPoints } from "@/lib/loyalty/session-link";
import { useOnlineStatus } from "@/hooks/use-online-status";

type LinkDoc = {
  linkedCustomerPhone?: string | null;
  linkedCustomerName?: string | null;
  linkedBy?: string | null;
  linkedCustomerLockedAt?: unknown;
};

/**
 * Loyalty status strip at the top of the payment modal. Reads the live
 * activeSessions doc so a card linked mid-checkout (cashier or diner) shows up
 * immediately. This is the same field `payment-modal` reads at submit to earn
 * points, so what the banner shows is what will be awarded.
 */
export function SessionCardBanner({
  storeId,
  sessionId,
  grandTotal,
  loyaltyConfig,
  canLink,
  sessionLabel,
}: {
  storeId: string;
  sessionId: string;
  grandTotal: number;
  loyaltyConfig?: { isEnabled?: boolean; pointsPerPeso?: number } | null;
  canLink: boolean;
  /** Optional subtitle for the link dialog (e.g. "Table 3"). */
  sessionLabel?: string;
}) {
  const isOnline = useOnlineStatus();
  const [link, setLink] = useState<LinkDoc | null>(null);
  // False until the first snapshot (or error) arrives, so the amber "No card" state never flashes.
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setLink(null); // never carry a previous session's link over to a new one
    const ref = doc(db, "stores", storeId, "activeSessions", sessionId);
    return onSnapshot(
      ref,
      // Billout deletes the activeSessions doc mid-payment. Keep the last known link
      // when the doc disappears so the banner doesn't flash "No loyalty card linked"
      // while the payment is still processing (points are earned from the pre-delete read).
      (snap) => { if (snap.exists()) setLink(snap.data() as LinkDoc); setLoaded(true); },
      () => { setLoaded(true); },
    );
  }, [storeId, sessionId]);

  const m = cardPillModel(link ?? {});
  const points = estimateEarnPoints(grandTotal, loyaltyConfig);
  const lockedOut = !!link?.linkedCustomerLockedAt;

  // Loyalty off for this store: linking only produces a "Loyalty earn failed" toast at billout.
  if (loyaltyConfig?.isEnabled === false) return null;
  if (!loaded) return null;

  if (m.linked) {
    return (
      <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <CardPill session={link!} />
          <span className="text-muted-foreground truncate">
            Earning points
          </span>
        </div>
        {points > 0 && <span className="shrink-0 font-medium">≈ {points} pts</span>}
      </div>
    );
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <span>No loyalty card linked</span>
        {canLink && !lockedOut && (
          isOnline ? (
            <Button size="sm" variant="outline" className="h-7" onClick={() => setDialogOpen(true)}>
              Link card
            </Button>
          ) : (
            <span className="text-xs">Linking needs internet</span>
          )
        )}
      </div>
      <LinkCardDialog open={dialogOpen} onOpenChange={setDialogOpen} storeId={storeId} sessionId={sessionId} sessionLabel={sessionLabel} />
    </>
  );
}
