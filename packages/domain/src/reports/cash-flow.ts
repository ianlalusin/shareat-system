/**
 * getCashFlow — T-209c. Indirect method, computed as balance-sheet-account deltas between two
 * snapshots (`reportsRepo.getBalanceSheetLines`, already signed by account TYPE), classified by
 * account CODE rather than by each entry's `source_type` (30+ distinct values across the domain
 * layer — a switch a new posting type could silently miss, exactly the "hand-maintained
 * classification list" shape bible §16.0/§4.2 rule 7 rules out elsewhere).
 * docs/tasks/209-reporting-read-model-and-statements.md (T-209c) has the full design, verified by
 * hand against a cash sale, a credit sale, a depreciation posting, and a loan disbursement before
 * this file was written.
 *
 * Operating starts from NET INCOME, not from zero — income/expense accounts are entirely absent
 * from `v_balance_sheet`, so a pure cash sale has no non-cash balance-sheet account to carry its
 * effect. The depreciation add-back is the one thing that DOES fall out for free: `1590`
 * (accumulated depreciation, a contra-asset) is bucketed as an ordinary operating asset account,
 * and applying the universal delta rule to it produces exactly the textbook add-back, because the
 * depreciation expense already reduced `netIncome` and the `1590` delta term cancels that
 * reduction (the posting itself is non-cash).
 *
 * `includeYearClose` defaults to FALSE, matching the income statement's own date-range default
 * (ADR-006) — deliberately, so a year-close entry's effect is excluded from BOTH `netIncome` and
 * every account's balance delta together. Excluding it from only one side would double-count (or
 * miss) the closed period's net income by way of `3300 Retained earnings`.
 */
import { reportsRepo, type Executor } from '@shareat/db';
import { add, equals, money, subtract, type Money } from '@shareat/core/money';
import { addDays, parseBusinessDate } from '@shareat/core/datetime';
import { getIncomeStatement } from './income-statement';

/** Same sentinel and reasoning as balance-sheet.ts's own INCEPTION — bible row 106: v2 always
 *  starts from a zero point, so this is exact, not approximate, as "everything ever posted". */
const INCEPTION = '2000-01-01';

const CASH_CODES: ReadonlySet<string> = new Set(['1110', '1115', '1120', '1130', '1140']);
const INVESTING_CODES: ReadonlySet<string> = new Set(['1510']);
const FINANCING_CODES: ReadonlySet<string> = new Set(['2400', '3100', '3200']);

export interface CashFlowInput {
  orgId: string;
  storeId?: string | null;
  /** Inclusive, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive, YYYY-MM-DD. */
  toDate: string;
  /** Defaults to FALSE — see this file's top comment. */
  includeYearClose?: boolean;
}

export interface CashFlowLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The account's own delta contribution — does not include the netIncome starting point. */
  amount: Money;
}

export interface CashFlowBasis {
  orgId: string;
  storeId: string | null;
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
}

export interface CashFlowResult {
  netIncome: Money;
  operatingLines: CashFlowLine[];
  operating: Money;
  investingLines: CashFlowLine[];
  investing: Money;
  financingLines: CashFlowLine[];
  financing: Money;
  /** operating + investing + financing. */
  netChangeInCash: Money;
  /** The independent check: the actual change in cash & cash-equivalent balances over the range. */
  actualCashChange: Money;
  /** netChangeInCash === actualCashChange, to the centavo — no tolerance. */
  reconciles: boolean;
  basis: CashFlowBasis;
}

type Bucket = 'investing' | 'financing' | 'operating';

function bucketOf(code: string): Bucket {
  if (INVESTING_CODES.has(code)) return 'investing';
  if (FINANCING_CODES.has(code)) return 'financing';
  return 'operating';
}

interface SnapshotRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: 'asset' | 'liability' | 'equity';
  netAmount: Money;
}

function toSnapshotMap(rows: reportsRepo.BalanceSheetRow[]): Map<string, SnapshotRow> {
  return new Map(
    rows.map((r) => [
      r.accountId,
      { accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, accountType: r.accountType, netAmount: money(r.netAmount) },
    ]),
  );
}

export async function getCashFlow(ex: Executor, input: CashFlowInput): Promise<CashFlowResult> {
  const storeId = input.storeId ?? null;
  const includeYearClose = input.includeYearClose ?? false;
  const openingAsOf = addDays(parseBusinessDate(input.fromDate), -1);

  const [openingRows, closingRows, incomeStatement] = await Promise.all([
    reportsRepo.getBalanceSheetLines(ex, { orgId: input.orgId, storeId, fromDate: INCEPTION, toDate: openingAsOf, includeYearClose }),
    reportsRepo.getBalanceSheetLines(ex, { orgId: input.orgId, storeId, fromDate: INCEPTION, toDate: input.toDate, includeYearClose }),
    getIncomeStatement(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, includeYearClose }),
  ]);

  const opening = toSnapshotMap(openingRows);
  const closing = toSnapshotMap(closingRows);
  const accountIds = new Set([...opening.keys(), ...closing.keys()]);

  const operatingLines: CashFlowLine[] = [];
  const investingLines: CashFlowLine[] = [];
  const financingLines: CashFlowLine[] = [];
  let cashChange: Money = money('0');

  for (const accountId of accountIds) {
    const snap = closing.get(accountId) ?? opening.get(accountId)!;
    const openAmount = opening.get(accountId)?.netAmount ?? money('0');
    const closeAmount = closing.get(accountId)?.netAmount ?? money('0');
    const delta = subtract(closeAmount, openAmount);

    if (CASH_CODES.has(snap.accountCode)) {
      cashChange = add(cashChange, delta);
      continue;
    }

    const contribution = snap.accountType === 'asset' ? subtract(money('0'), delta) : delta;
    const line: CashFlowLine = { accountId: snap.accountId, accountCode: snap.accountCode, accountName: snap.accountName, amount: contribution };

    const bucket = bucketOf(snap.accountCode);
    if (bucket === 'investing') investingLines.push(line);
    else if (bucket === 'financing') financingLines.push(line);
    else operatingLines.push(line);
  }

  const sortByCode = (a: CashFlowLine, b: CashFlowLine) => a.accountCode.localeCompare(b.accountCode);
  operatingLines.sort(sortByCode);
  investingLines.sort(sortByCode);
  financingLines.sort(sortByCode);

  const operating = add(incomeStatement.netIncome, ...operatingLines.map((l) => l.amount));
  const investing = add(...investingLines.map((l) => l.amount));
  const financing = add(...financingLines.map((l) => l.amount));
  const netChangeInCash = add(operating, investing, financing);

  return {
    netIncome: incomeStatement.netIncome,
    operatingLines,
    operating,
    investingLines,
    investing,
    financingLines,
    financing,
    netChangeInCash,
    actualCashChange: cashChange,
    reconciles: equals(netChangeInCash, cashChange),
    basis: { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, includeYearClose },
  };
}
