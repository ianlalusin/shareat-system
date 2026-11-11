'use client';

/**
 * T-528 - the amount keypad (row 371: amounts are tapped). Digits, a decimal point, Delete and Clear; it reports each tap and holds no state, and the
 * buffer rules live in `appendAmountKey`. Seven columns so the whole pad is TWO rows tall (the Payment screen has to fit 1280x800 with a readable bill and
 * several payment rows): 1 2 3 4 5 6 and Delete on the first row, 7 8 9 0 . and a double-wide Clear on the second. Every key is 3rem or taller through
 * `min-h-12 min-w-12` and opts out of the dialog's compact-control rule.
 */
// Plain literals (the touch-target census reads them).
const KEY = 'min-h-12 min-w-12 h-12 rounded-2xl border border-field-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEY_DEL = 'min-h-12 min-w-12 h-12 col-start-7 row-start-1 rounded-2xl border border-field-border bg-surface text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEY_CLEAR = 'min-h-12 min-w-12 h-12 col-span-2 col-start-6 row-start-2 rounded-2xl border border-field-border bg-surface text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.'] as const;

export function AmountPad({ onKey, onBack, onClear, disabled, label = 'Amount keypad' }: { onKey: (key: string) => void; onBack: () => void; onClear: () => void; disabled?: boolean; label?: string }) {
  return (
    <div className="grid grid-cols-7 gap-2" role="group" aria-label={label}>
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
