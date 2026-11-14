'use client';

/**
 * T-529 R3 - hands a just-saved event to the outage print. The store tablet only (a phone has no snapshot, no stands and no printer). It prints nothing
 * while online; offline it prints one ticket per station (orders) or one slip (refills), once per event (`outage-replay.ts`). The shell's
 * `useOutageReplay` catches what was saved before the poll said Offline. Paper width and copies are the till's own (T-546 `printSettingsOf`); a snapshot without them prints 58 mm, 1 copy. A failed ticket is kept for Reprint; the order is already in the outbox.
 */
import { useCallback } from 'react';
import { getMeta, setMeta } from '@/lib/pos-device';
import { printLines } from '@/lib/pos-print/adapter';
import { printSettingsOf } from '../_payment/logic';
import type { MenuLike } from '../_orders/menu-filter';
import type { PosContextValue } from '../_shell/pos-context';
import { reportOutage, reportOutageError } from './outage-jobs';
import type { OutageDeps } from './outage-print';
import { printUnprinted, type OutageEvent } from './outage-replay';

const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Everything the outage print needs from the tablet, or null while the cached snapshot has no menu. A missing till number stays null (the ticket says `K-—`). */
export function outageDeps(i: { online: boolean; snapshot: PosContextValue['ordersSnapshot']; tableLabels: Record<string, string | null> }): OutageDeps | null {
  if (!i.snapshot?.menu) return null;
  const { layout, copies } = i.snapshot.payment ? printSettingsOf(i.snapshot.payment.store) : { layout: { width: 58 as const, font: 'normal' as const }, copies: 1 };
  return {
    online: i.online,
    menu: i.snapshot.menu as MenuLike,
    stands: i.snapshot.stands,
    terminalNo: i.snapshot.payment?.store.terminalNo ?? null,
    layout,
    copies,
    sentAtLocal: clock(new Date()),
    tableLabels: i.tableLabels,
    printLines,
    getMeta,
    setMeta,
  };
}

export function useOutagePrint(pos: Pick<PosContextValue, 'paired' | 'online' | 'ordersSnapshot'> | null, tableLabels: () => Record<string, string | null>) {
  const snapshot = pos?.ordersSnapshot ?? null;
  const paired = pos?.paired ?? false;
  const online = pos?.online ?? true;
  return useCallback(
    async (event: OutageEvent): Promise<void> => {
      const deps = paired ? outageDeps({ online, snapshot, tableLabels: tableLabels() }) : null;
      if (!deps) return;
      try {
        reportOutage(await printUnprinted(deps, [event]));
      } catch {
        reportOutageError(); // the order is saved; a paper problem must never turn into a failed send, but it must show
      }
    },
    [paired, online, snapshot, tableLabels],
  );
}
