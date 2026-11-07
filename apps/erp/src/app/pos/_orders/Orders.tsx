'use client';

/**
 * T-527 - the Orders tab: reads what the shell polled, fetches each open table's lines, applies the outbox's pending events on top (`projectOrders`), and
 * turns every tap into ONE outbox event through `submitPosEvent` (enqueue, then ask for a send). Nothing is written straight to a server (A2, one path).
 * Only a paired store tablet may write (row 447); a phone reads. The store always comes from the shell, which takes it from the pairing first.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PosEvent } from '@/lib/pos-device';
import { Banner } from '@/components/ui';
import { enqueue } from '@/lib/pos-device';
import { usePos } from '../_shell/pos-context';
import { OrderDialog, CancelLineDialog, type OrderDialogMode, type OrderSend } from './OrderDialogs';
import type { MenuLike } from './menu-filter';
import { OrdersView } from './OrdersView';
import { actingPersonId, addLinesEvent, cancelLineEvent, ordersAccess, seatEvent, setHeadsEvent, submitPosEvent, takeOutEvent, HEADS_MAX, HEADS_MIN } from './payloads';
import { projectOrders, type ServerStand, type SessionBody } from './project';
import { droppedEvents, SETTLE_MAX_MS, stillSettling, type Settling } from './settle';

/** How many table reads run at once when the list changes. */
const FETCH_AT_ONCE = 4;
const CLOCK_MS = 30_000;
const EMPTY: PosEvent[] = [];

export function Orders() {
  const pos = usePos();
  const [bodies, setBodies] = useState<Record<string, SessionBody | undefined>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OrderDialogMode | null>(null);
  const [cancelling, setCancelling] = useState<{ lineId: string; name: string } | null>(null);
  const [landed, setLanded] = useState<Record<string, number | null>>({});
  const [settling, setSettling] = useState<Settling[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const seen = useRef<{ events: PosEvent[]; sessionOf: (e: PosEvent) => string | null }>({ events: [], sessionOf: () => null });

  const stands = (pos?.openStands ?? null) as ServerStand[] | null;
  const standKey = stands?.map((s) => s.sessionId).join(',') ?? '';
  const version = pos?.stateVersion ?? null;
  const storeId = pos?.storeId ?? null;
  const snapshot = pos?.ordersSnapshot ?? null;
  const menu = (snapshot?.menu ?? null) as MenuLike | null;

  // What is drawn: the dropped-but-not-yet-caught-up events (settling) first, then the outbox as it stands.
  const outbox = pos?.pendingEvents ?? EMPTY;
  const applied = useMemo(() => [...settling.map((s) => s.event), ...outbox.filter((e) => !settling.some((s) => s.event.seq === e.seq))], [settling, outbox]);
  const view = useMemo(
    () => projectOrders({ openStands: stands, sessions: bodies }, applied, snapshot && menu ? { stands: snapshot.stands, menu } : null),
    [stands, bodies, applied, snapshot, menu],
  );
  const sessionOf = (e: PosEvent): string | null => {
    const p = e.payload as { sessionId?: unknown; lineId?: unknown };
    if (typeof p.sessionId === 'string') return p.sessionId;
    return Object.keys(view.sessions).find((id) => view.sessions[id]!.lines.some((l) => l.id === p.lineId)) ?? null;
  };
  seen.current.sessionOf = sessionOf;

  // An event the outbox dropped starts settling; the bodies' versions and the poll's version decide when it lets go.
  useEffect(() => {
    const dropped = droppedEvents(seen.current.events, outbox);
    seen.current.events = outbox;
    if (dropped.length === 0) return;
    const at = Date.now();
    setSettling((cur) => [...cur, ...dropped.map((event) => ({ event, sessionId: seen.current.sessionOf(event), versionAtDrop: version, droppedAtMs: at }))]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version at the moment of the drop is the one wanted, not a trigger
  }, [outbox]);
  useEffect(() => {
    if (settling.length === 0) return;
    const check = () =>
      setSettling((cur) => {
        const kept = stillSettling(cur, { version, landed, nowMs: Date.now() });
        return kept.length === cur.length ? cur : kept;
      });
    check();
    const t = setTimeout(check, SETTLE_MAX_MS);
    return () => clearTimeout(t);
  }, [settling, version, landed]);

  // The shell's refusal notice names a cancelled line's stand from these bodies.
  const bodiesRef = pos?.bodiesRef;
  useEffect(() => {
    if (bodiesRef) bodiesRef.current = bodies;
  }, [bodiesRef, bodies]);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);

  // One read per open table whenever the list changes. A failed read (offline, signed out) keeps the last body, which is what the tablet knows.
  useEffect(() => {
    if (!storeId || !standKey) return;
    let stopped = false;
    const ids = standKey.split(',');
    void (async () => {
      for (let i = 0; i < ids.length; i += FETCH_AT_ONCE) {
        await Promise.all(
          ids.slice(i, i + FETCH_AT_ONCE).map(async (id) => {
            try {
              const res = await fetch(`/api/pos/session/${id}?storeId=${encodeURIComponent(storeId)}`, { credentials: 'same-origin' });
              const body = res.ok ? ((await res.json()) as SessionBody) : undefined;
              if (!stopped && (body || res.status === 404)) {
                setBodies((b) => ({ ...b, [id]: body }));
                setLanded((l) => ({ ...l, [id]: version })); // this body was read for THIS state version
              }
            } catch {
              // offline: keep the last body
            }
          }),
        );
      }
    })();
    return () => {
      stopped = true;
    };
  }, [storeId, standKey, version]);

  if (!pos) return null;
  const access = ordersAccess({ paired: pos.paired });
  const personId = actingPersonId(pos.offlineActorPersonId ? { personId: pos.offlineActorPersonId } : null, pos.personId);
  const submit = async (event: ReturnType<typeof seatEvent>): Promise<string | null> => {
    const result = await submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, event);
    setProblem(result.ok ? null : result.message);
    return result.ok ? null : result.message;
  };
  const build = async (make: () => ReturnType<typeof seatEvent>): Promise<string | null> => {
    try {
      return await submit(make());
    } catch (e) {
      return e instanceof Error ? e.message : 'That could not be sent.';
    }
  };

  const tileOf = (id: string) => view.tiles.find((t) => t.sessionId === id);
  const labelOf = (id: string) => {
    const t = tileOf(id);
    return t?.standNumber != null ? `Stand ${t.standNumber}` : 'Take-out';
  };
  const send = (o: OrderSend): Promise<string | null> => {
    if (!menu || !dialog) return Promise.resolve('The menu is not on this tablet yet.');
    const base = { personId, menu, now: new Date(), newId: () => crypto.randomUUID(), cart: o.cart };
    if (dialog.kind === 'seat') return build(() => seatEvent({ ...base, standId: o.standId!, heads: o.heads }));
    if (dialog.kind === 'take_out') return build(() => takeOutEvent({ ...base, name: o.name }));
    return build(() => addLinesEvent({ ...base, sessionId: dialog.sessionId, heads: o.heads }));
  };

  return (
    <div className="space-y-3">
      {problem ? <Banner tone="error">{problem}</Banner> : null}
      {access.canWrite && stands === null ? <p className="text-sm text-muted">Waiting for the open tables…</p> : null}
      <OrdersView
        readOnly={!access.canWrite}
        tiles={view.tiles}
        sessions={view.sessions}
        selectedSessionId={selected}
        nowMs={now}
        onSeat={() => setDialog({ kind: 'seat' })}
        onTakeOut={() => setDialog({ kind: 'take_out' })}
        onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
        onHeads={(id, delta) => {
          const next = (view.sessions[id]?.headsCashier ?? 0) + delta;
          if (next >= HEADS_MIN && next <= HEADS_MAX) void build(() => setHeadsEvent({ personId, sessionId: id, heads: next, now: new Date() }));
        }}
        onAddItems={(id) => setDialog({ kind: 'add', sessionId: id, label: labelOf(id), heads: view.sessions[id]?.headsCashier ?? 0, packageOpen: tileOf(id)?.packageName != null, takeOut: tileOf(id)?.mode === 'take_out' })}
        onCancelLine={(lineId) => {
          const line = Object.values(view.sessions).flatMap((s) => s.lines).find((l) => l.id === lineId);
          setCancelling({ lineId, name: line ? `${line.qty} × ${line.name}` : 'This line' });
        }}
      />
      {dialog ? <OrderDialog mode={dialog} menu={menu} stands={snapshot?.stands ?? []} tiles={view.tiles} onClose={() => setDialog(null)} onSend={send} /> : null}
      {cancelling ? (
        <CancelLineDialog
          lineName={cancelling.name}
          onClose={() => setCancelling(null)}
          onConfirm={(reason) => build(() => cancelLineEvent({ personId, lineId: cancelling.lineId, reason, now: new Date() }))}
        />
      ) : null}
    </div>
  );
}
