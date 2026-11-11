/**
 * T-529 R1 - who may press Served on the Kitchen tab. There is no `line.served` outbox kind (T-525 R3), so serving is ONLINE ONLY, on the store tablet
 * and on a kitchen browser alike. A person without `serve_pos_ticket` sees the tickets read-only. `paired` only decides whether the offline sentence is
 * said: a tablet that goes offline has a printed ticket to work from, a browser has nothing to say.
 */
export const KITCHEN_OFFLINE_NOTE = 'The kitchen screen updates when the internet is back. Use the printed tickets.';

export function kitchenAccess(a: { held: ReadonlySet<string>; paired: boolean; online: boolean }): { canServe: boolean; note: string | null } {
  return { canServe: a.held.has('serve_pos_ticket') && a.online, note: a.paired && !a.online ? KITCHEN_OFFLINE_NOTE : null };
}
