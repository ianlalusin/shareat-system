/**
 * T-644 S2 - the parties seated at a table whose lobby link was not saved. The table is open (its `stand.opened` is in the outbox) but `seatLobbyEntryAction` did not
 * answer ok, so the row shows "Seated, link not saved: Retry" until it works or the cashier dismisses it. Kept in this tablet's local storage per store, ids and the stand
 * label ONLY (no name, phone or note). A port of apps/pos lobbyPending.ts as REQUIREMENTS. Storage is a convenience: unavailable or cleared, the row simply shows Seat again
 * and the lobby's own expiry clears the party, so every read and write is wrapped and none can throw.
 */
export interface PendingSeat {
  entryId: string;
  sessionId: string;
  standLabel: string;
}

/** The two methods used, so a test can pass a plain object. */
export interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const keyOf = (storeId: string) => `erp.pos.lobbyPendingSeats.${storeId}`;
const browserStorage = (): PendingStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};
const pick = (v: unknown): PendingSeat | null => {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  // Only the three known fields survive a read, so anything else somebody stored there never reaches the screen.
  return typeof o.entryId === 'string' && typeof o.sessionId === 'string' && typeof o.standLabel === 'string' ? { entryId: o.entryId, sessionId: o.sessionId, standLabel: o.standLabel } : null;
};

export function readPending(storeId: string, storage: PendingStorage | null = browserStorage()): Record<string, PendingSeat> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(keyOf(storeId)) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, PendingSeat> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const p = pick(v);
      if (p) out[k] = p;
    }
    return out;
  } catch {
    return {};
  }
}

function write(storeId: string, all: Record<string, PendingSeat>, storage: PendingStorage | null): void {
  try {
    storage?.setItem(keyOf(storeId), JSON.stringify(all));
  } catch {
    // storage full or blocked: the row falls back to Seat
  }
}

export function addPending(storeId: string, p: PendingSeat, storage: PendingStorage | null = browserStorage()): void {
  write(storeId, { ...readPending(storeId, storage), [p.entryId]: { entryId: p.entryId, sessionId: p.sessionId, standLabel: p.standLabel } }, storage);
}

export function clearPending(storeId: string, entryId: string, storage: PendingStorage | null = browserStorage()): void {
  const rest = readPending(storeId, storage);
  delete rest[entryId];
  write(storeId, rest, storage);
}

/** Forget the parties that have left the line (seated elsewhere, removed, expired): their retry can never work, and the note would otherwise stay for good. */
export function keepOnly(storeId: string, entryIds: readonly string[], storage: PendingStorage | null = browserStorage()): void {
  const all = readPending(storeId, storage);
  const ids = Object.keys(all);
  const gone = ids.filter((id) => !entryIds.includes(id));
  if (gone.length === 0) return;
  for (const id of gone) delete all[id];
  write(storeId, all, storage);
}
