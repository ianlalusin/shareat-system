"use client";
import { useEffect, useRef, useState } from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * "You are offline" strip. T-425: the answer comes from the ONE connectivity store (a probe of the POS server), not from the browser's
 * online flag and not from a private copy of it, so a captive-portal Wi-Fi shows as offline here exactly as it does at the till.
 */
export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const [showBanner, setShowBanner] = useState(false);
  const wasOnline = useRef(true);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!isOnline) {
      setShowBanner(true);
    } else if (!wasOnline.current) {
      // Keep banner briefly to show "back online" then fade
      setShowBanner(true);
      timer = setTimeout(() => setShowBanner(false), 3000);
    }
    wasOnline.current = isOnline;
    return () => { if (timer) clearTimeout(timer); };
  }, [isOnline]);

  if (!showBanner) return null;

  return (
    <div className={cn(
      "fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-colors",
      isOnline
        ? "bg-green-600 text-white"
        : "bg-destructive text-destructive-foreground"
    )}>
      <WifiOff size={16} />
      {isOnline
        ? "✓ Back online — data will sync automatically."
        : "You are offline. Viewing cached data. Payments will queue when reconnected."}
    </div>
  );
}
