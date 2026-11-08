/**
 * T-529 R2 - the left side of refill.png: the refill lines not yet served, one row per REQUEST (the lines of one table added at the same moment),
 * oldest first. Only `refill` tickets: a dish is never in this list. Pure; `nowMs` comes in.
 */
import { byId, type KitchenTicket } from '../_kitchen/cards';

export interface RefillRow {
  key: string;
  sessionId: string;
  standLabel: string;
  itemsText: string;
  askedMinutes: number;
  askedLabel: string;
  /** Who asked, by name; null when the server does not say. */
  askedBy: string | null;
  lineIds: string[];
}

const order = (a: KitchenTicket, b: KitchenTicket) => Date.parse(a.addedAtDevice) - Date.parse(b.addedAtDevice) || byId(a.lineId, b.lineId);

export function buildRefillRows(tickets: readonly KitchenTicket[], nowMs: number): RefillRow[] {
  const groups = new Map<string, KitchenTicket[]>();
  // Sorted first, so every group is oldest first and the groups are inserted oldest first: the Map keeps that order.
  for (const t of [...tickets].filter((x) => x.kind === 'refill').sort(order)) {
    const key = `${t.sessionId}|${t.addedAtDevice}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()].map(([key, lines]) => {
    const first = lines[0]!;
    const askedMinutes = Math.max(0, Math.floor((nowMs - Date.parse(first.addedAtDevice)) / 60_000));
    return {
      key,
      sessionId: first.sessionId,
      standLabel: first.standNumber === null ? 'Take-out' : `Stand ${first.standNumber}`,
      itemsText: lines.map((l) => `${l.qty} × ${l.name}`).join(' · '),
      askedMinutes,
      askedLabel: `${askedMinutes} min`,
      askedBy: first.askedBy ?? null,
      lineIds: lines.map((l) => l.lineId),
    };
  });
}
