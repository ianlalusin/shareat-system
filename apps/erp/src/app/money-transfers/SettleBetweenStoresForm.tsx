'use client';

/**
 * T-369 S9 (DEF-557) — the "Settle between stores" form. Choosing a pair fills the From (the debtor's office accounts),
 * the To (the creditor's) and the amount (the full balance, less if you like - partial settlement is allowed). The
 * labels arrive finished from `page.tsx` (a plain function cannot cross the server/client boundary as a prop).
 * `settlementId` is generated when the page renders, so a double click is a replay, not a second settlement.
 */
import { useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { TRANSFER_SETTLE_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { settleBetweenStoresAction } from './actions';

export interface SettlePairOption {
  /** "Lipa owes Malvar ₱650.00" - in words. */
  label: string;
  /** The balance as a plain 2dp string, to pre-fill the amount. */
  owed: string;
  from: { id: string; label: string }[];
  to: { id: string; label: string }[];
}

function Field({ label, hint, rule, className, children }: { label: React.ReactNode; hint?: string; rule?: FieldRule; className?: string; children: React.ReactNode }) {
  const body = (
    <>      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    
    </>
  );
  // T-440: a ruled field keeps its label and puts the live helper line OUTSIDE it (never part of the accessible name).
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div className={className}>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

export function SettleBetweenStoresForm({
  pairs,
  settlementId,
  today,
}: {
  pairs: readonly SettlePairOption[];
  settlementId: string;
  today: string;
}) {
  const [index, setIndex] = useState(0);
  const pair = pairs[index] ?? pairs[0];
  if (!pair) return null;

  return (
    <CheckedForm rules={TRANSFER_SETTLE_RULES} action={settleBetweenStoresAction} className="space-y-4">
      <input type="hidden" name="settlementId" value={settlementId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who owes whom">
          <Select
            className="w-full"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            aria-label="Who owes whom"
          >
            {pairs.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <div />

        {/* Re-keyed on the pair so the amount and the account lists reset when another pair is chosen. */}
        <Field label="From — the paying store's account" hint="An office account of the store that owes" rule={TRANSFER_SETTLE_RULES.fromMoneyAccountId}>
          <Select key={`from-${index}`} {...nativeAttrs(TRANSFER_SETTLE_RULES.fromMoneyAccountId)} className="w-full" defaultValue={pair.from[0]?.id}>
            {pair.from.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To — the receiving store's account" hint="An office account of the store that is owed" rule={TRANSFER_SETTLE_RULES.toMoneyAccountId}>
          <Select key={`to-${index}`} {...nativeAttrs(TRANSFER_SETTLE_RULES.toMoneyAccountId)} className="w-full" defaultValue={pair.to[0]?.id}>
            {pair.to.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Amount that left" hint="Up to what is owed — a smaller amount settles part of it" rule={TRANSFER_SETTLE_RULES.amountOut}>
          <Input
            key={`out-${index}`}
            {...nativeAttrs(TRANSFER_SETTLE_RULES.amountOut)}
            defaultValue={pair.owed}
            className="w-full"
          />
        </Field>
        <Field label="Amount that arrived" hint="Leave blank unless a bank fee was deducted" rule={TRANSFER_SETTLE_RULES.amountIn}>
          <Input {...nativeAttrs(TRANSFER_SETTLE_RULES.amountIn)} placeholder="Same as above" className="w-full" />
        </Field>

        <Field label="Date" rule={TRANSFER_SETTLE_RULES.transferDate}>
          <Input {...nativeAttrs(TRANSFER_SETTLE_RULES.transferDate)} type="date" defaultValue={today} className="w-full" />
        </Field>
        <Field label="Reference" hint="The bank or wallet reference, if there is one" rule={TRANSFER_SETTLE_RULES.reference}>
          <Input {...nativeAttrs(TRANSFER_SETTLE_RULES.reference)} className="w-full" />
        </Field>
      </div>

      <Field label="Notes">
        <Input name="notes" className="w-full" />
      </Field>

      <Button type="submit" variant="secondary">
        Settle
      </Button>
    </CheckedForm>
  );
}
