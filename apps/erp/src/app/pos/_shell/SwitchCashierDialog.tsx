'use client';

/**
 * T-526 R5 - Switch cashier while OFFLINE: a 3-digit Employee ID and a 6-digit PIN on a tap keypad, checked on the tablet by
 * `attemptOfflineSwitch`. (Online, the shell signs out through the existing `signOutAction` instead, so this never runs.)
 * The wrong-PIN and pause sentences come from the check itself; nothing here decides who may sign in.
 */
import { useState } from 'react';
import { getMeta, setMeta } from '@/lib/pos-device';
import { Banner, Button, Dialog } from '@/components/ui';
import { Keypad } from './Keypad';
import { POS_SIGN_IN_BUTTON } from './touch';
import { attemptOfflineSwitch } from './offline-switch';
import type { OfflineActor } from './use-device-sync';

const ID_DIGITS = 3;
const PIN_DIGITS = 6;
const FIELD = 'min-h-12 flex w-full items-center justify-center rounded-2xl border bg-field px-4 text-2xl font-semibold tabular-nums tracking-widest';

const meta = { get: (k: string) => getMeta(k), set: (k: string, v: unknown) => setMeta(k, v) };

export function SwitchCashierDialog({ open, onClose, onSwitched }: { open: boolean; onClose: () => void; onSwitched: (actor: OfflineActor) => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [pin, setPin] = useState('');
  const [field, setField] = useState<'id' | 'pin'>('id');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setEmployeeId('');
    setPin('');
    setField('id');
    setMessage(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const onDigit = (d: string) => {
    setMessage(null);
    if (field === 'id') {
      const next = (employeeId + d).slice(0, ID_DIGITS);
      setEmployeeId(next);
      if (next.length === ID_DIGITS) setField('pin');
    } else {
      setPin((p) => (p + d).slice(0, PIN_DIGITS));
    }
  };
  const onBack = () => (field === 'id' ? setEmployeeId((v) => v.slice(0, -1)) : pin ? setPin((v) => v.slice(0, -1)) : setField('id'));
  const onClear = () => (field === 'id' ? setEmployeeId('') : setPin(''));

  const submit = async () => {
    setBusy(true);
    try {
      const result = await attemptOfflineSwitch({ employeeId, pin, nowMs: Date.now(), meta, storage: window.sessionStorage });
      if (result.ok) {
        onSwitched({ personId: result.personId, displayName: result.displayName, posCapabilities: result.posCapabilities });
        close();
      } else {
        setMessage(result.message);
        setPin('');
        setField(result.reason === 'wrong' ? 'pin' : 'id');
      }
    } finally {
      setBusy(false);
    }
  };

  const ready = employeeId.length === ID_DIGITS && pin.length === PIN_DIGITS;
  return (
    <Dialog open={open} onClose={close} title="Switch cashier" description="No internet. Enter your Employee ID and PIN." size="sm">
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-3">
          <button type="button" className={`${FIELD} ${field === 'id' ? 'border-ink' : 'border-field-border'}`} onClick={() => setField('id')} aria-label="Employee ID" aria-pressed={field === 'id'}>
            {employeeId || <span className="text-muted">ID</span>}
          </button>
          <button type="button" className={`${FIELD} ${field === 'pin' ? 'border-ink' : 'border-field-border'}`} onClick={() => setField('pin')} aria-label="PIN" aria-pressed={field === 'pin'}>
            {pin ? '•'.repeat(pin.length) : <span className="text-muted">PIN</span>}
          </button>
        </div>
        {message ? <Banner tone="error">{message}</Banner> : null}
        <Keypad onDigit={onDigit} onBack={onBack} onClear={onClear} disabled={busy} />
        <Button variant="primary" className={POS_SIGN_IN_BUTTON} data-erp-size="free" icon={null} disabled={!ready || busy} onClick={submit}>
          Sign in
        </Button>
        {ready ? null : <p className="text-center text-sm text-muted">Enter your Employee ID and PIN first.</p>}
      </div>
    </Dialog>
  );
}
