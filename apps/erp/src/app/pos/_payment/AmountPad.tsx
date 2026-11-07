'use client';

/**
 * T-528 - the amount keypad (row 371: amounts are tapped). Digits, a decimal point, Delete and Clear; it reports each tap and holds no state, and the
 * buffer rules live in `appendAmountKey`. Every key is 3rem or taller through `min-h-12 min-w-12` and opts out of the dialog's compact-control rule.
 */
// Plain literal (the touch-target census reads it).
const KEY = 'min-h-12 min-w-12 h-14 rounded-2xl border border-field-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0'] as const;

export function AmountPad({ onKey, onBack, onClear, disabled, label = 'Amount keypad' }: { onKey: (key: string) => void; onBack: () => void; onClear: () => void; disabled?: boolean; label?: string }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label={label}>
      {KEYS.map((k) => (
        <button key={k} type="button" className={KEY} data-erp-size="free" disabled={disabled} onClick={() => onKey(k)} aria-label={k === '.' ? 'Decimal point' : undefined}>
          {k}
        </button>
      ))}
      <button type="button" className={KEY} data-erp-size="free" disabled={disabled} onClick={onBack} aria-label="Delete last digit">
        Del
      </button>
      <button type="button" className={`${KEY} col-span-3`} data-erp-size="free" disabled={disabled} onClick={onClear} aria-label="Clear amount">
        Clear
      </button>
    </div>
  );
}
