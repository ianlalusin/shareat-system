'use client';

/**
 * T-527 - the Orders tab: reads what the shell polled, fetches each open table's lines, applies the outbox's pending events on top (`projectOrders`), and
 * turns every tap into ONE outbox event through `submitPosEvent` (enqueue, then ask for a send). Nothing is written straight to a server (A2, one path).
 * Only a paired store tablet may write (row 447); a phone reads. The store always comes from the shell, which takes it from the pairing first.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PosEvent } from '@/lib/pos-device';
import { Banner } from '@/components/ui';
import { enqueue, reserveTerminalSeq } from '@/lib/pos-device';
import { printLines, type PrintResult } from '@/lib/pos-print/adapter';
import { formatReceipt } from '@/lib/pos-print/receipt-text';
import type { PrintLayout, ReceiptView } from '@/lib/pos-print/types';
import { projectBill } from '../_payment/bill';
import { extraHeadsId } from '../_payment/uuidv5';
import { printSettingsOf, SENTENCES } from '../_payment/logic';
import { PaymentPanel } from '../_payment/PaymentPanel';
import { ReceiptScreen } from '../_payment/ReceiptScreen';
import { usePos } from '../_shell/pos-context';
import { OutageBanner } from '../_kitchen/outage-jobs';
import { useOutagePrint } from '../_kitchen/use-outage-print';
import { newDeviceId } from './ids';
import { OrderDialog, CancelLineDialog, type OrderDialogMode, type OrderSend } from './OrderDialogs';
import type { MenuLike } from './menu-filter';
import { OrdersView } from './OrdersView';
import { actingPersonId, addLinesEvent, cancelLineEvent, ordersAccess, seatEvent, setHeadsEvent, submitPosEvent, takeOutEvent, HEADS_MAX, HEADS_MIN } from './payloads';
import { projectOrders, type GhostLine, type ServerStand, type SessionBody } from './project';
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
  const [paying, setPaying] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<{ view: ReceiptView; layout: PrintLayout; receiptNo: string } | null>(null);
  // The receipt screen after Finish. It lives HERE, not in the Payment panel: the panel goes when the paid table leaves the open list (the poll), the receipt stays until Done.
  const [receipt, setReceipt] = useState<{ view: ReceiptView; layout: PrintLayout; receiptNo: string; lines: string[]; notice: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [extraIds, setExtraIds] = useState<Record<string, string>>({}); // a bundle's extra-heads line id, derived like the server does (uuidv5)
  const [now, setNow] = useState(0);
  const opener = useRef<HTMLElement | null>(null); // the control that opened the seat/add panel: focus goes back to it on close
  const lastSeen = useRef(new Map<string, GhostLine>()); // every line a table body ever held, so a cancelled one can stay on screen until the server confirms
  const seen = useRef<{ events: PosEvent[]; sessionOf: (e: PosEvent) => string | null }>({ events: [], sessionOf: () => null });

  const stands = (pos?.openStands ?? null) as ServerStand[] | null;
  const standKey = stands?.map((s) => s.sessionId).join(',') ?? '';
  const version = pos?.stateVersion ?? null;
  const storeId = pos?.storeId ?? null;
  const snapshot = pos?.ordersSnapshot ?? null;
  const menu = (snapshot?.menu ?? null) as MenuLike | null;
  const clockAt = pos?.clockAt;
  const menuAt = useMemo(() => (clockAt === undefined ? undefined : new Date(clockAt)), [clockAt]); // T-559: the picker's "now" follows the shell's menu clock

  // What is drawn: the dropped-but-not-yet-caught-up events (settling) first, then the outbox as it stands.
  const outbox = pos?.pendingEvents ?? EMPTY;
  const applied = useMemo(() => [...settling.map((s) => s.event), ...outbox.filter((e) => !settling.some((s) => s.event.seq === e.seq))], [settling, outbox]);
  const view = useMemo(() => {
    const cancelling = new Set(applied.filter((e) => e.kind === 'line.cancelled').map((e) => (e.payload as { lineId?: unknown }).lineId));
    const ghosts = [...lastSeen.current.values()].filter((g) => cancelling.has(g.line.id));
    return projectOrders({ openStands: stands, sessions: bodies }, applied, snapshot && menu ? { stands: snapshot.stands, menu } : null, ghosts);
  }, [stands, bodies, applied, snapshot, menu]);
  // T-529 R3: offline, a sent order also goes out on paper (one ticket per station). The tables' labels come from the view, which includes tables opened offline.
  const printOutage = useOutagePrint(pos, () => Object.fromEntries(view.tiles.map((t) => [t.sessionId, t.standNumber !== null ? String(t.standNumber) : null])));
  const sessionOf = (e: PosEvent): string | null => {
    const p = e.payload as { sessionId?: unknown; lineId?: unknown };
    if (typeof p.sessionId === 'string') return p.sessionId;
    // a cancelled line the server body already dropped is in no view any more: its table is where it was last seen
    return (typeof p.lineId === 'string' ? lastSeen.current.get(p.lineId)?.sessionId : undefined) ?? Object.keys(view.sessions).find((id) => view.sessions[id]!.lines.some((l) => l.id === p.lineId)) ?? null;
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

  useEffect(() => {
    if (dialog === null && opener.current) {
      opener.current.focus();
      opener.current = null;
    }
  }, [dialog]);

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

  // A table that left the open list takes its last-seen lines with it.
  useEffect(() => {
    const open = new Set(standKey.split(','));
    for (const [lineId, g] of lastSeen.current) if (!open.has(g.sessionId)) lastSeen.current.delete(lineId);
  }, [standKey]);

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
                for (const line of body?.lines ?? []) lastSeen.current.set(line.id, { sessionId: id, line });
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

  // The bill of the table being paid. A pending bundle with extra heads needs the server's derived line id first (async), so the bill is built here, in
  // front of the early return, and an effect fills the ids in.
  const draftBill = useMemo(
    () => (paying && snapshot?.payment ? projectBill({ sessionId: paying, view: view.sessions[paying], body: bodies[paying], pending: applied, menu, presets: snapshot.payment.discountPresets, extraIds }) : null),
    [paying, snapshot, view, bodies, applied, menu, extraIds],
  );
  const missingExtra = draftBill?.needsExtraFor.join(',') ?? '';
  useEffect(() => {
    if (!missingExtra) return;
    let stopped = false;
    void Promise.all(missingExtra.split(',').map(async (id) => [id, await extraHeadsId(id)] as const)).then((pairs) => {
      if (!stopped) setExtraIds((cur) => ({ ...cur, ...Object.fromEntries(pairs) }));
    });
    return () => {
      stopped = true;
    };
  }, [missingExtra]);

  if (!pos) return null;
  const access = ordersAccess({ paired: pos.paired });
  const personId = actingPersonId(pos.offlineActorPersonId ? { personId: pos.offlineActorPersonId } : null, pos.personId);
  const submit = async (event: ReturnType<typeof seatEvent>): Promise<string | null> => {
    const result = await submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, event);
    setProblem(result.ok ? null : result.message);
    if (result.ok) void printOutage(result.event);
    return result.ok ? null : result.message;
  };
  const build = async (make: () => ReturnType<typeof seatEvent>): Promise<string | null> => {
    try {
      return await submit(make());
    } catch (e) {
      return e instanceof Error ? e.message : 'That could not be sent.';
    }
  };

  const open = (mode: OrderDialogMode) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(mode);
  };
  const tileOf = (id: string) => view.tiles.find((t) => t.sessionId === id);
  const labelOf = (id: string) => {
    const t = tileOf(id);
    return t?.standNumber != null ? `Stand ${t.standNumber}` : 'Take-out';
  };
  const send = (o: OrderSend): Promise<string | null> => {
    if (!menu || !dialog) return Promise.resolve('The menu is not on this tablet yet.');
    const base = { personId, menu, now: new Date(), newId: newDeviceId, cart: o.cart };
    if (dialog.kind === 'seat') return build(() => seatEvent({ ...base, standId: o.standId!, heads: o.heads }));
    if (dialog.kind === 'take_out') return build(() => takeOutEvent({ ...base, name: o.name }));
    return build(() => addLinesEvent({ ...base, sessionId: dialog.sessionId, heads: o.heads }));
  };

  const payment = snapshot?.payment ?? null;
  const payingTile = paying ? tileOf(paying) : undefined;
  const reprint = async () => {
    if (!lastReceipt) return;
    const result: PrintResult = await printLines(formatReceipt({ ...lastReceipt.view, reprint: true }, lastReceipt.layout), { copies: payment?.store.receiptCopies ?? 1 });
    setNotice(result === 'failed' ? SENTENCES.printFailed : null);
  };
  const reprintFromScreen = async () => {
    if (!receipt) return;
    const result: PrintResult = await printLines(formatReceipt({ ...receipt.view, reprint: true }, receipt.layout), { copies: payment?.store.receiptCopies ?? 1 });
    setReceipt((r) => (r ? { ...r, notice: result === 'failed' ? SENTENCES.printFailed : null } : r));
  };
  if (paying && payingTile) {
    const session = view.sessions[paying];
    return (
      <div className="space-y-3">
        {payment && draftBill ? (
          <PaymentPanel
            sessionId={paying}
            label={labelOf(paying)}
            heads={Math.max(session?.headsCashier ?? 0, session?.headsServer ?? 0)}
            isTakeOut={payingTile.mode === 'take_out'}
            bill={draftBill}
            presets={payment.discountPresets}
            tenders={payment.tenders}
            rules={payment.rules}
            vatRegistered={payment.store.vatRegistered}
            terminalNo={payment.store.terminalNo}
            storeName={payment.store.name}
            cashierName={pos.personName ?? payment.staff.find((s) => s.personId === personId)?.displayName ?? ''}
            personId={personId}
            online={pos.online}
            layout={printSettingsOf(payment.store).layout}
            copies={printSettingsOf(payment.store).copies}
            deps={{ reserveTerminalSeq, newId: newDeviceId, enqueue, requestDrain: pos.requestDrain, print: printLines }}
            sendEvent={async (event) => (await submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, event).then((r) => (r.ok ? null : r.message)))}
            newId={newDeviceId}
            onBack={() => setPaying(null)}
            onPaid={(done) => {
              setLastReceipt({ view: done.view, layout: done.layout, receiptNo: done.receiptNo });
              setReceipt({ view: done.view, layout: done.layout, receiptNo: done.receiptNo, lines: done.lines, notice: done.notice });
              setNotice(null);
              setPaying(null);
              setSelected(null);
            }}
          />
        ) : (
          <Banner tone="warning">This tablet has not loaded its price list yet. Connect it to the internet once, then try again.</Banner>
        )}
        {payment && draftBill ? null : (
          <button type="button" data-erp-size="free" className="min-h-12 inline-flex items-center rounded-full border border-surface-border bg-surface px-6 text-sm font-semibold hover:bg-canvas" onClick={() => setPaying(null)}>
            Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {receipt ? <ReceiptScreen lines={receipt.lines} receiptNo={receipt.receiptNo} notice={receipt.notice} onReprint={() => void reprintFromScreen()} onDone={() => setReceipt(null)} /> : null}
      {problem ? <Banner tone="error">{problem}</Banner> : null}
      <OutageBanner />
      {notice ? <Banner tone="warning">{notice}</Banner> : null}
      {access.canWrite && stands === null ? <p className="text-sm text-muted">Waiting for the open tables…</p> : null}
      {dialog ? <OrderDialog mode={dialog} menu={menu} stands={snapshot?.stands ?? []} tiles={view.tiles} onClose={() => setDialog(null)} onSend={send} at={menuAt} /> : null}
      <div hidden={dialog !== null}>
        <OrdersView
          readOnly={!access.canWrite}
          tiles={view.tiles}
          sessions={view.sessions}
          selectedSessionId={selected}
          nowMs={now}
          warnMinutes={snapshot?.tableWarnMinutes ?? null}
          onSeat={() => open({ kind: 'seat' })}
          onTakeOut={() => open({ kind: 'take_out' })}
          onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
          onHeads={(id, delta) => {
            const next = (view.sessions[id]?.headsCashier ?? 0) + delta;
            if (next >= HEADS_MIN && next <= HEADS_MAX) void build(() => setHeadsEvent({ personId, sessionId: id, heads: next, now: new Date() }));
          }}
          onAddItems={(id) => open({ kind: 'add', sessionId: id, label: labelOf(id), heads: view.sessions[id]?.headsCashier ?? 0, packageOpen: tileOf(id)?.packageName != null, takeOut: tileOf(id)?.mode === 'take_out' })}
          onPay={(id) => setPaying(id)}
          canReprint={lastReceipt !== null}
          onReprint={() => void reprint()}
          onCancelLine={(lineId) => {
            const line = Object.values(view.sessions).flatMap((s) => s.lines).find((l) => l.id === lineId);
            setCancelling({ lineId, name: line ? `${line.qty} × ${line.name}` : 'This line' });
          }}
        />
      </div>
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
