"use client";
import { useConnectivity } from "@/hooks/useConnectivity";

/**
 * T-425: a thin wrapper over the ONE connectivity store (a probe of the POS server, not `navigator.onLine`). Kept so the many call sites
 * that only need a boolean do not change.
 */
export function useOnlineStatus(): boolean {
  return useConnectivity().online;
}
