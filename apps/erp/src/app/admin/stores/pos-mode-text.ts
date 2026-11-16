/**
 * T-533 S1 - the plain sentence the confirm step shows before a store's POS mode changes (pure, so it is tested without a page).
 * It says exactly what the switch does, in the store's own name.
 */
export type PosModeChoice = 'off' | 'test' | 'live';

/** "7 Dec 2026". Falls back to the raw text for anything that is not a date. */
export function niceDate(d: string): string {
  const at = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? d : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}

export function posModeConsequence(o: { mode: PosModeChoice; liveFrom: string | null; storeName: string; wasLive: boolean }): string {
  if (o.mode === 'live') {
    return `From ${niceDate(o.liveFrom ?? '')}, ${o.storeName}'s sales days come from the new POS; the v1 day feed stops for ${o.storeName}. You can roll this back only until the first day is closed on the new POS.`;
  }
  const back = o.wasLive ? ' This rolls the store back from live: it works only before the first day is closed on the new POS.' : '';
  if (o.mode === 'test') return `${o.storeName} can sell on the new POS for practice; no sales day is booked.${back}`;
  return `The new POS is switched off for ${o.storeName}. Its sales days come from the v1 day feed.${back}`;
}
