import { formatMoney, type Money } from '@shareat/core/money';

export interface CashFlowTableLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  amount: Money;
}

/**
 * The cash flow statement — T-209c. Presentation only; every figure was already computed by
 * packages/domain/src/reports/cash-flow.ts. `netIncome` is shown as the operating section's own
 * starting line — see that file's top comment for why it cannot be omitted.
 */
function LineRows({ lines }: { lines: CashFlowTableLine[] }) {
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
        <tr key={line.accountId}>
          <td className="px-3 py-1.5 pl-8 text-neutral-600 dark:text-neutral-400">
            <span className="mr-2 font-mono text-xs text-neutral-400 dark:text-neutral-600">{line.accountCode}</span>
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

function SectionHeading({ label }: { label: string }) {
  return (
    <tr className="bg-neutral-50 dark:bg-neutral-900">
      <td className="px-3 py-2 font-semibold" colSpan={2}>{label}</td>
    </tr>
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

export function CashFlowReconciliationIndicator({
  reconciles,
  netChangeInCash,
  actualCashChange,
}: {
  reconciles: boolean;
  netChangeInCash: Money;
  actualCashChange: Money;
}) {
  return (
    <div
      role="status"
      className={
        reconciles
          ? 'rounded-lg border-2 border-success bg-success-soft p-4'
          : 'rounded-lg border-4 border-danger bg-danger-surface p-4'
      }
    >
      <p className={reconciles ? 'text-lg font-bold text-success' : 'text-2xl font-extrabold uppercase tracking-wide text-danger'}>
        {reconciles ? 'Reconciles' : 'DOES NOT RECONCILE'}
      </p>
      <p className={reconciles ? 'mt-1 text-sm text-success' : 'mt-1 text-base font-semibold text-danger'}>
        Net change in cash {formatMoney(netChangeInCash)} {reconciles ? '=' : '≠'} actual cash change {formatMoney(actualCashChange)}
      </p>
      {!reconciles ? (
        <p className="mt-2 text-sm text-danger">
          This should never happen — a balance-sheet account posted since this design was written
          may not be classified. Stop and investigate before trusting any other figure on this
          screen.
        </p>
      ) : null}
    </div>
  );
}

export function CashFlowTable({
  netIncome,
  operatingLines,
  operating,
  investingLines,
  investing,
  financingLines,
  financing,
  netChangeInCash,
}: {
  netIncome: Money;
  operatingLines: CashFlowTableLine[];
  operating: Money;
  investingLines: CashFlowTableLine[];
  investing: Money;
  financingLines: CashFlowTableLine[];
  financing: Money;
  netChangeInCash: Money;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table data-card-columns="Activity|Amount" className="w-full min-w-[560px] border-collapse text-sm">
        <tbody>
          <SectionHeading label="Operating activities" />
          <tr>
            <td className="px-3 py-1.5 pl-8 text-neutral-600 dark:text-neutral-400">Net income</td>
            <td className="px-3 py-1.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">{formatMoney(netIncome)}</td>
          </tr>
          <LineRows lines={operatingLines} />
          <SectionTotal label="Net cash from operating activities" amount={operating} />

          <SectionHeading label="Investing activities" />
          <LineRows lines={investingLines} />
          <SectionTotal label="Net cash from investing activities" amount={investing} />

          <SectionHeading label="Financing activities" />
          <LineRows lines={financingLines} />
          <SectionTotal label="Net cash from financing activities" amount={financing} />

          <tr className="border-t-2 border-neutral-400 bg-neutral-100 text-base font-bold dark:border-neutral-600 dark:bg-neutral-800">
            <td className="px-3 py-3">Net change in cash</td>
            <td className="px-3 py-3 text-right tabular-nums">{formatMoney(netChangeInCash)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
