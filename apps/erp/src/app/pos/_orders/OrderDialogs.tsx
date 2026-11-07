'use client';

/**
 * T-527 R3, R5 - the three dialogs of the Orders tab: seat a party (new-order.png), take-out, add items to a table, and cancel a line.
 * Each one only collects choices; the container turns them into ONE outbox event and closes the dialog when the save worked. Tap, never type (row 371):
 * the one typed field is the optional note, or the optional take-out name, or the reason when the cashier picks "Other".
 */
import { useState } from 'react';
import { Dialog } from '@/components/ui';
import { MenuPicker } from './MenuPicker';
import type { MenuLike } from './menu-filter';
import { CANCEL_REASONS, CANCEL_REASON_MAX, CANCEL_REASON_MIN, HEADS_MAX, HEADS_MIN, TAKE_OUT_NAME_MAX, type CartLine } from './payloads';
import { seatStandChoices, type Tile } from './project';

/** UI starting value for the seat dialog's heads stepper (from the design); not a business setting. */
const START_HEADS = 2;

// Plain literals: the touch-target census reads them.
const STAND = 'min-h-12 min-w-12 rounded-2xl border px-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SEND = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const REASON = 'min-h-12 w-full rounded-2xl border px-4 text-left text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const chosen = 'border-ink bg-warning-soft text-ink';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';

export type OrderDialogMode = { kind: 'seat' } | { kind: 'take_out' } | { kind: 'add'; sessionId: string; label: string; heads: number; packageOpen: boolean; takeOut: boolean };
export interface OrderSend {
  standId: string | null;
  heads: number;
  cart: CartLine[];
  name: string;
}

export function OrderDialog({ mode, menu, stands, tiles, onClose, onSend }: { mode: OrderDialogMode; menu: MenuLike | null; stands: { id: string; number: number }[]; tiles: Tile[]; onClose: () => void; onSend: (o: OrderSend) => Promise<string | null> }) {
  const [standId, setStandId] = useState<string | null>(null);
  const [heads, setHeads] = useState(START_HEADS);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seat = mode.kind === 'seat';
  const ready = mode.kind === 'seat' ? standId !== null : cart.length > 0;
  const title = seat ? 'Seat a party' : mode.kind === 'take_out' ? 'Take-out' : `Add items · ${mode.label}`;
  const send = async () => {
    setBusy(true);
    setError(null);
    const message = await onSend({ standId, heads: mode.kind === 'add' ? mode.heads : mode.kind === 'take_out' ? 0 : heads, cart, name });
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };
  const sendLabel = seat ? 'Start order · send to kitchen' : mode.kind === 'take_out' ? 'Send take-out order' : 'Send to kitchen';
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="xl"
      footer={
        <div className="space-y-2">
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
          <button type="button" data-erp-size="free" className={SEND} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={send}>
            {busy ? 'Saving…' : sendLabel}
          </button>
          {!ready ? <p className="text-center text-xs text-muted">{seat ? 'Pick a stand first.' : 'Pick at least one item first.'}</p> : null}
        </div>
      }
    >
      <div className="space-y-5">
        {seat ? (
          <section aria-label="Stand" className="space-y-3">
            <h3 className="text-sm font-semibold text-muted">Stand</h3>
            <div className="flex flex-wrap gap-2">
              {seatStandChoices(stands, tiles).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  data-erp-size="free"
                  disabled={s.inUse}
                  aria-disabled={s.inUse}
                  aria-pressed={s.id === standId}
                  aria-label={s.inUse ? `Stand ${s.number}, in use` : `Stand ${s.number}`}
                  className={`${STAND} ${s.inUse ? 'border-dashed border-surface-border bg-canvas text-muted' : s.id === standId ? 'border-ink bg-ink text-canvas' : idle}`}
                  onClick={() => setStandId(s.id)}
                >
                  {s.number}
                </button>
              ))}
            </div>
            {stands.length === 0 ? <p className="text-sm text-muted">This store has no stands yet. A manager adds them in the ERP.</p> : null}
            <div className="flex items-center gap-3" role="group" aria-label="Heads">
              <span className="text-sm font-semibold text-muted">Heads</span>
              <button type="button" data-erp-size="free" className={STEP} aria-label="Fewer heads" disabled={heads <= HEADS_MIN} onClick={() => setHeads((h) => Math.max(HEADS_MIN, h - 1))}>
                −
              </button>
              <span className="min-w-8 text-center text-xl font-semibold tabular-nums">{heads}</span>
              <button type="button" data-erp-size="free" className={STEP} aria-label="More heads" disabled={heads >= HEADS_MAX} onClick={() => setHeads((h) => Math.min(HEADS_MAX, h + 1))}>
                +
              </button>
            </div>
          </section>
        ) : null}
        {mode.kind === 'take_out' ? (
          <label className="block space-y-1 text-sm font-semibold text-muted">
            Name (optional)
            <input type="text" data-erp-size="free" className={FIELD} maxLength={TAKE_OUT_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        ) : null}
        {menu ? (
          <MenuPicker menu={menu} packageOpen={mode.kind === 'add' ? mode.packageOpen : false} hidePackages={mode.kind === 'take_out' || (mode.kind === 'add' && mode.takeOut)} heads={mode.kind === 'add' ? mode.heads : mode.kind === 'take_out' ? null : heads} cart={cart} onChange={setCart} />
        ) : (
          <p className="text-sm text-muted">The menu is not on this tablet yet. It loads once the tablet has been online.</p>
        )}
      </div>
    </Dialog>
  );
}

export function CancelLineDialog({ lineName, onClose, onConfirm }: { lineName: string; onClose: () => void; onConfirm: (reason: string) => Promise<string | null> }) {
  const [pick, setPick] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = other.trim();
  const reason = pick === 'Other' ? typed : pick;
  const ready = reason !== null && reason.length >= CANCEL_REASON_MIN;
  const confirm = async () => {
    if (!reason) return;
    setBusy(true);
    const message = await onConfirm(reason);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Cancel this line?"
      description={lineName}
      size="sm"
      footer={
        <div className="space-y-2">
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
          <button type="button" data-erp-size="free" className={SEND} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={confirm}>
            Cancel this line
          </button>
        </div>
      }
    >
      <div className="space-y-2" role="group" aria-label="Reason">
        {CANCEL_REASONS.map((r) => (
          <button key={r} type="button" data-erp-size="free" aria-pressed={pick === r} className={`${REASON} ${pick === r ? chosen : idle}`} onClick={() => setPick(r)}>
            {r}
          </button>
        ))}
        {pick === 'Other' ? (
          <label className="block space-y-1 text-sm font-semibold text-muted">
            Reason
            <input type="text" data-erp-size="free" className={FIELD} maxLength={CANCEL_REASON_MAX} value={other} onChange={(e) => setOther(e.target.value)} />
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}
