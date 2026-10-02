'use client';

/**
 * T-369 S9 (DEF-557) — the "Settle between stores" form. Choosing a pair fills the From (the debtor's office accounts),
 * the To (the creditor's) and the amount (the full balance, less if you like - partial settlement is allowed). The
 * labels arrive finished from `page.tsx` (a plain function cannot cross the server/client boundary as a prop).
 * `settlementId` is generated when the page renders, so a double click is a replay, not a second settlement.
 */
import { useState } from 'react';

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export interface SettlePairOption {
  /** "Lipa owes Malvar ₱650.00" - in words. */
  label: string;
  /** The balance as a plain 2dp string, to pre-fill the amount. */
  owed: string;
  from: { id: string; label: string }[];
  to: { id: string; label: string }[];
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}

export function SettleBetweenStoresForm({
  action,
  pairs,
  settlementId,
  today,
}: {
  action: (fd: FormData) => void | Promise<void>;
  pairs: readonly SettlePairOption[];
  settlementId: string;
  today: string;
}) {
  const [index, setIndex] = useState(0);
  const pair = pairs[index] ?? pairs[0];
  if (!pair) return null;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="settlementId" value={settlementId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who owes whom">
          <select
            className={INPUT}
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            aria-label="Who owes whom"
          >
            {pairs.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <div />

        {/* Re-keyed on the pair so the amount and the account lists reset when another pair is chosen. */}
        <Field label="From — the paying store's account" hint="An office account of the store that owes">
          <select key={`from-${index}`} name="fromMoneyAccountId" required className={INPUT} defaultValue={pair.from[0]?.id}>
            {pair.from.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To — the receiving store's account" hint="An office account of the store that is owed">
          <select key={`to-${index}`} name="toMoneyAccountId" required className={INPUT} defaultValue={pair.to[0]?.id}>
            {pair.to.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Amount that left" hint="Up to what is owed — a smaller amount settles part of it">
          <input
            key={`out-${index}`}
            name="amountOut"
            required
            inputMode="decimal"
            defaultValue={pair.owed}
            className={INPUT}
          />
        </Field>
        <Field label="Amount that arrived" hint="Leave blank unless a bank fee was deducted">
          <input name="amountIn" inputMode="decimal" placeholder="Same as above" className={INPUT} />
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

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Settle
      </button>
    </form>
  );
}
