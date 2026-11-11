'use client';

/**
 * T-529 R2 - the Refills tab (refill.png). Left: the refill lines not yet served. Right: ask for a refill (pick the stand, step the meats, Send) and, on a
 * server's phone, confirm a table's head count. Refills carry no price. On the store TABLET a refill goes through the outbox (`refill.requested`), so it
 * works offline and prints one slip when it does; on a PHONE it is a Server Action and needs the internet. Every write is judged again by the domain.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@/components/ui';
import { enqueue } from '@/lib/pos-device';
import { actingPersonId, submitPosEvent } from '../_orders/payloads';
import { newDeviceId } from '../_orders/ids';
import { usePos } from '../_shell/pos-context';
import type { KitchenTicket } from '../_kitchen/cards';
import { OutageBanner } from '../_kitchen/outage-jobs';
import { useMenuMeta } from '../_kitchen/use-menu-meta';
import { useOutagePrint } from '../_kitchen/use-outage-print';
import { serveAllAction } from '../kitchen/actions';
import { confirmHeadsAction, requestRefillAction } from '../refills/actions';
import { refillAccess } from './access';
import { headsRows, stepHeads, type HeadsSource } from './heads';
import { refillEvent, refillRequestInput, stepQty } from './payloads';
import { buildRefillRows } from './queue';
import { RefillStandRow } from './RefillStandRow';
import { refillTables, type RefillTableSource } from './tables';

const CLOCK_MS = 15_000;
const NO_CONNECTION = 'That did not send. Check the internet and try again.';
// Plain literals: the touch-target census reads them.
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SEND = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const SERVED = 'min-h-12 min-w-12 shrink-0 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const CONFIRM = 'min-h-12 shrink-0 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-5 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';

export function Refills() {
  const pos = usePos();
  const meta = useMenuMeta(pos);
  const [selected, setSelected] = useState<string | null>(null);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [heads, setHeads] = useState<Record<string, number>>({});
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // The line ids of the cart being sent. A resend after "no connection" or a lost answer must carry the SAME ids, or the server writes the refill twice.
  const pendingIds = useRef<string[]>([]);
  const rawTables = (pos?.refillTables ?? null) as (RefillTableSource & HeadsSource)[] | null;
  const tables = useMemo(() => refillTables(rawTables ?? []), [rawTables]);
  const tickets = (pos?.refillQueue ?? null) as KitchenTicket[] | null;
  const labels = () => Object.fromEntries(tables.map((t) => [t.sessionId, String(t.standNumber)]));
  const printOutage = useOutagePrint(pos, labels);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  // A table that was paid or voided leaves the picker: forget a stand that is no longer there.
  useEffect(() => {
    if (selected !== null && !tables.some((t) => t.sessionId === selected)) setSelected(null);
  }, [tables, selected]);
  // A refill the server no longer lists is served for good: forget it, so the hidden set never grows over a shift.
  useEffect(() => {
    if (!tickets) return;
    const live = new Set(tickets.map((t) => t.lineId));
    setGone((g) => (g.size === 0 || [...g].every((id) => live.has(id)) ? g : new Set([...g].filter((id) => live.has(id)))));
  }, [tickets]);

  const rows = useMemo(() => buildRefillRows((tickets ?? []).filter((t) => !gone.has(t.lineId)), now), [tickets, gone, now]);
  if (!pos) return null;
  const storeId = pos.storeId;
  const access = refillAccess({ held: pos.held ?? new Set(), paired: pos.paired, online: pos.online });
  const table = tables.find((t) => t.sessionId === selected) ?? null;
  // Every package on the table offers its refills; a meat two packages share is listed once.
  const meats = table ? [...new Map((table.packageVariantIds ?? [table.packageVariantId]).flatMap((v) => meta?.refillCatalog[v] ?? []).map((m) => [m.itemId, m])).values()] : [];
  const picked = meats.reduce((n, m) => n + (qtys[m.itemId] ?? 0), 0);
  const personId = actingPersonId(pos.offlineActorPersonId ? { personId: pos.offlineActorPersonId } : null, pos.personId);

  const send = async () => {
    if (!table || !storeId) return;
    setBusy(true);
    setProblem(null);
    setSent(null);
    try {
      const cart = meats.map((m) => ({ itemId: m.itemId, qty: qtys[m.itemId] ?? 0 }));
      let n = 0;
      const newId = () => {
        const i = n++;
        return (pendingIds.current[i] ??= newDeviceId());
      };
      if (pos.paired) {
        const stored = await submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, refillEvent({ personId, sessionId: table.sessionId, cart, now: new Date(), newId }));
        if (!stored.ok) return setProblem(stored.message);
        void printOutage(stored.event);
      } else {
        const r = await requestRefillAction({ storeId, ...refillRequestInput({ sessionId: table.sessionId, cart, newId }) });
        if (!r.ok) return setProblem(r.error);
      }
      pendingIds.current = [];
      setQtys({});
      setSent(`Sent to the kitchen · ${table.label}`);
    } catch (e) {
      setProblem(e instanceof Error && e.message !== '' && !/fetch|network/i.test(e.message) ? e.message : NO_CONNECTION);
    } finally {
      setBusy(false);
    }
  };
  const serve = async (lineIds: string[]) => {
    if (!storeId) return;
    setProblem(null);
    setGone((g) => new Set([...g, ...lineIds]));
    const undo = (ids: string[]) => setGone((g) => new Set([...g].filter((id) => !ids.includes(id))));
    try {
      const r = await serveAllAction({ storeId, lineIds });
      if (r.failed.length > 0) {
        undo(r.failed.map((f) => f.lineId));
        setProblem(r.failed[0]!.error);
      }
    } catch {
      undo(lineIds);
      setProblem(NO_CONNECTION);
    }
  };
  const confirm = async (sessionId: string, count: number) => {
    if (!storeId) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await confirmHeadsAction({ storeId, sessionId, headsServer: count });
      if (!r.ok) setProblem(r.error);
      else setHeads(({ [sessionId]: _done, ...rest }) => rest);
    } catch {
      setProblem(NO_CONNECTION);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {problem ? <Banner tone="error">{problem}</Banner> : null}
      {access.note ? <Banner tone="info">{access.note}</Banner> : null}
      <OutageBanner />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <section aria-labelledby="refill-queue" className="order-2 min-w-0 flex-1 space-y-3 lg:order-1">
          <div>
            <h1 id="refill-queue" className="font-display text-3xl font-bold">
              Refills
            </h1>
            <p className="text-sm text-muted">Servers ask here; the grill sees them at once. Refills carry no price.</p>
          </div>
          {tickets === null ? (
            <p className="text-sm text-muted">Waiting for the refills…</p>
          ) : rows.length === 0 ? (
            <p className="rounded-2xl border border-surface-border bg-surface px-4 py-6 text-base text-muted">No refills waiting.</p>
          ) : (
            <ul className="divide-y divide-surface-border overflow-hidden rounded-2xl border border-surface-border bg-surface">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-3 px-4 py-2">
                  <span className="w-14 shrink-0 text-lg font-bold">{r.standLabel.replace('Stand ', '')}</span>
                  <div className="min-w-0 flex-1 py-1">
                    <p className="text-base">{r.itemsText}</p>
                    <p className="text-sm text-muted">
                      {r.askedLabel} ago{r.askedBy ? ` · ${r.askedBy}` : ''}
                    </p>
                  </div>
                  {access.canServe ? (
                    <button type="button" data-erp-size="free" className={SERVED} aria-label={`Served: ${r.standLabel}, ${r.itemsText}`} onClick={() => void serve(r.lineIds)}>
                      Served
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-label="Ask for a refill" className="order-1 w-full space-y-5 rounded-2xl border border-surface-border bg-surface p-4 lg:order-2 lg:w-96 lg:shrink-0">
          {access.canAsk ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Ask for a refill</h2>
                <p className="text-sm text-muted">Pick the stand, then the meats</p>
              </div>
              {rawTables === null ? (
                <p className="text-sm text-muted">Waiting for the open tables…</p>
              ) : tables.length === 0 ? (
                <p className="text-sm text-muted">No table with a package is open.</p>
              ) : (
                <RefillStandRow tables={tables} selectedSessionId={selected} onSelect={(id) => (setSelected(id), pendingIds.current = [], setQtys({}), setSent(null))} />
              )}
              {table ? (
                <ul className="space-y-1" aria-label={`Meats for ${table.label}`}>
                  {meats.map((m) => (
                    <li key={m.itemId} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 text-base">{m.name}</span>
                      <span className="flex items-center gap-3" role="group" aria-label={m.name}>
                        <button type="button" data-erp-size="free" className={STEP} aria-label={`Fewer ${m.name}`} disabled={(qtys[m.itemId] ?? 0) === 0} onClick={() => (pendingIds.current = [], setQtys((q) => ({ ...q, [m.itemId]: stepQty(q[m.itemId] ?? 0, -1) })))}>
                          −
                        </button>
                        <span className="min-w-8 text-center text-xl font-semibold tabular-nums">{qtys[m.itemId] ?? 0}</span>
                        <button type="button" data-erp-size="free" className={STEP} aria-label={`More ${m.name}`} onClick={() => (pendingIds.current = [], setQtys((q) => ({ ...q, [m.itemId]: stepQty(q[m.itemId] ?? 0, 1) })))}>
                          +
                        </button>
                      </span>
                    </li>
                  ))}
                  {meats.length === 0 ? <li className="text-sm text-muted">This package lists no refills.</li> : null}
                </ul>
              ) : null}
              {sent ? <p role="status" className="text-sm font-semibold text-success">{sent}</p> : null}
              <button type="button" data-erp-size="free" className={SEND} disabled={!table || picked === 0 || busy} onClick={() => void send()}>
                {table ? `Send refill · ${table.label}` : 'Pick a stand'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-muted">{access.note ? 'Asking for a refill is paused until the internet is back.' : 'Your sign-in cannot ask for refills.'}</p>
          )}

          {access.canConfirmHeads && rawTables !== null ? (
            <section aria-label="Heads" className="space-y-3 border-t border-surface-border pt-4">
              <h2 className="text-lg font-semibold">Heads</h2>
              {headsRows(rawTables).length === 0 ? <p className="text-sm text-muted">No table with a package is open.</p> : null}
              <ul className="space-y-2">
                {headsRows(rawTables).map((h) => {
                  const count = heads[h.sessionId] ?? h.current;
                  return (
                    <li key={h.sessionId} className="flex flex-wrap items-center gap-2">
                      <span className="w-20 shrink-0 text-base font-semibold">{h.label}</span>
                      <button type="button" data-erp-size="free" className={STEP} aria-label={`Fewer heads, ${h.label}`} onClick={() => setHeads((c) => ({ ...c, [h.sessionId]: stepHeads(count, -1) }))}>
                        −
                      </button>
                      <span className="min-w-8 text-center text-xl font-semibold tabular-nums">{count}</span>
                      <button type="button" data-erp-size="free" className={STEP} aria-label={`More heads, ${h.label}`} onClick={() => setHeads((c) => ({ ...c, [h.sessionId]: stepHeads(count, 1) }))}>
                        +
                      </button>
                      <button type="button" data-erp-size="free" className={CONFIRM} disabled={busy || (h.confirmed && count === h.current)} onClick={() => void confirm(h.sessionId, count)}>
                        {h.confirmed && count === h.current ? 'Confirmed' : 'Confirm'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
