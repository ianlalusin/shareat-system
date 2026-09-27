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

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}

export function RecordTransferForm({
  action,
  options,
  today,
}: {
  action: (fd: FormData) => void | Promise<void>;
  options: readonly PickerOption[];
  today: string;
}) {

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TwoWayPicker
          options={options}
          fromName="fromMoneyAccountId"
          toName="toMoneyAccountId"
          fromLabel="From — money left here"
          toLabel="To — money landed here"
          blankPlaceholder="Choose an account…"
          labelClassName="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400"
          selectClassName={INPUT}
        />

        {/*
          ⭐ TWO amounts, deliberately — see T-139 §3.

          v1 asks for one "amount" and adds the fee to the source; this project's own posting
          doc narrates the same legs the other way round. Both readings are real here (a bank
          wire adds its fee to the source; a cash-out deducts it from the target), so a single
          box would silently mean different things on different days. Both figures are
          observable — one on each statement — which is what makes a transfer checkable.
        */}
        <Field label="Amount that left" hint="What the source account was reduced by">
          <input
            name="amountOut"
            type="number"
            step="0.01"
            min="0.01"
            required
            inputMode="decimal"
            placeholder="0.00"
            className={INPUT}
          />
        </Field>
        <Field label="Amount that arrived" hint="Leave blank if nothing was deducted — the usual case">
          <input
            name="amountIn"
            inputMode="decimal"
            placeholder="Same as above"
            className={INPUT}
          />
        </Field>

        <Field label="Date">
          <input name="transferDate" type="date" required defaultValue={today} className={INPUT} />
        </Field>
        <Field label="Reference" hint="The bank or wallet reference, if there is one">
          <input name="reference" maxLength={120} className={INPUT} />
        </Field>
      </div>

      <Field label="Notes">
        <input name="notes" className={INPUT} />
      </Field>

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        Any gap between the two amounts is booked as a fee to <span className="font-mono">6870</span>{' '}
        Bank charges — a real expense, not a rounding difference. Money that arrives without leaving
        somewhere is income, and cannot be recorded here. A transfer between two stores also records
        what one owes the other, so the group&apos;s books still balance while each store carries its
        own position.
      </p>

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Record transfer
      </button>
    </form>
  );
}
