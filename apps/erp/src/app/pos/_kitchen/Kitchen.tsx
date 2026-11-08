'use client';

/**
 * T-529 R1 - the Kitchen tab: reads the queue the shell polled, groups it into cards by table, and sends Served / All out to the Server Actions. A served line
 * leaves its card at once (optimistic); the next poll confirms, and a refusal brings the line back with the domain's own sentence. The station filter is
 * applied here from the same poll (one queue, no extra request) and remembered per device. Read-only without `serve_pos_ticket`, and while the store tablet
 * is offline (there is no `line.served` outbox kind: the printed tickets carry the kitchen through an outage).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@/components/ui';
import { usePos } from '../_shell/pos-context';
import { serveAllAction, serveLineAction } from '../kitchen/actions';
import { kitchenAccess } from './access';
import { buildKitchenCards, stationChips, type KitchenTicket } from './cards';
import { KitchenBoard } from './KitchenBoard';
import { useMenuMeta } from './use-menu-meta';
import { readStationFilter, saveStationFilter } from './station-filter';
import { StationChips } from './StationChips';

const CLOCK_MS = 15_000;
const NO_CONNECTION = 'That did not save. Check the internet and try again.';
const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function Kitchen() {
  const pos = usePos();
  const meta = useMenuMeta(pos);
  const stations = meta?.stations ?? [];
  const [stationId, setStationId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Lines whose request is in flight: a double tap, or All out over a line already being served, never sends a second request.
  const inFlight = useRef(new Set<string>());
  const tickets = (pos?.kitchenQueue ?? null) as KitchenTicket[] | null;

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  // The remembered chip is read once the stations are known, so a retired station reads as All (never a chip that does not exist).
  const stationKey = stations.map((s) => s.id).join(',');
  useEffect(() => {
    if (stationKey) setStationId(readStationFilter(storage(), stationKey.split(',')));
  }, [stationKey]);
  // A line the server no longer lists is served for good: forget it, so a hidden set never grows over a long shift.
  useEffect(() => {
    if (!tickets) return;
    const live = new Set(tickets.map((t) => t.lineId));
    setHidden((h) => (h.size === 0 || [...h].every((id) => live.has(id)) ? h : new Set([...h].filter((id) => live.has(id)))));
  }, [tickets]);

  const cards = useMemo(() => buildKitchenCards(tickets ?? [], { stations, nowMs: now, stationId, hiddenLineIds: hidden }), [tickets, stations, now, stationId, hidden]);
  if (!pos) return null;
  const storeId = pos.storeId;
  const access = kitchenAccess({ held: pos.held ?? new Set(), paired: pos.paired, online: pos.online });
  const nameOf = (lineId: string) => tickets?.find((t) => t.lineId === lineId)?.name ?? 'A line';
  const unhide = (ids: string[]) => setHidden((h) => new Set([...h].filter((id) => !ids.includes(id))));
  const hide = (ids: string[]) => setHidden((h) => new Set([...h, ...ids]));

  const serve = async (lineId: string) => {
    if (!storeId || inFlight.current.has(lineId)) return;
    inFlight.current.add(lineId);
    setProblem(null);
    hide([lineId]);
    try {
      const r = await serveLineAction({ storeId, lineId });
      if (!r.ok) {
        unhide([lineId]);
        setProblem(`${nameOf(lineId)}: ${r.error}`);
      }
    } catch {
      unhide([lineId]);
      setProblem(NO_CONNECTION);
    } finally {
      inFlight.current.delete(lineId);
    }
  };
  const allOut = async (all: string[]) => {
    const lineIds = all.filter((id) => !inFlight.current.has(id));
    if (!storeId || lineIds.length === 0) return;
    for (const id of lineIds) inFlight.current.add(id);
    setProblem(null);
    hide(lineIds);
    try {
      const r = await serveAllAction({ storeId, lineIds });
      if (r.failed.length > 0) {
        unhide(r.failed.map((f) => f.lineId));
        setProblem(`${r.failed.length === 1 ? 'One line' : `${r.failed.length} lines`} did not save. ${r.failed.map((f) => `${nameOf(f.lineId)}: ${f.error}`).join(' ')}`);
      }
    } catch {
      unhide(lineIds);
      setProblem(NO_CONNECTION);
    } finally {
      for (const id of lineIds) inFlight.current.delete(id);
    }
  };
  const choose = (id: string | null) => {
    setStationId(id);
    saveStationFilter(storage(), id);
  };

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Kitchen</h1>
      {problem ? <Banner tone="error">{problem}</Banner> : null}
      {access.note ? <Banner tone="info">{access.note}</Banner> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StationChips chips={stationChips(stations)} selected={stationId} onSelect={choose} />
        <p className="text-sm text-muted">{access.canServe ? 'Oldest first · tap Served when a dish goes out' : 'Oldest first'}</p>
      </div>
      {tickets === null ? (
        <p className="text-sm text-muted">Waiting for the tickets…</p>
      ) : cards.length === 0 ? (
        <p className="rounded-2xl border border-surface-border bg-surface px-4 py-6 text-base text-muted">Nothing waiting{stationId ? ' at this station' : ''}. New orders show up here.</p>
      ) : (
        <KitchenBoard cards={cards} canServe={access.canServe} onServe={(id) => void serve(id)} onAllOut={(ids) => void allOut(ids)} />
      )}
    </div>
  );
}
