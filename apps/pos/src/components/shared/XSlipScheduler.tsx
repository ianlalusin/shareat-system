"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useOutboxStatus } from "@/hooks/useOutboxStatus";
import { useStoreContext } from "@/context/store-context";
import { Button } from "@/components/ui/button";
import {
  advanceOfflinePeriod,
  loadOfflinePeriod,
  markSlipsPrinted,
  saveOfflinePeriod,
  type OfflinePeriodState,
} from "@/lib/outbox/offlinePeriod";
import { buildXSlipText, printXSlipText } from "@/lib/outbox/xSlipRun";
import { XSLIP_HEADER } from "@/lib/printing/xSlipFormatter";

const TICK_MS = 30_000;

/**
 * T-425 Ruling 7: prints an X-slip (cash control, not a BIR document) at every 4 hours of an OFFLINE PERIOD. The period start and the slips
 * already printed are kept in IndexedDB, so a restart neither loses the clock nor prints a slip twice. With no paired printer the slip is
 * shown here and stays until a person prints it or confirms they wrote it down. Renders nothing otherwise.
 */
export function XSlipScheduler() {
  const online = useOnlineStatus();
  const outbox = useOutboxStatus();
  const { activeStore } = useStoreContext();
  const [pending, setPending] = useState<{ text: string; widthMm: 58 | 80; upTo: number } | null>(null);
  const stateRef = useRef<OfflinePeriodState | null>(null);
  const busyRef = useRef(false);
  const latest = useRef({ online, unsent: outbox.unsentCount, loaded: outbox.loaded, store: activeStore });
  latest.current = { online, unsent: outbox.unsentCount, loaded: outbox.loaded, store: activeStore };

  const tick = useCallback(async () => {
    if (busyRef.current || !latest.current.loaded) return; // do not judge "no unsent rows" before the ledger was read
    busyRef.current = true;
    try {
      const before = stateRef.current ?? (await loadOfflinePeriod());
      const now = Date.now();
      const step = advanceOfflinePeriod(before, { nowMs: now, online: latest.current.online, unsentCount: latest.current.unsent });
      let next = step.state;
      if (step.slipsDue.length > 0 && latest.current.store) {
        const startMs = step.ended?.startMs ?? next.periodStartMs ?? before.periodStartMs ?? now;
        const upTo = Math.max(...step.slipsDue);
        const { text, widthMm } = await buildXSlipText({ storeId: latest.current.store.id, storeName: latest.current.store.name, periodStartMs: startMs, periodEndMs: now });
        const outcome = await printXSlipText(text, widthMm);
        if (outcome === "printed") {
          next = markSlipsPrinted(next, upTo);
        } else {
          // Not printed: keep the slip DUE (and the period open) until a person prints it or confirms it is written down.
          next = before.periodStartMs === null ? next : before;
          setPending({ text, widthMm, upTo });
        }
      }
      stateRef.current = next;
      if (JSON.stringify(next) !== JSON.stringify(before)) await saveOfflinePeriod(next);
    } catch (e) {
      console.error("[x-slip] period tick failed", e);
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    void tick();
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    return () => clearInterval(timer);
  }, [tick]);
  useEffect(() => { void tick(); }, [online, outbox.unsentCount, outbox.loaded, tick]);

  const confirmDone = useCallback(async () => {
    if (!pending) return;
    const cur = stateRef.current ?? (await loadOfflinePeriod());
    const next = markSlipsPrinted(cur, pending.upTo);
    stateRef.current = next;
    await saveOfflinePeriod(next);
    setPending(null);
  }, [pending]);

  const retryPrint = useCallback(async () => {
    if (!pending) return;
    if ((await printXSlipText(pending.text, pending.widthMm)) === "printed") await confirmDone();
  }, [pending, confirmDone]);

  if (!pending) return null;
  return (
    <div className="fixed inset-x-0 top-12 z-50 mx-auto max-w-md rounded-md border bg-background p-3 shadow-lg" role="alertdialog" aria-label="X-slip due">
      <p className="text-sm font-semibold">X-slip due. No printer paired: copy this to paper or print it.</p>
      <pre className="my-2 max-h-64 overflow-auto whitespace-pre text-xs" aria-label={XSLIP_HEADER}>{pending.text}</pre>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => void retryPrint()}>Print</Button>
        <Button size="sm" onClick={() => void confirmDone()}>I wrote it down</Button>
      </div>
    </div>
  );
}
