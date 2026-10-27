'use client';

/**
 * The settle form for an owner's receivable. The "How" choice lives here, in the form, because only a write-off needs an
 * administrator's own PIN (T-412 Tier P, DEF-654), so the PIN box appears only then. A convenience: the SERVER decides which
 * branch ran and checks the PIN, and "the PIN is required for a write-off" is a cross-field rule that stays server-only (T-440 Q4).
 * T-440: the form is a CheckedForm, so the shapes (amount, date, 6-digit PIN when typed) are live checks.
 */
import { useState } from 'react';
import { CheckedForm } from '@/components/forms';
import { Button, Field, Input, Select } from '@/components/ui';
import { OWNERS_SETTLE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { settleAction } from '../actions';

export interface SettleAccount {
  readonly id: string;
  /** The account name and its balance, already formatted on the server. */
  readonly label: string;
}

export function SettleForm({
  ownerId,
  requestId,
  defaultAmount,
  today,
  accounts,
}: {
  ownerId: string;
  /** Minted per page render (T-488): the entry is keyed on it, so a double click replays ONE posting. */
  requestId: string;
  defaultAmount: string;
  today: string;
  accounts: readonly SettleAccount[];
}) {
  const [how, setHow] = useState('');
  return (
    <CheckedForm rules={OWNERS_SETTLE_RULES} action={settleAction} className="space-y-4">
      <input type="hidden" name="ownerId" value={ownerId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How" rule={OWNERS_SETTLE_RULES.how}>
          <Select {...nativeAttrs(OWNERS_SETTLE_RULES.how)} value={how} onChange={(e) => setHow(e.target.value)} className="w-full">
            <option value="" disabled>
              Choose…
            </option>
            <option value="cash">Cash back — the money returns to an account</option>
            <option value="pay">Recover from pay — becomes a salary advance</option>
            <option value="writeoff">Write off — it becomes a drawing</option>
          </Select>
        </Field>
        {how === 'writeoff' && (
          <Field
            label="Administrator PIN (write-off only)"
            hint="An administrator must approve a write-off with their own PIN."
            rule={OWNERS_SETTLE_RULES.adminPin}
          >
            <Input {...nativeAttrs(OWNERS_SETTLE_RULES.adminPin)} type="password" autoComplete="off" className="w-full" />
          </Field>
        )}
        <Field label="Amount" rule={OWNERS_SETTLE_RULES.amount}>
          <Input {...nativeAttrs(OWNERS_SETTLE_RULES.amount)} defaultValue={defaultAmount} className="w-full" />
        </Field>
        <Field label="Into (cash back only)">
          <Select name="intoMoneyAccountId" defaultValue="" className="w-full">
            <option value="">—</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Because (write-off only)" hint="A write-off with no reason is indistinguishable from nobody collecting.">
          <Input name="reason" className="w-full" />
        </Field>
        <Field label="On" rule={OWNERS_SETTLE_RULES.on}>
          <Input type="date" {...nativeAttrs(OWNERS_SETTLE_RULES.on)} defaultValue={today} className="w-full" />
        </Field>
      </div>
      <Button type="submit" variant="secondary">
        Settle
      </Button>
    </CheckedForm>
  );
}
