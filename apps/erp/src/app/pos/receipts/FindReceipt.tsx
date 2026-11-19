/**
 * T-613 D4 - "Find a receipt": type the number printed on a receipt (for example LIP-01-000123, or just 01-000123) to refund a receipt from an earlier day, which has no row in the
 * list of receipts since the last close. A plain GET form: the page reads `?find=` and shows the one receipt with the same Refund button. The store (when the page was opened
 * for a requested store) is carried along. Plain class literals: the touch-target census reads them.
 */
const FIELD = 'min-h-12 w-full max-w-xs rounded-2xl border border-field-border bg-field px-4 font-mono text-base text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

export function FindReceipt({ value, storeId, days }: { value: string; storeId?: string; days: number }) {
  return (
    <form method="get" role="search" aria-label="Find a receipt" className="flex flex-wrap items-end gap-3">
      {storeId ? <input type="hidden" name="storeId" value={storeId} /> : null}
      <label className="space-y-1">
        <span className="block text-sm font-semibold">Find a receipt</span>
        <input type="text" name="find" defaultValue={value} maxLength={40} autoComplete="off" placeholder="Receipt number" className={FIELD} />
        <span className="block text-xs text-muted">Receipts from the last {days} days. Use it to refund an earlier day&apos;s receipt.</span>
      </label>
      <button type="submit" className={SECONDARY}>
        Find
      </button>
    </form>
  );
}
