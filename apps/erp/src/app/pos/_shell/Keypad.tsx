'use client';

/**
 * T-526 R5 - the tap keypad (bible row 371: nothing is typed on the tablet). Pure presentation: it reports each tap and holds no state.
 * Every key meets the POS touch size through `min-h-12 min-w-12` (3rem, a spacing token), never a raw pixel value, and opts out of the dialog's compact-control rule.
 */
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
// A plain literal (the touch-target census reads it); `min-h-12 min-w-12` is `POS_TOUCH` in ./touch.ts.
const KEY = 'min-h-12 min-w-12 h-16 rounded-2xl border border-field-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';

export function Keypad({ onDigit, onBack, onClear, disabled }: { onDigit: (d: string) => void; onBack: () => void; onClear: () => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Number keypad">
      {DIGITS.map((d) => (
        <button key={d} type="button" className={KEY} data-erp-size="free" disabled={disabled} onClick={() => onDigit(d)}>
          {d}
        </button>
      ))}
      <button type="button" className={KEY} data-erp-size="free" disabled={disabled} onClick={onClear} aria-label="Clear">
        Clear
      </button>
      <button type="button" className={KEY} data-erp-size="free" disabled={disabled} onClick={() => onDigit('0')}>
        0
      </button>
      <button type="button" className={KEY} data-erp-size="free" disabled={disabled} onClick={onBack} aria-label="Delete last digit">
        Del
      </button>
    </div>
  );
}
