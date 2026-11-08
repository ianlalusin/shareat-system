'use client';

/**
 * T-527 R2 + R5 - the Orders tab as it is drawn: the tile grid and the table panel (orders.png). Presentational: everything arrives as props from the
 * container (`Orders.tsx`) and every action leaves as a callback, so this renders the same on the server (the tests) and in the browser.
 * `readOnly` (a phone or a kitchen browser, row 447) draws the tiles and the panel with NO Seat, Take-out, Add, heads or cancel control.
 * Money is shown only as qty x unit price for the eye: the bill and its total are the Payment screen's (T-528). Tokens only; every control is 3rem or taller and opts out of the compact rule.
 */
import { Badge } from '@/components/ui';
import { peso } from '@/lib/format';
import { POS_TILE_WARN_AFTER_MINUTES } from '../_shell/constants';
import { offlineFor } from '../_shell/status-pill';
import { POS_READ_ONLY_NOTE } from './payloads';
import { tileClock, type ProjectedLine, type ProjectedSession, type Tile } from './project';

export interface OrdersViewProps {
  readOnly: boolean;
  tiles: Tile[];
  sessions: Record<string, ProjectedSession>;
  selectedSessionId: string | null;
  nowMs: number;
  onSeat: () => void;
  onTakeOut: () => void;
  onSelect: (sessionId: string) => void;
  onHeads: (sessionId: string, delta: 1 | -1) => void;
  onAddItems: (sessionId: string) => void;
  onCancelLine: (lineId: string) => void;
  /** T-528: opens the Payment screen for a table. Absent: the Pay button stays off. */
  onPay?: (sessionId: string) => void;
  /** T-528: prints the last receipt again (REPRINT). Absent or false: no button. */
  canReprint?: boolean;
  onReprint?: () => void;
}

// Plain literals: the touch-target census reads them. `min-h-12` is 3rem (POS_TOUCH), `min-h-16` is 4rem; both come from the spacing scale.
const SEAT = 'min-h-16 inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';
const TAKE_OUT = 'min-h-16 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-6 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const PAY = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const TILE = 'flex min-h-24 w-full flex-col gap-1 rounded-2xl border bg-surface p-4 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

const standLabel = (t: Tile): string => (t.standNumber !== null ? `Stand ${t.standNumber}` : 'Take-out');
const headsText = (t: Tile): string =>
  t.mode === 'take_out' ? 'Take-out' : `${t.headsCashier} heads${t.headsServer !== null && t.headsServer !== t.headsCashier ? ` (server counted ${t.headsServer})` : ''}`;

function TimeBar({ openedAtDevice, nowMs }: { openedAtDevice: string; nowMs: number }) {
  const clock = tileClock(openedAtDevice, nowMs);
  const pct = Math.min(100, Math.round((clock.minutes / POS_TILE_WARN_AFTER_MINUTES) * 100));
  return (
    <div className="mt-auto pt-2">
      <p className={`text-sm ${clock.warn ? 'font-semibold text-danger' : 'text-muted'}`}>
        Seated {clock.label}
        {clock.warn ? ` · over ${offlineFor(POS_TILE_WARN_AFTER_MINUTES * 60_000)}` : ''}
      </p>
      <div className="mt-1 h-2 w-full rounded-full bg-closed-soft" aria-hidden="true">
        <div className={`h-2 rounded-full ${clock.warn ? 'bg-brand' : 'bg-success'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TileCard({ tile, loaded, selected, nowMs, onSelect }: { tile: Tile; loaded: boolean; selected: boolean; nowMs: number; onSelect: () => void }) {
  return (
    <li>
      <button type="button" data-erp-size="free" aria-pressed={selected} className={`${TILE} ${selected ? 'border-ink bg-warning-soft' : 'border-surface-border'}`} onClick={onSelect}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-display text-2xl font-bold">{standLabel(tile)}</span>
          {tile.headsMismatch ? <Badge tone="warning" label={`Heads ${tile.headsCashier} vs ${tile.headsServer}`} /> : null}
          {tile.pending ? <Badge tone="info" label="Sending" /> : null}
          {tile.paid ? <Badge tone="success" label="Paid, sending" /> : null}
        </span>
        {/* One line, never wrapping, so the grid stays even; the full sentence is the accessible label (T-528 Addendum, P1). */}
        <span className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm text-muted">
          <span className="min-w-0 truncate">
            {headsText(tile)}
            {tile.packageName ? ` · ${tile.packageName}` : tile.mode === 'dine_in' && loaded ? ' · à la carte only' : ''}
          </span>
          {tile.needsHeads ? (
            <span role="note" className="shrink-0 truncate" aria-label="Heads not checked yet. The server confirms the count at the stand." title="Heads not checked yet. The server confirms the count at the stand.">
              Heads: not checked
            </span>
          ) : null}
        </span>
        <TimeBar openedAtDevice={tile.openedAtDevice} nowMs={nowMs} />
      </button>
    </li>
  );
}

function LineRow({ line, readOnly, onCancel }: { line: ProjectedLine; readOnly: boolean; onCancel: () => void }) {
  const cancellable = !readOnly && !line.cancelled && !line.extraHeads && line.kitchenStatus === 'queued';
  return (
    <li className="flex items-start justify-between gap-3 border-b border-surface-border py-3">
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${line.cancelled ? 'text-muted line-through' : ''}`}>
          {line.qty} × {line.name}
        </p>
        {line.optionNames.length > 0 ? <p className="text-xs text-muted">{line.optionNames.join(', ')}</p> : null}
        {line.note ? <p className="text-xs text-muted">Note: {line.note}</p> : null}
        <p className="mt-1 flex flex-wrap items-center gap-2">
          {line.cancelled ? (
            <Badge tone="closed" label="Cancelling…" />
          ) : line.kitchenStatus === 'served' ? (
            <Badge tone="success" label="Served" />
          ) : line.pending ? (
            <Badge tone="warning" label="Queued" />
          ) : null}
          {line.pending ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-info" />
              Sending
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        {line.unitPrice !== null ? (
          <p className={`text-sm tabular-nums ${line.cancelled ? 'text-muted line-through' : ''}`}>
            {line.qty} × {peso(line.unitPrice)}
          </p>
        ) : null}
        {cancellable ? (
          <button type="button" data-erp-size="free" className={SECONDARY} aria-label={`Cancel ${line.name}`} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}

interface PanelProps {
  tile: Tile;
  session: ProjectedSession | undefined;
  readOnly: boolean;
  nowMs: number;
  onHeads: (delta: 1 | -1) => void;
  onAddItems: () => void;
  onCancelLine: (lineId: string) => void;
  onPay?: () => void;
}

function Panel({ tile, session, readOnly, nowMs, onHeads, onAddItems, onCancelLine, onPay }: PanelProps) {
  const lines = session?.lines.filter((l) => !l.cancelled) ?? [];
  const canPay = onPay !== undefined && tile.paid !== true && session?.loaded === true && lines.length > 0;
  const clock = tileClock(tile.openedAtDevice, nowMs);
  return (
    <aside aria-label={`${standLabel(tile)} order`} className="flex flex-col rounded-2xl border border-surface-border bg-surface p-4 lg:w-96 lg:shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl font-bold">{standLabel(tile)}</h2>
        {tile.headsMismatch ? <Badge tone="warning" label={`Heads ${tile.headsCashier} vs ${tile.headsServer}`} /> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {headsText(tile)} · seated {clock.label}
          {tile.needsHeads ? ' · heads not checked' : ''}
        </p>
        {!readOnly && tile.mode === 'dine_in' ? (
          <div className="flex items-center gap-2" role="group" aria-label="Heads">
            <button type="button" data-erp-size="free" className={STEP} aria-label="Fewer heads" onClick={() => onHeads(-1)}>
              −
            </button>
            <span className="min-w-8 text-center text-lg font-semibold tabular-nums">{tile.headsCashier}</span>
            <button type="button" data-erp-size="free" className={STEP} aria-label="More heads" onClick={() => onHeads(1)}>
              +
            </button>
          </div>
        ) : null}
      </div>
      {session && !session.loaded ? <p className="mt-4 text-sm text-muted">Loading this table…</p> : null}
      {session && session.loaded && session.lines.length === 0 ? <p className="mt-4 text-sm text-muted">Nothing ordered yet.</p> : null}
      {session && session.lines.length > 0 ? (
        <ul className="mt-2">
          {session.lines.map((l) => (
            <LineRow key={l.id} line={l} readOnly={readOnly} onCancel={() => onCancelLine(l.id)} />
          ))}
        </ul>
      ) : null}
      {readOnly ? null : (
        <div className="mt-4 flex flex-col gap-3">
          <button type="button" data-erp-size="free" className={SECONDARY} onClick={onAddItems}>
            Add items
          </button>
          <button type="button" data-erp-size="free" className={PAY} disabled={!canPay} aria-disabled={!canPay} onClick={onPay}>
            {tile.paid ? 'Paid, sending' : 'Pay'}
          </button>
        </div>
      )}
    </aside>
  );
}

export function OrdersView(p: OrdersViewProps) {
  const selected = p.tiles.find((t) => t.sessionId === p.selectedSessionId) ?? null;
  const heads = p.tiles.reduce((n, t) => n + t.headsCashier, 0);
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <section aria-labelledby="pos-orders-title" className="min-w-0 flex-1">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="pos-orders-title" className="font-display text-3xl font-bold">
              Open orders
            </h1>
            <p className="text-sm text-muted">
              {p.tiles.length} open · {heads} heads
            </p>
          </div>
          {p.readOnly ? null : (
            <div className="flex flex-wrap gap-3">
              {p.canReprint && p.onReprint ? (
                <button type="button" data-erp-size="free" className={TAKE_OUT} onClick={p.onReprint}>
                  Reprint last receipt
                </button>
              ) : null}
              <button type="button" data-erp-size="free" className={TAKE_OUT} onClick={p.onTakeOut}>
                Take-out
              </button>
              <button type="button" data-erp-size="free" className={SEAT} onClick={p.onSeat}>
                Seat a party
              </button>
            </div>
          )}
        </div>
        {p.readOnly ? <p className="mt-3 rounded-2xl bg-info-soft px-4 py-3 text-sm font-semibold text-info">{POS_READ_ONLY_NOTE}</p> : null}
        {p.tiles.length === 0 ? (
          <p className="mt-6 text-sm text-muted">No open orders.</p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {p.tiles.map((t) => (
              <TileCard key={t.sessionId} tile={t} loaded={p.sessions[t.sessionId]?.loaded === true} selected={t.sessionId === p.selectedSessionId} nowMs={p.nowMs} onSelect={() => p.onSelect(t.sessionId)} />
            ))}
          </ul>
        )}
      </section>
      {selected ? (
        <Panel
          tile={selected}
          session={p.sessions[selected.sessionId]}
          readOnly={p.readOnly}
          nowMs={p.nowMs}
          onHeads={(d) => p.onHeads(selected.sessionId, d)}
          onAddItems={() => p.onAddItems(selected.sessionId)}
          onCancelLine={p.onCancelLine}
          {...(p.onPay ? { onPay: () => p.onPay!(selected.sessionId) } : {})}
        />
      ) : null}
    </div>
  );
}
