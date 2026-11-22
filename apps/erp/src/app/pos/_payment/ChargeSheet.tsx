'use client';

/**
 * T-627 - the charge sheet: choose one of the store's charges (Leftover, Extra griller; a per-unit one asks how many) or type a custom one (a name and a peso
 * amount, on a keypad). Any cashier may add one with no PIN; each change is audited by the server. The checks are the server's own sentences (`checkCharge`).
 * docs/tasks/627-pos-charges.md.
 */
import { useState } from 'react';
import { fromCentavos } from '@shareat/core/money';
import { nativeAttrs, POS_CHARGE_RULES } from '@shareat/domain/field-rules';
import { Dialog } from '@/components/ui';
import { peso } from '@/lib/format';
import { AmountPad } from './AmountPad';
import { amountCents, appendAmountKey, CHARGE_QTY_MAX, checkCharge } from './logic';
import type { ChargePresetLike } from './bill';

// Plain literals: the touch-target census reads them.
const CHOICE = 'min-h-12 rounded-2xl border px-4 py-2 text-left text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const PRIMARY = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
// The charge name's own rule (1 to 40), the same one the ERP screen and the server use.
const NAME_ATTRS = nativeAttrs(POS_CHARGE_RULES.name);
const chosen = 'border-ink bg-warning-soft text-ink';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';

type Choice = { type: 'preset'; presetId: string } | { type: 'custom' };

export interface ChargeAdd {
  presetId?: string;
  name?: string;
  unitAmount?: string;
  qty: number;
}

export function ChargeSheet({ presets, onClose, onAdd }: { presets: readonly ChargePresetLike[]; onClose: () => void; onAdd: (add: ChargeAdd) => Promise<string | null> }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [qty, setQty] = useState(1);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = choice?.type === 'preset' ? presets.find((p) => p.id === choice.presetId) : undefined;
  const waiting = choice === null || (choice.type === 'custom' && (name.trim() === '' || amount === ''));
  const refusal = choice === null || waiting ? null : choice.type === 'custom' ? checkCharge({ kind: 'custom', name, amount }) : checkCharge({ kind: 'preset', qty });
  const ready = !waiting && refusal === null;

  const confirm = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    const message = await onAdd(choice.type === 'preset' ? { presetId: choice.presetId, qty: preset?.perUnit ? qty : 1 } : { name: name.trim(), unitAmount: String(fromCentavos(amountCents(amount))), qty: 1 });
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };
  const pick = (c: Choice) => {
    setChoice(c);
    setQty(1);
    setError(null);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a charge"
      description="Charges are added after discounts and VAT. They are not discounted."
      size="md"
      footer={
        <div className="space-y-2">
          {refusal ? <p role="alert" className="text-sm font-semibold text-danger">{refusal}</p> : null}
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
          <button type="button" data-erp-size="free" className={PRIMARY} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={confirm}>
            {busy ? 'Saving…' : 'Add charge'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <section aria-label="Charge" className="space-y-2">
          <h3 className="text-sm font-semibold text-muted">Charge</h3>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((p) => {
              const on = choice?.type === 'preset' && choice.presetId === p.id;
              return (
                <button key={p.id} type="button" data-erp-size="free" aria-pressed={on} className={`${CHOICE} ${on ? chosen : idle}`} onClick={() => pick({ type: 'preset', presetId: p.id })}>
                  <span className="block truncate">{p.name}</span>
                  <span className="block text-sm font-normal tabular-nums text-muted">{p.perUnit ? `${peso(p.amount)} each` : peso(p.amount)}</span>
                </button>
              );
            })}
            <button type="button" data-erp-size="free" aria-pressed={choice?.type === 'custom'} className={`${CHOICE} ${choice?.type === 'custom' ? chosen : idle}`} onClick={() => pick({ type: 'custom' })}>
              Custom charge
            </button>
          </div>
          {presets.length === 0 ? <p className="text-sm text-muted">This store has no charges set up yet. A manager adds them in the ERP. You can still add a custom charge.</p> : null}
        </section>

        {choice?.type === 'custom' ? (
          <section aria-label="Custom charge" className="space-y-3">
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-muted">What is it for?</span>
              <input type="text" data-erp-size="free" className={FIELD} {...NAME_ATTRS} autoComplete="off" placeholder="Leftover" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="rounded-2xl border border-surface-border bg-canvas px-4 py-3 text-right font-display text-3xl font-bold tabular-nums" aria-label="Charge amount">
              ₱{amount === '' ? '0' : amount}
            </p>
            <AmountPad onKey={(k) => setAmount((v) => appendAmountKey(v, k))} onBack={() => setAmount((v) => v.slice(0, -1))} onClear={() => setAmount('')} />
          </section>
        ) : null}

        {preset?.perUnit ? (
          <div className="flex items-center gap-3" role="group" aria-label="Quantity">
            <span className="text-sm font-semibold text-muted">How many</span>
            <button type="button" data-erp-size="free" className={STEP} aria-label="Fewer" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
              −
            </button>
            <span className="min-w-8 text-center text-xl font-semibold tabular-nums">{qty}</span>
            <button type="button" data-erp-size="free" className={STEP} aria-label="More" disabled={qty >= CHARGE_QTY_MAX} onClick={() => setQty((q) => Math.min(CHARGE_QTY_MAX, q + 1))}>
              +
            </button>
            <span className="ml-auto text-base font-semibold tabular-nums">{peso(fromCentavos(amountCents(preset.amount) * BigInt(qty)))}</span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
