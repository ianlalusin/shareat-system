/**
 * T-529 R2 - what the Refills tab lets this person do. On a server's PHONE (no pairing) every write is a Server Action, so it needs the internet. On the
 * store TABLET asking for a refill goes through the outbox (`refill.requested`), so it works offline too; serving is online only (there is no
 * `line.served` kind), and confirming heads is not offered (the tablet counts heads with `heads.set`, never `confirmHeads`).
 */
export const REFILLS_PHONE_OFFLINE_NOTE = 'Refills need the internet on this phone. Ask at the till.';

export function refillAccess(a: { held: ReadonlySet<string>; paired: boolean; online: boolean }): { canAsk: boolean; canServe: boolean; canConfirmHeads: boolean; note: string | null } {
  const ask = a.held.has('request_pos_refill');
  return {
    canAsk: ask && (a.paired || a.online),
    canServe: a.held.has('serve_pos_ticket') && a.online,
    canConfirmHeads: !a.paired && a.held.has('confirm_pos_heads') && a.online,
    note: !a.paired && !a.online ? REFILLS_PHONE_OFFLINE_NOTE : null,
  };
}
