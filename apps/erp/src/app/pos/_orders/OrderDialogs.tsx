'use client';

/**
 * T-527 R3, R5 - the three dialogs of the Orders tab: seat a party (new-order.png), take-out, add items to a table, and cancel a line.
 * Each one only collects choices; the container turns them into ONE outbox event and closes the dialog when the save worked. Tap, never type (row 371):
 * the one typed field is the optional note, or the optional take-out name, or the reason when the cashier picks "Other".
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Dialog } from '@/components/ui';
import { ItemsSoFar, ItemsSoFarTotal } from './ItemsSoFar';
import { MenuPicker } from './MenuPicker';
import type { MenuLike } from './menu-filter';
import { CANCEL_REASONS, CANCEL_REASON_MAX, CANCEL_REASON_MIN, HEADS_MAX, HEADS_MIN, TAKE_OUT_NAME_MAX, type CartLine } from './payloads';
import { seatStandChoices, type Tile } from './project';
import { LineApprovalField } from '../_shell/LineApprovalField';
import type { LineApprovalMode } from '../_shell/line-approval';

/** UI starting value for the seat dialog's heads stepper (from the design); not a business setting. */
const START_HEADS = 2;

// Plain literals: the touch-target census reads them.
const STAND = 'min-h-12 min-w-12 shrink-0 snap-start rounded-2xl border px-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SEND = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const CLOSE = 'min-h-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-6 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
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

/** `at` is the shell's menu clock (T-559): the picker and the items-so-far price at that instant and flip at each daypart boundary. */
export function OrderDialog({ mode, menu, stands, tiles, onClose, onSend, at }: { mode: OrderDialogMode; menu: MenuLike | null; stands: { id: string; number: number }[]; tiles: Tile[]; onClose: () => void; onSend: (o: OrderSend) => Promise<string | null>; at?: Date }) {
  const [standId, setStandId] = useState<string | null>(null);
  const [heads, setHeads] = useState(START_HEADS);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seat = mode.kind === 'seat';
  const heading = useRef<HTMLHeadingElement>(null);
  const standButtons = useRef(new Map<string, HTMLButtonElement>());
  // Addendum 2: the stand row slides sideways, so the chosen stand is brought into view whenever the choice changes (never on open: nothing is chosen yet).
  useEffect(() => {
    if (standId !== null) standButtons.current.get(standId)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [standId]);
  // Not a Dialog, so it keeps a Dialog's keyboard manners (T-527b): focus starts inside it, and Escape closes it like Cancel, but only when that loses
  // nothing: not while saving, and not with items picked (Cancel is the explicit way out). An open choice sheet takes Escape first (it calls preventDefault).
  const guard = useRef({ busy: false, items: 0, close: onClose });
  useEffect(() => {
    guard.current = { busy, items: cart.length, close: onClose };
  });
  useEffect(() => {
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || guard.current.busy || guard.current.items > 0) return;
      guard.current.close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
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
  const pickedStand = stands.find((s) => s.id === standId);
  const asideTitle = seat ? (pickedStand ? `Stand ${pickedStand.number} · new` : 'New order') : mode.kind === 'take_out' ? 'Take-out · new' : mode.label;
  // The arrow keys walk the row from the stand that has focus, skipping stands in use and stopping at both ends.
  const walkStands = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const choices = seatStandChoices(stands, tiles);
    const from = choices.findIndex((c) => standButtons.current.get(c.id) === e.target);
    const base = from >= 0 ? from : choices.findIndex((c) => c.id === standId);
    const step = e.key === 'ArrowRight' ? 1 : -1;
    for (let i = base + step; i >= 0 && i < choices.length; i += step) {
      if (choices[i]!.inUse) continue;
      e.preventDefault();
      setStandId(choices[i]!.id);
      standButtons.current.get(choices[i]!.id)?.focus();
      return;
    }
  };
  const pickerHeads = mode.kind === 'add' ? mode.heads : mode.kind === 'take_out' ? null : heads;
  // A panel under the shell's header, not a full-screen cover: the status pill and the tabs stay in view the whole time (T-527b).
  return (
    <section aria-label={title} className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-5 rounded-2xl border border-surface-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 ref={heading} tabIndex={-1} className="font-display text-3xl font-bold focus:outline-none">{title}</h2>
          <button type="button" data-erp-size="free" className={CLOSE} onClick={onClose}>
            Cancel
          </button>
        </div>
        {seat ? (
          <section aria-label="Stand" className="space-y-3">
            <h3 className="text-sm font-semibold text-muted">Stand</h3>
            <div className="flex flex-nowrap gap-2 overflow-x-auto snap-x snap-mandatory pb-2 [scrollbar-width:thin]" onKeyDown={walkStands}>
              {seatStandChoices(stands, tiles).map((s) => (
                <button
                  key={s.id}
                  ref={(el) => {
                    if (el) standButtons.current.set(s.id, el);
                    else standButtons.current.delete(s.id);
                  }}
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
            <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Heads">
              <span className="text-sm font-semibold text-muted">Heads</span>
              <button type="button" data-erp-size="free" className={STEP} aria-label="Fewer heads" disabled={heads <= HEADS_MIN} onClick={() => setHeads((h) => Math.max(HEADS_MIN, h - 1))}>
                −
              </button>
              <span className="min-w-8 text-center text-xl font-semibold tabular-nums">{heads}</span>
              <button type="button" data-erp-size="free" className={STEP} aria-label="More heads" disabled={heads >= HEADS_MAX} onClick={() => setHeads((h) => Math.min(HEADS_MAX, h + 1))}>
                +
              </button>
              <span className="text-xs text-muted">The server confirms the count at the stand; the higher number is billed.</span>
            </div>
          </section>
        ) : null}
        {mode.kind === 'take_out' ? (
          <label className="block space-y-2 text-sm font-semibold text-muted">
            <span className="block">Name (optional)</span>
            <input type="text" data-erp-size="free" className={FIELD} value={name} onChange={(e) => setName(e.target.value.slice(0, TAKE_OUT_NAME_MAX))} />
          </label>
        ) : null}
        {menu ? (
          <MenuPicker menu={menu} packageOpen={mode.kind === 'add' ? mode.packageOpen : false} hidePackages={mode.kind === 'take_out' || (mode.kind === 'add' && mode.takeOut)} heads={pickerHeads} cart={cart} onChange={setCart} at={at} />
        ) : (
          <p className="text-sm text-muted">The menu is not on this tablet yet. It loads once the tablet has been online.</p>
        )}
      </div>
      <aside aria-label="New order summary" className="flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-4 lg:w-96 lg:shrink-0">
        <h2 className="font-display text-2xl font-bold">{asideTitle}</h2>
        {menu ? <ItemsSoFar cart={cart} menu={menu} heads={pickerHeads} onChange={setCart} pinTotal at={at} /> : null}
        {/* Pinned: the running total and the Send button stay in view however long the list grows (T-528 Addendum, P1). */}
        <div className="sticky bottom-0 -mx-4 -mb-4 space-y-3 rounded-b-2xl bg-surface px-4 pb-4">
          {menu ? <ItemsSoFarTotal cart={cart} menu={menu} heads={pickerHeads} at={at} /> : null}
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
          <button type="button" data-erp-size="free" className={SEND} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={send}>
            {busy ? 'Saving…' : sendLabel}
          </button>
          {!ready ? <p className="text-center text-xs text-muted">{seat ? 'Pick a stand first.' : 'Pick at least one item first.'}</p> : null}
        </div>
      </aside>
    </section>
  );
}

/** T-576: `approvalMode` pin = the store asks for a manager PIN (it goes with the reason); review = offline, goes ahead with a "needs manager review" note. */
export function CancelLineDialog({ lineName, approvalMode = 'none', onClose, onConfirm }: { lineName: string; approvalMode?: LineApprovalMode; onClose: () => void; onConfirm: (reason: string, pin: string) => Promise<string | null> }) {
  const [pin, setPin] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = other.trim();
  const reason = pick === 'Other' ? typed : pick;
  const ready = reason !== null && reason.length >= CANCEL_REASON_MIN && !(approvalMode === 'pin' && pin === '');
  const confirm = async () => {
    if (!reason) return;
    setBusy(true);
    const message = await onConfirm(reason, approvalMode === 'pin' ? pin : '');
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
          <label className="block space-y-2 text-sm font-semibold text-muted">
            <span className="block">Reason</span>
            <input type="text" data-erp-size="free" className={FIELD} value={other} onChange={(e) => setOther(e.target.value.slice(0, CANCEL_REASON_MAX))} />
          </label>
        ) : null}
        <LineApprovalField mode={approvalMode} pin={pin} onPin={setPin} />
      </div>
    </Dialog>
  );
}
