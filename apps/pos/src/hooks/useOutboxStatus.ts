"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getInitialOutboxStatus, getOutboxStatus, refreshOutboxStatus, subscribeOutboxStatus, type OutboxStatus } from "@/lib/outbox/outboxStatus";

const POLL_MS = 15_000;

/** The ledger's unsent count/total and the manager counts, refreshed on every ledger change and every 15 s. */
export function useOutboxStatus(): OutboxStatus {
  useEffect(() => {
    void refreshOutboxStatus();
    const timer = setInterval(() => { void refreshOutboxStatus(); }, POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return useSyncExternalStore(subscribeOutboxStatus, getOutboxStatus, getInitialOutboxStatus);
}
