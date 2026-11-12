/** T-563 R4 - which waiting sales belong to another store, and what the drain remembers about them. Plain functions: the hook only schedules them. */
import type { DrainReport, PosEvent } from '@/lib/pos-device';

/** A drain that reached the end of the outbox knows exactly which pairings the server refused; one that stopped early keeps what it knew before. */
export function nextHeldOrigins(prev: string[], report: Pick<DrainReport, 'stopped' | 'heldOrigins'>): string[] {
  return report.stopped === 'empty' ? report.heldOrigins : [...new Set([...prev, ...report.heldOrigins])];
}

/** The waiting sales the server refused to take under this tablet's current store. Events of the current pairing are never "another store". */
export function heldSalesCount(events: PosEvent[], heldOrigins: string[], currentPairingId: string | null): number {
  return events.filter((e) => e.pairingId !== undefined && e.pairingId !== currentPairingId && heldOrigins.includes(e.pairingId)).length;
}
