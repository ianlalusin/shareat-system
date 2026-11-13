'use client';

/**
 * T-576 - the manager-PIN box (or the small "needs manager review" note) that the discount sheet, the cancel dialog and the discount-removal prompt share.
 * Renders nothing when the rule is off.
 */
import { useState } from 'react';
import { Dialog } from '@/components/ui';
import { nativeAttrs, STAFF_PIN_RULES } from '@shareat/domain/field-rules';
import { PIN_LABEL, REVIEW_NOTE, type LineApprovalMode } from './line-approval';

const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const PIN_ATTRS = nativeAttrs(STAFF_PIN_RULES.pin);
const SEND = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';

export function LineApprovalField({ mode, pin, onPin }: { mode: LineApprovalMode; pin: string; onPin: (v: string) => void }) {
  if (mode === 'review') return <p className="text-sm text-muted">{REVIEW_NOTE}</p>;
  if (mode !== 'pin') return null;
  return (
    <label className="block space-y-2 text-sm font-semibold text-muted">
      <span className="block">{PIN_LABEL}</span>
      <input {...PIN_ATTRS} type="password" autoComplete="off" data-erp-size="free" className={FIELD} value={pin} onChange={(e) => onPin(e.target.value.slice(0, 12))} />
    </label>
  );
}

/** Asks for the manager PIN before one action that has no sheet of its own (removing a discount). */
export function ManagerPinDialog({ title, description, confirmLabel, onClose, onConfirm }: { title: string; description: string; confirmLabel: string; onClose: () => void; onConfirm: (pin: string) => Promise<string | null> }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    const message = await onConfirm(pin);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <div className="space-y-2">
          {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
          <button type="button" data-erp-size="free" className={SEND} disabled={pin === '' || busy} aria-disabled={pin === '' || busy} onClick={confirm}>
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      }
    >
      <LineApprovalField mode="pin" pin={pin} onPin={setPin} />
    </Dialog>
  );
}
