'use client';

/**
 * The sign-in on a PAIRED POS tablet. T-464, docs/tasks/464-pos-tablet-sign-in.md s4.
 *
 * Employee ID (the NUMBER of the badge code, 1-3 digits) + PIN. Nothing else is asked: the store comes from the pairing the server
 * reads off the httpOnly cookie, so no org, store or label is ever sent by - or exposed to - this form (T-304 invariant 9).
 *
 * ⛔ T-304 invariant 7: the email form stays reachable. It sits behind a small "Manager sign-in" link, which is the way in for a
 * manager, an admin from head office (no code at this store), and anyone whose code is not `SE-` plus digits.
 *
 * The server refuses a malformed ID again; the digit filter here is a convenience, never the control.
 */
import { useState } from 'react';
import { signInWithTabletPinAction } from './actions';
import { EmailSignInForm } from './EmailSignInForm';
import { Button, Input } from '@/components/ui';

export function TabletSignInForm({ next, label }: { next: string; label: string }) {
  const [staffCode, setStaffCode] = useState('');
  const [pin, setPin] = useState('');
  const [manager, setManager] = useState(false);

  return (
    <div className="space-y-6">
      <form action={signInWithTabletPinAction} className="space-y-4 text-sm">
        <p className="text-sm font-medium">{label}</p>
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Employee ID</span>
          <Input
            name="staffCode"
            inputMode="numeric"
            autoComplete="off"
            required
            maxLength={3}
            pattern="[0-9]{1,3}"
            placeholder="007"
            value={staffCode}
            onChange={(e) => setStaffCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
            className="text-center text-2xl tracking-[0.3em] tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">PIN</span>
          <Input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            required
            maxLength={6}
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            // Touch-first: a cashier enters this on a tablet, so the target is large and the keypad is numeric.
            className="text-center text-2xl tracking-[0.5em] tabular-nums"
          />
        </label>
        <Button type="submit" variant="primary" className="w-full justify-center">
          Sign in
        </Button>
      </form>

      {manager ? (
        <EmailSignInForm next={next} />
      ) : (
        <p className="text-center text-xs">
          <Button type="button" variant="ghost" onClick={() => setManager(true)}>
            Manager sign-in
          </Button>
        </p>
      )}
    </div>
  );
}
