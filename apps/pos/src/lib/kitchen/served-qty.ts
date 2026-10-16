/**
 * The quantity bookkeeping that closing a kitchen ticket as SERVED implies.
 *
 * Three places close a whole ticket: the KDS "Served" button
 * (`updateTicketStatus`), `completePaymentFromUnits`, and
 * `completePaymentOffline`. For a long time only the first wrote these
 * fields, and the gap was expensive:
 *
 *  - `computeKdsTargets` reads `qtyServed ?? fallback` — nullish, not falsy —
 *    so a ticket left with an explicit `qtyServed: 0` logs ZERO serves to KDS
 *    analytics (pinned in `src/lib/analytics/kdsTargets.test.ts`).
 *  - The CUSTOMER app's order log used to read a served ticket with no
 *    `qtyServed` as CANCELLED, and told diners their food had been cancelled.
 *
 * `qtyOrdered ?? qty ?? 1` mirrors what every other quantity reader in POS
 * does, so a package ticket — created by `startSession` with `qty: 1` and no
 * `qtyOrdered` — resolves to 1 here exactly as it does on the KDS card.
 */
export type ServedQtyTicket = {
  qty?: number | null;
  qtyOrdered?: number | null;
  qtyCancelled?: number | null;
};

export function servedQtyFields(ticket: ServedQtyTicket): { qtyServed: number; qtyRemaining: number } {
  const ordered = Number(ticket.qtyOrdered ?? ticket.qty ?? 1) || 0;
  const cancelled = Number(ticket.qtyCancelled ?? 0) || 0;
  return { qtyServed: Math.max(0, ordered - cancelled), qtyRemaining: 0 };
}
