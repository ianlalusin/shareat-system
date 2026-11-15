'use client';
/**
 * ConfirmDestructive - the one danger button for destructive actions (T-412).
 * docs/tasks/412-confirm-destructive-tiers.md "UI".
 *
 * Rendered INSIDE the existing `<form action={...}>`, replacing its danger `<Button>`. The first button only reveals a panel
 * (no browser dialog); the panel says what will happen and asks for the confirmation, then the real submit button sends the
 * form. Two tiers:
 *   'retype'    - the person types the record's name (field `confirmName`); the submit is disabled until it matches, which is a
 *                 convenience only: the SERVER compares with the name it loads from the database.
 *   'admin-pin' - an administrator types THEIR OWN 6-digit PIN (field `adminPin`); the SERVER re-verifies it.
 *   'confirm'   - T-589 B3d: a plain extra click for an action that is reversible or only posts (retire, withdraw an unposted
 *                 day, run depreciation). No field is typed and the server asks for nothing more than it did before: the panel
 *                 says what will happen, then Confirm sends the form. The server rule is unchanged.
 * The browser never decides anything: no flag leaves this component except the typed text.
 */
import { useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { retypeMatches } from '@/lib/retype';

export interface ConfirmDestructiveProps {
  readonly tier: 'retype' | 'admin-pin' | 'confirm';
  /** The real submit button's words, e.g. "Void expense". */
  readonly label: string;
  /** What will happen, in plain words. */
  readonly consequence: string;
  /** Required for 'retype': the record's name, shown in the prompt (the server loads its own copy to compare). */
  readonly expectedName?: string;
  /** The first button is a plain secondary button, not a red one. Only that trigger: the confirm step keeps its danger look. */
  readonly quiet?: boolean;
  /** The first button is still the red danger button, but shows its words instead of the label's icon (a lone red icon says nothing). */
  readonly showLabel?: boolean;
}

export function ConfirmDestructive({ tier, label, consequence, expectedName, quiet, showLabel }: ConfirmDestructiveProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pin, setPin] = useState('');

  if (!open) {
    return quiet ? (
      <Button type="button" variant="secondary" icon={null} onClick={() => setOpen(true)}>
        {label}
      </Button>
    ) : (
      <Button type="button" variant="danger" {...(showLabel ? { icon: null } : {})} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  const ready = tier === 'confirm' ? true : tier === 'retype' ? retypeMatches(typed, expectedName ?? '') : /^\d{6}$/.test(pin);
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-3 rounded-[20px] border border-danger p-3">
      <p className="text-sm text-ink">{consequence}</p>
      {tier === 'confirm' ? null : tier === 'retype' ? (
        <label className="flex flex-col gap-1 text-sm text-ink">
          <span>
            Type <strong>{expectedName}</strong> to confirm
          </span>
          <Input name="confirmName" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-sm text-ink">
          <span>Administrator PIN</span>
          <Input
            name="adminPin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={tier === 'confirm' && quiet ? 'primary' : 'danger'} disabled={!ready}>
          {label}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
