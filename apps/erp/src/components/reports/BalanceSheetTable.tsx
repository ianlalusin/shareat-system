import { formatMoney, type Money } from '@shareat/core/money';
import { AccountDrillLink } from './AccountDrillLink';

export interface BalanceSheetTableLine {
  accountId: string | null;
  accountCode: string | null;
  accountName: string;
  amount: Money;
}

interface DrillFilter {
  storeId?: string | null;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
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
function LineRows({ lines, filter }: { lines: BalanceSheetTableLine[]; filter: DrillFilter }) {
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
            {/* The synthesised "Current period earnings" line has no accountId — nothing to
             *  drill into (T-209a's own note: it is not a ledger account). */}
            {line.accountId ? (
              <AccountDrillLink
                accountId={line.accountId}
                accountCode={line.accountCode}
                accountName={line.accountName}
                storeId={filter.storeId}
                fromDate={filter.fromDate}
                toDate={filter.toDate}
                includeYearClose={filter.includeYearClose}
              >
                {line.accountName}
              </AccountDrillLink>
            ) : (
              line.accountName
            )}
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
  storeId,
  asOfDate,
  includeYearClose,
}: {
  assetLines: BalanceSheetTableLine[];
  assets: Money;
  liabilityLines: BalanceSheetTableLine[];
  liabilities: Money;
  equityLines: BalanceSheetTableLine[];
  equity: Money;
  storeId?: string | null;
  asOfDate: string;
  includeYearClose: boolean;
}) {
  // A balance sheet is a snapshot from inception, not a range (T-209a) — the drill-down needs
  // the SAME fromDate the domain layer used internally, so its total matches this line exactly.
  const filter: DrillFilter = { storeId, fromDate: '2000-01-01', toDate: asOfDate, includeYearClose };
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <tbody>
          <SectionHeading label="Assets" />
          <LineRows lines={assetLines} filter={filter} />
          <SectionTotal label="Total assets" amount={assets} />

          <SectionHeading label="Liabilities" />
          <LineRows lines={liabilityLines} filter={filter} />
          <SectionTotal label="Total liabilities" amount={liabilities} />

          <SectionHeading label="Equity" />
          <LineRows lines={equityLines} filter={filter} />
          <SectionTotal label="Total equity" amount={equity} />
        </tbody>
      </table>
    </div>
  );
}
