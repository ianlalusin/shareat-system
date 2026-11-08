'use client';

/**
 * T-528c - the receipt on the screen after Finish: the SAME lines that went to the printer (monospace, nothing re-computed), with Reprint and Done.
 * The sale is already saved when this shows; Done returns to Orders. A print that failed says so here and Reprint is the way out.
 */
import { useEffect, useRef } from 'react';
import { Dialog } from '@/components/ui';

// Plain literals: the touch-target census reads them.
const SECONDARY = 'min-h-12 min-w-12 flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const PRIMARY = 'min-h-16 flex-1 inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

export function ReceiptScreen({ lines, receiptNo, notice, onReprint, onDone }: { lines: readonly string[]; receiptNo: string; notice: string | null; onReprint: () => void; onDone: () => void }) {
  const done = useRef<HTMLButtonElement>(null);
  // The dialog opens on its first control, the small close X; the cashier's next move is Done. This runs after the Dialog's own open.
  useEffect(() => done.current?.focus(), []);
  return (
    <Dialog
      open
      onClose={onDone}
      title={`Paid · receipt ${receiptNo}`}
      description="The sale is saved. This is what the customer's paper says."
      size="receipt"
      footer={
        <div className="space-y-2">
          {notice ? <p role="alert" className="text-base font-semibold text-danger">{notice}</p> : null}
          <div className="flex gap-2">
            <button type="button" data-erp-size="free" className={SECONDARY} onClick={onReprint}>
              Reprint
            </button>
            <button ref={done} type="button" data-erp-size="free" className={PRIMARY} onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      }
    >
      <pre aria-label="Receipt" className="overflow-x-auto whitespace-pre pb-4 pr-3 font-mono text-xs leading-tight text-ink">
        {lines.join('\n')}
      </pre>
    </Dialog>
  );
}
