import { formatMoney, type Money } from '@shareat/core/money';

/**
 * The tie indicator — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "an explicit 'ties / DOES NOT TIE' indicator that is impossible to miss. If it ever
 * does not tie, that is the most important fact on the screen and it must not be a
 * subtle red number."
 *
 * `ties` is computed once, in packages/domain/src/reports/trial-balance.ts, from the
 * SAME totals rendered here — this component never re-derives it, it only renders the
 * verdict it is given. Money is formatted here, at the presentation edge, never on the
 * server elsewhere (bible landmine: never `toLocaleString` on the server — `formatMoney`
 * hardcodes locale 'en-PH' and currency 'PHP', so it is safe wherever it runs).
 */
export function TieIndicator({
  ties,
  totalDebit,
  totalCredit,
}: {
  ties: boolean;
  totalDebit: Money;
  totalCredit: Money;
}) {
  return (
    <div
      role="status"
      className={
        ties
          ? 'rounded-lg border-2 border-success bg-success-soft p-4'
          : 'rounded-lg border-4 border-danger bg-danger-surface p-4'
      }
    >
      <p
        className={
          ties
            ? 'text-lg font-bold text-success'
            : 'text-2xl font-extrabold uppercase tracking-wide text-danger'
        }
      >
        {ties ? 'Ties' : 'DOES NOT TIE'}
      </p>
      <p
        className={
          ties
            ? 'mt-1 text-sm text-success'
            : 'mt-1 text-base font-semibold text-danger'
        }
      >
        Total debits {formatMoney(totalDebit)} {ties ? '=' : '≠'} total credits {formatMoney(totalCredit)}
      </p>
      {!ties ? (
        <p className="mt-2 text-sm text-danger">
          This should never happen — every journal entry is enforced balanced at the
          database level. Stop and investigate before trusting any other figure on this
          screen.
        </p>
      ) : null}
    </div>
  );
}
