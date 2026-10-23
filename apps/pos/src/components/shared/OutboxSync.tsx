"use client";

import { useEffect } from "react";
import { useAuthContext } from "@/context/auth-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { pruneLedger } from "@/lib/outbox/ledger";
import { runReconcileNow } from "@/lib/outbox/reconcileRunner";
import { refreshOutboxStatus } from "@/lib/outbox/outboxStatus";

const PASS_EVERY_MS = 60_000;

/**
 * Runs the reconcile pass (T-425 Ruling 2): on start, on going online, and every 60 s while online. A pass with nothing unsent only reads
 * IndexedDB. Renders nothing. Other tabs skip while one tab holds the Web Lock `pos-reconcile`.
 */
export function OutboxSync() {
  const online = useOnlineStatus();
  const { user } = useAuthContext();
  const signedIn = !!user;

  useEffect(() => {
    if (!online || !signedIn) return;
    let stopped = false;
    const pass = async () => {
      if (stopped) return;
      try {
        await runReconcileNow();
      } catch (e) {
        console.error("[outbox] reconcile pass failed", e);
      }
      await refreshOutboxStatus();
    };
    void pass();
    // Old acknowledged / skipped rows hold customer names and lines: drop them after 7 days (unsent rows are never touched).
    void pruneLedger(Date.now()).catch(() => {});
    const timer = setInterval(() => { void pass(); }, PASS_EVERY_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [online, signedIn]);

  return null;
}
