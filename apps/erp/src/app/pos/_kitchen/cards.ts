/**
 * T-529 R1 - the Kitchen tab's cards as pure functions over the polled queue: one card per table, oldest first, lines oldest first, late when a line passes
 * ITS OWN station's SLA (read from the menu's stations, never a number in this file), refill lines tagged. No React, no clock: `nowMs` comes in.
 */
import type { MenuMetaStation } from './menu-meta';

/** T-524 `listKitchenQueue` ticket (`packages/domain/src/pos/sale.ts`). */
export interface KitchenTicket {
  lineId: string;
  sessionId: string;
  standNumber: number | null;
  sessionMode: string;
  kind: string;
  name: string;
  qty: number;
  note: string | null;
  stationId: string | null;
  addedAtDevice: string;
  askedBy?: string | null;
}
export interface KitchenCardLine {
  lineId: string;
  name: string;
  qty: number;
  note: string | null;
  tag: 'Refill' | null;
  stationId: string | null;
}
export interface KitchenCard {
  sessionId: string;
  title: string;
  standNumber: number | null;
  takeOut: boolean;
  ageMinutes: number;
  ageLabel: string;
  late: boolean;
  lines: KitchenCardLine[];
}

const byAge = (a: KitchenTicket, b: KitchenTicket) => Date.parse(a.addedAtDevice) - Date.parse(b.addedAtDevice) || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);

export function buildKitchenCards(
  tickets: readonly KitchenTicket[],
  o: { stations: readonly Pick<MenuMetaStation, 'id' | 'slaMinutes'>[]; nowMs: number; stationId?: string | null; hiddenLineIds?: ReadonlySet<string> },
): KitchenCard[] {
  const sla = new Map(o.stations.map((s) => [s.id, s.slaMinutes]));
  const bySession = new Map<string, KitchenTicket[]>();
  for (const t of [...tickets].sort(byAge)) {
    if (o.hiddenLineIds?.has(t.lineId)) continue;
    if (o.stationId && t.stationId !== o.stationId) continue;
    bySession.set(t.sessionId, [...(bySession.get(t.sessionId) ?? []), t]);
  }
  // Each group is already oldest first, so the first of a group is the card's oldest line and the groups sort by it.
  return [...bySession.values()]
    .sort((a, b) => byAge(a[0]!, b[0]!))
    .map((lines) => {
      const first = lines[0]!;
      const ageMinutes = Math.max(0, Math.floor((o.nowMs - Date.parse(first.addedAtDevice)) / 60_000));
      const late = lines.some((l) => {
        const limit = l.stationId ? sla.get(l.stationId) : undefined;
        return limit !== undefined && (o.nowMs - Date.parse(l.addedAtDevice)) / 60_000 > limit;
      });
      const takeOut = first.standNumber === null;
      return {
        sessionId: first.sessionId,
        title: takeOut ? 'Take-out' : `Stand ${first.standNumber}`,
        standNumber: first.standNumber,
        takeOut,
        ageMinutes,
        ageLabel: `${ageMinutes} min`,
        late,
        lines: lines.map((l) => ({ lineId: l.lineId, name: l.name, qty: l.qty, note: l.note, tag: l.kind === 'refill' ? ('Refill' as const) : null, stationId: l.stationId })),
      };
    });
}

/** All first, then every station in the order the menu gives them. */
export function stationChips(stations: readonly Pick<MenuMetaStation, 'id' | 'name'>[]): { id: string | null; label: string }[] {
  return [{ id: null, label: 'All' }, ...stations.map((s) => ({ id: s.id, label: s.name }))];
}
