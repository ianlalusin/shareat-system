/**
 * T-529 R1 - the Kitchen tab remembers which station chip this device last chose. A per-viewer convenience in localStorage: every access is wrapped, and a
 * broken or missing store just means "All". A saved station the store no longer has reads as All.
 */
export const KITCHEN_STATION_KEY = 'pos.kitchen.station';

export function readStationFilter(storage: Pick<Storage, 'getItem'> | null, stationIds: readonly string[]): string | null {
  try {
    const saved = storage?.getItem(KITCHEN_STATION_KEY) ?? null;
    return saved !== null && stationIds.includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function saveStationFilter(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, stationId: string | null): void {
  try {
    if (stationId === null) storage?.removeItem(KITCHEN_STATION_KEY);
    else storage?.setItem(KITCHEN_STATION_KEY, stationId);
  } catch {
    // a private window or blocked site data: the filter is simply not remembered
  }
}
