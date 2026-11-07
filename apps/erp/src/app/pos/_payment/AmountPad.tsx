'use client';

/**
 * T-528 - the amount keypad (row 371: amounts are tapped). Digits, a decimal point, Delete and Clear; it reports each tap and holds no state, and the
 * buffer rules live in `appendAmountKey`. Four columns so the whole pad is four rows tall (the Payment screen fits one screen at 1280x800): the digits
 * fill three columns, Delete and Clear stand two rows tall in the fourth, and the 0 is two columns wide. Every key is 3rem or taller through
 * `min-h-12 min-w-12` and opts out of the dialog's compact-control rule.
 */
// Plain literals (the touch-target census reads them).
const KEY = 'min-h-12 min-w-12 h-12 rounded-2xl border border-field-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEY_DEL = 'min-h-12 min-w-12 col-start-4 row-start-1 row-span-2 rounded-2xl border border-field-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEY_CLEAR = 'min-h-12 min-w-12 col-start-4 row-start-3 row-span-2 rounded-2xl border border-field-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0'] as const;

export function AmountPad({ onKey, onBack, onClear, disabled, label = 'Amount keypad' }: { onKey: (key: string) => void; onBack: () => void; onClear: () => void; disabled?: boolean; label?: string }) {
  return (
    <div className="grid grid-cols-4 gap-2 [&>[data-key='0']]:col-span-2" role="group" aria-label={label}>
      {KEYS.map((k) => (
        <button key={k} type="button" className={KEY} data-erp-size="free" data-key={k} disabled={disabled} onClick={() => onKey(k)} aria-label={k === '.' ? 'Decimal point' : undefined}>
          {k}
        </button>
      ))}
      <button type="button" className={KEY_DEL} data-erp-size="free" disabled={disabled} onClick={onBack} aria-label="Delete last digit">
        Del
      </button>
      <button type="button" className={KEY_CLEAR} data-erp-size="free" disabled={disabled} onClick={onClear} aria-label="Clear amount">
        Clear
      </button>
    </div>
  );
}
