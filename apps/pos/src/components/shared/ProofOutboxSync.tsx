"use client";

import { useEffect } from "react";

import { useOnlineStatus } from "@/hooks/use-online-status";
import { flushProofOutbox } from "@/lib/payments/proof/capture";

/**
 * Uploads any payment-proof photos captured while offline.
 *
 * Renders nothing. Mounted once at the app root so a photo taken on the QR
 * wallet still uploads even if nobody reopens that screen — it would otherwise
 * sit in IndexedDB until the browser evicted it.
 */
export function ProofOutboxSync() {
  const isOnline = useOnlineStatus();

  useEffect(() => {
    if (!isOnline) return;
    // Small delay so a flapping connection does not start an upload that the
    // next offline transition immediately kills.
    const timer = setTimeout(() => {
      void flushProofOutbox().then(({ uploaded, failed }) => {
        if (uploaded || failed) {
          console.info(`[proof-outbox] flushed ${uploaded} uploaded, ${failed} failed`);
        }
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [isOnline]);

  return null;
}
