/** T-526b - the full-width amber band shown while the shell is offline, and the one rule for the "needs the internet once" banner. Pure. */

/** Local time, 24 h, zero-padded: the clock the cashier is looking at (the time of the FIRST failed poll). */
export function localHHMM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** What still works offline (orders-offline.png). Cash and GCash/Maya-with-reference sell and are checked later; card, refunds and day close need the server. */
export const posOfflineBandText = (sinceMs: number): string =>
  `No internet since ${localHHMM(sinceMs)}. Keep selling: cash, and GCash/Maya with the reference (marked to check). Card, refunds and day close wait for the internet.`;

/**
 * The "needs the internet once" banner is for a paired tablet that has NO usable menu snapshot, and for nothing else: never beside a good snapshot,
 * online or offline. `snapshotUsable` is null until the first refresh has finished (no banner yet), and an un-paired tablet has its own message.
 */
export function showNeedsInternetOnce(s: { paired: boolean; snapshotUsable: boolean | null; unpaired: boolean }): boolean {
  return s.paired && s.snapshotUsable === false && !s.unpaired;
}
