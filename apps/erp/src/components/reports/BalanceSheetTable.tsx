import { formatMoney, type Money } from '@shareat/core/money';

export interface BalanceSheetTableLine {
  accountId: string | null;
  accountCode: string | null;
  accountName: string;
  amount: Money;
}

/**
 * The balance sheet — docs/tasks/209-reporting-read-model-and-statements.md.
 *
 * Presentation only — every figure was already computed by
 * packages/domain/src/reports/balance-sheet.ts; this component does no arithmetic beyond
 * `formatMoney` at the display edge, same discipline as TrialBalanceTable/
 * IncomeStatementTable. The tie indicator is a local variant of `TieIndicator` (not the
 * shared component) because "total debits = total credits" is the wrong sentence for a
 * balance sheet reader; "Assets = Liabilities + Equity" is the one bible §10 actually names.
 */
function LineRows({ lines }: { lines: BalanceSheetTableLine[] }) {
  if (lines.length === 0) {
    return (
      <tr>
        <td className="px-3 py-1.5 pl-8 text-neutral-400 dark:text-neutral-600" colSpan={2}>
          (none)
        </td>
      </tr>
    );
  }
  return (
    <>
      {lines.map((line) => (
        <tr key={line.accountId ?? line.accountName}>
          <td className="px-3 py-1.5 pl-8 text-neutral-600 dark:text-neutral-400">
            {line.accountCode ? (
              <span className="mr-2 font-mono text-xs text-neutral-400 dark:text-neutral-600">{line.accountCode}</span>
            ) : null}
            {line.accountName}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
            {formatMoney(line.amount)}
          </td>
        </tr>
      ))}
    </>
  );
}

function SectionTotal({ label, amount }: { label: string; amount: Money }) {
  return (
    <tr className="border-y border-neutral-300 bg-neutral-50 font-semibold dark:border-neutral-700 dark:bg-neutral-900">
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(amount)}</td>
    </tr>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <tr className="bg-neutral-50 dark:bg-neutral-900">
      <td className="px-3 py-2 font-semibold" colSpan={2}>
        {label}
      </td>
    </tr>
  );
}

export function BalanceSheetTieIndicator({
  ties,
  assets,
  liabilitiesAndEquity,
}: {
  ties: boolean;
  assets: Money;
  liabilitiesAndEquity: Money;
}) {
  return (
    <div
      role="status"
      className={
        ties
          ? 'rounded-lg border-2 border-emerald-600 bg-emerald-50 p-4 dark:border-emerald-500 dark:bg-emerald-950'
          : 'rounded-lg border-4 border-red-600 bg-red-100 p-4 dark:border-red-500 dark:bg-red-950'
      }
    >
      <p
        className={
          ties
            ? 'text-lg font-bold text-emerald-800 dark:text-emerald-200'
            : 'text-2xl font-extrabold uppercase tracking-wide text-red-800 dark:text-red-100'
        }
      >
        {ties ? 'Ties' : 'DOES NOT TIE'}
      </p>
      <p
        className={
          ties
            ? 'mt-1 text-sm text-emerald-700 dark:text-emerald-300'
            : 'mt-1 text-base font-semibold text-red-800 dark:text-red-100'
        }
      >
        Assets {formatMoney(assets)} {ties ? '=' : '≠'} Liabilities + Equity {formatMoney(liabilitiesAndEquity)}
      </p>
      {!ties ? (
        <p className="mt-2 text-sm text-red-800 dark:text-red-100">
          This should never happen — bible §16.1 invariant 9. Stop and investigate before
          trusting any other figure on this screen.
        </p>
      ) : null}
    </div>
  );
}

export function BalanceSheetTable({
  assetLines,
  assets,
  liabilityLines,
  liabilities,
  equityLines,
  equity,
}: {
  assetLines: BalanceSheetTableLine[];
  assets: Money;
  liabilityLines: BalanceSheetTableLine[];
  liabilities: Money;
  equityLines: BalanceSheetTableLine[];
  equity: Money;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <tbody>
          <SectionHeading label="Assets" />
          <LineRows lines={assetLines} />
          <SectionTotal label="Total assets" amount={assets} />

          <SectionHeading label="Liabilities" />
          <LineRows lines={liabilityLines} />
          <SectionTotal label="Total liabilities" amount={liabilities} />

          <SectionHeading label="Equity" />
          <LineRows lines={equityLines} />
          <SectionTotal label="Total equity" amount={equity} />
        </tbody>
      </table>
    </div>
  );
}
