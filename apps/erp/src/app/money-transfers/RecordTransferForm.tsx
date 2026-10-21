'use client';

/**
 * The "Record a transfer" form. From/To exclusivity is `TwoWayPicker`'s job — shared with the
 * stock-transfers screen rather than reimplemented here (see that component's header).
 *
 * ⚠️ Takes pre-built `options`, not `byStore` + a `peso` formatter — a plain function cannot
 * cross the server/client boundary as a prop (only a `'use server'` action can), so the label
 * formatting happens in `page.tsx`, server-side, before this component ever renders.
 */
import { TwoWayPicker, type PickerOption } from '../../components/two-way-picker';
import { Button, Input } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { TRANSFER_RECORD_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { createMoneyTransferAction } from './actions';

// The picker draws its own <select>, so it takes the kit's field tokens as a class string.
const PICKER_SELECT =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';

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

export function RecordTransferForm({
  options,
  today,
}: {
  options: readonly PickerOption[];
  today: string;
}) {

  return (
    <CheckedForm rules={TRANSFER_RECORD_RULES} action={createMoneyTransferAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TwoWayPicker
          options={options}
          fromName="fromMoneyAccountId"
          toName="toMoneyAccountId"
          fromLabel="From — money left here"
          toLabel="To — money landed here"
          blankPlaceholder="Choose an account…"
          labelClassName="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400"
          selectClassName={PICKER_SELECT}
        />

        {/*
          ⭐ TWO amounts, deliberately — see T-139 §3.

          v1 asks for one "amount" and adds the fee to the source; this project's own posting
          doc narrates the same legs the other way round. Both readings are real here (a bank
          wire adds its fee to the source; a cash-out deducts it from the target), so a single
          box would silently mean different things on different days. Both figures are
          observable — one on each statement — which is what makes a transfer checkable.
        */}
        <Field label="Amount that left" hint="What the source account was reduced by" rule={TRANSFER_RECORD_RULES.amountOut}>
          <input
            {...nativeAttrs(TRANSFER_RECORD_RULES.amountOut)}
            placeholder="0.00"
            className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink"
          />
        </Field>
        <Field label="Amount that arrived" hint="Leave blank if nothing was deducted — the usual case" rule={TRANSFER_RECORD_RULES.amountIn}>
          <Input
            {...nativeAttrs(TRANSFER_RECORD_RULES.amountIn)}
            placeholder="Same as above"
            className="w-full"
          />
        </Field>

        <Field label="Date" rule={TRANSFER_RECORD_RULES.transferDate}>
          <Input {...nativeAttrs(TRANSFER_RECORD_RULES.transferDate)} type="date" defaultValue={today} className="w-full" />
        </Field>
        <Field label="Reference" hint="The bank or wallet reference, if there is one" rule={TRANSFER_RECORD_RULES.reference}>
          <Input {...nativeAttrs(TRANSFER_RECORD_RULES.reference)} className="w-full" />
        </Field>
      </div>

      <Field label="Notes">
        <Input name="notes" className="w-full" />
      </Field>

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        Any gap between the two amounts is booked as a fee to <span>bank charges</span> — a real expense, not a rounding difference. Money that arrives without leaving
        somewhere is income, and cannot be recorded here. A transfer between two stores also records
        what one owes the other, so the group&apos;s books still balance while each store carries its
        own position.
      </p>

      <Button type="submit" variant="primary">
        Record transfer
      </Button>
    </CheckedForm>
  );
}
