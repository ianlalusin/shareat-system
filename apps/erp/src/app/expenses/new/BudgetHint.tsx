'use client';

/**
 * T-215 §5 — **what is left in this category's envelope, at the moment of spending.**
 *
 * ⭐ This is the point of the whole budgets task. A budget-vs-actual report at month end is a
 * post-mortem; the number only changes a decision if it is on the screen where the decision is
 * made. v1 built the envelope for exactly this reason.
 *
 * ⛔ **It warns and never blocks, and that is a decision rather than an omission.** T-175 settled
 * the pattern for this codebase — *a finding replaces v1's block: nag whoever can act, never block
 * whoever cannot.* A cashier who cannot buy gas because a cap was set wrong buys it with their own
 * money, and then the expense leaves the system entirely, which is strictly worse than an
 * over-spent envelope somebody can see.
 *
 * ⚠️ A client component only because it must react to a `<select>`; it fetches nothing and decides
 * nothing. Every figure is computed on the server and passed in — the caps below are already
 * derived from `journal_lines`-adjacent facts, never from a stored counter.
 */
import { useEffect, useState } from 'react';

export interface BudgetCap {
  categoryId: string;
  label: string;
  amount: string;
  consumed: string;
  remaining: string;
}

const peso = (v: number) =>
  `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function BudgetHint({ caps, periodKey }: { caps: BudgetCap[]; periodKey: string }) {
  const [categoryId, setCategoryId] = useState('');
  const [entered, setEntered] = useState(0);

  useEffect(() => {
    const form = document.querySelector('form');
    if (!form) return;

    const read = () => {
      const select = form.querySelector<HTMLSelectElement>('select[name="categoryId"]');
      setCategoryId(select?.value ?? '');
      // ⚠️ The total is the SUM of the split-payment rows, not one field — an expense here is
      // paid from one or more accounts (bible row 148), so reading a single "amount" box would
      // under-state every split expense and quietly make the hint optimistic.
      let total = 0;
      for (const input of form.querySelectorAll<HTMLInputElement>('input[name^="amount_"]')) {
        const n = Number(input.value);
        if (Number.isFinite(n)) total += n;
      }
      setEntered(total);
    };

    read();
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    return () => {
      form.removeEventListener('input', read);
      form.removeEventListener('change', read);
    };
  }, []);

  if (!categoryId) return null;
  const cap = caps.find((c) => c.categoryId === categoryId);

  // ⚠️ NO cap is not the same as a cap of zero, and saying nothing is the right answer for the
  // first: most categories have no envelope, and a "no budget set" banner on every one of them
  // is noise people learn to look past — which is how they stop seeing the real one.
  if (!cap) return null;

  const remaining = Number(cap.remaining);
  const after = remaining - entered;
  const tone =
    after < 0
      ? 'border-danger bg-danger-surface text-danger'
      : after < Number(cap.amount) * 0.1
        ? 'border-warning bg-warning-soft text-warning-ink'
        : 'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300';

  return (
    <div className={`rounded-lg border p-3 text-sm ${tone}`}>
      <strong className="font-medium">{cap.label}</strong> — {peso(Number(cap.amount))} capped for{' '}
      {periodKey}, {peso(Number(cap.consumed))} spent, <strong>{peso(remaining)} left</strong>.
      {entered > 0 && (
        <>
          {' '}
          This expense leaves <strong>{peso(after)}</strong>.
        </>
      )}
      {after < 0 && (
        <div className="mt-1">
          ⚠️ That is over the cap. <strong>It will still save</strong> — this is a warning, not a
          gate. Tell whoever set the cap.
        </div>
      )}
    </div>
  );
}
