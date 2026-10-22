"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useOutboxStatus } from "@/hooks/useOutboxStatus";
import { shouldShowUnsentBanner, unsentBannerText } from "@/lib/outbox/unsentBanner";

/**
 * T-425 Ruling 6: on every screen while the unsent sales total is 50,000.00 pesos or more. Selling is NEVER blocked: this only tells the
 * manager. A second strip appears when sales were quarantined, rejected or stuck (a person must look at them in Settings).
 */
export function UnsentBanner() {
  const s = useOutboxStatus();
  if (!s.loaded) return null;
  const needsManager = s.quarantined + s.rejected + s.stuck;
  const showMoney = shouldShowUnsentBanner(s.unsentTotalCentavos);
  if (!showMoney && needsManager === 0) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 space-y-px text-sm font-medium">
      {showMoney && (
        <div role="alert" className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-black">
          <AlertTriangle size={16} />
          {unsentBannerText(s.unsentTotalCentavos)}
        </div>
      )}
      {needsManager > 0 && (
        <div role="status" className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-2 text-amber-900">
          {needsManager} sale{needsManager === 1 ? "" : "s"} need a manager. <Link href="/settings" className="underline">Open Settings</Link>
        </div>
      )}
    </div>
  );
}
