/**
 * Pure helpers for "Everything unpaid" (T-431). No database, no React.
 * The figures all come from `getUnpaidLiabilities`; this file only orders and words them.
 */
import { ZERO, compare, money, negate } from '@shareat/core/money';
import type { UnpaidLine } from '@shareat/domain';

/** Overdue lines first (due before today, Manila), then by due date; undated last. Stable otherwise. */
export function orderLines(lines: readonly UnpaidLine[], today: string): UnpaidLine[] {
  const rank = (l: UnpaidLine): number => (isOverdue(l, today) ? 0 : 1);
  return lines
    .map((l, i) => ({ l, i }))
    .sort(
      (a, b) =>
        rank(a.l) - rank(b.l) ||
        (a.l.dueOn ?? '9999-99-99').localeCompare(b.l.dueOn ?? '9999-99-99') ||
        a.i - b.i,
    )
    .map((x) => x.l);
}

/** ISO business dates order lexicographically; `localeCompare` says "before" without a relational `<` on strings. */
function before(a: string, b: string): boolean {
  return Math.sign(a.localeCompare(b)) === -1;
}

export function isOverdue(line: UnpaidLine, today: string): boolean {
  return line.dueOn !== null && before(line.dueOn, today);
}

/** A leftover is signed: the books carry more (positive) or less (negative) than the records listed. */
export function leftoverDirection(amount: string): { more: boolean; size: string } {
  const m = money(amount);
  return compare(m, ZERO) < 0 ? { more: false, size: negate(m) } : { more: true, size: m };
}

export function daysWord(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}
