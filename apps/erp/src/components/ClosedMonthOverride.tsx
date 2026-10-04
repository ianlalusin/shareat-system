'use client';

/**
 * "Post this one entry into a closed month." T-369 S5a (DEF-314).
 *
 * Rendered ONLY for someone who holds `override_period_lock`, and only inside forms whose date can fall
 * in a closed month. It shows itself when the chosen date is in one of `closedMonths` and hides itself
 * otherwise. The fields it carries (`periodOverrideConfirm` / `periodOverrideReason` /
 * `periodOverrideNote`) are read by `readPeriodOverride`; the person answering for the entry is always
 * the signed-in actor, never a field (I4).
 *
 * ⛔ I5: never on a stock screen. A native `<details>`, no dialogs.
 */
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui';

export interface ClosedMonthOption {
  startsOn: string;
  endsOn: string;
  label: string;
}

const REASONS: { value: string; label: string }[] = [
  { value: 'late_supplier_invoice', label: 'Late supplier bill' },
  { value: 'regulatory_correction', label: 'Correction required by BIR/regulator' },
  { value: 'data_entry_error', label: 'Fixing a mistake' },
  { value: 'other', label: 'Other' },
];

const SELECT =
  'rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

export function ClosedMonthOverride({
  closedMonths,
  dateFieldName,
  initialDate,
  count = 1,
}: {
  closedMonths: ClosedMonthOption[];
  /** The `name` of the date input in the same form. */
  dateFieldName: string;
  initialDate: string;
  /** How many entries this form posts (the bills screen: one per draft). 1 keeps the original copy. */
  count?: number;
}) {
  const many = count > 1;
  const ref = useRef<HTMLDetailsElement>(null);
  const [date, setDate] = useState(initialDate);

  useEffect(() => {
    const field = ref.current?.closest('form')?.elements.namedItem(dateFieldName);
    if (!(field instanceof HTMLInputElement)) return;
    const sync = () => setDate(field.value);
    sync();
    field.addEventListener('input', sync);
    field.addEventListener('change', sync);
    return () => {
      field.removeEventListener('input', sync);
      field.removeEventListener('change', sync);
    };
  }, [dateFieldName]);

  const month = closedMonths.find((m) => date >= m.startsOn && date <= m.endsOn);

  return (
    <details ref={ref} data-closed-month-override="" hidden={!month} className="sm:col-span-2 rounded-md border border-amber-300 p-3 dark:border-amber-800">
      <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium">
        {month ? `${month.label} is closed — post ${many ? `these ${count} expenses` : 'this one entry'} anyway` : 'Post into a closed month'}
      </summary>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <p className="text-xs text-neutral-600 dark:text-neutral-400 sm:col-span-2">
          {month ? `${month.label} is closed.` : 'This month is closed.'} {many ? `You can post these ${count} expenses into it. Each will be` : 'You can post this one entry into it. It will be'}{' '}
          recorded against your name with the reason below.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Reason</span>
          <select name="periodOverrideReason" defaultValue="" className={SELECT}>
            <option value="" disabled>
              Choose a reason…
            </option>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Note (required for “Other”)</span>
          <Input name="periodOverrideNote" />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="periodOverrideConfirm" />
          <span>I confirm this entry belongs in a closed month.</span>
        </label>
      </div>
    </details>
  );
}
