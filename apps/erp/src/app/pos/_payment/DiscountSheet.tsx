'use client';

/**
 * T-528 R2 - the discount sheet: tap a line, choose a preset, a custom amount (a percent or pesos per unit, on a keypad) or Senior / PWD for a numbered
 * diner, then how many units. Every rule is checked here with the server's own sentence (`checkDiscount`), so a discount that breaks one cannot be added.
 * "Apply to all" takes a preset only. Any cashier may do this with no PIN; each change is audited by the server (row 440). T-576: when the store's rule is on, a custom or preset discount asks for the manager PIN (online) or is flagged for review (offline).
 */
import { useState } from 'react';
import { Dialog } from '@/components/ui';
import { AmountPad } from './AmountPad';
import { appendAmountKey, checkDiscount, freeUnits, type BillLine, type DiscountAdd } from './logic';
import type { PresetLike } from './bill';
import { LineApprovalField } from '../_shell/LineApprovalField';
import type { LineApprovalMode } from '../_shell/line-approval';

// Plain literals: the touch-target census reads them.
const CHOICE = 'min-h-12 rounded-2xl border px-4 text-left text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const PRIMARY = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const chosen = 'border-ink bg-warning-soft text-ink';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';

type Choice = { type: 'preset'; presetId: string } | { type: 'custom' } | { type: 'senior' } | { type: 'pwd' };

export type SheetTarget = { kind: 'line'; line: BillLine } | { kind: 'all' };

export function DiscountSheet({ target, bill, heads, presets, approvalMode = 'none', onClose, onAdd, onApplyAll }: {
  target: SheetTarget;
  bill: readonly BillLine[];
  heads: number;
  presets: readonly PresetLike[];
  /** T-576: the store asks for a manager PIN on a custom or preset discount (and on every-line), or flags it for review when offline. Senior/PWD are never asked. */
  approvalMode?: LineApprovalMode;
  onClose: () => void;
  onAdd: (add: DiscountAdd & { presetId?: string }, pin: string) => Promise<string | null>;
  onApplyAll: (presetId: string, pin: string) => Promise<string | null>;
}) {
  const line = target.kind === 'line' ? target.line : null;
  const [choice, setChoice] = useState<Choice | null>(null);
  const [qty, setQty] = useState(1);
  const [dinerNo, setDinerNo] = useState(1);
  const [valueType, setValueType] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  const free = line ? freeUnits(line) : 0;
  const add: DiscountAdd | null =
    line && choice
      ? choice.type === 'custom'
        ? { lineId: line.lineId, kind: 'custom', qty, valueType, value }
        : choice.type === 'preset'
          ? { lineId: line.lineId, kind: 'preset', qty }
          : { lineId: line.lineId, kind: choice.type, qty, dinerNo }
      : null;
  // The sheet shows the refusal as soon as a choice breaks a rule; an unfinished custom amount is not a refusal yet.
  const refusal = add ? checkDiscount(bill, heads, add) : null;
  const waitingForValue = choice?.type === 'custom' && value === '';
  // A senior/PWD discount is the statutory rate, never a cashier's choice, so it never asks for a PIN.
  const mode: LineApprovalMode = choice?.type === 'senior' || choice?.type === 'pwd' ? 'none' : approvalMode;
  const needsPin = mode === 'pin' && pin === '';
  const ready = (target.kind === 'all' ? choice?.type === 'preset' : add !== null && refusal === null && !waitingForValue) && !needsPin;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const message =
      target.kind === 'all'
        ? choice?.type === 'preset'
          ? await onApplyAll(choice.presetId, mode === 'pin' ? pin : '')
          : 'Choose a discount.'
        : add
          ? await onAdd({ ...add, ...(choice?.type === 'preset' ? { presetId: choice.presetId } : {}) }, mode === 'pin' ? pin : '')
          : 'Choose a discount.';
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  const title = target.kind === 'all' ? 'Discount every line' : `Discount · ${target.line.name}`;
  const statutory = choice?.type === 'senior' || choice?.type === 'pwd';
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={target.kind === 'all' ? 'One preset on every line, on the units that have no discount yet.' : `${free} ${free === 1 ? 'unit is' : 'units are'} free of discount.`}
      size="md"
      footer={
        <div className="space-y-2">
          {refusal ? <p role="alert" className="text-sm font-semibold text-danger">{refusal}</p> : null}
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
          <button type="button" data-erp-size="free" className={PRIMARY} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={confirm}>
            {busy ? 'Saving…' : target.kind === 'all' ? 'Apply to all lines' : 'Add discount'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <section aria-label="Discount" className="space-y-2">
          <h3 className="text-sm font-semibold text-muted">Discount</h3>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((p) => (
              <button key={p.id} type="button" data-erp-size="free" aria-pressed={choice?.type === 'preset' && choice.presetId === p.id} className={`${CHOICE} ${choice?.type === 'preset' && choice.presetId === p.id ? chosen : idle}`} onClick={() => setChoice({ type: 'preset', presetId: p.id })}>
                {p.name}
              </button>
            ))}
            {target.kind === 'line' ? (
              <>
                <button type="button" data-erp-size="free" aria-pressed={choice?.type === 'custom'} className={`${CHOICE} ${choice?.type === 'custom' ? chosen : idle}`} onClick={() => setChoice({ type: 'custom' })}>
                  Custom amount
                </button>
                <button type="button" data-erp-size="free" aria-pressed={choice?.type === 'senior'} className={`${CHOICE} ${choice?.type === 'senior' ? chosen : idle}`} onClick={() => setChoice({ type: 'senior' })}>
                  Senior
                </button>
                <button type="button" data-erp-size="free" aria-pressed={choice?.type === 'pwd'} className={`${CHOICE} ${choice?.type === 'pwd' ? chosen : idle}`} onClick={() => setChoice({ type: 'pwd' })}>
                  PWD
                </button>
              </>
            ) : null}
          </div>
          {presets.length === 0 && target.kind === 'all' ? <p className="text-sm text-muted">This store has no discount presets yet. A manager adds them in the ERP.</p> : null}
        </section>

        {choice?.type === 'custom' ? (
          <section aria-label="Custom amount" className="space-y-3">
            <div className="flex gap-2" role="group" aria-label="Amount type">
              <button type="button" data-erp-size="free" aria-pressed={valueType === 'percent'} className={`${CHOICE} flex-1 text-center ${valueType === 'percent' ? chosen : idle}`} onClick={() => (setValueType('percent'), setValue(''))}>
                Percent off
              </button>
              <button type="button" data-erp-size="free" aria-pressed={valueType === 'fixed'} className={`${CHOICE} flex-1 text-center ${valueType === 'fixed' ? chosen : idle}`} onClick={() => (setValueType('fixed'), setValue(''))}>
                Pesos off each
              </button>
            </div>
            <p className="rounded-2xl border border-surface-border bg-canvas px-4 py-3 text-right font-display text-3xl font-bold tabular-nums" aria-label="Custom value">
              {valueType === 'fixed' ? '₱' : ''}
              {value === '' ? '0' : value}
              {valueType === 'percent' ? '%' : ''}
            </p>
            <AmountPad onKey={(k) => setValue((v) => appendAmountKey(v, k))} onBack={() => setValue((v) => v.slice(0, -1))} onClear={() => setValue('')} />
          </section>
        ) : null}

        {statutory ? (
          <section aria-label="Diner" className="space-y-2">
            <h3 className="text-sm font-semibold text-muted">Diner number</h3>
            <div className="flex flex-nowrap gap-2 overflow-x-auto snap-x snap-mandatory pb-2 [scrollbar-width:thin]">
              {Array.from({ length: Math.max(1, heads) }, (_, n) => n + 1).map((n) => (
                <button key={n} type="button" data-erp-size="free" aria-pressed={dinerNo === n} aria-label={`Diner ${n}`} className={`min-h-12 min-w-12 shrink-0 snap-start rounded-2xl border px-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${dinerNo === n ? 'border-ink bg-ink text-canvas' : idle}`} onClick={() => setDinerNo(n)}>
                  {n}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {choice ? <LineApprovalField mode={mode} pin={pin} onPin={setPin} /> : null}

        {line && choice ? (
          <div className="flex items-center gap-3" role="group" aria-label="Units">
            <span className="text-sm font-semibold text-muted">Units</span>
            <button type="button" data-erp-size="free" className={STEP} aria-label="Fewer units" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
              −
            </button>
            <span className="min-w-8 text-center text-xl font-semibold tabular-nums">{qty}</span>
            <button type="button" data-erp-size="free" className={STEP} aria-label="More units" disabled={qty >= free} onClick={() => setQty((q) => Math.min(Math.max(1, free), q + 1))}>
              +
            </button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
