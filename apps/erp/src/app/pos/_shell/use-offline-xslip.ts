'use client';

/**
 * T-621 S4 - schedules the offline X-slip: a check every minute while the paired tablet is offline (and once when it comes back, to forget the stretch).
 * The decision and the figures are `offline-xslip.ts`; this hook only wires the meta store, the clock and the printer.
 * With the APK printer it prints through the same path the Till tab uses (`printLines`); without one it puts the slip on screen with a Print button.
 * Never blocks selling: every failure is swallowed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { getMeta, setMeta, type PosEvent } from '@/lib/pos-device';
import { formatOfflineXSlip, receiptHeaderOf } from '@/lib/pos-print';
import { printLines } from '@/lib/pos-print/adapter';
import { printSettingsOf } from '../_payment/logic';
import { checkOfflineXSlip, OFFLINE_XSLIP_META_KEY, offlineXSlipFigures, offlineXSlipView, type OfflineXSlipMeta } from './offline-xslip';
import type { SnapshotPaymentPart } from './payment-part';

const CHECK_MS = 60_000;
const local = (ms: number): string =>
  formatBusinessDateTime(new Date(ms), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');

export interface OfflineXSlipState {
  /** The slip's lines when there is no printer to send them to; null otherwise. */
  onScreen: string[] | null;
  printOnScreen: () => void;
  dismiss: () => void;
}

export function useOfflineXSlip(i: { paired: boolean; online: boolean; offlineSinceMs: number | null; hours: number | null; pendingEvents: PosEvent[]; payment: SnapshotPaymentPart | null | undefined; printer: 'plugin' | 'browser' | null }): OfflineXSlipState {
  const [onScreen, setOnScreen] = useState<string[] | null>(null);
  const latest = useRef(i);
  latest.current = i;

  const run = useCallback(async () => {
    const c = latest.current;
    if (!c.paired) return;
    try {
      await checkOfflineXSlip({
        online: c.online,
        offlineSinceMs: c.offlineSinceMs,
        nowMs: Date.now(),
        hours: c.payment ? c.hours : null, // no store details in the cache: nothing to head the slip with
        getMeta: () => getMeta<OfflineXSlipMeta>(OFFLINE_XSLIP_META_KEY),
        setMeta: (v) => setMeta(OFFLINE_XSLIP_META_KEY, v),
        print: async (sinceMs) => {
          const now = latest.current;
          if (!now.payment) return false; // nothing to head the slip with: not done, tried again at the next check
          const { store, tenders } = now.payment;
          const view = offlineXSlipView(offlineXSlipFigures(now.pendingEvents, tenders), {
            header: receiptHeaderOf({ name: store.name, vatRegistered: store.vatRegistered, identity: store.identity, mode: store.mode }),
            terminalNo: store.terminalNo,
            offlineSinceLocal: local(sinceMs),
            printedAtLocal: local(Date.now()),
            waitingCount: now.pendingEvents.length,
          });
          const lines = formatOfflineXSlip(view, printSettingsOf(store).layout);
          if (now.printer === 'plugin' && (await printLines(lines, { copies: 1 })) === 'printed') return true;
          setOnScreen(lines); // no printer, or it failed: show it, with Print
          return true;
        },
      });
    } catch {
      // storage blocked or a print error: selling goes on; the next check tries again
    }
  }, []);

  useEffect(() => {
    if (!i.paired) return;
    void run();
    if (i.online) return;
    const t = setInterval(() => void run(), CHECK_MS);
    return () => clearInterval(t);
  }, [i.paired, i.online, run]);

  const printOnScreen = useCallback(() => {
    if (onScreen) void printLines(onScreen, { copies: 1 });
  }, [onScreen]);
  const dismiss = useCallback(() => setOnScreen(null), []);
  return { onScreen, printOnScreen, dismiss };
}
