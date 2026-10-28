/**
 * T-455 S5 - the seated-but-not-yet-linked parties of this tablet. When the POS session started but the join link or the `lobby/seat` call
 * failed, the party stays on the list and its row shows "Retry link". Cashier screens change page right after seating, so what is still
 * to be linked is kept in the browser's local storage (a convenience only: if it is gone the row simply shows Seat again, and the
 * 3 hour expiry on the server clears the party).
 */
export interface PendingLink {
  entryId: string;
  sessionId: string;
  standLabel: string;
}

const key = (storeId: string) => `pos2.lobbyPendingLinks.${storeId}`;

export function readPendingLinks(storeId: string): Record<string, PendingLink> {
  try {
    const raw = window.localStorage.getItem(key(storeId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PendingLink>) : {};
  } catch {
    return {};
  }
}

function write(storeId: string, all: Record<string, PendingLink>): void {
  try {
    window.localStorage.setItem(key(storeId), JSON.stringify(all));
  } catch {
    /* storage unavailable: the row falls back to Seat */
  }
}

export function addPendingLink(storeId: string, link: PendingLink): void {
  write(storeId, { ...readPendingLinks(storeId), [link.entryId]: link });
}

export function clearPendingLink(storeId: string, entryId: string): void {
  const all = readPendingLinks(storeId);
  delete all[entryId];
  write(storeId, all);
}
